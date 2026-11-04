/* --------------------------------------------------------------------------
   TELA DE NFC-e E CERTIFICADO DIGITAL

   Aqui mora o cadastro do certificado A1, os dados fiscais da loja, o CSC
   e a lista de notas emitidas.
   -------------------------------------------------------------------------- */

/* Campos de configuracao que esta tela grava. Ficam separados dos de
   CAMPOS_CFG (tela de Configuracoes) so para nao misturar as duas telas. */
const CAMPOS_FISCAL = [
  'nfce_modo',
  'nfce_ativo', 'nfce_ambiente', 'nfce_serie', 'nfce_proximo_numero',
  'nfce_csc_id_homologacao', 'nfce_csc_id_producao',
  'nfce_qrcode_versao', 'nfce_crt', 'nfce_municipio_ibge',
  'nfce_cnae', 'nfce_ncm_padrao', 'nfce_cfop_padrao', 'nfce_origem_padrao',
  'nfce_csosn_padrao', 'nfce_emitir_automatico',
  'nfce_ws_producao', 'nfce_ws_homologacao',
  'nfce_ws_status_producao', 'nfce_ws_status_homologacao',
  'nfce_ws_evento_producao', 'nfce_ws_evento_homologacao',
  'nfce_ws_inutilizacao_producao', 'nfce_ws_inutilizacao_homologacao',
  'nfce_url_qrcode_producao', 'nfce_url_qrcode_homologacao',
  'nfce_url_consulta_producao', 'nfce_url_consulta_homologacao'
];

let CERT = { cadastrado: false };

async function carregarFiscalTela() {
  await carregarConfig();
  CAMPOS_FISCAL.forEach((c) => setVal('cfg_' + c, CONFIG[c] || ''));
  // a IE aparece nas duas telas; e o mesmo campo do banco
  setVal('cfg_loja_ie2', CONFIG.loja_ie || '');
  mostrarDicaCsc();
  aplicarModoNaTela();

  await carregarCertificado();
  await carregarNotas();
  montarChecklist();
  prepararBalancoNotas();
}

const modoFocusNaTela = () => (el('cfg_nfce_modo') ? el('cfg_nfce_modo').value : CONFIG.nfce_modo) === 'focus';

/** Mostra/esconde o que cada caminho usa. */
function aplicarModoNaTela() {
  const focus = modoFocusNaTela();
  ['avisoModoFocusCert', 'avisoModoFocusCsc', 'avisoModoFocusWs'].forEach((id) => {
    if (el(id)) el(id).style.display = focus ? '' : 'none';
  });
  if (el('cardFocus')) el('cardFocus').style.display = focus ? '' : 'none';
  if (el('btnTestarSefaz')) el('btnTestarSefaz').textContent = focus ? '📡 Testar Focus' : '📡 Testar SEFAZ';
  if (el('modoExplicacao')) {
    el('modoExplicacao').innerHTML = focus
      ? 'A venda vai em JSON para a API da Focus; ela monta o XML, assina com o certificado que ' +
        'está no painel dela, transmite à SEFAZ e devolve chave, número e QR Code. Certificado, ' +
        'CSC e endereços da SEFAZ <strong>não</strong> são usados daqui. Custo: mensalidade da Focus.'
      : 'O sistema monta e assina o XML com o certificado cadastrado aqui e fala direto com a SEFAZ ' +
        '(SVRS). Sem custo por nota. Precisa de certificado, CSC e endereços certos.';
  }
  [['Homologacao', 'homologacao'], ['Producao', 'producao']].forEach(([sufixoEl, sufixoCfg]) => {
    const d = el('focusDica' + sufixoEl);
    if (!d) return;
    d.textContent = Number(CONFIG['focus_token_' + sufixoCfg + '_preenchido'])
      ? 'Já existe um token guardado. Deixe em branco para manter.'
      : 'Ainda não há token cadastrado para este ambiente.';
  });
  montarChecklist();
}

