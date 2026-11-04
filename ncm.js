/* ==========================================================================
   ncm.js — tabela NCM (Nomenclatura Comum do Mercosul) e sugestao de NCM

   O NCM vai em cada item da NFC-e. Codigo que nao existe derruba a nota
   (rejeicao 778) e codigo errado e problema na fiscalizacao. Aqui mora:
     - a tabela de codigos validos com descricao (dados/ncm.json)
     - busca por codigo ou por palavras da descricao (para a tela)
     - sugestao de NCM pela descricao do produto, com regras feitas para
       loja de material de construcao (e SUGESTAO: quem confirma e a loja
       ou o contador)

   Fonte dos dados: tabela "NCM x uTrib" do portal da NF-e (validade dos
   codigos, 01/09/2022) e descricoes da tabela de 2015, com complementos
   escritos a mao para as subposicoes criadas depois.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

let MAPA = null;        // codigo -> { d: descricao completa, n: descricao normalizada }
let LISTA = [];         // [{ ncm, d, n }]
let VOCAB = new Set();  // palavras que aparecem nas descricoes da tabela (nomes de produto)
let FONTE = '';

/** Tira acento, poe em maiusculas e deixa so letras, numeros e espacos. */
function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9/.,-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function carregar(arquivo) {
  const caminho = arquivo || path.join(__dirname, 'dados', 'ncm.json');
  const bruto = JSON.parse(fs.readFileSync(caminho, 'utf8'));
  const posicoes = bruto.posicoes || {};
  MAPA = new Map();
  LISTA = [];
  FONTE = bruto.fonte || '';
  (bruto.itens || []).forEach(([codigo, resto]) => {
    const cab = posicoes[codigo.slice(0, 4)] || '';
    const d = !resto ? cab : (resto.startsWith(cab) ? resto : (cab ? cab + ' - ' + resto : resto));
    const item = { ncm: codigo, d, n: normalizar(d) };
    MAPA.set(codigo, item);
    LISTA.push(item);
    item.n.split(' ').forEach((w) => { if (w.length >= 4 && /^[A-Z]+$/.test(w)) VOCAB.add(w); });
  });
  return LISTA.length;
}

function garantir() { if (!MAPA) carregar(); }

const limpar = (c) => String(c || '').replace(/\D/g, '');

/** Existe e esta em vigor? */
function valido(codigo) {
  garantir();
  const c = limpar(codigo);
  return c.length === 8 && MAPA.has(c);
}

function descricao(codigo) {
  garantir();
  const it = MAPA.get(limpar(codigo));
  return it ? it.d : '';
}

/** So o fim da descricao (os ultimos niveis), que e o que cabe na tela. */
function resumo(codigo, niveis = 3) {
  const d = descricao(codigo);
  if (!d) return '';
  const partes = d.split(' - ');
  return partes.slice(-niveis).join(' - ');
}

/**
 * Busca para a tela: por codigo (prefixo) ou por palavras (todas precisam
 * aparecer na descricao). Palavras que batem no fim da descricao (o nivel
 * mais especifico) vem primeiro.
 */
function buscar(q, limite = 30) {
  garantir();
  const texto = normalizar(q);
  if (!texto) return [];
  const soDigitos = texto.replace(/[^0-9]/g, '');
  if (/^[0-9.]+$/.test(texto) && soDigitos.length >= 2) {
    return LISTA.filter((it) => it.ncm.startsWith(soDigitos)).slice(0, limite)
      .map((it) => ({ ncm: it.ncm, descricao: it.d, resumo: resumo(it.ncm) }));
  }
  const palavras = texto.split(' ').filter((p) => p.length >= 2);
  if (!palavras.length) return [];
  const achados = [];
  for (const it of LISTA) {
    if (!palavras.every((p) => it.n.includes(p))) continue;
    const fim = normalizar(resumo(it.ncm, 2));
    const pontos = palavras.filter((p) => fim.includes(p)).length;
    achados.push({ it, pontos });
    if (achados.length > 2000) break;
  }
  achados.sort((a, b) => b.pontos - a.pontos || a.it.ncm.localeCompare(b.it.ncm));
  return achados.slice(0, limite).map(({ it }) => ({ ncm: it.ncm, descricao: it.d, resumo: resumo(it.ncm) }));
}

