/* ==========================================================================
   pacote.js — pacote mensal para a contabilidade

   Junta num ZIP os XMLs de compra (NF-e que entraram) e de venda (NFC-e
   autorizadas e canceladas) de um mes, mais uma planilha-resumo e um
   LEIA-ME. Nao usa biblioteca de ZIP: o formato e simples o bastante para
   ser escrito aqui, e assim a loja nao precisa rodar "npm install" ao
   atualizar.

   Quem monta os dados (consultas no banco) e o server.js; aqui so entra
   o que ja foi lido.
   ========================================================================== */
'use strict';

const zlib = require('zlib');
const XLSX = require('xlsx');

/* ------------------------------------------------------------------------
   1. ZIP (formato PKZIP, deflate ou store, nomes em UTF-8)
   ------------------------------------------------------------------------ */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Data/hora no formato do MS-DOS que o ZIP usa (resolucao de 2 segundos). */
function horaDos(d) {
  const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  return { data: data & 0xFFFF, hora: hora & 0xFFFF };
}

/**
 * Monta um ZIP em memoria.
 * @param {Array<{nome: string, conteudo: Buffer|string, data?: Date}>} arquivos
 *   nome com barras normais ("compras/x.xml"); pastas nascem sozinhas.
 * @returns {Buffer}
 */