function mostrarDicaCsc() {
  [['Homologacao', 'homologacao'], ['Producao', 'producao']].forEach(([sufixoEl, sufixoCfg]) => {
    const alvo = el('cscDica' + sufixoEl);
    if (!alvo) return;
    if (!Number(CONFIG['nfce_csc_' + sufixoCfg + '_preenchido'])) {
      alvo.textContent = 'Ainda não há CSC cadastrado para este ambiente. Digite exatamente como o portal da SEFAZ mostra, com os hífens.';
      alvo.classList.remove('alerta');
      return;
    }
    /* [1.10.2] o código não sai do servidor; só o formato, para conferir com o
       portal (o da SEFAZ-BA tem 36 caracteres, com 4 hífens) */
    const tam = Number(CONFIG['nfce_csc_' + sufixoCfg + '_tamanho'] || 0);
    const hifens = Number(CONFIG['nfce_csc_' + sufixoCfg + '_hifens'] || 0);
    const formato = tam ? ` (${tam} caracteres, ${hifens ? 'com hífens' : 'sem hífen'})` : '';
    alvo.textContent = `Já existe um CSC guardado${formato}. Deixe em branco para manter o que está lá.`;
    alvo.classList.toggle('alerta', tam > 0 && !hifens && tam < 36);
  });
  /* [1.12] o ID e um campo separado — e o mais esquecido. Sem ele o par nao serve. */
  [['Homologacao', 'homologacao'], ['Producao', 'producao']].forEach(([sufixoEl, sufixoCfg]) => {
    const alvo = el('cscIdDica' + sufixoEl);
    if (!alvo) return;
    const temId = !!String(CONFIG['nfce_csc_id_' + sufixoCfg] || '').trim();
    const temCsc = !!Number(CONFIG['nfce_csc_' + sufixoCfg + '_preenchido']);
    alvo.textContent = temId ? 'ID gravado.' : (temCsc ? 'FALTA O ID: o portal mostra o "Identificador do CSC" junto com o código.' : 'Vem do portal da SEFAZ, junto com o código.');
    alvo.classList.toggle('alerta', !temId && temCsc);
  });
}

/** Par de CSC do ambiente escolhido na tela (ou o gravado). */
function cscDoAmbienteNaTela(d) {
  const amb = (d && d.nfce_ambiente) || CONFIG.nfce_ambiente;
  const sufixo = amb === '1' ? 'producao' : 'homologacao';
  return {
    nome: amb === '1' ? 'produção' : 'homologação',
    sufixo,
    id: String((d && d['nfce_csc_id_' + sufixo]) || CONFIG['nfce_csc_id_' + sufixo] || '').trim(),
    guardado: !!Number(CONFIG['nfce_csc_' + sufixo + '_preenchido']),
    digitado: el('cfg_nfce_csc_' + sufixo) ? el('cfg_nfce_csc_' + sufixo).value.trim() : ''
  };
}

/* ---------------- certificado ---------------- */

async function carregarCertificado() {
  try {
    CERT = await api('/api/certificado');
  } catch (e) {
    CERT = { cadastrado: false };
  }
  desenharCertificado();
  avisarCertificadoNoMenu();
}

function desenharCertificado() {
  const c = CERT;
  const alvo = el('certStatus');
  if (!alvo) return;

  if (!c.cadastrado) {
    alvo.innerHTML = `<div class="aviso alerta"><span>📄</span>
      <div>Nenhum certificado cadastrado. Sem ele o sistema não consegue
      assinar nenhuma NFC-e.</div></div>`;
    el('certForm').style.display = '';
    return;
  }

  const ate = new Date(c.valido_ate).toLocaleDateString('pt-BR');
  const de = new Date(c.valido_de).toLocaleDateString('pt-BR');

  let cor = 'ok';
  let icone = '✅';
  let recado = `Válido até <strong>${ate}</strong> — faltam ${c.dias_restantes} dias.`;
  if (c.vencido) {
    cor = 'erro'; icone = '⛔';
    recado = `<strong>Venceu em ${ate}.</strong> Renove com a certificadora: nenhuma nota vai ser autorizada.`;
  } else if (c.vence_em_breve) {
    cor = 'alerta'; icone = '⚠️';
    recado = `<strong>Vence em ${c.dias_restantes} dia(s)</strong>, em ${ate}. Providencie a renovação.`;
  }

  const aviso = c.confere_com_a_loja ? '' :
    `<div class="aviso erro" style="margin-top:10px"><span>⛔</span>
      <div>O CNPJ do certificado (${esc(c.cnpj)}) é diferente do CNPJ da loja.
      A SEFAZ vai rejeitar as notas.</div></div>`;

  alvo.innerHTML = `
    <div class="aviso ${cor}"><span>${icone}</span><div>${recado}</div></div>
    <div class="tabela-wrap" style="margin-top:10px">
      <table>
        <tr><th style="width:190px">Titular</th><td>${esc(c.titular || '-')}</td></tr>
        <tr><th>CNPJ</th><td>${docFmt(c.cnpj) || "-"}</td></tr>
        <tr><th>Emitido por</th><td>${esc(c.emissor || '-')}</td></tr>
        <tr><th>Validade</th><td>${de} até ${ate}</td></tr>
        <tr><th>Arquivo</th><td>${esc(c.nome_arquivo || '-')}</td></tr>
        <tr><th>Cadastrado por</th><td>${esc(c.enviado_por || '-')} em ${
          c.enviado_em ? new Date(c.enviado_em).toLocaleString('pt-BR') : '-'}</td></tr>
      </table>
    </div>
    <div style="margin-top:11px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn pequeno" onclick="testarCertificado()">🧪 Testar assinatura</button>
      <button class="btn pequeno" onclick="el('certForm').style.display=''">🔄 Trocar certificado</button>
      <button class="btn pequeno perigo" onclick="removerCertificado()">🗑️ Remover</button>
    </div>${aviso}`;

  el('certForm').style.display = 'none';
}