/* --------------------------------------------------------------------------
   Regras por palavra, para loja de material de construcao.

   Cada regra olha a CABECA da descricao (as duas primeiras palavras, pulando
   codigos e medidas: "857 4 ESPATULA ACO" -> "ESPATULA ACO"), porque e ali que
   fica o nome do produto. "ESPACADOR P/PISO" nao e piso, "BRACO P/CHUVEIRO"
   nao e chuveiro. Regras marcadas com texto: true olham a descricao inteira
   (termos de duas palavras, dificeis de confundir). excl barra a regra quando
   a descricao inteira tem a palavra (telha de PVC nao e telha ceramica).
   A primeira que casar vale, entao as mais especificas vem antes.
   -------------------------------------------------------------------------- */
const R = (re, ncm, nome, opc = {}) => ({ re, ncm, nome, texto: !!opc.texto, excl: opc.excl || null });
const REGRAS = [
  // termos compostos, na descricao inteira
  R(/\bCIMENTO BRANCO\b/, '25232100', 'cimento branco', { texto: true }),
  R(/\b(CIMENTO COLA|ARGAMASSA|REJUNTE|CHAPISCO|GRAUTE|REBOCO PRONTO|MASSA DE ASSENTAMENTO|CONCRETO USINADO|CONCRETO PRONTO|CIMENTO QUEIMADO)\b/, '38245000', 'argamassa / rejunte', { texto: true, excl: /\b(ESPATULA|DESEMPENADEIRA|BISNAGA|APLICADOR|RODO|ESPONJA|BALDE|MISTURADOR|BROXA)/ }),
  R(/\b(DRYWALL|GESSO ACARTONADO|PLACA DE GESSO|CHAPA DE GESSO|FORRO DE GESSO)\b/, '68091100', 'placa de gesso', { texto: true, excl: /\b(TINTA|MASSA|PARAFUSO|FITA|PERFIL)/ }),
  R(/\b(PAVER|BLOQUETE|INTERTRAVADO|MEIO FIO|MEIO-FIO|GUIA DE CONCRETO|CANALETA DE CONCRETO|LAJOTA DE CONCRETO|COBOGO DE CONCRETO)\b/, '68101900', 'artefato de concreto', { texto: true }),
  R(/\bBLOCO\b.*\b(CONCRETO|CIMENTO)\b/, '68101100', 'bloco de concreto', { texto: true }),
  R(/\b(MASSA CORRIDA|MASSA ACRILICA|MASSA PVA|TEXTURA|GRAFIATO|MASSA NIVELADORA)\b/, '32141020', 'massa / textura', { texto: true, excl: /\b(ROLO|ESPATULA|DESEMPENADEIRA|LIXA)/ }),
  R(/\b(ESPUMA EXPANSIVA|VEDA CALHA|VEDACALHA|COLA PU|SELANTE PU)\b/, '32141010', 'selante', { texto: true }),
  R(/\bMANTA ASFALTICA\b/, '68071000', 'manta asfaltica', { texto: true }),
  R(/\bFITA CREPE\b/, '48114110', 'fita crepe', { texto: true }),
  R(/\b(IMPERMEABILIZANTE|VEDACIT|VEDALIT|BIANCO|PLASTIFICANTE|ADITIVO)\b/, '38244000', 'aditivo para cimento / argamassa', { texto: true }),
  R(/\b(CAIXA D ?AGUA|CAIXA DAGUA|RESERVATORIO)\b/, '39251000', 'caixa d agua', { texto: true, excl: /\b(BOIA|TORNEIRA|TAMPA|FLANGE|ADAPTADOR|SUPORTE|KIT|TUBO|CONEXAO)/ }),
  R(/\bCAIXA DE DESCARGA\b/, '39229000', 'caixa de descarga', { texto: true, excl: /\b(REPARO|BOIA|TUBO|ENGATE|MECANISMO|KIT)/ }),
  R(/\bASSENTO\b.*\bSANITARI/, '39222000', 'assento sanitario', { texto: true }),
  R(/^ASSENTO\b/, '39222000', 'assento sanitario', { excl: /\b(CARRO|MOTO|CADEIRA|BANCO|BICICLETA|INFANTIL)/ }),
  R(/^CAIXA (PE|POLIETILENO|FORTLEV|TIGRE|FIBRA)\b/, '39251000', 'caixa d agua', { excl: /\b(TAMPA|BOIA|TORNEIRA|FLANGE|ADAPTADOR)/ }),
  R(/^PORTA SANF/, '39252000', 'porta sanfonada de PVC'),
  R(/^QUADRO (DISTR|DE DISTRIBUICAO|DISJUNTOR|P\/ ?DISJUNTOR)/, '85371090', 'quadro de distribuicao'),
  R(/^GRAMPO\b.*\bCERCA\b/, '73170090', 'grampo para cerca'),
  R(/^CHAVE BOIA\b/, '85365090', 'chave boia (interruptor de nivel)'),
  R(/^CONECTOR\b/, '85369090', 'conector eletrico', { excl: /\b(MANGUEIRA|JARDIM|RAPIDO|PVC|TUBO)/ }),
  R(/\bDUCHA HIGIENICA\b/, '84818019', 'ducha higienica', { texto: true }),
  R(/\b(CAIXA 4X2|CAIXA 4X4|CAIXA DE PASSAGEM|CAIXA DE LUZ|CAIXA OCTOGONAL|CAIXINHA DE LUZ|CAIXA P\/? ?DISJUNTOR|CAIXA (PARA|P\/) ?DISJUNTOR)\b/, '39259090', 'caixa eletrica de PVC', { texto: true }),
  R(/\bLAMPADA\b.*\bLED\b|\bLED\b.*\bLAMPADA\b/, '85395200', 'lampada LED', { texto: true }),
  R(/\b(VERGALHAO|CA ?50|CA ?60|BARRA DE FERRO|VARA (DE )?FERRO|FERRO (DE )?CONSTRUCAO|ACO CA)\b|\bFERRO\b\s*(\d|3\/8|1\/2|5\/16|1\/4)/, '72142000', 'vergalhao', { texto: true, excl: /\b(PORTA|PORTAO|JANELA|GRADE|CHAPA)/ }),
  R(/\bARAME\b.*\bFARPADO\b/, '73130000', 'arame farpado', { texto: true }),
  R(/\bTELA\b.*\bSOLDADA\b/, '73143100', 'tela soldada galvanizada', { texto: true }),
  R(/\bTELA\b.*\b(PINTEIRO|GALINHEIRO|HEXAGONAL|VIVEIRO|ALAMBRADO|GALVANIZADA)\b/, '73144100', 'tela galvanizada', { texto: true }),
  R(/\b(CARRINHO|CARRO) DE MAO\b/, '87168000', 'carrinho de mao', { texto: true, excl: /\b(PNEU|RODA|CAMARA|CACAMBA)/ }),
  R(/\bLONA\b.*\b(PLASTICA|PRETA|PRETO|TRANSPARENTE)\b|\bLONA PLASTICA\b/, '39201099', 'lona plastica', { texto: true }),
  R(/\bLIXA\b.*\b(FERRO|PANO|METAL)\b/, '68051000', 'lixa de pano', { texto: true }),
  R(/\bREGISTRO\b.*\bGAVETA\b/, '84818093', 'registro de gaveta', { texto: true, excl: /\b(MVS|REPARO|CANOPLA|ACABAMENTO|VOLANTE)/ }),
  R(/\bREGISTRO\b.*\bESFERA\b/, '84818095', 'registro de esfera', { texto: true, excl: /\b(MVS|REPARO)/ }),
  R(/\bREGISTRO\b.*\b(PRESSAO|GLOBO)\b/, '84818094', 'registro de pressao', { texto: true, excl: /\b(MVS|REPARO|CANOPLA|ACABAMENTO|VOLANTE)/ }),
  R(/\bPORTA\b.*\b(MADEIRA|ANGELIM|CEDRO|EUCALIPTO|PINUS|MOGNO|SEMI ?OCA|LISA|ALMOFADADA|MEXICANA|FRIS)\b|\bPORTA MAD\b/, '44182900', 'porta de madeira', { texto: true, excl: /\b(CADEADO|FECHADURA|DOBRADICA|BATENTE|TRINCO)/ }),
  R(/\b(PORTA|JANELA|PORTAO|GRADE|BASCULANTE|VENEZIANA)\b.*\b(FERRO|ACO|METAL|METALICA)\b/, '73083000', 'esquadria de ferro', { texto: true, excl: /\b(CADEADO|FECHADURA|DOBRADICA|PARAFUSO|TRINCO)/ }),
  R(/\b(PORTA|JANELA|PORTAO|BASCULANTE|VENEZIANA|ESQUADRIA)\b.*\bALUMINIO\b/, '76101000', 'esquadria de aluminio', { texto: true, excl: /\b(CADEADO|FECHADURA|DOBRADICA|PARAFUSO|TRINCO)/ }),
  R(/\bESCADA\b.*\bALUMINIO\b/, '76169900', 'escada de aluminio', { texto: true }),
  R(/\b(SERRA MARMORE|SERRA CIRCULAR|TICO TICO)\b/, '84672200', 'serra eletrica', { texto: true, excl: /\b(DISCO|LAMINA|WID|CORTE)/ }),
  R(/\bPISO\b.*\bVINILICO\b/, '39181000', 'piso vinilico', { texto: true }),
  R(/\bTELHA\b.*\b(FIBROCIMENTO|FIBRO|ONDULADA|BRASILIT|ETERNIT)\b/, '68118100', 'telha de fibrocimento', { texto: true, excl: /\b(KIT|PARAFUSO|FIXACAO|CUMEEIRA|VEDA)/ }),
  R(/\bTELHA\b.*\b(METALICA|GALVANIZADA|GALVALUME|ZINCO|ALUZINCO|TRAPEZOIDAL|SANDUICHE)\b/, '73089010', 'telha metalica', { texto: true, excl: /\b(KIT|PARAFUSO|FIXACAO)/ }),

  // pelo nome do produto (cabeca da descricao)
  R(/^CIMENTO\b/, '25232910', 'cimento Portland comum'),
  R(/^CAL\b.*\b(VIRGEM|VIVA)\b/, '25221000', 'cal virgem'),
  R(/^CAL\b/, '25222000', 'cal hidratada (apagada)'),
  R(/^AREIA\b/, '25051000', 'areia natural'),
  R(/^(BRITA|PEDRISCO|CASCALHO|SEIXO|RACHAO)\b|^PO DE PEDRA\b/, '25171000', 'pedra britada / cascalho'),
  R(/^(TIJOLO|TIJOLINHO|BLOCO)\b/, '69041000', 'tijolo / bloco ceramico', { excl: /\b(CONCRETO|CIMENTO|VIDRO|ISOPOR|EPS|ESPUMA|LIXA|PAPEL|ANOTAC|NOTA|TOMADA|BORRACHA)/ }),
  R(/^TELHA\b/, '69051000', 'telha ceramica', { excl: /\b(PVC|PLASTIC|POLICARBONATO|FIBRA|VIDRO|TRANSPARENTE|CONCRETO|CIMENTO|FIBROCIMENTO|FIBRO|ONDULADA|BRASILIT|ETERNIT|METAL|GALV|ZINCO|ALUZINCO|ACO|TRAPEZOIDAL|SANDUICHE|KIT|PARAFUSO|FIXACAO|ISOPOR|ECOLOGICA)/ }),
  R(/^GESSO\b/, '25202090', 'gesso em po'),
  R(/^PORCELANATO\b/, '69072100', 'porcelanato'),
  R(/^AZULEJO\b/, '69072300', 'azulejo'),
  R(/^(PISO|REVESTIMENTO|REVEST|CERAMICA)\b/, '69072200', 'piso / revestimento ceramico', { excl: /\b(VINILICO|LAMINADO|PVC|CONCRETO|CIMENTO|MADEIRA|TACO|CIMENTICIO|BORRACHA|EMBORRACHADO|TATIL|ESPACADOR|NIVELADOR|CUNHA)/ }),
  R(/^(ESMALTE|ESM)\b.*\b(AGUA|B AGUA|BASE AGUA)\b/, '32091010', 'esmalte base agua'),
  R(/^(ESMALTE|ESM|TINTA OLEO|TINTA A OLEO)\b|^TINTA\b.*\b(ESMALTE|OLEO)\b/, '32081010', 'esmalte sintetico'),
  R(/^VERNIZ\b/, '32081020', 'verniz'),
  R(/^(TINTA|LATEX|SELADOR|FUNDO|LIQUIDO PREPARADOR|ACR|ACRILICA|ACRILICO)\b/, '32091010', 'tinta base agua', { excl: /\b(SPRAY|ESMALTE|OLEO|AUTOMOTIVA|PISCINA|EPOXI|ROLO|PINCEL)/ }),
  R(/^SILICONE\b/, '32141010', 'silicone (mastique)'),
  R(/^(THINNER|THINER|TINER|SOLVENTE|DILUENTE|REDUTOR)\b|^REMOVEDOR\b.*\b(TINTA|PASTOSO|VERNIZ)\b/, '38140090', 'solvente / thinner'),
  R(/^AGUARRAS\b/, '27101230', 'aguarras mineral'),
  R(/^ROLO\b/, '96034090', 'rolo de pintura', { excl: /\b(FITA|LONA|TELA|ARAME|PAPEL|ETIQUETA)/ }),
  R(/^(PINCEL|TRINCHA|BROXA)\b/, '96034010', 'pincel / trincha'),
  R(/^LIXA\b/, '68052000', 'lixa de papel'),
  R(/^(COLA|ADESIVO|ADES)\b.*\b(INST|INSTANTANE|BONDER|CIANO)/, '35061010', 'cola instantanea (cianoacrilato)'),
  R(/^ADES\b.*\bSILICONE\b/, '32141010', 'silicone (mastique)'),
  R(/^(COLA|ADESIVO|ADES)\b/, '35061090', 'cola / adesivo', { excl: /\bFITA\b/ }),
  R(/^(VASO|BACIA)\b.*\b(SANITARI|CONVENCIONAL|ACOPLAD)/, '69101000', 'louca sanitaria'),
  R(/^(LAVATORIO|CUBA|MICTORIO|CAIXA ACOPLADA)\b|^COLUNA\b.*\bLAVATORIO\b/, '69101000', 'louca sanitaria', { excl: /\b(PLASTIC|PVC|INOX|ACO|GRANITO|MARMORE|SINTETIC|TORNEIRA|VALVULA|SIFAO|PARAFUSO|KIT|MECANISMO|REPARO|TAMPA|ENGATE|FLEX)/ }),
  R(/^(PIA|CUBA)\b.*\bINOX\b/, '73241000', 'pia / cuba de aco inox'),
  R(/^(LAVATORIO|TANQUE|PIA)\b.*\b(PLASTIC\w*|PVC|POLIPROPILENO|POLIETILENO)\b/, '39221000', 'louca de plastico'),
  R(/^(CHUVEIRO|DUCHA)\b/, '85161000', 'chuveiro eletrico', { excl: /\b(BRACO|SUPORTE|CANO|HASTE|REGISTRO|CROMAD|METAL|ARTICULAD|GATILHO|CRIVO|MANUAL|JARDIM|LAVA|LAVAGEM)/ }),
  R(/^RESISTENCIA\b/, '85168010', 'resistencia de chuveiro'),
  R(/^(TUBO|CANO)\b/, '39172300', 'tubo de PVC', { excl: /\b(ACO|FERRO|GALVANIZADO|COBRE|ALUMINIO|METALON|INOX|LED|COLA|SILICONE)/ }),
  R(/^ELETRODUTO\b.*\bRIGIDO\b/, '39172300', 'eletroduto rigido de PVC'),
  R(/^MANGUEIRA\b/, '39173900', 'mangueira'),
  R(/^(JOELHO|LUVA|TE|TEE|CAP|ADAPTADOR|BUCHA|CURVA|NIPEL|UNIAO|PLUG|FLANGE|REDUCAO|CONEXAO|SIFAO|ENGATE|ANEL|CRUZETA)\b/, '39174090', 'conexao de PVC', { excl: /\b(ACO|FERRO|GALVANIZADO|COBRE|INOX|METAL|LATAO|RASPA|LATEX|VAQUETA|NITRILICA|SEGURANCA|MALHA|VEDACAO ORING|FIXACAO|S\d)/ }),
  R(/^(BOIA|TORNEIRA BOIA)\b/, '84818099', 'torneira boia'),
  R(/^(TORNEIRA|TORN|VALVULA|REGISTRO|MISTURADOR)\b/, '84818019', 'torneira / valvula de uso domestico', { excl: /\b(MVS|REPARO|CANOPLA|ACABAMENTO|VOLANTE|BOIA|VEDANTE|VEDACAO|ESTOJO)/ }),
  R(/^(FIO|CABO)\b/, '85444900', 'fio / cabo eletrico', { excl: /\b(ACO|RETINIDA|NYLON|SISAL|VARAL|VASSOURA|RODO|MADEIRA|ENXADA|MACHADO|MARTELO|FERRAMENTA|PA|P\/PA|PICARETA|FOICE|IMPERIAL|REDE|HDMI|USB|COAXIAL|ANTENA|TELEFONE)\b/ }),
  R(/^DISJUNTOR\b/, '85362000', 'disjuntor'),
  R(/^(TOMADA|TOMAD|MODTOMADA|MOD TOMAD|MOD TOMADA)/, '85366990', 'tomada', { excl: /\b(INTERRUPTOR|INTER|INT)/ }),
  R(/^(INTERRUPTOR|INTER|MOD INT|MOD INTER)\b/, '85365090', 'interruptor'),
  R(/^(BOCAL|SOQUETE|RECEPTACULO)\b/, '85366100', 'bocal de lampada'),
  R(/^ARAME\b.*\bGALVANIZADO\b/, '72172090', 'arame galvanizado'),
  R(/^ARAME\b/, '72171090', 'arame recozido'),
  R(/^PREGO\b/, '73170090', 'prego'),
  R(/^PARAFUSO\b/, '73181500', 'parafuso', { excl: /\b(KIT|MADEIRA|DRYWALL|GESSO)/ }),
  R(/^PORCA\b/, '73181600', 'porca'),
  R(/^ARRUELA\b/, '73182200', 'arruela'),
  R(/^(FECHADURA|FECH|FERROLHO|TRINCO)\b/, '83014000', 'fechadura / ferrolho'),
  R(/^CADEADO\b/, '83011000', 'cadeado'),
  R(/^(DOBRADICA|DOB)\b/, '83021000', 'dobradica'),
  R(/^(TABUA|CAIBRO|RIPA|SARRAFO|VIGA|PRANCHA|PONTALETE)\b.*\bPINUS\b|^PINUS\b/, '44071100', 'madeira de pinus'),
  R(/^(TABUA|CAIBRO|RIPA|SARRAFO|VIGA|PRANCHA|PONTALETE)\b.*\bEUCALIPTO\b|^EUCALIPTO\b/, '44079990', 'madeira de eucalipto'),
  R(/^(ENXADA|ENXADAO|PICARETA|SACHO|ANCINHO|RASTELO)\b/, '82013000', 'enxada / picareta'),
  R(/^PA\b/, '82011000', 'pa', { excl: /\b(PLASTIC|LIXO|ROLO|PINTURA|TINTA)/ }),
  R(/^MACHADO\b/, '82014000', 'machado'),
  R(/^(FACAO|FOICE|PODAO)\b/, '82019000', 'facao / foice', { excl: /\bBAINHA\b/ }),
  R(/^(MARTELO|MARRETA)\b/, '82052000', 'martelo'),
  R(/^(SERROTE|ARCO DE SERRA|SERRA MANUAL)\b/, '82021000', 'serra manual'),
  R(/^ALICATE\b/, '82032000', 'alicate'),
  R(/^(CHAVE FENDA|CHAVE PHILIPS|CHAVE PHILLIPS|JOGO CHAVE FENDA)\b|^CHAVE\b.*\b(FENDA|PHILIPS|PHILLIPS)\b/, '82054000', 'chave de fenda'),
  R(/^TRENA\b/, '90178010', 'trena'),
  R(/^(COLHER|DESEMPENADEIRA|ESPATULA|TALHADEIRA|PONTEIRO|PRUMO)\b/, '82055900', 'ferramenta manual', { excl: /\b(PLASTIC|MADEIRA|ACRILIC)/ }),
  R(/^FURADEIRA\b/, '84672100', 'furadeira'),
  R(/^(ESMERILHADEIRA|LIXADEIRA|POLITRIZ)\b/, '84672999', 'esmerilhadeira / lixadeira'),
  R(/^BETONEIRA\b/, '84743100', 'betoneira'),
  R(/^ESPELHO\b/, '70099100', 'espelho')
];

