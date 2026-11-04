/* =========================================================================
   MODULO FISCAL - NFC-e (modelo 65)

   Tudo que envolve certificado digital, montagem e assinatura do XML,
   QR Code e conversa com a SEFAZ mora aqui, separado do server.js.

   IMPORTANTE PARA QUEM FOR MEXER:
   A NFC-e e um documento fiscal de verdade. Um campo errado nao gera um
   bug silencioso: a SEFAZ rejeita a nota e o caixa para. Por isso este
   arquivo evita "esperteza" e escreve cada campo do jeito que o manual
   (MOC 7.0 / layout 4.00) manda, mesmo quando fica repetitivo.
   ========================================================================= */

const forge = require('node-forge');
const crypto = require('crypto');
const https = require('https');
const { SignedXml } = require('xml-crypto');

/* =========================================================================
   1. CERTIFICADO DIGITAL A1 (.pfx / .p12)
   ========================================================================= */

/** Tira o CNPJ de dentro do "nome" do certificado: "RAZAO SOCIAL:68114805000108". */
function cnpjDoTitular(cn) {
  const m = String(cn || '').match(/:(\d{11,14})\s*$/);
  return m ? m[1] : '';
}

function nomeDoTitular(cn) {
  return String(cn || '').replace(/:(\d{11,14})\s*$/, '').trim();
}

/** Le um campo do "assunto" do certificado (CN, O, OU...). */
function campoDoNome(attrs, nome) {
  const a = (attrs || []).find((x) => x.shortName === nome || x.name === nome);
  return a ? String(a.value) : '';
}

/**
 * Abre o .pfx e devolve o certificado, a chave privada e os dados do titular.
 * Erra com mensagem em portugues — quem le e o dono da loja, nao um programador.
 *
 * @param {Buffer|string} arquivo  conteudo do .pfx (Buffer ou base64)
 * @param {string} senha           senha do certificado
 */
function abrirCertificado(arquivo, senha) {
  const b64 = Buffer.isBuffer(arquivo) ? arquivo.toString('base64') : String(arquivo || '');
  if (!b64) throw new Error('Nenhum arquivo de certificado foi enviado.');

  let p12;
  try {
    const der = forge.util.decode64(b64);
    const asn1 = forge.asn1.fromDer(der);
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, String(senha === undefined ? '' : senha));
  } catch (e) {
    const m = String(e.message || '');
    if (/mac could not be verified|invalid password/i.test(m)) {
      throw new Error('Senha do certificado incorreta.');
    }
    if (/Cannot read|Too few bytes|ASN\.1|Invalid/i.test(m)) {
      throw new Error('Este arquivo nao parece ser um certificado A1 (.pfx ou .p12) valido.');
    }
    throw new Error('Nao foi possivel abrir o certificado: ' + m);
  }

  /* A chave privada pode estar em dois formatos de "sacola" dentro do pfx.
     Emissores brasileiros usam os dois, entao procuramos nos dois. */
  let chave = null;
  [forge.pki.oids.pkcs8ShroudedKeyBag, forge.pki.oids.keyBag].forEach((oid) => {
    if (chave) return;
    const sacolas = p12.getBags({ bagType: oid })[oid] || [];
    const achou = sacolas.find((b) => b.key);
    if (achou) chave = achou.key;
  });

  const sacolasCert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  const certificados = sacolasCert.map((b) => b.cert).filter(Boolean);
  if (!certificados.length) throw new Error('O arquivo nao contem nenhum certificado.');

  /* O certificado do titular e o que casa com a chave privada. Sem a chave,
     ficamos com o primeiro que tenha CNPJ no nome (os outros sao da cadeia
     da Autoridade Certificadora: AC SyngularID, ICP-Brasil Raiz, etc). */
  let cert = null;
  if (chave) {
    cert = certificados.find((c) => {
      try {
        return c.publicKey && c.publicKey.n && chave.n && c.publicKey.n.compareTo(chave.n) === 0;
      } catch (e) { return false; }
    }) || null;
  }
  if (!cert) {
    cert = certificados.find((c) => cnpjDoTitular(campoDoNome(c.subject.attributes, 'CN'))) || certificados[0];
  }
  if (!chave) throw new Error('O certificado nao tem a chave privada. Exporte o .pfx de novo marcando a opcao de exportar a chave.');

  const cn = campoDoNome(cert.subject.attributes, 'CN');
  const de = cert.validity.notBefore;
  const ate = cert.validity.notAfter;
  const hoje = new Date();

  return {
    cert,
    chave,
    cadeia: certificados.filter((c) => c !== cert),
    /* usado na assinatura do XML: o certificado em base64, sem cabecalho PEM */
    certBase64: forge.util.encode64(
      forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    ),
    pemCert: forge.pki.certificateToPem(cert),
    pemChave: forge.pki.privateKeyToPem(chave),
    info: {
      titular: nomeDoTitular(cn),
      cnpj: cnpjDoTitular(cn),
      nome_completo: cn,
      emissor: campoDoNome(cert.issuer.attributes, 'CN'),
      serie: cert.serialNumber,
      valido_de: de.toISOString(),
      valido_ate: ate.toISOString(),
      dias_restantes: Math.floor((ate - hoje) / 86400000),
      vencido: ate < hoje,
      ainda_nao_vale: de > hoje
    }
  };
}