/** Marca o menu quando o certificado está vencido ou perto de vencer. */
function avisarCertificadoNoMenu() {
  const b = el('badgeCert');
  if (!b) return;
  if (CERT.cadastrado && (CERT.vencido || CERT.vence_em_breve)) {
    b.textContent = CERT.vencido ? 'vencido' : `${CERT.dias_restantes}d`;
    b.style.display = '';
  } else {
    b.style.display = 'none';
  }
}

async function enviarCertificado() {
  const inp = el('certArquivo');
  const arq = inp.files && inp.files[0];
  const senha = el('certSenha').value;

  if (!arq) return alerta('Escolha o arquivo .pfx do certificado.');
  if (!senha) return alerta('Digite a senha do certificado.');

  let base64;
  try {
    base64 = await new Promise((pronto, falhou) => {
      const r = new FileReader();
      r.onload = () => pronto(String(r.result).split(',')[1]);
      r.onerror = () => falhou(new Error('Não consegui ler o arquivo.'));
      r.readAsDataURL(arq);
    });
  } catch (e) {
    return erro(e.message);
  }

  try {
    await api('/api/certificado', {
      method: 'POST',
      body: { arquivo: base64, senha, nome_arquivo: arq.name }
    });
    el('certSenha').value = '';
    inp.value = '';
    ok('Certificado cadastrado.');
    await carregarCertificado();
    montarChecklist();
  } catch (e) {
    erro(e.message);
  }
}

async function testarCertificado() {
  try {
    const r = await api('/api/certificado/testar', { method: 'POST', body: {} });
    ok(r.mensagem);
  } catch (e) {
    erro(e.message);
  }
}

async function removerCertificado() {
  if (!confirm('Remover o certificado?\n\nA emissão de NFC-e será desligada.')) return;
  await api('/api/certificado', { method: 'DELETE' });
  ok('Certificado removido.');
  await carregarCertificado();
  await carregarConfig();
  setVal('cfg_nfce_ativo', CONFIG.nfce_ativo || '0');
  montarChecklist();
}

/* ---------------- dados fiscais ---------------- */

async function salvarFiscal() {
  const dados = {};
  CAMPOS_FISCAL.forEach((c) => { dados[c] = val('cfg_' + c); });
  dados.loja_ie = val('cfg_loja_ie2');
  // o CSC so vai se foi digitado — em branco significa "mantenha o atual"
  ['homologacao', 'producao'].forEach((amb) => {
    const c = el('cfg_nfce_csc_' + amb) ? el('cfg_nfce_csc_' + amb).value.trim() : '';
    if (c) dados['nfce_csc_' + amb] = c;
    const t = el('cfg_focus_token_' + amb) ? el('cfg_focus_token_' + amb).value.trim() : '';
    if (t) dados['focus_token_' + amb] = t;
  });

  const problema = validarFiscal(dados);
  if (problema) return alerta(problema);

  try {
    await api('/api/config', { method: 'POST', body: dados });
  } catch (e) {
    return erro(e.message);
  }
  ['homologacao', 'producao'].forEach((amb) => {
    if (el('cfg_nfce_csc_' + amb)) el('cfg_nfce_csc_' + amb).value = '';
    if (el('cfg_focus_token_' + amb)) el('cfg_focus_token_' + amb).value = '';
  });
  ok('Dados fiscais salvos.');
  await carregarConfig();
  mostrarDicaCsc();
  montarChecklist();
}