/* A cabeca: as duas primeiras palavras com letras, pulando codigos e medidas. */
function cabeca(textoNormalizado) {
  const tokens = textoNormalizado.split(' ');
  const i = tokens.findIndex((t) => /^[A-Z]{2,}/.test(t) && !/^(C|S|P|CX|UN|KG|KGS|LT|LTS|ML|MM|CM|MT|MTS|M|GL|BD|PC|PCS|KIT)$/.test(t));
  if (i < 0) return '';
  return tokens.slice(i, i + 2).join(' ');
}

/** Sugere um NCM pela descricao do produto, ou null. */
/* Primeira palavra que, quando esta na frente, diz que o produto e um
   acessorio ou peca — ai nao vale pular para a palavra seguinte. */
const ACESSORIO = /^(BRACO|SUPORTE|KIT|ESPACADOR|BAINHA|DISCO|DISC|BROCA|LIMA|REPARO|VEDANTE|TAMPA|BOTAO|HASTE|ACABAMENTO|CANOPLA|MVS|PROTETOR|CAPA|PECA|REFIL|MECANISMO|CHAPA|PERFIL|GRELHA|RALO|SACO|BALDE|PANO|ESCOVA|CUNHA|NIVELADOR|PORTA|CABO|VALVULA|ADAPTADOR|BASE|PARAFUSO|BUCHA|ABRAC|CONECTOR|CAIXA|CXA|CAMARA|PNEU|RODA|LAMINA|JOGO|CONJ|CONJUNTO|FILTRO|TUBO|BICO|PONTEIRA|ENGATE|FLANGE|ANEL|BORRACHA|ESTOJO|MOLA|PINO|TRAVA|PUXADOR|RODIZIO|ROLDANA|CORRENTE|GANCHO|ALCA|CESTO|TELA|FITA)$/;