/* =========================================================================
   2. GUARDA DA SENHA DO CERTIFICADO

   A senha precisa ser recuperavel (sem ela nao da para assinar), entao e
   cifrada, nao "hasheada". Isso protege de quem der uma olhada no banco,
   mas nao de quem levar o loja.db inteiro — por isso o README avisa que o
   backup do banco tem que ser guardado como se fosse o proprio certificado.
   ========================================================================= */

function cifrar(texto, chaveHex) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(chaveHex, 'hex'), iv);
  const dados = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv.toString('hex'), c.getAuthTag().toString('hex'), dados.toString('hex')].join(':');
}

function decifrar(pacote, chaveHex) {
  const [ivHex, tagHex, dadosHex] = String(pacote || '').split(':');
  if (!ivHex || !tagHex || !dadosHex) throw new Error('Senha do certificado guardada em formato invalido.');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(chaveHex, 'hex'), Buffer.from(ivHex, 'hex'));
  d.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(dadosHex, 'hex')), d.final()]).toString('utf8');
}

/* =========================================================================
   3. CHAVE DE ACESSO (44 digitos)

   cUF(2) AAMM(4) CNPJ(14) mod(2) serie(3) nNF(9) tpEmis(1) cNF(8) DV(1)
   ========================================================================= */

const UF_CODIGO = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53
};

const zeros = (v, n) => String(v === null || v === undefined ? '' : v).replace(/\D/g, '').padStart(n, '0').slice(-n);