/** Barra o que a SEFAZ certamente rejeitaria, antes de ligar a emissão. */
function validarFiscal(d) {
  /* formato dos dois pares, mesmo com a emissao desligada — gravar errado e
     o que derruba a nota depois */
  for (const amb of ['homologacao', 'producao']) {
    const id = String(d['nfce_csc_id_' + amb] || '').trim();
    const csc = String(d['nfce_csc_' + amb] || '').trim();
    if (id && (!/^\d{1,6}$/.test(id) || !(parseInt(id, 10) >= 1))) {
      return `O ID do CSC de ${amb} é um número curto (ex.: 000001). "${id}" não é um ID — ` +
             'o código longo vai no campo CSC, ao lado.';
    }
    if (csc && (csc.replace(/\s/g, '').length < 16 || /^\d{1,6}$/.test(csc))) {
      return `O CSC de ${amb} é o código longo (uns 32 a 36 caracteres). O que foi digitado parece o ID.`;
    }
    // [1.12] CSC digitado sem o ID: o par fica pela metade e a nota cai (462)
    if (csc && !id) {
      return `Você digitou o CSC de ${amb}, mas o campo ID do CSC (à esquerda) está vazio. ` +
             'O portal da SEFAZ mostra o "Identificador do CSC" junto com o código — normalmente é 1.';
    }
  }

  if (d.nfce_ativo !== '1') return null;   // desligado, pode salvar do jeito que estiver

  if (d.nfce_modo === 'focus') {
    const amb = d.nfce_ambiente === '1' ? 'producao' : 'homologacao';
    const nome = d.nfce_ambiente === '1' ? 'produção' : 'homologação';
    const guardado = !!Number(CONFIG['focus_token_' + amb + '_preenchido']);
    const digitado = !!(d['focus_token_' + amb]);
    if (!guardado && !digitado) {
      return `O ambiente escolhido é ${nome}, e falta o token de ${nome} da Focus NFe.`;
    }
    return null;
  }

  if (!CERT.cadastrado) return 'Cadastre o certificado digital antes de ligar a emissão.';
  if (CERT.vencido) return 'O certificado está vencido. Renove antes de ligar a emissão.';
  if (!String(d.loja_ie || '').replace(/\D/g, '')) return 'Preencha a inscrição estadual da loja.';
  if (!String(d.nfce_municipio_ibge || '').trim()) return 'Preencha o código IBGE do município.';
  if (d.nfce_qrcode_versao === '2') {
    const par = cscDoAmbienteNaTela(d);
    if (!par.guardado && !par.digitado) {
      return `O ambiente escolhido é ${par.nome}, e falta o CSC de ${par.nome} (ID e código). ` +
             'Gere no portal da SEFAZ-BA e cadastre na coluna certa.';
    }
    if (!par.id) {
      return `O CSC de ${par.nome} está gravado, mas falta o ID do CSC de ${par.nome} (o campo pequeno, à esquerda do código). ` +
             'É o "Identificador do CSC" que o portal da SEFAZ mostra — normalmente 1.';
    }
  }
  return null;
}