function sugerirPorDescricao(descricaoProduto) {
  garantir();
  const t = normalizar(descricaoProduto);
  if (!t) return null;
  const tokens = t.split(' ');
  const i0 = tokens.findIndex((x) => /^[A-Z]{2,}/.test(x) && !/^(C|S|P|CX|UN|KG|KGS|LT|LTS|ML|MM|CM|MT|MTS|M|GL|BD|PC|PCS|KIT)$/.test(x));
  if (i0 < 0) return null;
  const testar = (cab) => {
    for (const r of REGRAS) {
      const alvo = r.texto ? t : cab;
      if (!r.re.test(alvo)) continue;
      if (r.excl && r.excl.test(t)) continue;
      if (!MAPA.has(r.ncm)) continue;
      return { ncm: r.ncm, regra: r.nome };
    }
    return null;
  };
  const cab0 = tokens.slice(i0, i0 + 2).join(' ');
  const achou = testar(cab0);
  if (achou) return achou;
  /* nada na frente: pode ser marca primeiro ("GERDAU PREGO 2X10"). Tenta a
     palavra seguinte, a nao ser que a primeira diga que e peca/acessorio. */
  if (ACESSORIO.test(tokens[i0]) || tokens.length < i0 + 3) return null;
  // palavra que existe na tabela NCM e nome de produto, nao marca: nao pula
  if (VOCAB.has(tokens[i0]) || VOCAB.has(tokens[i0].replace(/S$/, ''))) return null;
  const cab1 = tokens.slice(i0 + 1, i0 + 3).join(' ');
  if (!/^[A-Z]{3,}/.test(tokens[i0 + 1])) return null;
  const r1 = testar(cab1);
  // regras de texto inteiro ja foram testadas; so as de cabeca valem aqui
  return r1 && !REGRAS.find((r) => r.nome === r1.regra && r.texto) ? r1 : null;
}

/** Palavra que "identifica" o produto: a primeira com 4+ letras, fora de preposicoes. */
function palavraChave(descricaoProduto) {
  const ignorar = new Set(['PARA', 'COM', 'SEM', 'TIPO', 'KIT', 'PECA', 'UNID', 'LINHA', 'MARCA']);
  const palavras = normalizar(descricaoProduto).split(' ').filter((p) => /^[A-Z]{4,}$/.test(p) && !ignorar.has(p));
  return palavras[0] || '';
}

module.exports = { carregar, normalizar, valido, descricao, resumo, buscar, sugerirPorDescricao, palavraChave, cabeca, REGRAS,
  get fonte() { garantir(); return FONTE; }, get total() { garantir(); return LISTA.length; } };