/** Digito verificador da chave: modulo 11, pesos 2..9 da direita para a esquerda. */
function dvChave(chave43) {
  const d = String(chave43).replace(/\D/g, '');
  let peso = 2;
  let soma = 0;
  for (let i = d.length - 1; i >= 0; i--) {
    soma += Number(d[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  return String(resto === 0 || resto === 1 ? 0 : 11 - resto);
}

/**
 * Monta a chave de acesso completa.
 * cNF (codigo numerico) nao pode ser igual ao numero da nota — regra da SEFAZ.
 */
function montarChave({ uf, dataEmissao, cnpj, modelo = 65, serie, numero, tpEmis = 1, cNF }) {
  const cUF = UF_CODIGO[String(uf || '').toUpperCase()];
  if (!cUF) throw new Error('UF invalida para montar a chave: ' + uf);
  const dt = new Date(dataEmissao);
  const aamm = String(dt.getFullYear()).slice(2) + zeros(dt.getMonth() + 1, 2);
  const base =
    zeros(cUF, 2) + aamm + zeros(cnpj, 14) + zeros(modelo, 2) +
    zeros(serie, 3) + zeros(numero, 9) + zeros(tpEmis, 1) + zeros(cNF, 8);
  if (base.length !== 43) throw new Error('Chave de acesso montada com tamanho errado: ' + base.length);
  return base + dvChave(base);
}

/**
 * [1.9.2] GTIN (codigo de barras) valido: 8, 12, 13 ou 14 digitos E digito
 * verificador certo (modulo 10 do GS1). Codigo inventado — ex.: um numero
 * interno de 13 digitos — quase nunca fecha o DV, e a SEFAZ rejeita a nota
 * inteira por causa dele (rejeicao 883). Nesses casos e melhor mandar
 * "SEM GTIN" do que travar a venda.
 */
function gtinValido(codigo) {
  const g = String(codigo || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(g.length)) return false;
  const d = g.slice(0, -1).split('').map(Number);
  let soma = 0;
  for (let i = d.length - 1, peso = 3; i >= 0; i--, peso = peso === 3 ? 1 : 3) soma += d[i] * peso;
  return String((10 - (soma % 10)) % 10) === g.slice(-1);
}

/** Codigo numerico aleatorio de 8 digitos, garantidamente diferente do numero da nota. */
function gerarCodigoNumerico(numeroNota) {
  let c;
  do {
    c = zeros(crypto.randomInt(0, 100000000), 8);
  } while (Number(c) === Number(numeroNota));
  return c;
}

/* =========================================================================
   4. MONTAGEM DO XML DA NFC-e (layout 4.00, modelo 65)
   ========================================================================= */

const NS_NFE = 'http://www.portalfiscal.inf.br/nfe';

/* Frase obrigatoria em ambiente de teste, no primeiro item (rejeicao 373).
   Sem acento e com hifen cercado de espaco, exatamente como a SEFAZ compara. */
const FRASE_HOMOLOGACAO = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/** Texto seguro para XML: sem acento, sem caractere de controle, sem <>&. */
function limpo(v, tamanho) {
  let s = String(v === null || v === undefined ? '' : v)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // tira acento
    .replace(/[<>&"']/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (tamanho) s = s.slice(0, tamanho);
  return s;
}

/** Numero com casas fixas — a SEFAZ recusa "1,50" e recusa "1.5" onde pede 2 casas. */
function dec(v, casas = 2) {
  const n = Number(v) || 0;
  return n.toFixed(casas);
}

/** Data no formato exigido: 2026-08-11T14:32:05-03:00 */
function dataXml(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  const min = -dt.getTimezoneOffset();
  const sinal = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` +
         `T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}` +
         `${sinal}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const tag = (nome, valor) =>
  (valor === null || valor === undefined || valor === '') ? '' : `<${nome}>${valor}</${nome}>`;

/**
 * Forma de pagamento do sistema -> codigo tPag da SEFAZ.
 * 01 dinheiro | 03 cartao de credito | 04 cartao de debito
 * 05 credito da loja (crediario) | 17 PIX | 99 outros
 */
function codigoPagamento(forma) {
  const f = String(forma || '').toLowerCase();
  if (f.includes('dinheiro')) return '01';
  if (f.includes('pix')) return '17';
  if (f.includes('debito') || f.includes('débito')) return '04';
  if (f.includes('credito') || f.includes('crédito')) return '03';
  if (f.includes('crediario') || f.includes('crediário') || f.includes('prazo')) return '05';
  return '99';
}

/**
 * Monta o <infNFe> completo.
 *
 * dados = {
 *   chave, cNF, numero, serie, tpEmis, ambiente, dataEmissao,
 *   emitente: {...}, destinatario: {...} | null,
 *   itens: [{...}], pagamentos: [{...}], troco, desconto, informacao
 * }
 */
function montarInfNfe(d) {
  const e = d.emitente;
  const ambiente = Number(d.ambiente) === 1 ? '1' : '2';

  /* ---------- ide ---------- */
  const ide =
    '<ide>' +
    tag('cUF', zeros(UF_CODIGO[e.uf], 2)) +
    tag('cNF', d.cNF) +
    tag('natOp', limpo(d.natureza || 'VENDA', 60)) +
    tag('mod', '65') +
    tag('serie', String(Number(d.serie))) +
    tag('nNF', String(Number(d.numero))) +
    tag('dhEmi', dataXml(d.dataEmissao)) +
    tag('tpNF', '1') +                      // 1 = saida
    tag('idDest', '1') +                    // 1 = operacao dentro do estado
    tag('cMunFG', zeros(e.municipio_ibge, 7)) +
    tag('tpImp', '4') +                     // 4 = DANFE NFC-e
    tag('tpEmis', String(d.tpEmis || 1)) +
    tag('cDV', d.chave.slice(-1)) +
    tag('tpAmb', ambiente) +
    tag('finNFe', '1') +                    // 1 = normal
    tag('indFinal', '1') +                  // 1 = consumidor final
    tag('indPres', '1') +                   // 1 = presencial
    tag('procEmi', '0') +
    tag('verProc', limpo(d.versaoSistema || 'LOJA 1.9', 20)) +
    /* Em contingencia offline a SEFAZ exige o momento e o motivo da entrada. */
    (Number(d.tpEmis) === 9
      ? tag('dhCont', dataXml(d.contingenciaEm || d.dataEmissao)) +
        tag('xJust', limpo(d.contingenciaMotivo || 'FALHA DE COMUNICACAO COM A SEFAZ', 256))
      : '') +
    '</ide>';

  /* ---------- emitente ---------- */
  const emit =
    '<emit>' +
    tag('CNPJ', zeros(e.cnpj, 14)) +
    tag('xNome', limpo(e.razao_social, 60)) +
    tag('xFant', limpo(e.fantasia || e.razao_social, 60)) +
    '<enderEmit>' +
    tag('xLgr', limpo(e.logradouro, 60)) +
    tag('nro', limpo(e.numero || 'S/N', 60)) +
    tag('xBairro', limpo(e.bairro || 'CENTRO', 60)) +
    tag('cMun', zeros(e.municipio_ibge, 7)) +
    tag('xMun', limpo(e.municipio, 60)) +
    tag('UF', limpo(e.uf, 2)) +
    tag('CEP', zeros(e.cep, 8)) +
    tag('cPais', '1058') +
    tag('xPais', 'BRASIL') +
    (e.telefone ? tag('fone', String(e.telefone).replace(/\D/g, '').slice(0, 14)) : '') +
    '</enderEmit>' +
    tag('IE', String(e.ie || '').replace(/\D/g, '')) +
    (e.cnae ? tag('CNAE', String(e.cnae).replace(/\D/g, '')) : '') +
    tag('CRT', String(e.crt || '1')) +
    '</emit>';

  /* ---------- destinatario (so quando o cliente pediu CPF na nota) ---------- */
  let dest = '';
  if (d.destinatario && d.destinatario.documento) {
    const doc = String(d.destinatario.documento).replace(/\D/g, '');
    dest =
      '<dest>' +
      (doc.length === 14 ? tag('CNPJ', doc) : tag('CPF', zeros(doc, 11))) +
      /* Em homologacao a razao social do destinatario e obrigatoriamente
         esta frase — regra da propria SEFAZ para nota de teste. */
      (ambiente === '2'
        ? tag('xNome', 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL')
        : (d.destinatario.nome ? tag('xNome', limpo(d.destinatario.nome, 60)) : '')) +
      tag('indIEDest', '9') +               // 9 = nao contribuinte
      (d.destinatario.email ? tag('email', limpo(d.destinatario.email, 60)) : '') +
      '</dest>';
  }

  /* ---------- itens ---------- */
  const det = d.itens.map((it, i) => {
    const q = Number(it.quantidade) || 0;
    const vun = Number(it.valor_unitario) || 0;
    const vprod = round2v(q * vun);

    const imposto =
      '<imposto>' +
      '<ICMS>' + blocoIcms(it, d.crt) + '</ICMS>' +
      grupoPisCofins('PIS', it.cst_pis || '49') +
      grupoPisCofins('COFINS', it.cst_cofins || '49') +
      '</imposto>';

    return `<det nItem="${i + 1}">` +
      '<prod>' +
      tag('cProd', limpo(it.codigo || (i + 1), 60)) +
      tag('cEAN', limpo(it.ean || 'SEM GTIN', 14)) +
      tag('xProd', limpo(
        /* Regra da SEFAZ para nota de TESTE: a descricao do PRIMEIRO item
           tem que ser exatamente esta frase, senao vem a rejeicao 373.
           Vale so em homologacao — em producao sai a descricao de verdade. */
        (ambiente === '2' && i === 0)
          ? FRASE_HOMOLOGACAO
          : it.descricao, 120)) +
      tag('NCM', zeros(it.ncm, 8)) +
      (it.cest ? tag('CEST', zeros(it.cest, 7)) : '') +
      tag('CFOP', zeros(it.cfop, 4)) +
      tag('uCom', limpo(it.unidade || 'UN', 6)) +
      tag('qCom', dec(q, 4)) +
      tag('vUnCom', dec(vun, 10)) +
      tag('vProd', dec(vprod, 2)) +
      tag('cEANTrib', limpo(it.ean || 'SEM GTIN', 14)) +
      tag('uTrib', limpo(it.unidade || 'UN', 6)) +
      tag('qTrib', dec(q, 4)) +
      tag('vUnTrib', dec(vun, 10)) +
      (Number(it.desconto) ? tag('vDesc', dec(it.desconto, 2)) : '') +
      tag('indTot', '1') +
      '</prod>' + imposto +
      '</det>';
  }).join('');

  /* ---------- totais ---------- */
  const vProd = round2v(d.itens.reduce(
    (s, it) => s + (Number(it.quantidade) || 0) * (Number(it.valor_unitario) || 0), 0));
  const vDesc = round2v(d.itens.reduce((s, it) => s + (Number(it.desconto) || 0), 0));
  /* Acrescimo entra como "outras despesas acessorias". Sem isto a soma
     dos pagamentos nao bate com o total da nota (rejeicao 610). */
  const vOutro = round2v(d.acrescimo || 0);
  const vNF = round2v(vProd - vDesc + vOutro);

  const total =
    '<total><ICMSTot>' +
    tag('vBC', '0.00') + tag('vICMS', '0.00') + tag('vICMSDeson', '0.00') +
    tag('vFCP', '0.00') + tag('vBCST', '0.00') + tag('vST', '0.00') +
    tag('vFCPST', '0.00') + tag('vFCPSTRet', '0.00') +
    tag('vProd', dec(vProd)) +
    tag('vFrete', '0.00') + tag('vSeg', '0.00') +
    tag('vDesc', dec(vDesc)) +
    tag('vII', '0.00') + tag('vIPI', '0.00') + tag('vIPIDevol', '0.00') +
    tag('vPIS', '0.00') + tag('vCOFINS', '0.00') + tag('vOutro', dec(vOutro)) +
    tag('vNF', dec(vNF)) +
    '</ICMSTot></total>';

  /* ---------- pagamentos ---------- */
  const pagamentos = (d.pagamentos && d.pagamentos.length)
    ? d.pagamentos
    : [{ forma: 'dinheiro', valor: vNF }];

  const pag =
    '<pag>' +
    pagamentos.map((p) => {
      const tPag = codigoPagamento(p.forma);
      /* [1.14] O grupo <card> (com tpIntegra) e obrigatorio nao so no cartao
         (03/04): a SEFAZ passou a exigi-lo tambem no PIX (17 dinamico e 20
         estatico). Sem ele, rejeicao 391 ("Nao informados os dados do cartao
         de credito/debito nas Formas de Pagamento"). tpIntegra = 2 significa
         que o recebimento (maquininha ou PIX) NAO e integrado ao sistema de
         emissao — e o caso da loja. */
      const grupoCard = ['03', '04', '17', '20'].includes(tPag);
      return '<detPag>' +
        tag('indPag', tPag === '05' ? '1' : '0') +   // 1 = a prazo
        tag('tPag', tPag) +
        tag('vPag', dec(p.valor)) +
        (grupoCard
          ? '<card>' + tag('tpIntegra', '2') +       // 2 = recebimento nao integrado ao sistema
            (p.cnpj_operadora ? tag('CNPJ', zeros(p.cnpj_operadora, 14)) : '') +
            (p.bandeira ? tag('tBand', zeros(p.bandeira, 2)) : '') +
            '</card>'
          : '') +
        '</detPag>';
    }).join('') +
    (Number(d.troco) > 0 ? tag('vTroco', dec(d.troco)) : '') +
    '</pag>';

  /* ---------- informacoes adicionais ---------- */
  const infoComplementar = limpo(d.informacao || '', 5000);
  const infAdic = infoComplementar
    ? '<infAdic>' + tag('infCpl', infoComplementar) + '</infAdic>'
    : '';

  /* ---------- responsavel tecnico ---------- */
  const respTec = d.responsavel_tecnico
    ? '<infRespTec>' +
      tag('CNPJ', zeros(d.responsavel_tecnico.cnpj, 14)) +
      tag('xContato', limpo(d.responsavel_tecnico.contato, 60)) +
      tag('email', limpo(d.responsavel_tecnico.email, 60)) +
      tag('fone', String(d.responsavel_tecnico.fone || '').replace(/\D/g, '').slice(0, 14)) +
      '</infRespTec>'
    : '';

  return `<infNFe versao="4.00" Id="NFe${d.chave}">` +
    ide + emit + dest + det + total +
    '<transp>' + tag('modFrete', '9') + '</transp>' +   // 9 = sem frete
    pag + infAdic + respTec +
    '</infNFe>';
}

const round2v = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Bloco de ICMS do item.
 *
 * No Simples Nacional (CRT 1 ou 2) usa-se CSOSN; no regime normal, CST.
 * Cada CSOSN tem o seu grupo, com campos proprios — nao da para mandar
 * so orig+CSOSN em todos, a SEFAZ rejeita os que exigem mais.
 */
function blocoIcms(it, crt) {
  const orig = tag('orig', String(it.origem || '0'));
  const simples = String(crt || '1') !== '3';

  if (!simples) {
    // regime normal: CST. 40/41/50/60 nao pedem base de calculo.
    const cst = String(it.cst || '40').padStart(2, '0');
    if (cst === '60') {
      return '<ICMS60>' + orig + tag('CST', cst) +
        tag('vBCSTRet', dec(it.vbc_st_retido || 0)) +
        tag('pST', dec(it.p_st || 0, 4)) +
        tag('vICMSSubstituto', dec(it.icms_substituto || 0)) +
        tag('vICMSSTRet', dec(it.icms_st_retido || 0)) +
        '</ICMS60>';
    }
    return '<ICMS40>' + orig + tag('CST', cst) + '</ICMS40>';
  }

  const csosn = String(it.csosn || '102');

  if (csosn === '101') {
    return '<ICMSSN101>' + orig + tag('CSOSN', csosn) +
      tag('pCredSN', dec(it.credito_simples_pct || 0, 4)) +
      tag('vCredICMSSN', dec(it.credito_simples_valor || 0)) +
      '</ICMSSN101>';
  }

  /* 500: mercadoria que ja pagou ICMS por substituicao tributaria antes de
     chegar na loja — no material de construcao e o caso do cimento. */
  if (csosn === '500') {
    return '<ICMSSN500>' + orig + tag('CSOSN', csosn) +
      tag('vBCSTRet', dec(it.vbc_st_retido || 0)) +
      tag('pST', dec(it.p_st || 0, 4)) +
      tag('vICMSSubstituto', dec(it.icms_substituto || 0)) +
      tag('vICMSSTRet', dec(it.icms_st_retido || 0)) +
      '</ICMSSN500>';
  }

  if (csosn === '900') {
    return '<ICMSSN900>' + orig + tag('CSOSN', csosn) +
      tag('modBC', '3') + tag('vBC', '0.00') + tag('pICMS', '0.0000') + tag('vICMS', '0.00') +
      tag('pCredSN', '0.0000') + tag('vCredICMSSN', '0.00') +
      '</ICMSSN900>';
  }

  // 102, 103, 300, 400 — nenhum credito, nenhum valor: so a origem e o codigo
  return '<ICMSSN102>' + orig + tag('CSOSN', csosn) + '</ICMSSN102>';
}

/**
 * PIS e COFINS mudam de grupo conforme o CST — e a SEFAZ rejeita se o CST
 * nao pertencer ao grupo usado (erro classico: CST 49 dentro de PISNT).
 *   01,02   -> PISAliq  (tem base e aliquota)
 *   03      -> PISQtde
 *   04..09  -> PISNT    (nao tributado: so o CST)
 *   demais  -> PISOutr  (o caso do Simples Nacional, CST 49)
 */
function grupoPisCofins(imposto, cst) {
  const c = String(cst).padStart(2, '0');
  const nt = ['04', '05', '06', '07', '08', '09'].includes(c);

  if (nt) {
    return `<${imposto}><${imposto}NT>` + tag('CST', c) + `</${imposto}NT></${imposto}>`;
  }
  if (['01', '02'].includes(c)) {
    return `<${imposto}><${imposto}Aliq>` + tag('CST', c) +
      tag('vBC', '0.00') + tag(imposto === 'PIS' ? 'pPIS' : 'pCOFINS', '0.0000') +
      tag(imposto === 'PIS' ? 'vPIS' : 'vCOFINS', '0.00') +
      `</${imposto}Aliq></${imposto}>`;
  }
  return `<${imposto}><${imposto}Outr>` + tag('CST', c) +
    tag('vBC', '0.00') + tag(imposto === 'PIS' ? 'pPIS' : 'pCOFINS', '0.0000') +
    tag(imposto === 'PIS' ? 'vPIS' : 'vCOFINS', '0.00') +
    `</${imposto}Outr></${imposto}>`;
}

/** O nome da tag muda conforme o CSOSN: ICMSSN101, ICMSSN102, ICMSSN500... */
function grupoCsosn(csosn) {
  const c = String(csosn);
  if (c === '101') return '101';
  if (['102', '103', '300', '400'].includes(c)) return '102';
  if (c === '201') return '201';
  if (['202', '203'].includes(c)) return '202';
  if (c === '500') return '500';
  if (c === '900') return '900';
  return '102';
}

/** Envelope <NFe> ja pronto para assinar. */
function montarNfe(dados) {
  return `<NFe xmlns="${NS_NFE}">` + montarInfNfe(dados) + '</NFe>';
}

/* =========================================================================
   5. ASSINATURA DIGITAL

   A SEFAZ exige: assinatura envelopada dentro de <NFe>, referenciando o
   Id do <infNFe>, com SHA-1 e canonicalizacao C14N (a inclusiva, nao a
   exclusiva). Mudar qualquer um destes tres da rejeicao 297.
   ========================================================================= */

function assinarXml(xml, idReferencia, cert) {
  const sig = new SignedXml({
    privateKey: cert.pemChave,
    publicCert: cert.pemCert,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    /* A SEFAZ quer o X509Certificate e nada mais dentro do KeyInfo. */
    getKeyInfoContent: () => `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data>`
  });

  sig.addReference({
    xpath: `//*[local-name(.)='infNFe']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    uri: '#' + idReferencia
  });

  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='infNFe']`, action: 'after' }
  });

  return sig.getSignedXml();
}

/**
 * Assinatura de evento (cancelamento, carta de correcao...).
 * Muda so o que e referenciado: infEvento no lugar de infNFe.
 */
function assinarEvento(xml, idEvento, cert) {
  const sig = new SignedXml({
    privateKey: cert.pemChave,
    publicCert: cert.pemCert,
    signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    getKeyInfoContent: () => `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate></X509Data>`
  });

  sig.addReference({
    xpath: `//*[local-name(.)='infEvento']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/TR/2001/REC-xml-c14n-20010315'
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
    uri: '#' + idEvento
  });

  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='infEvento']`, action: 'after' }
  });

  return sig.getSignedXml();
}

/** Le o DigestValue da assinatura — o QR Code offline precisa dele. */
function digestDoXml(xmlAssinado) {
  const m = String(xmlAssinado).match(/<DigestValue>([^<]*)<\/DigestValue>/);
  return m ? m[1] : '';
}

/* =========================================================================
   6. QR CODE

   Versao 2: leva o CSC e um hash SHA-1 que prova que a nota veio de quem diz.
   Versao 3: dispensa o CSC (NT 2025.001) — a assinatura da propria nota faz
   esse papel. Qual usar depende do que a SEFAZ do estado ja aceita, por isso
   as duas ficam disponiveis e a escolha e do usuario, na tela.
   ========================================================================= */

function qrCodeNfce(op) {
  const url = String(op.urlQrCode || '').replace(/\?.*$/, '');
  const versao = String(op.versao || '2');

  if (versao === '3') {
    /* [1.9.5] NT 2025.001: online e so chave|3|ambiente — sem CSC e sem
       hash (a SEFAZ rejeita com 445 se vier assinatura no modo online).
       Offline exige a assinatura digital dos parametros, que esta versao
       nao monta; a tela impede ligar contingencia com a versao 3. */
    if (op.offline) {
      throw new Error('Contingencia offline com QR Code versao 3 nao esta disponivel. Use a versao 2.');
    }
    return `${url}?p=${[op.chave, '3', String(op.ambiente)].join('|')}`;
  }

  /* versao 2 */
  /* [1.9.4] O ID do CSC vai como numero, sem zeros a esquerda ("000001" -> "1").
     Se o que esta gravado nao for numero (letra, hifen, o CSC colado no campo
     errado), o QR Code sairia com "NaN" e a SEFAZ derruba no schema (225).
     Melhor parar aqui, com recado claro, do que queimar uma tentativa. */
  const idNum = parseInt(String(op.cscId || '').replace(/\D/g, ''), 10);
  if (!(idNum >= 1)) {
    throw new Error('O ID do CSC precisa ser um numero (ex.: 1 ou 000001). ' +
      'Confira em Sistema > NFC-e > CSC se o ID e o codigo nao foram trocados de campo.');
  }
  /* [1.10.2] O CSC entra no hash EXATAMENTE como a SEFAZ o gerou — com os
     hifens. So espaco e descartado. (Ate a 1.10.1 os hifens eram tirados
     aqui, e o hash nunca batia: rejeicao 464.) */
  const csc = String(op.csc || '').replace(/\s/g, '');
  if (csc.length < 16) {
    throw new Error('O CSC gravado esta curto demais. Cadastre-o de novo em Sistema > NFC-e > CSC.');
  }
  const idCsc = String(idNum);
  const partes = op.offline
    ? [op.chave, '2', String(op.ambiente), op.diaEmissao, dec(op.valorTotal, 2),
       Buffer.from(op.digestValue || '', 'base64').toString('hex'), idCsc]
    : [op.chave, '2', String(op.ambiente), idCsc];

  const semHash = partes.join('|');
  /* Hash em MAIUSCULAS: e como esta no exemplo do manual da SEFAZ e como as
     bibliotecas de referencia (sped-nfe, ACBr) mandam. */
  const hash = crypto.createHash('sha1').update(semHash + csc, 'utf8').digest('hex').toUpperCase();
  return `${url}?p=${semHash}|${hash}`;
}

/** Endereco que o consumidor digita para consultar a nota pela chave. */
function urlConsultaChave(base, chave) {
  return `${String(base || '').replace(/\/$/, '')}?chNFe=${chave}`;
}

/**
 * [1.9.2] Poe o bloco <infNFeSupl> (QR Code + endereco de consulta) na
 * NFC-e JA ASSINADA. Na NFC-e esse bloco e obrigatorio — sem ele a SEFAZ
 * devolve a rejeicao 394 "Nota Fiscal sem a informacao do QR-Code".
 *
 * Ele fica FORA da assinatura: a assinatura cobre so o <infNFe>, e o
 * schema manda a ordem infNFe -> infNFeSupl -> Signature. Como o
 * assinador coloca a Signature logo depois de </infNFe>, inserir o bloco
 * ali deixa tudo na ordem certa sem invalidar nada.
 */
function inserirInfNfeSupl(xmlAssinado, qrcode, urlChave) {
  const xml = String(xmlAssinado || '');
  if (xml.includes('<infNFeSupl>')) return xml;      // ja tem
  if (!xml.includes('</infNFe>')) throw new Error('XML sem <infNFe>: nao da para inserir o QR Code.');
  /* Texto puro, sem CDATA — e assim que sped-nfe e ACBr mandam, e e o que
     a SEFAZ compara ao recalcular o QR Code. So se escapa o que o XML exige. */
  const escapar = (v) => String(v || '').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const supl =
    '<infNFeSupl>' +
    '<qrCode>' + escapar(qrcode) + '</qrCode>' +
    '<urlChave>' + escapar(String(urlChave || '').replace(/\?.*$/, '')) + '</urlChave>' +
    '</infNFeSupl>';
  return xml.replace('</infNFe>', '</infNFe>' + supl);
}

/* =========================================================================
   7. CONVERSA COM A SEFAZ

   O webservice exige autenticacao com o proprio certificado da loja
   (TLS mutuo). O Node aceita o .pfx direto, sem precisar converter nada.
   ========================================================================= */

function envelopeSoap(corpo, servico) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">' +
    '<soap12:Body>' +
    `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${servico}">` +
    corpo +
    '</nfeDadosMsg>' +
    '</soap12:Body></soap12:Envelope>';
}

/**
 * POST no webservice da SEFAZ com o certificado da loja.
 * Devolve o corpo da resposta em texto.
 */
function postarSefaz(url, corpoSoap, pfxBase64, senha, tempoLimite = 30000) {
  return new Promise((pronto, falhou) => {
    let alvo;
    try { alvo = new URL(url); } catch (e) {
      return falhou(new Error('Endereco da SEFAZ invalido: ' + url));
    }

    const dados = Buffer.from(corpoSoap, 'utf8');
    /* [1.9.1] Certificado em formato antigo (RC2/3DES, comum em A1 emitido ha
       alguns anos) o Node recusa AQUI, antes de conectar — e o erro vinha cru
       para a tela ("Unsupported PKCS12 PFX data"). Agora sai em portugues. */
    let req;
    try {
      req = https.request({
      host: alvo.hostname,
      port: alvo.port || 443,
      path: alvo.pathname + alvo.search,
      method: 'POST',
      pfx: Buffer.from(pfxBase64, 'base64'),
      passphrase: senha,
      /* A cadeia da ICP-Brasil nem sempre esta no Node. Recusar aqui
         derrubaria o caixa por um detalhe de raiz confiavel; a autenticidade
         de quem fala esta garantida pela assinatura da propria nota. */
      rejectUnauthorized: false,
      secureOptions: require('constants').SSL_OP_LEGACY_SERVER_CONNECT,
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': dados.length
      }
    }, (resp) => {
      let corpo = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { corpo += c; });
      resp.on('end', () => {
        if (resp.statusCode >= 400) {
          return falhou(new Error(
            `A SEFAZ respondeu com erro ${resp.statusCode}. ` +
            (corpo ? 'Detalhe: ' + limpo(corpo, 300) : '')));
        }
        pronto(corpo);
      });
    });
    } catch (e) {
      const m = String(e.message || '');
      if (/PKCS12|PFX|mac verify|wrong password/i.test(m)) {
        return falhou(new Error(
          'O certificado digital esta num formato que este computador nao abre ' +
          '(' + m + '). Peca a certificadora para exportar o .pfx de novo em formato ' +
          'atual (AES), ou reinstale o certificado e cadastre-o outra vez.'));
      }
      return falhou(new Error('Falha ao preparar a conexao com a SEFAZ: ' + m));
    }

    req.setTimeout(tempoLimite, () => {
      req.destroy();
      falhou(new Error('A SEFAZ nao respondeu a tempo. Verifique a internet da loja.'));
    });

    req.on('error', (e) => {
      const m = String(e.message || '');
      if (/ENOTFOUND|EAI_AGAIN/.test(m)) {
        return falhou(new Error('Nao consegui achar o endereco da SEFAZ. Confira a internet da loja.'));
      }
      if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(m)) {
        return falhou(new Error('A SEFAZ recusou a conexao ou esta fora do ar. Tente de novo em instantes.'));
      }
      if (/mac verify|PKCS12|wrong password/i.test(m)) {
        return falhou(new Error('Nao consegui abrir o certificado para falar com a SEFAZ. Cadastre-o de novo.'));
      }
      falhou(new Error('Falha ao falar com a SEFAZ: ' + m));
    });

    req.write(dados);
    req.end();
  });
}