/** Lista do que falta para conseguir emitir. É o guia da tela. */
function montarChecklist() {
  const alvo = el('fiscalChecklist');
  if (!alvo) return;

  const ie = String(CONFIG.loja_ie || '').replace(/\D/g, '');
  const focus = modoFocusNaTela();
  const ambCfg = (el('cfg_nfce_ambiente') ? el('cfg_nfce_ambiente').value : CONFIG.nfce_ambiente) === '1' ? 'producao' : 'homologacao';
  const itens = focus ? [
    { ok: !!Number(CONFIG['focus_token_' + ambCfg + '_preenchido']),
      txt: `Token de ${ambCfg === 'producao' ? 'produção' : 'homologação'} da Focus NFe cadastrado` },
    { ok: true, txt: 'No painel da Focus: empresa cadastrada com certificado A1 e CSC (confira lá)' },
    { ok: CONFIG.nfce_ativo === '1', txt: 'Emissão de NFC-e ligada' }
  ] : [
    { ok: CERT.cadastrado && !CERT.vencido, txt: 'Certificado digital A1 cadastrado e dentro da validade' },
    { ok: !!ie, txt: 'Inscrição estadual preenchida' },
    { ok: !!String(CONFIG.nfce_municipio_ibge || '').trim(), txt: 'Código IBGE do município' },
    { ok: CONFIG.nfce_qrcode_versao === '3' ||
          (cscDoAmbienteNaTela().guardado && !!cscDoAmbienteNaTela().id),
      txt: `CSC e ID do CSC de ${cscDoAmbienteNaTela().nome} (gerados no portal da SEFAZ-BA)` },
    { ok: CONFIG.nfce_ativo === '1', txt: 'Emissão de NFC-e ligada' }
  ];

  const faltam = itens.filter((i) => !i.ok).length;
  const linhas = itens.map((i) =>
    `<div style="display:flex;gap:9px;align-items:flex-start;padding:3px 0">
       <span>${i.ok ? '✅' : '⬜'}</span>
       <span style="${i.ok ? 'color:var(--texto-fraco)' : 'font-weight:600'}">${i.txt}</span>
     </div>`).join('');

  setTimeout(avisoNcmNoChecklist, 0);
  const ambiente = CONFIG.nfce_ambiente === '1' ? 'PRODUÇÃO' : 'homologação (teste)';
  const caminho = focus ? 'pela Focus NFe' : 'direto na SEFAZ';
  const cabecalho = faltam
    ? `<strong>Faltam ${faltam} item(ns) para emitir NFC-e ${caminho}.</strong>`
    : `<strong>Tudo pronto.</strong> Ambiente: <strong>${ambiente}</strong>, ${caminho}.`;

  alvo.innerHTML = `<div class="card" style="border-left:4px solid ${faltam ? 'var(--laranja)' : 'var(--verde)'}">
      <h3>${faltam ? '📋' : '✅'} Passo a passo</h3>
      <div style="font-size:13.5px;margin-bottom:9px">${cabecalho}</div>
      ${linhas}
      <div id="checklistNcm"></div>
      <div class="aviso info" style="margin-top:11px"><span>ℹ️</span>
        <div>Enquanto a emissão estiver desligada, o sistema segue imprimindo o
        <strong>cupom interno</strong> normalmente — nada de venda para.</div>
      </div>
    </div>`;
}

/* ---------------- SEFAZ ---------------- */

async function testarStatusSefaz() {
  toast('📡 Consultando a SEFAZ…', 'ok', 2500);
  try {
    const r = await api('/api/nfce/status-servico');
    if (r.ok) ok(`${modoFocusNaTela() ? 'Focus NFe' : 'SEFAZ'} no ar — ${esc(r.motivo || 'serviço em operação')}`);
    else alerta(r.motivo || 'A SEFAZ respondeu, mas o serviço não está disponível.');
  } catch (e) {
    erro(e.message);
  }
}

/* ---------------- notas emitidas ---------------- */