function criarZip(arquivos) {
  const locais = [];
  const centrais = [];
  let deslocamento = 0;

  for (const a of arquivos) {
    const nome = Buffer.from(String(a.nome).replace(/\\/g, '/').replace(/^\/+/, ''), 'utf8');
    const dados = Buffer.isBuffer(a.conteudo) ? a.conteudo : Buffer.from(String(a.conteudo || ''), 'utf8');
    const crc = crc32(dados);
    let comprimido = zlib.deflateRawSync(dados, { level: 9 });
    let metodo = 8;
    if (comprimido.length >= dados.length) { comprimido = dados; metodo = 0; }
    const { data, hora } = horaDos(a.data instanceof Date ? a.data : new Date());
    const flags = 0x0800;                          // bit 11: nome em UTF-8

    const local = Buffer.alloc(30 + nome.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // versao necessaria
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    nome.copy(local, 30);

    const central = Buffer.alloc(46 + nome.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);                  // feito pela versao
    central.writeUInt16LE(20, 6);                  // versao necessaria
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(metodo, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt16LE(0, 30);                  // extra
    central.writeUInt16LE(0, 32);                  // comentario
    central.writeUInt16LE(0, 34);                  // disco
    central.writeUInt16LE(0, 36);                  // atributos internos
    central.writeUInt32LE(0, 38);                  // atributos externos
    central.writeUInt32LE(deslocamento, 42);       // onde esta o cabecalho local
    nome.copy(central, 46);

    locais.push(local, comprimido);
    centrais.push(central);
    deslocamento += local.length + comprimido.length;
  }

  const tamanhoCentral = centrais.reduce((s, c) => s + c.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4);
  fim.writeUInt16LE(0, 6);
  fim.writeUInt16LE(centrais.length, 8);
  fim.writeUInt16LE(centrais.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);
  fim.writeUInt16LE(0, 20);

  return Buffer.concat([...locais, ...centrais, fim]);
}

/* ------------------------------------------------------------------------
   2. PLANILHA-RESUMO E LEIA-ME
   ------------------------------------------------------------------------ */

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
  'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function nomeDoMes(mes) {                          // 'AAAA-MM' -> 'agosto de 2026'
  const [a, m] = String(mes).split('-').map(Number);
  return `${MESES[(m || 1) - 1]} de ${a}`;
}

const dataBr = (iso) => {
  const s = String(iso || '').slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(iso || '');
};
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Planilha com tres abas: Resumo, Compras (NF-e de entrada) e Vendas (NFC-e).
 * @param {object} d  { mes, loja: {nome, cnpj, ie}, compras: [...], vendas: [...], gerado_em }
 */
function planilhaResumo(d) {
  const wb = XLSX.utils.book_new();

  const totalCompras = n2(d.compras.reduce((s, c) => s + n2(c.valor_total), 0));
  const autorizadas = d.vendas.filter((v) => v.situacao === 'autorizada');
  const canceladas = d.vendas.filter((v) => v.situacao === 'cancelada');
  const totalVendas = n2(autorizadas.reduce((s, v) => s + n2(v.valor), 0));
  const totalCanceladas = n2(canceladas.reduce((s, v) => s + n2(v.valor), 0));
  const semXml = d.compras.filter((c) => !c.tem_xml).length;

  const resumo = [
    ['PACOTE PARA A CONTABILIDADE — ' + nomeDoMes(d.mes).toUpperCase()],
    [],
    ['Empresa', d.loja.nome || ''],
    ['CNPJ', d.loja.cnpj || ''],
    ['Inscrição estadual', d.loja.ie || ''],
    ['Gerado em', d.gerado_em || ''],
    [],
    ['COMPRAS (NF-e de entrada, modelo 55)', 'Quantidade', 'Valor total (R$)'],
    ['Notas de compra lançadas no mês', d.compras.length, totalCompras],
    ['  das quais com XML neste pacote', d.compras.length - semXml, ''],
    ['  das quais SEM XML (lançadas antes da versão 1.11 — ver LEIA-ME)', semXml, ''],
    [],
    ['VENDAS (NFC-e, modelo 65)', 'Quantidade', 'Valor total (R$)'],
    ['NFC-e autorizadas', autorizadas.length, totalVendas],
    ['NFC-e canceladas (não somam)', canceladas.length, totalCanceladas],
    [],
    ['Observação', 'Só entram notas de PRODUÇÃO. Notas de homologação (teste) não têm valor fiscal e ficam fora.']
  ];
  const wsResumo = XLSX.utils.aoa_to_sheet(resumo);
  wsResumo['!cols'] = [{ wch: 62 }, { wch: 14 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, wsResumo, 'Resumo');

  const compras = [[
    'Emissão', 'Número', 'Série', 'Fornecedor', 'CNPJ do fornecedor', 'Chave de acesso',
    'Valor produtos (R$)', 'Desconto (R$)', 'Valor total (R$)', 'Itens', 'Lançada em', 'Por', 'XML no pacote', 'Arquivo'
  ]];
  d.compras.forEach((c) => compras.push([
    dataBr(c.emissao), c.numero || '', c.serie || '', c.fornecedor || '', c.cnpj || '', c.chave || '',
    n2(c.valor_produtos), n2(c.valor_desconto), n2(c.valor_total), Number(c.itens_qtd) || 0,
    dataBr(c.data_entrada), c.usuario || '', c.tem_xml ? 'Sim' : 'NÃO', c.arquivo || ''
  ]));
  compras.push(['TOTAL', '', '', '', '', '', '', '', totalCompras, '', '', '', '', '']);
  const wsCompras = XLSX.utils.aoa_to_sheet(compras);
  wsCompras['!cols'] = [12, 10, 7, 34, 20, 48, 18, 14, 16, 7, 12, 12, 14, 52].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsCompras, 'Compras');

  const vendas = [[
    'Autorizada em', 'Número', 'Série', 'Chave de acesso', 'Situação', 'Protocolo',
    'Valor (R$)', 'Venda nº', 'Cliente / CPF na nota', 'Cancelada em', 'Motivo do cancelamento', 'Arquivo'
  ]];
  d.vendas.forEach((v) => vendas.push([
    dataBr(v.data_autorizacao), v.numero || '', v.serie || '', v.chave || '', v.situacao || '',
    v.protocolo || '', n2(v.valor), v.venda_numero || '', v.cliente || '',
    v.cancelamento_em ? dataBr(v.cancelamento_em) : '', v.cancelamento_motivo || '', v.arquivo || ''
  ]));
  vendas.push(['TOTAL AUTORIZADAS', '', '', '', '', '', totalVendas, '', '', '', '', '']);
  const wsVendas = XLSX.utils.aoa_to_sheet(vendas);
  wsVendas['!cols'] = [13, 9, 6, 48, 11, 17, 14, 9, 28, 13, 36, 52].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsVendas, 'Vendas');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function leiaMe(d) {
  const semXml = d.compras.filter((c) => !c.tem_xml);
  const autorizadas = d.vendas.filter((v) => v.situacao === 'autorizada');
  const canceladas = d.vendas.filter((v) => v.situacao === 'cancelada');
  const linhas = [
    `PACOTE PARA A CONTABILIDADE — ${nomeDoMes(d.mes)}`,
    `${d.loja.nome || ''}  CNPJ ${d.loja.cnpj || ''}  IE ${d.loja.ie || ''}`,
    `Gerado em ${d.gerado_em} pelo sistema da loja (versao ${d.versao}).`,
    '',
    'O QUE TEM AQUI',
    `  resumo_${d.mes}.xlsx      planilha com o resumo do mes e a lista de cada nota`,
    `  compras/                 XML das NF-e de compra que entraram no mes (${d.compras.length - semXml.length} arquivo(s))`,
    `  vendas/                  XML das NFC-e de venda autorizadas (${autorizadas.length} arquivo(s))`,
    `  vendas/canceladas/       XML das NFC-e canceladas e o evento de cancelamento (${canceladas.length} nota(s))`,
    '',
    'COMO O MES FOI FECHADO',
    '  Compras: pela data de EMISSAO da NF-e do fornecedor (a mesma que a SEFAZ usa).',
    '  Vendas: pela data de AUTORIZACAO da NFC-e, ambiente de producao. Notas de',
    '  homologacao (teste) nao tem valor fiscal e nao entram.',
    '  Os arquivos se chamam <chave de acesso>-nfe.xml (compra) e <chave>-nfce.xml (venda);',
    '  o evento de cancelamento e <chave>-canc.xml.'
  ];
  if (semXml.length) {
    linhas.push('', 'ATENCAO — NOTAS DE COMPRA SEM O XML NESTE PACOTE',
      `  ${semXml.length} nota(s) foram lancadas antes da versao 1.11 do sistema, que ainda nao guardava o`,
      '  arquivo XML. Elas estao na planilha (aba Compras, coluna "XML no pacote" = NAO).',
      '  O XML pode ser baixado no portal da SEFAZ com a chave de acesso, ou pedido ao fornecedor:');
    semXml.forEach((c) => linhas.push(`    NF ${c.numero || '?'}  ${c.fornecedor || ''}  chave ${c.chave || '(sem chave)'}  R$ ${n2(c.valor_total).toFixed(2)}`));
  }
  return linhas.join('\r\n') + '\r\n';
}

/**
 * Monta o pacote inteiro.
 * @param {object} d  { mes, loja, versao, gerado_em, compras: [{..., xml}], vendas: [{..., xml, xml_cancelamento}] }
 * @returns {{ zip: Buffer, nome: string }}
 */
function montarPacote(d) {
  const pasta = `contabilidade_${d.mes}`;
  const arquivos = [];
  const agora = new Date();

  d.compras.forEach((c) => {
    if (!c.xml) { c.tem_xml = false; c.arquivo = ''; return; }
    const base = c.chave ? `${c.chave}-nfe.xml` : `nf-${c.numero || c.id}-${(c.cnpj || 'fornecedor')}.xml`;
    c.tem_xml = true;
    c.arquivo = `compras/${base}`;
    arquivos.push({ nome: `${pasta}/${c.arquivo}`, conteudo: c.xml, data: agora });
  });

  d.vendas.forEach((v) => {
    const sub = v.situacao === 'cancelada' ? 'vendas/canceladas' : 'vendas';
    const base = `${v.chave || 'nfce-' + v.id}-nfce.xml`;
    v.arquivo = v.xml ? `${sub}/${base}` : '';
    if (v.xml) arquivos.push({ nome: `${pasta}/${v.arquivo}`, conteudo: v.xml, data: agora });
    if (v.situacao === 'cancelada' && v.xml_cancelamento) {
      arquivos.push({ nome: `${pasta}/${sub}/${v.chave || 'nfce-' + v.id}-canc.xml`, conteudo: v.xml_cancelamento, data: agora });
    }
  });

  arquivos.unshift(
    { nome: `${pasta}/LEIA-ME.txt`, conteudo: leiaMe(d), data: agora },
    { nome: `${pasta}/resumo_${d.mes}.xlsx`, conteudo: planilhaResumo(d), data: agora }
  );

  return { zip: criarZip(arquivos), nome: `${pasta}.zip` };
}

module.exports = { criarZip, crc32, planilhaResumo, leiaMe, montarPacote, nomeDoMes };