/** Pega o CONTEUDO de uma tag da resposta, ignorando prefixo de namespace. */
function extrair(xml, nome) {
  const m = String(xml || '').match(
    new RegExp(`<(?:\\w+:)?${nome}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${nome}>`));
  return m ? m[1].trim() : '';
}

/**
 * Pega o BLOCO INTEIRO, com as tags de abertura e fechamento.
 * O <protNFe> tem que ir para dentro do nfeProc do jeito que veio — sem as
 * tags, o arquivo nao vale como documento fiscal.
 */
function extrairBloco(xml, nome) {
  const m = String(xml || '').match(
    new RegExp(`<(?:\\w+:)?${nome}[^>]*>[\\s\\S]*?</(?:\\w+:)?${nome}>`));
  return m ? m[0] : '';
}

module.exports = {
  abrirCertificado,
  cnpjDoTitular,
  nomeDoTitular,
  cifrar,
  decifrar,
  UF_CODIGO,
  dvChave,
  montarChave,
  gerarCodigoNumerico,
  gtinValido,
  zeros,
  limpo,
  dec,
  dataXml,
  codigoPagamento,
  grupoCsosn,
  grupoPisCofins,
  blocoIcms,
  montarInfNfe,
  montarNfe,
  assinarXml,
  assinarEvento,
  digestDoXml,
  qrCodeNfce,
  urlConsultaChave,
  inserirInfNfeSupl,
  envelopeSoap,
  postarSefaz,
  extrair,
  extrairBloco,
  FRASE_HOMOLOGACAO,
  NS_NFE
};