async function carregarNotas() {
  const alvo = el('notasLista');
  if (!alvo) return;
  let lista = [];
  try { lista = await api('/api/nfce?limite=50'); } catch (e) { lista = []; }

  if (!lista.length) {
    alvo.innerHTML = '<div class="vazio"><span class="ic">🧾</span>Nenhuma NFC-e emitida ainda.</div>';
    return;
  }

  const cores = {
    autorizada: 'verde', rejeitada: 'vermelha', cancelada: 'cinza',
    pendente: 'amarela', erro: 'vermelha', contingencia: 'azul'
  };

  alvo.innerHTML = `<table>
    <thead><tr>
      <th>Número</th><th>Data</th><th>Venda</th><th>Chave de acesso</th>
      <th>Situação</th><th>Protocolo</th><th></th>
    </tr></thead>
    <tbody>${lista.map((n) => `
      <tr>
        <td>${n.numero ? `${n.serie}/${n.numero}` : '—'}${n.modo === 'focus' ? ' <span class="pill azul" title="transmitida pela Focus NFe">focus</span>' : ''}</td>
        <td>${n.criado_em ? new Date(n.criado_em).toLocaleString('pt-BR') : '-'}</td>
        <td>${n.venda_id ? '#' + n.venda_id : '-'}</td>
        <td style="font-family:monospace;font-size:11px">${esc(n.chave || '-')}</td>
        <td><span class="pill ${cores[n.situacao] || 'cinza'}">${esc(n.situacao)}</span>
            ${n.motivo ? `<div class="dica">${esc(n.motivo)}</div>` : ''}</td>
        <td>${esc(n.protocolo || '-')}</td>
        <td style="white-space:nowrap">
          ${n.situacao === 'autorizada'
            ? `<button class="btn pequeno" onclick="baixarXmlNota(${n.id})">📄 XML</button>
               <button class="btn pequeno perigo" onclick="cancelarNota(${n.id})">✖ Cancelar</button>`
            : ''}
          ${n.situacao === 'rejeitada' || n.situacao === 'erro' || n.situacao === 'pendente'
            ? `<button class="btn pequeno verde" onclick="reenviarNota(${n.id}, ${n.venda_id || 0})">🔁 Reenviar</button>
               <button class="btn pequeno" onclick="baixarXmlNota(${n.id})" title="O XML exatamente como foi enviado">📄 XML</button>
               <button class="btn pequeno" onclick="verMotivoNota(${n.id})">🔍 Detalhe</button>` : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

function baixarXmlNota(id) {
  window.open(`/api/nfce/${id}/xml?token=${TOKEN}`, '_blank');
}

/**
 * [1.9.3] Reenvia a NFC-e de uma venda que foi rejeitada ou deu erro.
 * A tela do PDV sempre disse "reenvie em Sistema -> NFC-e", mas o botao
 * nao existia. Rejeicao nao gasta numero: o reenvio usa o mesmo.
 */
async function reenviarNota(id, vendaId) {
  if (!vendaId) return alerta('Esta nota nao esta ligada a nenhuma venda.');
  if (!confirm('Reenviar a NFC-e desta venda para a SEFAZ agora?')) return;
  const botoes = document.querySelectorAll('#notasLista button');
  botoes.forEach((b) => { b.disabled = true; });
  try {
    const r = await api('/api/nfce/emitir', { method: 'POST', body: { venda_id: vendaId } });
    ok(`NFC-e ${r.serie}/${r.numero} autorizada. Protocolo ${r.protocolo}.`);
  } catch (e) {
    erro(e.message);
  }
  carregarNotas();
}

async function verMotivoNota(id) {
  const n = await api('/api/nfce/' + id);
  alert(`NFC-e ${n.serie}/${n.numero}\n\nStatus ${n.status || '-'}\n\n${
    n.motivo || 'Sem detalhe registrado.'}`);
}

async function cancelarNota(id) {
  const motivo = prompt('Motivo do cancelamento (mínimo 15 letras, exigência da SEFAZ):', '');
  if (motivo === null) return;
  if (String(motivo).trim().length < 15) {
    return alerta('A SEFAZ exige pelo menos 15 letras na justificativa.');
  }
  try {
    const r = await api(`/api/nfce/${id}/cancelar`, {
      method: 'POST', body: { justificativa: motivo }
    });
    ok(r.mensagem || 'Cancelamento enviado.');
    carregarNotas();
  } catch (e) {
    erro(e.message);
  }
}

/* ==========================================================================
   [1.11] NOTAS DO MÊS: compras com nota × cartão × NFC-e emitidas
   O mínimo a emitir é o que passou no cartão (a operadora informa tudo à
   SEFAZ) mais uma folga. Aparece na tela de NFC-e e, uma vez por semana,
   num aviso ao abrir o sistema.
   ========================================================================== */

const CAMPOS_AVISO = ['aviso_notas_ativo', 'aviso_notas_margem', 'aviso_notas_incluir_pix', 'aviso_notas_dia'];

function prepararBalancoNotas() {
  const sel = el('balMes');
  if (!sel) return;
  if (!sel.options.length) {
    const h = new Date();
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    for (let i = 0; i < 12; i++) {
      const d = new Date(h.getFullYear(), h.getMonth() - i, 1);
      const o = document.createElement('option');
      o.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      o.textContent = `${nomes[d.getMonth()]} de ${d.getFullYear()}`;
      sel.appendChild(o);
    }
  }
  CAMPOS_AVISO.forEach((c) => setVal('cfg_' + c, CONFIG[c] === undefined ? '' : CONFIG[c]));
  if (!val('cfg_aviso_notas_margem')) setVal('cfg_aviso_notas_margem', '3');
  carregarBalancoNotas();
}

async function carregarBalancoNotas() {
  const alvo = el('balancoNotas');
  if (!alvo) return;
  try {
    const b = await api('/api/fiscal/balanco?mes=' + encodeURIComponent(val('balMes')));
    alvo.innerHTML = htmlBalanco(b, false);
  } catch (e) {
    alvo.innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`;
  }
}

const pct = (v) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** O mesmo quadro serve para a tela e para o aviso. */
function htmlBalanco(b, resumido) {
  const falta = b.falta > 0;
  const semMinimo = b.minimo <= 0;
  const alerta1 = !b.nfce_ativa || !b.ambiente_producao
    ? `<div class="aviso alerta"><span>⚠️</span><div>${!b.nfce_ativa
        ? 'A emissão de NFC-e está <strong>desligada</strong>.'
        : 'A NFC-e está em <strong>homologação</strong> (teste).'} Só nota de <strong>produção</strong> conta aqui —
        até lá, o valor "emitido" fica em zero.</div></div>`
    : '';

  const conclusao = semMinimo
    ? `<div class="aviso info"><span>ℹ️</span><div>Nada passou no cartão em ${esc(b.nome_mes)} — não há mínimo a cobrir.</div></div>`
    : falta
      ? `<div class="aviso erro"><span>🚨</span><div><strong>Falta emitir pelo menos ${R$(b.falta)} de nota de venda</strong>
          ${b.mes_atual ? `até o fim do mês (${b.dias_restantes} dia(s): uns ${R$(b.media_dia)} por dia).` : `— o mês fechou abaixo do mínimo.`}
          Mínimo = cartão ${R$(b.cartao.total + (b.pix_conta ? b.pix : 0))} + ${pct(b.margem)}% de folga = <strong>${R$(b.minimo)}</strong>;
          emitido ${R$(b.notas.autorizadas)}.
          ${b.vendas_sem_nota.qtd ? `<br>Há <strong>${b.vendas_sem_nota.qtd} venda(s) sem NFC-e</strong> no mês, somando ${R$(b.vendas_sem_nota.total)} —
          dá para emitir pela tela de Vendas / Cupons.` : ''}
          ${b.vendas_sem_nota.cartao_qtd ? `<br>🚨 <strong>${b.vendas_sem_nota.cartao_qtd} venda(s) no CARTÃO sem nota</strong> (${R$(b.vendas_sem_nota.cartao_total)}):
          a operadora já informou essas vendas à SEFAZ — emita hoje.` : ''}</div></div>`
      : `<div class="aviso ok"><span>✅</span><div><strong>Mínimo coberto.</strong> Emitido ${R$(b.notas.autorizadas)} em NFC-e
          contra um mínimo de ${R$(b.minimo)} (cartão + ${pct(b.margem)}%).
          ${b.vendas_sem_nota.cartao_qtd ? `<br>🚨 Mesmo assim: <strong>${b.vendas_sem_nota.cartao_qtd} venda(s) no CARTÃO sem nota</strong> (${R$(b.vendas_sem_nota.cartao_total)}) — emita hoje.` : ''}</div></div>`;

  const tiles = `
    <div class="grid g4" style="margin-bottom:10px">
      ${tile('Compras com nota', R$(b.compras.total), `${b.compras.qtd} NF-e de entrada em ${esc(b.nome_mes)}`, '')}
      ${tile('Passou no cartão', R$(b.cartao.total), `débito ${R$(b.cartao.debito)} · crédito ${R$(b.cartao.credito)}`
        + (b.cartao.crediario ? ` · crediário no cartão ${R$(b.cartao.crediario)}` : ''), 'laranja')}
      ${tile('Mínimo de nota a emitir', R$(b.minimo), `cartão${b.pix_conta ? ' + PIX' : ''} + ${pct(b.margem)}% de folga`, '')}
      ${tile('NFC-e emitidas', R$(b.notas.autorizadas), `${b.notas.autorizadas_qtd} autorizada(s)`
        + (b.notas.canceladas_qtd ? ` · ${b.notas.canceladas_qtd} cancelada(s)` : ''), falta ? 'vermelho' : 'verde')}
    </div>`;

  const detalhe = resumido ? '' : `
    <div style="font-size:12.5px;color:var(--texto-fraco);margin-top:8px">
      Vendas do mês (todas as formas): ${R$(b.vendas_total)} — dinheiro ${R$(b.outras_formas.dinheiro)},
      PIX ${R$(b.pix)}${b.pix_conta ? ' (contando no mínimo)' : ''}, crediário ${R$(b.outras_formas.crediario)}.
      Vendas ainda sem NFC-e: ${b.vendas_sem_nota.qtd} (${R$(b.vendas_sem_nota.total)}).
      Compras: pela data de emissão da NF-e. Notas: só produção, pela data de autorização.
    </div>`;

  return alerta1 + tiles + conclusao + detalhe;
}

async function salvarAvisoNotas() {
  const body = {};
  CAMPOS_AVISO.forEach((c) => { body[c] = val('cfg_' + c); });
  const m = valor(body.aviso_notas_margem);
  if (m < 0 || m > 100) return erro('A folga é uma porcentagem entre 0 e 100.');
  body.aviso_notas_margem = String(m);
  try {
    await api('/api/config', { method: 'POST', body });
    await carregarConfig();
    ok('Regra do aviso salva.');
    carregarBalancoNotas();
  } catch (e) { erro(e.message); }
}

/* ---------------- aviso semanal (popup) ---------------- */

let AVISO_SEMANAL = null;

async function verificarAvisoSemanal() {
  if (!podeVer('fiscal')) return;
  try {
    AVISO_SEMANAL = await api('/api/fiscal/aviso-semanal');
  } catch (e) { return; }
  const a = AVISO_SEMANAL;
  if (!a || !a.mostrar) return;

  const b = a.balanco;
  const pacote = a.pacote_pendente
    ? `<div class="aviso info" style="margin-top:8px"><span>📦</span><div>
        <strong>${esc(a.pacote_pendente.nome_mes)} fechou</strong> e o pacote com os XMLs para a contabilidade
        ainda não foi gerado (${a.pacote_pendente.notas} nota(s)).
        <button class="btn pequeno primario" style="margin-left:6px" onclick="fecharAvisoNotas(); irPara('entradaNota'); setTimeout(() => escolherMesDoPacote('${esc(a.pacote_pendente.mes)}'), 600)">
          Gerar pacote de ${esc(a.pacote_pendente.nome_mes)}</button></div></div>`
    : '';

  el('avisoNotasCorpo').innerHTML = `
    <div style="font-size:13px;color:var(--texto-fraco);margin-bottom:8px">
      ${esc(b.nome_mes)}${b.mes_atual ? ' — até hoje' : ''}. Este aviso aparece uma vez por semana para quem cuida das notas.
    </div>
    ${htmlBalanco(b, true)}
    ${pacote}`;
  abrirModal('modalAvisoNotas');
}

async function fecharAvisoNotas() {
  fecharModal('modalAvisoNotas');
  try { await api('/api/fiscal/aviso-semanal/visto', { method: 'POST', body: {} }); } catch (e) { /* mostra de novo na proxima */ }
}


/* [1.12] NCM dos produtos no passo a passo: nao trava a emissao, mas e o que
   a fiscalizacao olha. So quem pode mexer em produtos ve o link. */
let NCM_RESUMO_CACHE = null;
async function avisoNcmNoChecklist() {
  const alvo = el('checklistNcm');
  if (!alvo) return;
  try {
    if (!NCM_RESUMO_CACHE) NCM_RESUMO_CACHE = await api('/api/produtos/ncm/resumo');
  } catch (e) { return; }
  const r = NCM_RESUMO_CACHE;
  const pend = r.sem + r.invalido;
  const okTudo = pend === 0;
  alvo.innerHTML = `<div style="display:flex;gap:9px;align-items:flex-start;padding:3px 0">
    <span>${okTudo ? '✅' : (r.vendidos_sem_ncm ? '⚠️' : '⬜')}</span>
    <span style="${okTudo ? 'color:var(--texto-fraco)' : ''}">NCM dos produtos: ${okTudo ? 'todos os produtos têm NCM'
      : `<strong>${pend}</strong> sem NCM (${r.vendidos_sem_ncm} vendidos nos últimos 180 dias) — saem com o padrão ${esc(r.ncm_padrao)}.`}
      ${podeVer('produtos') ? ` <a href="#" onclick="irPara('ncm');return false">Corrigir em NCM dos produtos</a>` : ''}</span></div>`;
}
