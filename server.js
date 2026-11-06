/* =========================================================================
   SISTEMA DE VENDAS E CUPOM - LOJA DE MATERIAL DE CONSTRUCAO
   Node.js + Express + sql.js (banco em arquivo unico)
   ========================================================================= */

let express, fs, path, crypto, initSqlJs, XMLParser, XLSX, fiscal, QRCode, pacote, ncm;
try {
  express = require('express');
  fs = require('fs');
  path = require('path');
  crypto = require('crypto');
  initSqlJs = require('sql.js');
  XMLParser = require('fast-xml-parser').XMLParser;
  XLSX = require('xlsx');
  fiscal = require('./fiscal');            // NFC-e: certificado, XML, SEFAZ
  QRCode = require('qrcode');              // QR Code do DANFE NFC-e
  pacote = require('./pacote');            // [1.11] ZIP mensal para a contabilidade
  ncm = require('./ncm');                  // [1.12] tabela NCM e sugestao de NCM
} catch (e) {
  // acontece quando o sistema e atualizado por cima de uma pasta antiga:
  // o package.json pede uma biblioteca nova que ainda nao foi instalada
  console.error('');
  console.error('==================================================');
  console.error('  FALTA INSTALAR UMA BIBLIOTECA DO SISTEMA');
  console.error('==================================================');
  console.error('  ' + e.message);
  console.error('');
  console.error('  Como resolver:');
  console.error('    1) Feche esta janela');
  console.error('    2) Apague a pasta node_modules (NAO apague o loja.db)');
  console.error('    3) Rode o iniciar.bat de novo');
  console.error('');
  console.error('  Ou abra o Prompt de Comando nesta pasta e digite:');
  console.error('    npm install');
  console.error('==================================================');
  console.error('');
  process.exit(1);
}

/* [1.14] Fuso horario. Na internet (Railway) o servidor nasce em UTC e a loja
   e na Bahia: sem isto a hora do cupom, o dia das vendas, o aviso semanal e o
   dhEmi da NFC-e sairiam 3 horas adiantados. No Windows o Node usa o fuso do
   proprio computador e esta linha nao muda nada. */
if (!process.env.TZ) process.env.TZ = 'America/Bahia';

const app = express();
const PORT = process.env.PORT || 3000;

/* Versao do sistema — aparece na tela e no rodape do cupom.
   Serve para conferir na hora se o arquivo em uso e o mais novo. */
const VERSAO = '1.22 - Vendas do Dia mostra o vendedor';

/* =========================================================================
   [1.14] ONDE O SISTEMA ESTA RODANDO
   No Railway (ou com a variavel NA_INTERNET=1) o sistema se comporta como
   um servico na internet: confia no proxy do Railway para saber o IP de
   quem chama, manda http para https, exige trocar a senha padrao e so sobe
   se o volume (a pasta que sobrevive aos deploys) estiver montado.
   Em casa, no iniciar.bat, nada disso muda.
   ========================================================================= */
const NO_RAILWAY = !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT_NAME);
const NA_INTERNET = NO_RAILWAY || process.env.NA_INTERNET === '1';

app.disable('x-powered-by');
if (NA_INTERNET) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  // na internet, quem chegar por http vai para https (o /saude fica fora: e o
  // Railway conferindo se o servico esta de pe)
  if (NA_INTERNET && req.method === 'GET' && req.path !== '/saude' &&
      req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  }
  next();
});

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

/* ---------- caminho do banco ----------
   [1.14] No Railway o volume avisa onde foi montado (RAILWAY_VOLUME_MOUNT_PATH);
   nao precisa criar DATA_DIR na mao. DATA_DIR continua valendo e ganha. */
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const DB_FILE = path.join(DATA_DIR, 'loja.db');
const PASTA_BACKUPS = path.join(DATA_DIR, 'backups');   // [1.14] copias diarias automaticas

let SQL = null;
let db = null;

/* =========================================================================
   HELPERS DE BANCO
   ATENCAO: db.export() zera o last_insert_rowid() do sql.js.
   Por isso SEMPRE pegue o id com ultimoId() ANTES de chamar salvarBanco().
   O helper inserir() ja faz isso na ordem correta.
   ========================================================================= */

function salvarBanco() {
  try {
    const dados = Buffer.from(db.export());
    /* [1.14] grava num arquivo ao lado e so depois troca o nome: se a luz cair
       (ou o Railway reiniciar) no meio da gravacao, o loja.db de antes continua
       inteiro em vez de ficar pela metade */
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, dados);
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      // Windows com antivirus segurando o arquivo: grava direto, como sempre foi
      try { fs.unlinkSync(tmp); } catch (e2) { /* nao existe */ }
      fs.writeFileSync(DB_FILE, dados);
    }
  } catch (e) {
    console.error('ERRO ao salvar o banco:', e.message);
  }
}

/* =========================================================================
   [1.14] PASTA DOS DADOS, VOLUME, COPIAS AUTOMATICAS E RESTAURACAO
   ========================================================================= */

/** Mensagem grande na janela preta / no log do Railway. */
function avisoGrande(linhas) {
  console.error('');
  console.error('==================================================');
  linhas.forEach((l) => console.error('  ' + l));
  console.error('==================================================');
  console.error('');
}

/**
 * Confere a pasta onde o banco vai morar ANTES de abrir qualquer coisa.
 * No Railway, se o volume nao estiver montado, a pasta e uma pasta comum do
 * container: o sistema subiria com um banco vazio, a loja venderia em cima
 * dele e no proximo deploy tudo sumiria (e a numeracao da NFC-e recomecaria,
 * o que a SEFAZ rejeita). Por isso aqui o sistema prefere NAO SUBIR — o
 * Railway reinicia sozinho e tenta de novo com o volume no lugar.
 */
function conferirPastaDoBanco() {
  const exigeVolume = NO_RAILWAY && process.env.VOLUME_OBRIGATORIO !== '0';

  if (!exigeVolume) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return;
  }

  if (!process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.DATA_DIR) {
    avisoGrande([
      'O SISTEMA ESTA NO RAILWAY SEM UM VOLUME.',
      'Sem volume, o banco (loja.db) e apagado a cada deploy.',
      '',
      'Como resolver: no Railway, botao direito no servico -> Add Volume,',
      'ponto de montagem /data. O sistema acha o volume sozinho.',
      '(Para subir mesmo assim, so para testar: variavel VOLUME_OBRIGATORIO=0)'
    ]);
    process.exit(2);
  }

  if (!fs.existsSync(DATA_DIR)) {
    avisoGrande([
      'A PASTA DO VOLUME NAO EXISTE: ' + DATA_DIR,
      'O volume nao foi montado ainda. Nao vou criar um banco vazio no lugar dele.',
      'O Railway vai reiniciar o sistema; se continuar assim, confira em',
      'Settings -> Volumes se o volume esta ligado a ESTE servico.',
      '(Para subir mesmo assim: variavel VOLUME_OBRIGATORIO=0)'
    ]);
    process.exit(2);
  }

  // A pasta existe, mas e um volume de verdade ou uma pasta comum do container?
  // Um volume montado e outro "disco" (dev diferente da raiz).
  try {
    if (process.platform !== 'win32' && fs.statSync(DATA_DIR).dev === fs.statSync('/').dev) {
      avisoGrande([
        'A PASTA ' + DATA_DIR + ' EXISTE, MAS NAO E UM VOLUME MONTADO.',
        'Se eu subisse agora, a loja venderia em cima de um banco que some no',
        'proximo deploy. Vou esperar o Railway reiniciar com o volume no lugar.',
        'Se voce tem certeza de que o volume esta montado nessa pasta, crie a',
        'variavel VOLUME_OBRIGATORIO=0 no servico.'
      ]);
      process.exit(2);
    }
  } catch (e) { /* nao conseguiu conferir: segue */ }
}

/**
 * Abre o loja.db conferindo se ele esta inteiro. Um arquivo danificado ou
 * vazio NUNCA e substituido por um banco novo em silencio — e assim que se
 * perde uma loja inteira sem perceber.
 */
function abrirBanco() {
  if (!fs.existsSync(DB_FILE)) {
    db = new SQL.Database();
    console.log('Banco novo criado em', DB_FILE);
    return;
  }
  const buf = fs.readFileSync(DB_FILE);
  if (!buf.length) {
    avisoGrande([
      'O ARQUIVO ' + DB_FILE + ' ESTA VAZIO (0 bytes).',
      'Nao vou criar um banco novo por cima dele. Veja a pasta ' + PASTA_BACKUPS,
      '(copias diarias) ou restaure um backup: apague o loja.db vazio, suba o',
      'sistema e use Configuracoes -> Backup -> Restaurar.'
    ]);
    process.exit(3);
  }
  try {
    db = new SQL.Database(buf);
    one('SELECT count(*) AS n FROM sqlite_master');
  } catch (e) {
    avisoGrande([
      'O ARQUIVO ' + DB_FILE + ' NAO ABRIU: ' + e.message,
      'Nao vou criar um banco novo por cima dele. Veja a pasta ' + PASTA_BACKUPS,
      '(copias diarias) ou restaure um backup pela tela de Configuracoes.'
    ]);
    process.exit(3);
  }
  console.log('Banco carregado de', DB_FILE);
}

/** Resumo de um banco aberto (o atual ou um arquivo que vai ser restaurado). */
function resumoDoBanco(banco) {
  const q = (sql, params = []) => {
    try {
      const st = banco.prepare(sql); st.bind(params);
      const r = st.step() ? st.getAsObject() : null; st.free(); return r;
    } catch (e) { return null; }
  };
  const tabelas = [];
  try {
    const st = banco.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
    while (st.step()) tabelas.push(st.getAsObject().name);
    st.free();
  } catch (e) { /* vazio */ }
  const cfg = (chave) => { const r = q('SELECT valor FROM config WHERE chave = ?', [chave]); return r ? txt(r.valor) : ''; };
  const n = (sql, params) => { const r = q(sql, params); return r ? num(r.n) : 0; };
  const nfce = q("SELECT COUNT(*) AS n, MAX(numero) AS ultimo FROM nfce WHERE situacao IN ('autorizada', 'cancelada') AND ambiente = 1");
  return {
    tabelas: tabelas.length,
    tem_tabelas: ['usuarios', 'produtos', 'vendas', 'config'].every((t) => tabelas.includes(t)),
    loja_nome: cfg('loja_fantasia') || cfg('loja_nome'),
    loja_cnpj: cfg('loja_cnpj'),
    usuarios: n('SELECT COUNT(*) AS n FROM usuarios WHERE ativo = 1'),
    produtos: n('SELECT COUNT(*) AS n FROM produtos'),
    clientes: n('SELECT COUNT(*) AS n FROM clientes'),
    vendas: n('SELECT COUNT(*) AS n FROM vendas'),
    ultima_venda: (q('SELECT MAX(data) AS d FROM vendas') || {}).d || '',
    nfce_producao: nfce ? num(nfce.n) : 0,
    nfce_ultimo_numero: nfce ? num(nfce.ultimo) : 0,
    certificado: !!(q('SELECT id FROM certificado WHERE id = 1 AND arquivo IS NOT NULL AND arquivo <> \'\'')),
    csc_producao: !!cfg('nfce_csc_producao'),
    entregas_abertas: n("SELECT COUNT(*) AS n FROM entregas WHERE situacao IN ('pendente','parcial')")
  };
}

/** Confere um arquivo enviado para restauracao. Devolve { erro } ou { resumo }. */
function conferirArquivoDeBanco(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 512) {
    return { erro: 'O arquivo enviado esta vazio ou nao e um banco do sistema.' };
  }
  if (buf.slice(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    return { erro: 'Esse arquivo nao e um banco do sistema (loja.db ou backup-loja-....db). Confira se escolheu o arquivo certo.' };
  }
  let banco;
  try {
    banco = new SQL.Database(buf);
    const resumo = resumoDoBanco(banco);
    banco.close();
    if (!resumo.tem_tabelas) return { erro: 'O arquivo abre, mas nao tem as tabelas do sistema (usuarios, produtos, vendas, config). Nao e um loja.db.' };
    return { resumo };
  } catch (e) {
    try { if (banco) banco.close(); } catch (e2) { /* ja fechado */ }
    return { erro: 'O arquivo esta danificado e nao abre: ' + e.message };
  }
}

/** Espaco livre na pasta dos dados, em bytes (ou null se nao der para saber). */
function espacoLivre(pasta) {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(pasta);
    return Number(s.bavail) * Number(s.bsize);
  } catch (e) { return null; }
}

function listarCopias() {
  try {
    if (!fs.existsSync(PASTA_BACKUPS)) return [];
    return fs.readdirSync(PASTA_BACKUPS)
      .filter((f) => /\.db$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(PASTA_BACKUPS, f));
        return { nome: f, tamanho: st.size, data: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.data < b.data ? 1 : -1));
  } catch (e) { return []; }
}

/**
 * Uma copia do banco por dia, na pasta backups/ ao lado do loja.db. Guarda as
 * 7 ultimas. Nao substitui o "Baixar backup" (que leva o arquivo para fora do
 * servidor), mas salva o dia quando alguem apaga ou estraga alguma coisa.
 */
const COPIAS_GUARDADAS = 7;
function copiaDiaria() {
  try {
    if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
    const destino = path.join(PASTA_BACKUPS, 'loja-' + dataLocalIso(new Date()) + '.db');
    if (fs.existsSync(destino)) return false;

    const dados = Buffer.from(db.export());
    // apaga as mais velhas antes, para a pasta nao crescer sem parar
    const antigas = fs.readdirSync(PASTA_BACKUPS).filter((f) => /^loja-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    while (antigas.length >= COPIAS_GUARDADAS) fs.unlinkSync(path.join(PASTA_BACKUPS, antigas.shift()));

    const livre = espacoLivre(PASTA_BACKUPS);
    if (livre !== null && livre < dados.length * 3) {
      console.error('Copia diaria pulada: pouco espaco livre na pasta dos dados (' +
        Math.round(livre / 1048576) + ' MB).');
      return false;
    }
    fs.writeFileSync(destino, dados);
    console.log('Copia diaria do banco guardada em', destino);
    return true;
  } catch (e) {
    console.error('Copia diaria do banco falhou:', e.message);
    return false;
  }
}

/** Copia de seguranca do banco atual antes de uma restauracao. */
function copiaAntesDeRestaurar() {
  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const destino = path.join(PASTA_BACKUPS, 'antes-de-restaurar-' + carimbo + '.db');
  fs.writeFileSync(destino, Buffer.from(db.export()));
  return destino;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const linhas = [];
  while (stmt.step()) linhas.push(stmt.getAsObject());
  stmt.free();
  return linhas;
}

function one(sql, params = []) {
  const r = all(sql, params);
  return r.length ? r[0] : null;
}

function ultimoId() {
  const r = one('SELECT last_insert_rowid() AS id');
  return r ? r.id : null;
}

/** Insere e devolve o id ja lido ANTES de exportar o banco. */
function inserir(sql, params = [], salvar = true) {
  run(sql, params);
  const id = ultimoId();
  if (salvar) salvarBanco();
  return id;
}

/* ---------- utilidades ---------- */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const agora = () => new Date().toISOString();
const hoje = () => new Date().toISOString().slice(0, 10);

function somenteDigitos(v) {
  return txt(v).replace(/\D/g, '');
}

/** Soma dias corridos a uma data 'AAAA-MM-DD'. Sem regra de mes: 30 dias e 30 dias. */
function somarDiasCorridos(iso, dias) {
  const [a, m, d] = txt(iso).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return txt(iso).slice(0, 10);
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

/**
 * Soma um prazo a uma data 'AAAA-MM-DD' e devolve outra data 'AAAA-MM-DD'.
 * Prazo multiplo de 30 anda de MES em MES mantendo o dia — e assim que o
 * crediario de loja funciona ("todo dia 10"). Qualquer outro prazo soma
 * dias corridos. Dia que nao existe no mes de destino cai no ultimo dia
 * (31/01 + 30 = 28/02). Trabalha so com numeros, sem fuso horario.
 */
function somarPrazo(iso, dias) {
  const [a, m, d] = txt(iso).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return txt(iso).slice(0, 10);
  if (dias === 0) return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  if (dias % 30 === 0) {
    let mes = m - 1 + dias / 30;
    const ano = a + Math.floor(mes / 12);
    mes = ((mes % 12) + 12) % 12;
    const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ultimoDia)).padStart(2, '0')}`;
  }

  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

function registrarLog(usuario, acao, detalhe) {
  try {
    run('INSERT INTO log (data, usuario, acao, detalhe) VALUES (?,?,?,?)', [
      agora(), txt(usuario), txt(acao), txt(detalhe)
    ]);
  } catch (e) { /* log nunca derruba a operacao */ }
}

/* =========================================================================
   ESTRUTURA DO BANCO
   ========================================================================= */

function criarEstrutura() {
  db.run(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE, senha TEXT, nome TEXT,
    perfil TEXT DEFAULT 'operador', ativo INTEGER DEFAULT 1, criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS perfis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, descricao TEXT, permissoes TEXT,
    sistema INTEGER DEFAULT 0, criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token TEXT PRIMARY KEY, usuario TEXT, nome TEXT, perfil TEXT, expira TEXT
  );

  CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT);

  CREATE TABLE IF NOT EXISTS categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS produtos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT, codigo_barras TEXT, descricao TEXT,
    categoria_id INTEGER, unidade TEXT DEFAULT 'UN',
    ncm TEXT, preco_custo REAL DEFAULT 0, preco_venda REAL DEFAULT 0,
    estoque REAL DEFAULT 0, estoque_minimo REAL DEFAULT 0,
    fracionado INTEGER DEFAULT 0, localizacao TEXT, fornecedor TEXT,
    ativo INTEGER DEFAULT 1, criado_em TEXT, atualizado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS estoque_mov (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produto_id INTEGER, tipo TEXT, quantidade REAL,
    saldo_anterior REAL, saldo_novo REAL, custo REAL,
    documento TEXT, observacao TEXT, usuario TEXT, data TEXT
  );

  CREATE TABLE IF NOT EXISTS clientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, tipo TEXT DEFAULT 'F', cpf_cnpj TEXT, rg_ie TEXT,
    telefone TEXT, email TEXT, cep TEXT, logradouro TEXT, numero TEXT,
    complemento TEXT, bairro TEXT, cidade TEXT, uf TEXT,
    limite_credito REAL DEFAULT 0, observacao TEXT,
    status TEXT DEFAULT 'ativo', criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS caixas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    abertura TEXT, fundo REAL DEFAULT 0, usuario_abertura TEXT,
    fechamento TEXT, usuario_fechamento TEXT,
    valor_informado REAL, valor_sistema REAL, diferenca REAL,
    observacao TEXT, situacao TEXT DEFAULT 'aberto'
  );

  CREATE TABLE IF NOT EXISTS caixa_mov (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caixa_id INTEGER, tipo TEXT, valor REAL, motivo TEXT, usuario TEXT, data TEXT
  );

  CREATE TABLE IF NOT EXISTS vendas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER, data TEXT, caixa_id INTEGER,
    cliente_id INTEGER, cliente_nome TEXT, cliente_doc TEXT,
    vendedor TEXT, subtotal REAL, desconto REAL DEFAULT 0,
    acrescimo REAL DEFAULT 0, total REAL, troco REAL DEFAULT 0,
    situacao TEXT DEFAULT 'finalizada',
    cancelado_motivo TEXT, cancelado_por TEXT, cancelado_em TEXT,
    observacao TEXT, usuario TEXT
  );

  CREATE TABLE IF NOT EXISTS venda_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, produto_id INTEGER, codigo TEXT, descricao TEXT,
    unidade TEXT, quantidade REAL, preco_unit REAL,
    desconto REAL DEFAULT 0, total REAL, custo REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS venda_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, forma TEXT, valor REAL, parcelas INTEGER DEFAULT 1, detalhe TEXT
  );

  CREATE TABLE IF NOT EXISTS receber (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, cliente_id INTEGER, cliente_nome TEXT,
    parcela INTEGER, total_parcelas INTEGER, documento TEXT,
    emissao TEXT, vencimento TEXT, valor REAL,
    valor_pago REAL DEFAULT 0, pago_em TEXT, forma_pagto TEXT,
    situacao TEXT DEFAULT 'aberto', usuario TEXT, observacao TEXT
  );

  CREATE TABLE IF NOT EXISTS operadoras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, apelido TEXT,
    taxa_debito REAL DEFAULT 0, taxa_credito REAL DEFAULT 0, taxa_parcelado REAL DEFAULT 0,
    prazo_debito INTEGER DEFAULT 1, prazo_credito INTEGER DEFAULT 30, prazo_parcela INTEGER DEFAULT 30,
    padrao INTEGER DEFAULT 0, status TEXT DEFAULT 'ativo', observacao TEXT, criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS cartao_recebiveis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, venda_numero INTEGER,
    operadora_id INTEGER, operadora TEXT, bandeira TEXT, forma TEXT,
    parcela INTEGER DEFAULT 1, total_parcelas INTEGER DEFAULT 1,
    data_venda TEXT, previsao TEXT,
    valor_bruto REAL, taxa_percentual REAL DEFAULT 0, valor_taxa REAL DEFAULT 0,
    valor_liquido REAL, valor_recebido REAL DEFAULT 0, recebido_em TEXT,
    situacao TEXT DEFAULT 'aberto', observacao TEXT, usuario TEXT
  );

  CREATE TABLE IF NOT EXISTS fornecedores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, cnpj TEXT, telefone TEXT, email TEXT, contato TEXT,
    cidade TEXT, uf TEXT, observacao TEXT,
    status TEXT DEFAULT 'ativo', criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS cp_categorias (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, ativo INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS cp_contas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fornecedor_id INTEGER, fornecedor TEXT, categoria_id INTEGER,
    documento TEXT, descricao TEXT, emissao TEXT, vencimento TEXT,
    valor REAL, valor_pago REAL DEFAULT 0, juros REAL DEFAULT 0, desconto REAL DEFAULT 0,
    pago_em TEXT, forma_pagto TEXT, situacao TEXT DEFAULT 'aberto',
    parcela INTEGER DEFAULT 1, total_parcelas INTEGER DEFAULT 1, grupo TEXT,
    observacao TEXT, usuario TEXT, criado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS orcamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero INTEGER, data TEXT, validade_dias INTEGER DEFAULT 15, validade TEXT,
    cliente_id INTEGER, cliente_nome TEXT, cliente_doc TEXT, cliente_telefone TEXT,
    vendedor TEXT, condicao_pagamento TEXT, prazo_entrega TEXT,
    subtotal REAL, desconto REAL DEFAULT 0, acrescimo REAL DEFAULT 0, total REAL,
    observacao TEXT, situacao TEXT DEFAULT 'aberto',
    venda_id INTEGER, venda_numero INTEGER, fechado_em TEXT,
    cancelado_motivo TEXT, cancelado_em TEXT,
    usuario TEXT, criado_em TEXT, atualizado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS orcamento_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orcamento_id INTEGER, produto_id INTEGER, codigo TEXT, descricao TEXT,
    unidade TEXT, quantidade REAL, preco_unit REAL, desconto REAL DEFAULT 0, total REAL
  );

  CREATE TABLE IF NOT EXISTS entradas_nf (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chave TEXT, numero TEXT, serie TEXT,
    fornecedor_id INTEGER, fornecedor TEXT, cnpj TEXT,
    emissao TEXT, valor_total REAL, valor_produtos REAL, valor_desconto REAL,
    itens_qtd INTEGER, parcelas_qtd INTEGER,
    gerou_contas INTEGER DEFAULT 0, atualizou_preco INTEGER DEFAULT 0,
    observacao TEXT, usuario TEXT, data_entrada TEXT
  );

  CREATE TABLE IF NOT EXISTS entrada_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entrada_id INTEGER, produto_id INTEGER,
    codigo_fornecedor TEXT, descricao TEXT, ncm TEXT, unidade TEXT,
    quantidade REAL, custo_unitario REAL, total REAL,
    preco_venda_novo REAL, criou_produto INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT, usuario TEXT, acao TEXT, detalhe TEXT
  );

  /* Certificado digital A1 da loja. So existe uma linha (id = 1).
     O arquivo .pfx fica em base64 e a senha cifrada — nunca saem pela API. */
  CREATE TABLE IF NOT EXISTS certificado (
    id INTEGER PRIMARY KEY,
    arquivo TEXT, senha TEXT, nome_arquivo TEXT,
    titular TEXT, cnpj TEXT, emissor TEXT, numero_serie TEXT,
    valido_de TEXT, valido_ate TEXT,
    enviado_em TEXT, enviado_por TEXT
  );

  /* Uma linha por NFC-e emitida (ou tentada). O XML autorizado fica aqui:
     a lei obriga a guardar por 5 anos. */
  CREATE TABLE IF NOT EXISTS nfce (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, ambiente INTEGER, modelo INTEGER DEFAULT 65,
    serie INTEGER, numero INTEGER, chave TEXT, codigo_numerico TEXT,
    tp_emis INTEGER DEFAULT 1,
    situacao TEXT DEFAULT 'pendente',
    status TEXT, motivo TEXT, protocolo TEXT, data_autorizacao TEXT,
    digest_value TEXT, qrcode TEXT, url_consulta TEXT,
    xml_assinado TEXT, xml_autorizado TEXT, xml_retorno TEXT,
    cancelamento_protocolo TEXT, cancelamento_motivo TEXT, cancelamento_em TEXT,
    tentativas INTEGER DEFAULT 0,
    criado_em TEXT, atualizado_em TEXT, usuario TEXT
  );

  /* [1.13] Expedicao: a venda NAO baixa o estoque; quem baixa e a entrega
     confirmada. Uma entrega por venda, com os itens e quanto ja foi
     entregue de cada um; cada confirmacao (total ou parcial) vira um
     movimento com quem recebeu. */
  CREATE TABLE IF NOT EXISTS entregas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    venda_id INTEGER, venda_numero INTEGER, data_venda TEXT,
    cliente_id INTEGER, cliente_nome TEXT, telefone TEXT, endereco TEXT,
    previsao TEXT, situacao TEXT DEFAULT 'pendente',
    observacao TEXT, criado_em TEXT, concluida_em TEXT, usuario TEXT
  );

  CREATE TABLE IF NOT EXISTS entrega_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entrega_id INTEGER, venda_item_id INTEGER, produto_id INTEGER,
    codigo TEXT, descricao TEXT, unidade TEXT,
    quantidade REAL, entregue REAL DEFAULT 0, custo REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS entrega_movs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entrega_id INTEGER, data TEXT, usuario TEXT, recebido_por TEXT,
    observacao TEXT, itens TEXT
  );

  /* Faixas de numeracao queimadas (inutilizacao) — a SEFAZ nao aceita buraco
     na sequencia sem justificativa. */
  CREATE TABLE IF NOT EXISTS nfce_inutilizacao (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ambiente INTEGER, serie INTEGER, de INTEGER, ate INTEGER,
    justificativa TEXT, protocolo TEXT, status TEXT, motivo TEXT,
    xml_retorno TEXT, data TEXT, usuario TEXT
  );

  /* [1.16] OBRAS: material que sai (a preco de custo) para as obras do dono,
     por obra, com saldo a acertar com a loja. Nao e venda fiscal, nao passa
     pelo caixa; o estoque baixa na saida. */
  CREATE TABLE IF NOT EXISTS obras (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, responsavel TEXT, endereco TEXT, telefone TEXT, observacao TEXT,
    status TEXT DEFAULT 'andamento', criado_em TEXT, usuario TEXT
  );
  CREATE TABLE IF NOT EXISTS obra_saidas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER, data TEXT, observacao TEXT, total REAL DEFAULT 0,
    usuario TEXT, criado_em TEXT
  );
  CREATE TABLE IF NOT EXISTS obra_saida_itens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saida_id INTEGER, produto_id INTEGER, codigo TEXT, descricao TEXT,
    unidade TEXT, quantidade REAL, custo_unit REAL, total REAL
  );
  CREATE TABLE IF NOT EXISTS obra_pagamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obra_id INTEGER, data TEXT, valor REAL, forma TEXT, observacao TEXT,
    usuario TEXT, criado_em TEXT
  );

  /* [1.16] anexo (boleto) das contas a pagar — guardado no proprio banco
     (base64), para o backup/restauracao levar junto. Um anexo por conta. */
  CREATE TABLE IF NOT EXISTS cp_anexos (
    conta_id INTEGER PRIMARY KEY,
    nome TEXT, tipo TEXT, dados TEXT, enviado_em TEXT, usuario TEXT
  );
  `);

  // indices que ajudam nas telas de consulta
  db.run(`
    CREATE INDEX IF NOT EXISTS ix_prod_barras ON produtos (codigo_barras);
    CREATE INDEX IF NOT EXISTS ix_prod_codigo ON produtos (codigo);
    CREATE INDEX IF NOT EXISTS ix_item_venda  ON venda_itens (venda_id);
    CREATE INDEX IF NOT EXISTS ix_pag_venda   ON venda_pagamentos (venda_id);
    CREATE INDEX IF NOT EXISTS ix_venda_data  ON vendas (data);
    CREATE INDEX IF NOT EXISTS ix_receber_venc ON receber (vencimento);
    CREATE INDEX IF NOT EXISTS ix_cp_venc     ON cp_contas (vencimento);
    CREATE INDEX IF NOT EXISTS ix_cp_grupo    ON cp_contas (grupo);
    CREATE INDEX IF NOT EXISTS ix_rec_prev    ON cartao_recebiveis (previsao);
    CREATE INDEX IF NOT EXISTS ix_rec_venda   ON cartao_recebiveis (venda_id);
    CREATE INDEX IF NOT EXISTS ix_orc_data    ON orcamentos (data);
    CREATE INDEX IF NOT EXISTS ix_orc_item    ON orcamento_itens (orcamento_id);
    CREATE INDEX IF NOT EXISTS ix_nfce_venda  ON nfce (venda_id);
    CREATE INDEX IF NOT EXISTS ix_nfce_chave  ON nfce (chave);
    CREATE INDEX IF NOT EXISTS ix_entregas_venda ON entregas (venda_id);
    CREATE INDEX IF NOT EXISTS ix_entregas_sit   ON entregas (situacao);
    CREATE INDEX IF NOT EXISTS ix_entrega_itens  ON entrega_itens (entrega_id);
    CREATE INDEX IF NOT EXISTS ix_entrega_prod   ON entrega_itens (produto_id);
    CREATE INDEX IF NOT EXISTS ix_obra_saida     ON obra_saidas (obra_id);
    CREATE INDEX IF NOT EXISTS ix_obra_saida_item ON obra_saida_itens (saida_id);
    CREATE INDEX IF NOT EXISTS ix_obra_pag       ON obra_pagamentos (obra_id);
  `);

  // colunas novas em bases que ja existiam antes destes modulos
  try { db.run('ALTER TABLE venda_pagamentos ADD COLUMN operadora_id INTEGER'); } catch (e) { /* ja existe */ }
  try { db.run('ALTER TABLE usuarios ADD COLUMN perfil_id INTEGER'); } catch (e) { /* ja existe */ }

  // [1.10] referencia da nota na Focus NFe (modo focus)
  try { db.run('ALTER TABLE nfce ADD COLUMN ref_externa TEXT'); } catch (e) { /* ja existe */ }
  try { db.run('ALTER TABLE nfce ADD COLUMN modo TEXT'); } catch (e) { /* ja existe */ }

  /* [1.11] O XML da nota de compra fica guardado: e ele que vai no pacote
     mensal para a contabilidade. E o evento de cancelamento da NFC-e
     (procEventoNFe), que a contabilidade tambem precisa. */
  try { db.run('ALTER TABLE entradas_nf ADD COLUMN xml TEXT'); } catch (e) { /* ja existe */ }
  try { db.run('ALTER TABLE nfce ADD COLUMN xml_cancelamento TEXT'); } catch (e) { /* ja existe */ }

  // campos fiscais dos produtos (chegaram com a NFC-e)
  // [1.11] marca/modelo: segundo nivel do relatorio de compras (fornecedor > marca > produto)
  ['cest TEXT', 'cfop TEXT', 'origem TEXT', 'csosn TEXT', 'cst TEXT',
   'unidade_tributavel TEXT', 'marca TEXT'].forEach((col) => {
    try { db.run('ALTER TABLE produtos ADD COLUMN ' + col); } catch (e) { /* ja existe */ }
  });
  // itens da venda guardam o que foi usado na NFC-e daquele dia,
  // porque o cadastro do produto pode mudar depois
  ['ncm TEXT', 'cfop TEXT', 'origem TEXT', 'csosn TEXT', 'cest TEXT'].forEach((col) => {
    try { db.run('ALTER TABLE venda_itens ADD COLUMN ' + col); } catch (e) { /* ja existe */ }
  });

  /* [1.14] sessao que ainda precisa trocar a senha padrao (na internet nao
     passa dai ate trocar) e IP de onde o login veio */
  try { db.run('ALTER TABLE sessoes ADD COLUMN trocar INTEGER DEFAULT 0'); } catch (e) { /* ja existe */ }
  try { db.run('ALTER TABLE sessoes ADD COLUMN ip TEXT'); } catch (e) { /* ja existe */ }

  // [1.16] contas a pagar: forma prevista (boleto/pix) e os dados do PIX
  try { db.run('ALTER TABLE cp_contas ADD COLUMN forma_prevista TEXT'); } catch (e) { /* ja existe */ }
  try { db.run('ALTER TABLE cp_contas ADD COLUMN pix_dados TEXT'); } catch (e) { /* ja existe */ }
  // [1.17] codigo de barras / linha digitavel do boleto
  try { db.run('ALTER TABLE cp_contas ADD COLUMN boleto_linha TEXT'); } catch (e) { /* ja existe */ }
}

/* ---------- dados iniciais ---------- */
const CONFIG_PADRAO = {
  loja_nome: 'RVL MATERIAL DE CONSTRUCAO LTDA',
  loja_fantasia: 'RVL MATERIAL DE CONSTRUCAO',
  loja_cnpj: '68114805000108',
  loja_ie: '',                        // preencher quando sair a inscricao estadual
  loja_telefone: '(75) 8125-6013',
  loja_endereco: 'V AC BR 420 SENTIDO MUTUIPE, 2 - TERREO',
  loja_bairro: 'CENTRO',
  loja_cidade: 'LAJE',
  loja_uf: 'BA',
  loja_cep: '45490000',
  cupom_rodape: 'Obrigado pela preferencia! Volte sempre.',
  cupom_cabecalho: '',

  // impressora — padrao ajustado para a Epson TM-T20 (termica 80mm)
  impressora_modelo: 'EPSON TM-T20',
  impressora_nome: 'EPSON TM-T20 Receipt',
  cupom_largura: '80',
  cupom_fonte: '11',
  cupom_margem: '3',
  cupom_vias: '1',
  cupom_linhas_fim: '4',
  cupom_auto_imprimir: '1',
  venda_permite_estoque_negativo: '1',
  venda_exige_caixa_aberto: '1',

  /* ---------- NFC-e ----------
     Nada aqui liga a emissao sozinho: enquanto nfce_ativo for '0' o sistema
     continua imprimindo so o cupom interno. */
  nfce_ativo: '0',
  nfce_ambiente: '2',                 // 2 = homologacao (teste). 1 = producao (vale de verdade)
  nfce_serie: '1',
  nfce_proximo_numero: '1',
  /* [1.9.5] Um par ID+CSC POR AMBIENTE. Homologacao e producao tem CSC
     diferentes, e o sistema escolhe o par certo pelo ambiente ligado — antes
     era um par so, e trocar de ambiente exigia trocar o CSC na mao. */
  nfce_csc_id_homologacao: '',
  nfce_csc_homologacao: '',
  nfce_csc_id_producao: '',
  nfce_csc_producao: '',
  nfce_csc_id: '',                    // (antigo) migra para o par do ambiente atual
  nfce_csc: '',                       // (antigo) idem

  /* [1.10] Como transmitir: 'direto' (o sistema assina e fala com a SEFAZ)
     ou 'focus' (manda a venda para a API da Focus NFe, que assina, transmite
     e guarda; certificado e CSC ficam no painel deles). */
  nfce_modo: 'direto',
  focus_token_homologacao: '',
  focus_token_producao: '',
  focus_base_url: '',                 // vazio = oficial; so para testes
  nfce_qrcode_versao: '2',
  nfce_crt: '1',                      // 1 = Simples Nacional
  nfce_municipio_ibge: '2918803',     // LAJE / BA (2918605 e Jussiape)
  nfce_cnae: '',
  nfce_ncm_padrao: '68109900',
  nfce_cfop_padrao: '5102',           // venda de mercadoria adquirida de terceiros, dentro do estado
  nfce_origem_padrao: '0',            // 0 = nacional
  nfce_csosn_padrao: '102',           // Simples Nacional, sem permissao de credito
  nfce_cst_pis: '49',
  nfce_cst_cofins: '49',
  nfce_info_complementar: '',
  nfce_emitir_automatico: '0',        // 0 = pergunta (cartao emite sem perguntar) | 1 = emite sozinho | 2 = pergunta ate no cartao
  nfce_contingencia: '0',
  // enderecos dos servicos da SEFAZ — conferir no portal antes de ligar em producao
  /* A Bahia NAO tem autorizador proprio de NFC-e: quem autoriza e a SEFAZ
     Virtual do Rio Grande do Sul (SVRS), nos dois ambientes. O nfe.sefaz.ba
     atende so NF-e modelo 55 — mandar a NFC-e para la da rejeicao 702.
     Da Bahia ficam so as paginas de consulta e QR Code. */
  nfce_ws_producao: 'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
  nfce_ws_homologacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
  nfce_ws_status_producao: 'https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
  nfce_ws_status_homologacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
  nfce_ws_evento_producao: 'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  nfce_ws_evento_homologacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
  nfce_ws_inutilizacao_producao: 'https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
  nfce_ws_inutilizacao_homologacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
  nfce_url_qrcode_producao: 'http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx',
  nfce_url_qrcode_homologacao: 'http://hnfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx',
  nfce_url_consulta_producao: 'http://www.sefaz.ba.gov.br/nfce/consulta',
  nfce_url_consulta_homologacao: 'http://hinternet.sefaz.ba.gov.br/nfce/consulta',

  /* [1.11] Aviso semanal de notas: quanto entrou de compra com nota, quanto
     passou no cartao e quanto de NFC-e ja foi emitido no mes. O minimo a
     emitir e o que passou no cartao (a operadora informa tudo a SEFAZ) mais
     uma folga. Quem ve: perfis com acesso a NFC-e / Certificado. */
  aviso_notas_ativo: '1',
  aviso_notas_margem: '3',            // % de folga sobre o cartao (30 mil -> 30,9 mil)
  aviso_notas_incluir_pix: '0',       // '1' = PIX conta como cartao no minimo
  aviso_notas_dia: '1',               // dia da semana em que o aviso aparece (1 = segunda ... 7 = domingo)

  /* [1.13] Expedicao: a venda nao baixa o estoque; a entrega confirmada baixa.
     'depois' = toda venda vai para a expedicao (padrao); 'agora' = o caixa
     ja marca como entregue (cliente levou no balcao). O PDV deixa trocar
     venda a venda. */
  venda_entrega_padrao: 'depois'
};

/* Chaves que NUNCA podem sair pela API /api/config: ela e liberada para
   qualquer usuario logado. O CSC assina o QR Code — vazou, acabou. */
const CONFIG_SECRETA = ['nfce_csc', 'nfce_csc_homologacao', 'nfce_csc_producao',
  'focus_token_homologacao', 'focus_token_producao'];

const CP_CATEGORIAS_PADRAO = [
  'MERCADORIA / FORNECEDORES', 'ALUGUEL', 'ENERGIA ELETRICA', 'AGUA',
  'TELEFONE E INTERNET', 'FOLHA DE PAGAMENTO', 'PRO-LABORE', 'IMPOSTOS E TAXAS',
  'FRETE E ENTREGA', 'COMBUSTIVEL', 'MANUTENCAO E REPAROS', 'MATERIAL DE ESCRITORIO',
  'CONTABILIDADE', 'SEGUROS', 'EMPRESTIMO / FINANCIAMENTO', 'MARKETING E PROPAGANDA',
  'DESPESAS BANCARIAS', 'OUTRAS DESPESAS'
];

const CATEGORIAS_PADRAO = [
  'CIMENTO E ARGAMASSA', 'AREIA E BRITA', 'TIJOLO E BLOCO', 'FERRO E ACO',
  'HIDRAULICA', 'ELETRICA', 'TINTAS E ACESSORIOS', 'MADEIRA',
  'FERRAMENTAS', 'PISOS E REVESTIMENTOS', 'TELHAS E COBERTURA',
  'FERRAGENS E FIXACAO', 'ACABAMENTO', 'DIVERSOS'
];

function semear() {
  // perfis de acesso — criados uma vez; depois o usuario edita como quiser
  PERFIS_PADRAO.forEach((p) => {
    const existe = one('SELECT id FROM perfis WHERE upper(nome) = ?', [p.nome.toUpperCase()]);
    if (!existe) {
      run(`INSERT INTO perfis (nome, descricao, permissoes, sistema, criado_em)
           VALUES (?,?,?,?,?)`,
        [p.nome, p.descricao, JSON.stringify(p.permissoes),
         p.nome === 'Administrador' ? 1 : 0, agora()]);
    }
  });
  const perfilAdmin = one("SELECT id FROM perfis WHERE nome = 'Administrador'");
  const perfilCaixa = one("SELECT id FROM perfis WHERE nome = 'Operador de Caixa'");

  /* [1.12] Quem vende tem que poder emitir a nota da venda: perfis criados
     antes da NFC-e existir tinham acesso ao PDV sem a acao "Emitir NFC-e",
     e a venda saia sem nota ("Seu perfil nao tem permissao"). Roda uma vez.
     Tambem da ao Gerente o relatorio novo (Sugestao de Compra). */
  /* [1.16] o Gerente passa a ver o modulo Obras (material do dono). Roda uma vez. */
  const ajuste16 = one("SELECT valor FROM config WHERE chave = 'perfis_ajuste_1_16'");
  if (!ajuste16 || txt(ajuste16.valor) !== '1') {
    let n = 0;
    all('SELECT id, nome, permissoes FROM perfis').forEach((p) => {
      let perm; try { perm = JSON.parse(p.permissoes) || {}; } catch (e) { return; }
      if (perm.todos === true || perm.obras === true) return;
      if (txt(p.nome).toUpperCase() === 'GERENTE') {
        perm.obras = true;
        run('UPDATE perfis SET permissoes = ? WHERE id = ?', [JSON.stringify(perm), p.id]);
        n++;
      }
    });
    run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('perfis_ajuste_1_16', '1')");
    if (n) console.log(`Perfis ajustados: ${n} ganharam o modulo Obras.`);
  }

  const ajuste13 = one("SELECT valor FROM config WHERE chave = 'perfis_ajuste_1_13'");
  if (!ajuste13 || txt(ajuste13.valor) !== '1') {
    let n = 0;
    all('SELECT id, nome, permissoes FROM perfis').forEach((p) => {
      let perm; try { perm = JSON.parse(p.permissoes) || {}; } catch (e) { return; }
      if (perm.todos === true || perm.expedicao === true) return;
      const nome = txt(p.nome).toUpperCase();
      if (nome === 'GERENTE' || nome === 'ESTOQUISTA' || perm.estoque === true) {
        perm.expedicao = true;
        run('UPDATE perfis SET permissoes = ? WHERE id = ?', [JSON.stringify(perm), p.id]);
        n++;
      }
    });
    run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('perfis_ajuste_1_13', '1')");
    if (n) console.log(`Perfis ajustados: ${n} ganharam Expedicao / Entregas.`);
  }

  const ajusteFeito = one("SELECT valor FROM config WHERE chave = 'perfis_ajuste_1_12'");
  if (!ajusteFeito || txt(ajusteFeito.valor) !== '1') {
    let ajustados = 0;
    all('SELECT id, nome, permissoes FROM perfis').forEach((p) => {
      let perm;
      try { perm = JSON.parse(p.permissoes) || {}; } catch (e) { return; }
      if (perm.todos === true) return;
      let mudou = false;
      if (perm.pdv === true && perm.nfce_emitir !== true) { perm.nfce_emitir = true; mudou = true; }
      if (txt(p.nome).toUpperCase() === 'GERENTE' && perm.relCompras !== true) { perm.relCompras = true; mudou = true; }
      if (mudou) {
        run('UPDATE perfis SET permissoes = ? WHERE id = ?', [JSON.stringify(perm), p.id]);
        ajustados++;
      }
    });
    run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('perfis_ajuste_1_12', '1')");
    if (ajustados) console.log(`Perfis ajustados: ${ajustados} (quem vende agora emite NFC-e).`);
  }

  const u = one('SELECT COUNT(*) AS n FROM usuarios');
  if (!u || !u.n) {
    run(`INSERT INTO usuarios (usuario, senha, nome, perfil, perfil_id, ativo, criado_em)
         VALUES (?,?,?,?,?,1,?)`,
      ['admin', senhaHash('admin'), 'Administrador', 'admin',
       perfilAdmin ? perfilAdmin.id : null, agora()]);
    run(`INSERT INTO usuarios (usuario, senha, nome, perfil, perfil_id, ativo, criado_em)
         VALUES (?,?,?,?,?,1,?)`,
      ['caixa', senhaHash('caixa'), 'Operador de Caixa', 'operador',
       perfilCaixa ? perfilCaixa.id : null, agora()]);
  } else {
    // bases antigas: liga cada usuario a um perfil, sem tirar acesso de ninguem
    all('SELECT id, perfil FROM usuarios WHERE perfil_id IS NULL').forEach((x) => {
      const alvo = x.perfil === 'admin' ? perfilAdmin : perfilCaixa;
      if (alvo) run('UPDATE usuarios SET perfil_id = ? WHERE id = ?', [alvo.id, x.id]);
    });
  }

  Object.entries(CONFIG_PADRAO).forEach(([k, v]) => {
    const existe = one('SELECT chave FROM config WHERE chave = ?', [k]);
    if (!existe) run('INSERT INTO config (chave, valor) VALUES (?,?)', [k, v]);
  });

  corrigirConfigErrada();

  const c = one('SELECT COUNT(*) AS n FROM categorias');
  if (!c || !c.n) {
    CATEGORIAS_PADRAO.forEach((nome) =>
      run('INSERT INTO categorias (nome, ativo) VALUES (?,1)', [nome]));
  }

  const cp = one('SELECT COUNT(*) AS n FROM cp_categorias');
  if (!cp || !cp.n) {
    CP_CATEGORIAS_PADRAO.forEach((nome) =>
      run('INSERT INTO cp_categorias (nome, ativo) VALUES (?,1)', [nome]));
  }

  const p = one('SELECT COUNT(*) AS n FROM produtos');
  if (!p || !p.n) semearProdutosExemplo();

  salvarBanco();
}

/**
 * Conserta valores que sairam errados em versoes anteriores.
 * So troca quando o valor gravado e EXATAMENTE o errado conhecido —
 * assim nao atropela nada que o usuario ja tenha ajustado na mao.
 */
function corrigirConfigErrada() {
  const trocas = [
    // 2918605 e Jussiape; Laje/BA e 2918803
    ['nfce_municipio_ibge', '2918605', '2918803'],
    // NFC-e da Bahia e autorizada pela SEFAZ Virtual do RS, nao pelo
    // autorizador de NF-e da propria BA (isso dava a rejeicao 702)
    ['nfce_ws_producao',
      'https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
      'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx'],
    ['nfce_ws_homologacao',
      'https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx',
      'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx'],
    ['nfce_ws_status_producao',
      'https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
      'https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx'],
    ['nfce_ws_status_homologacao',
      'https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx',
      'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx'],
    ['nfce_ws_evento_producao',
      'https://nfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
      'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx'],
    ['nfce_ws_evento_homologacao',
      'https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx',
      'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx'],
    ['nfce_ws_inutilizacao_producao',
      'https://nfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx',
      'https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx'],
    ['nfce_ws_inutilizacao_homologacao',
      'https://hnfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx',
      'https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx'],
    ['nfce_url_qrcode_producao',
      'http://www.sefaz.ba.gov.br/nfce/qrcode',
      'http://nfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx'],
    ['nfce_url_qrcode_homologacao',
      'http://hinternet.sefaz.ba.gov.br/nfce/qrcode',
      'http://hnfe.sefaz.ba.gov.br/servicos/nfce/modulos/geral/NFCEC_consulta_chave_acesso.aspx']
  ];

  /* [1.9.5] O CSC antigo (um so) vira o CSC do ambiente que estava ligado
     quando a loja atualizou — e o que faz sentido: era com ele que a loja
     estava tentando emitir. Roda uma vez; depois os campos antigos ficam
     vazios e nao sao mais usados. */
  const antigoCsc = one("SELECT valor FROM config WHERE chave = 'nfce_csc'");
  const antigoId = one("SELECT valor FROM config WHERE chave = 'nfce_csc_id'");
  if (antigoCsc && txt(antigoCsc.valor)) {
    const amb = one("SELECT valor FROM config WHERE chave = 'nfce_ambiente'");
    const sufixo = amb && txt(amb.valor) === '1' ? 'producao' : 'homologacao';
    const jaTem = one('SELECT valor FROM config WHERE chave = ?', ['nfce_csc_' + sufixo]);
    if (!jaTem || !txt(jaTem.valor)) {
      run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)',
        ['nfce_csc_' + sufixo, txt(antigoCsc.valor)]);
      run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)',
        ['nfce_csc_id_' + sufixo, antigoId ? txt(antigoId.valor) : '']);
      console.log('CSC antigo movido para o ambiente de ' + sufixo + '.');
    }
    run("UPDATE config SET valor = '' WHERE chave IN ('nfce_csc', 'nfce_csc_id')");
  }

  /* [1.10.2] Da 1.9.4 ate a 1.10.1 o sistema tirava os hifens do CSC ao
     gravar. Errado: o CSC vem do portal da SEFAZ no formato
     xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx e os hifens fazem parte dele — a
     SEFAZ calcula o hash do QR Code com eles (sem, rejeicao 464). Um CSC
     gravado com exatamente 32 caracteres hexadecimais so pode ter passado
     por essa limpeza, entao os hifens voltam para o lugar (8-4-4-4-12).
     Roda uma unica vez; o que for gravado daqui em diante ja fica certo. */
  const jaCorrigiu = one("SELECT valor FROM config WHERE chave = 'nfce_csc_hifens_corrigidos'");
  if (!jaCorrigiu || txt(jaCorrigiu.valor) !== '1') {
    ['nfce_csc_homologacao', 'nfce_csc_producao'].forEach((chave) => {
      const c = one('SELECT valor FROM config WHERE chave = ?', [chave]);
      const v = c ? txt(c.valor) : '';
      if (/^[0-9A-Fa-f]{32}$/.test(v)) {
        const comHifens = [v.slice(0, 8), v.slice(8, 12), v.slice(12, 16), v.slice(16, 20), v.slice(20)].join('-');
        run('UPDATE config SET valor = ? WHERE chave = ?', [comHifens, chave]);
        console.log('Hifens devolvidos ao CSC (' + chave.replace('nfce_csc_', '') + ').');
      }
    });
    run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('nfce_csc_hifens_corrigidos', '1')");
  }

  /* [1.12] Quatro NCMs dos produtos de exemplo nao existiam na tabela
     (erro de digitacao de versoes antigas). Troca pelo codigo certo da
     mesma familia, so onde esta exatamente o codigo errado. */
  let ncmsCorrigidos = 0;
  [['72171000', '72171090'], ['39172390', '39172300'], ['39251090', '39251000'], ['85366900', '85366990']]
    .forEach(([errado, certo]) => {
      const n = one('SELECT COUNT(*) AS n FROM produtos WHERE ncm = ?', [errado]);
      if (n && n.n) { run('UPDATE produtos SET ncm = ? WHERE ncm = ?', [certo, errado]); ncmsCorrigidos += n.n; }
    });
  if (ncmsCorrigidos) console.log('NCM de ' + ncmsCorrigidos + ' produto(s) de exemplo corrigido (codigo que nao existia na tabela).');

  let mudou = 0;
  trocas.forEach(([chave, errado, certo]) => {
    const c = one('SELECT valor FROM config WHERE chave = ?', [chave]);
    if (c && txt(c.valor) === errado) {
      run('UPDATE config SET valor = ? WHERE chave = ?', [certo, chave]);
      mudou++;
    }
  });
  if (mudou) console.log('Configuracao da NFC-e corrigida em ' + mudou + ' campo(s).');
}

function semearProdutosExemplo() {
  // Produtos de demonstracao para o sistema abrir ja utilizavel.
  // Podem ser excluidos em Cadastros > Produtos.
  const exemplos = [
    ['0001', '7891000000011', 'CIMENTO CP II 50KG', 'CIMENTO E ARGAMASSA', 'SC', '25232910', 28.90, 38.50, 320, 50],
    ['0002', '7891000000028', 'ARGAMASSA AC-I INTERNA 20KG', 'CIMENTO E ARGAMASSA', 'SC', '38245000', 12.40, 18.90, 180, 40],
    ['0003', '7891000000035', 'ARGAMASSA AC-II EXTERNA 20KG', 'CIMENTO E ARGAMASSA', 'SC', '38245000', 15.80, 23.50, 140, 40],
    ['0004', '7891000000042', 'CAL HIDRATADA 20KG', 'CIMENTO E ARGAMASSA', 'SC', '25221000', 9.20, 14.90, 90, 20],
    ['0005', '7891000000059', 'AREIA MEDIA LAVADA M3', 'AREIA E BRITA', 'M3', '25051000', 75.00, 120.00, 40, 5],
    ['0006', '7891000000066', 'BRITA 1 M3', 'AREIA E BRITA', 'M3', '25171000', 90.00, 145.00, 30, 5],
    ['0007', '7891000000073', 'TIJOLO CERAMICO 8 FUROS', 'TIJOLO E BLOCO', 'UN', '69041000', 0.85, 1.45, 6000, 1000],
    ['0008', '7891000000080', 'BLOCO ESTRUTURAL 14X19X39', 'TIJOLO E BLOCO', 'UN', '68101100', 3.10, 4.90, 1200, 300],
    ['0009', '7891000000097', 'VERGALHAO CA-50 8MM 12M', 'FERRO E ACO', 'BR', '72142000', 32.00, 47.90, 250, 50],
    ['0010', '7891000000103', 'VERGALHAO CA-50 10MM 12M', 'FERRO E ACO', 'BR', '72142000', 49.00, 72.00, 180, 40],
    ['0011', '7891000000110', 'ARAME RECOZIDO 18 KG', 'FERRO E ACO', 'KG', '72171090', 14.50, 22.90, 60, 10],
    ['0012', '7891000000127', 'TUBO PVC ESGOTO 100MM 6M', 'HIDRAULICA', 'BR', '39172300', 68.00, 98.00, 45, 10],
    ['0013', '7891000000134', 'TUBO PVC SOLDAVEL 25MM 6M', 'HIDRAULICA', 'BR', '39172300', 18.90, 29.90, 80, 15],
    ['0014', '7891000000141', 'JOELHO PVC SOLDAVEL 25MM', 'HIDRAULICA', 'UN', '39174090', 1.20, 2.50, 400, 50],
    ['0015', '7891000000158', 'CAIXA DAGUA 1000L', 'HIDRAULICA', 'UN', '39251000', 420.00, 610.00, 12, 3],
    ['0016', '7891000000165', 'FIO FLEXIVEL 2,5MM ROLO 100M', 'ELETRICA', 'RL', '85444200', 189.00, 279.00, 25, 5],
    ['0017', '7891000000172', 'DISJUNTOR MONOPOLAR 25A', 'ELETRICA', 'UN', '85362000', 12.00, 21.90, 70, 15],
    ['0018', '7891000000189', 'TOMADA 2P+T 10A COM PLACA', 'ELETRICA', 'UN', '85366990', 8.50, 15.90, 120, 20],
    ['0019', '7891000000196', 'TINTA ACRILICA FOSCA 18L', 'TINTAS E ACESSORIOS', 'LT', '32091010', 178.00, 259.00, 35, 8],
    ['0020', '7891000000202', 'MASSA CORRIDA PVA 18L', 'TINTAS E ACESSORIOS', 'LT', '32091010', 62.00, 94.90, 40, 10],
    ['0021', '7891000000219', 'SELADOR ACRILICO 18L', 'TINTAS E ACESSORIOS', 'LT', '32091010', 85.00, 129.00, 28, 6],
    ['0022', '7891000000226', 'ROLO DE LA 23CM COM CABO', 'TINTAS E ACESSORIOS', 'UN', '96031000', 11.00, 19.90, 60, 10],
    ['0023', '7891000000233', 'PORCELANATO ACETINADO 60X60 M2', 'PISOS E REVESTIMENTOS', 'M2', '69072300', 42.00, 69.90, 300, 50],
    ['0024', '7891000000240', 'REJUNTE ACRILICO 1KG', 'PISOS E REVESTIMENTOS', 'UN', '38245000', 4.80, 9.50, 200, 40],
    ['0025', '7891000000257', 'TELHA FIBROCIMENTO 2,44X1,10', 'TELHAS E COBERTURA', 'UN', '68114000', 58.00, 89.00, 90, 20],
    ['0026', '7891000000264', 'MADEIRA CAIBRO 5X6 3M', 'MADEIRA', 'UN', '44071100', 22.00, 36.00, 150, 30],
    ['0027', '7891000000271', 'PREGO 17X27 KG', 'FERRAGENS E FIXACAO', 'KG', '73170020', 11.00, 18.50, 80, 15],
    ['0028', '7891000000288', 'PARAFUSO BUCHA 8MM PACOTE 50', 'FERRAGENS E FIXACAO', 'PC', '73181500', 9.00, 16.90, 100, 20],
    ['0029', '7891000000295', 'TRENA 5M', 'FERRAMENTAS', 'UN', '90178010', 14.00, 26.90, 40, 10],
    ['0030', '7891000000301', 'CARRINHO DE MAO 60L', 'FERRAMENTAS', 'UN', '87168000', 165.00, 239.00, 15, 4]
  ];

  exemplos.forEach((p) => {
    const cat = one('SELECT id FROM categorias WHERE nome = ?', [p[3]]);
    run(`INSERT INTO produtos
      (codigo, codigo_barras, descricao, categoria_id, unidade, ncm,
       preco_custo, preco_venda, estoque, estoque_minimo, fracionado, ativo, criado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [p[0], p[1], p[2], cat ? cat.id : null, p[4], p[5], p[6], p[7], p[8], p[9],
       ['M3', 'M2', 'KG', 'M'].includes(p[4]) ? 1 : 0, agora()]);
  });
}

/* =========================================================================
   AUTENTICACAO
   ========================================================================= */

function senhaHash(senha) {
  return crypto.createHash('sha256').update('lojacon:' + senha).digest('hex');
}

const sessoes = new Map();

function restaurarSessoes() {
  const agoraIso = agora();
  sessoes.clear();
  run('DELETE FROM sessoes WHERE expira < ?', [agoraIso]);
  all('SELECT * FROM sessoes').forEach((s) => {
    sessoes.set(s.token, { usuario: s.usuario, nome: s.nome, perfil: s.perfil, expira: s.expira,
      trocar: num(s.trocar) ? 1 : 0 });
  });
}

function novaSessao(u, trocar, ip) {
  const token = crypto.randomBytes(24).toString('hex');
  const expira = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const s = { usuario: u.usuario, nome: u.nome, perfil: u.perfil, expira, trocar: trocar ? 1 : 0 };
  sessoes.set(token, s);
  run('INSERT OR REPLACE INTO sessoes (token, usuario, nome, perfil, expira, trocar, ip) VALUES (?,?,?,?,?,?,?)',
    [token, s.usuario, s.nome, s.perfil, expira, s.trocar, txt(ip)]);
  salvarBanco();
  return token;
}

/* =========================================================================
   [1.14] SENHA PADRAO E FORCA BRUTA
   Na internet qualquer um acha o endereco. Dois cuidados simples:
   - quem entra com a senha padrao (admin/admin, caixa/caixa, senha igual ao
     login...) e obrigado a trocar antes de fazer qualquer outra coisa;
   - quem erra a senha muitas vezes seguidas espera um tempo.
   ========================================================================= */

const SENHAS_FRACAS = ['admin', 'caixa', '1234', '12345', '123456', 'senha', 'loja', 'rvl'];

/** A senha e a que veio de fabrica (ou fraca demais para ficar na internet)? */
function senhaPadrao(usuario, senha) {
  const s = txt(senha).toLowerCase();
  return s === txt(usuario).toLowerCase() || SENHAS_FRACAS.includes(s);
}

function ipDe(req) {
  return txt(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

const ERROS_LOGIN = new Map();   // chave (ip ou usuario) -> { n, ate }
const LIMITE_POR_IP = { n: 10, min: 15 };
const LIMITE_POR_USUARIO = { n: 8, min: 10 };

function bloqueioDeLogin(chave) {
  const e = ERROS_LOGIN.get(chave);
  if (!e) return 0;
  if (e.ate && e.ate > Date.now()) return Math.ceil((e.ate - Date.now()) / 60000);
  if (e.ate && e.ate <= Date.now()) ERROS_LOGIN.delete(chave);
  return 0;
}

function registrarErroDeLogin(chave, limite) {
  const e = ERROS_LOGIN.get(chave) || { n: 0, ate: 0, desde: Date.now() };
  // erros muito antigos nao contam mais
  if (Date.now() - e.desde > limite.min * 60000) { e.n = 0; e.desde = Date.now(); }
  e.n++;
  if (e.n >= limite.n) e.ate = Date.now() + limite.min * 60000;
  ERROS_LOGIN.set(chave, e);
  return e.n >= limite.n;
}

// limpeza, para o mapa nao crescer para sempre
setInterval(() => {
  const agoraMs = Date.now();
  ERROS_LOGIN.forEach((e, k) => { if ((e.ate && e.ate < agoraMs) || agoraMs - e.desde > 3600000) ERROS_LOGIN.delete(k); });
}, 10 * 60000).unref();

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const s = sessoes.get(token);
  if (!s || s.expira < agora()) {
    return res.status(401).json({ erro: 'Sessao expirada. Faca login de novo.' });
  }
  req.usuario = s;
  next();
}

/* =========================================================================
   PERFIS DE ACESSO
   Cada perfil guarda um objeto de permissoes { chave: true }.
   O perfil com { todos: true } enxerga o sistema inteiro.
   ========================================================================= */

const MODULOS = [
  { chave: 'dashboard', nome: 'Painel', grupo: 'Operação' },
  { chave: 'pdv', nome: 'Frente de Caixa', grupo: 'Operação' },
  { chave: 'vendas', nome: 'Vendas / Cupons', grupo: 'Operação' },
  { chave: 'orcamentos', nome: 'Orçamentos', grupo: 'Operação' },
  { chave: 'caixa', nome: 'Caixa', grupo: 'Operação' },
  { chave: 'entradaNota', nome: 'Entrada de Nota (compra)', grupo: 'Operação' },
  { chave: 'expedicao', nome: 'Expedição / Entregas', grupo: 'Operação' },
  { chave: 'obras', nome: 'Obras (material do dono)', grupo: 'Operação' },

  { chave: 'receber', nome: 'Contas a Receber', grupo: 'Financeiro' },
  { chave: 'cartao', nome: 'Recebíveis de Cartão', grupo: 'Financeiro' },
  { chave: 'pagar', nome: 'Contas a Pagar', grupo: 'Financeiro' },
  { chave: 'fluxo', nome: 'Fluxo de Caixa', grupo: 'Financeiro' },

  { chave: 'produtos', nome: 'Produtos', grupo: 'Cadastros' },
  { chave: 'estoque', nome: 'Estoque', grupo: 'Cadastros' },
  { chave: 'clientes', nome: 'Clientes', grupo: 'Cadastros' },
  { chave: 'fornecedores', nome: 'Fornecedores', grupo: 'Cadastros' },
  { chave: 'operadoras', nome: 'Maquininhas', grupo: 'Cadastros' },

  { chave: 'relVendas', nome: 'Relatório de Vendas', grupo: 'Relatórios' },
  { chave: 'relProdutos', nome: 'Produtos / Curva ABC', grupo: 'Relatórios' },
  { chave: 'relClientes', nome: 'Vendas por Cliente', grupo: 'Relatórios' },
  { chave: 'relDespesas', nome: 'Despesas', grupo: 'Relatórios' },
  { chave: 'relCompras', nome: 'Sugestão de Compra (mais vendidos por fornecedor)', grupo: 'Relatórios' },

  { chave: 'fiscal', nome: 'NFC-e / Certificado digital', grupo: 'Sistema' },
  { chave: 'config', nome: 'Configurações', grupo: 'Sistema' }
];

const ACOES = [
  { chave: 'venda_desconto', nome: 'Dar desconto na venda', dica: 'sem isso o botão de desconto some do PDV' },
  { chave: 'venda_preco', nome: 'Alterar o preço no PDV', dica: 'trava o preço de venda do cadastro' },
  { chave: 'venda_cancelar', nome: 'Cancelar venda', dica: 'devolve o estoque' },
  { chave: 'excluir', nome: 'Excluir cadastros e lançamentos', dica: 'produtos, clientes, contas…' },
  { chave: 'preco_reajuste', nome: 'Reajustar preços em lote', dica: '' },
  { chave: 'usuarios', nome: 'Gerenciar usuários e perfis', dica: '' },
  { chave: 'backup', nome: 'Baixar backup do sistema', dica: '' },
  { chave: 'nfce_emitir', nome: 'Emitir NFC-e', dica: 'transmitir a nota para a SEFAZ' },
  { chave: 'nfce_cancelar', nome: 'Cancelar NFC-e', dica: 'evento de cancelamento na SEFAZ' }
];

const TODAS_CHAVES = [...MODULOS, ...ACOES].map((m) => m.chave);

function permissoesDe(lista) {
  const p = {};
  lista.forEach((c) => { p[c] = true; });
  return p;
}

const PERFIS_PADRAO = [
  {
    nome: 'Administrador',
    descricao: 'Acesso total ao sistema',
    permissoes: { todos: true }
  },
  {
    nome: 'Gerente',
    descricao: 'Tudo, menos usuários, backup, configurações e certificado',
    permissoes: permissoesDe(
      TODAS_CHAVES.filter((c) => !['config', 'usuarios', 'backup', 'fiscal'].includes(c)))
  },
  {
    nome: 'Operador de Caixa',
    descricao: 'Vende e opera o caixa; não mexe em preço nem em cadastro',
    permissoes: permissoesDe(['dashboard', 'pdv', 'vendas', 'orcamentos', 'caixa', 'clientes',
      'nfce_emitir'])
  },
  {
    nome: 'Vendedor',
    descricao: 'Vende e consulta produtos e estoque',
    permissoes: permissoesDe(['dashboard', 'pdv', 'vendas', 'orcamentos', 'produtos', 'estoque',
      'clientes', 'venda_desconto', 'nfce_emitir'])
  },
  {
    nome: 'Financeiro',
    descricao: 'Contas a pagar e receber, cartão e relatórios; não vende',
    permissoes: permissoesDe(['dashboard', 'receber', 'cartao', 'pagar', 'fluxo',
      'fornecedores', 'operadoras', 'clientes',
      'relVendas', 'relProdutos', 'relClientes', 'relDespesas'])
  },
  {
    nome: 'Estoquista',
    descricao: 'Cuida de produtos, estoque e entregas; não vende nem vê dinheiro',
    permissoes: permissoesDe(['dashboard', 'produtos', 'estoque', 'fornecedores',
      'entradaNota', 'expedicao', 'relProdutos'])
  }
];

function permissoesDoUsuario(login) {
  const u = one('SELECT perfil, perfil_id FROM usuarios WHERE lower(usuario) = ?',
    [txt(login).toLowerCase()]);
  if (!u) return {};

  if (u.perfil_id) {
    const p = one('SELECT permissoes FROM perfis WHERE id = ?', [u.perfil_id]);
    if (p) {
      try { return JSON.parse(p.permissoes) || {}; } catch (e) { return {}; }
    }
  }
  // usuario antigo, sem perfil vinculado: admin ve tudo, os outros ficam no basico
  return u.perfil === 'admin'
    ? { todos: true }
    : permissoesDe(['dashboard', 'pdv', 'vendas', 'caixa', 'clientes', 'nfce_emitir']);
}

function pode(req, chave) {
  const p = req.perm || {};
  if (p.todos === true) return true;
  // uma lista significa "qualquer uma destas libera"
  if (Array.isArray(chave)) return chave.some((c) => p[c] === true);
  return p[chave] === true;
}

function nomeDaPermissao(chave) {
  const c = Array.isArray(chave) ? chave[0] : chave;
  const m = [...MODULOS, ...ACOES].find((x) => x.chave === c);
  return m ? m.nome : c;
}

function exigir(chave) {
  return (req, res, next) => {
    if (pode(req, chave)) return next();
    res.status(403).json({
      erro: `Seu perfil nao tem permissao para "${nomeDaPermissao(chave)}". Fale com o administrador.` });
  };
}

/* ---- Uma tabela so, com o que cada rota exige. Ordem importa: a primeira
   regra que casar e a que vale. ---- */
const REGRAS_PERMISSAO = [
  /* O PDV precisa buscar produto, ler categoria e maquininha mesmo quando o
     perfil nao tem acesso as telas de cadastro. Sem isto o caixa nao vende. */
  { re: /^\/produtos\/busca/, p: ['pdv', 'produtos', 'estoque'] },
  { m: 'GET', re: /^\/categorias/, p: null },
  { m: 'GET', re: /^\/operadoras/, p: ['operadoras', 'pdv', 'cartao'] },
  { re: /^\/vendas\/\d+\/cupom/, p: ['vendas', 'pdv'] },

  { re: /^\/orcamentos/, p: 'orcamentos' },
  { re: /^\/entrada-nota/, p: 'entradaNota' },
  /* [1.13] expedicao confirma entregas; o caixa tambem pode (cliente que volta para buscar) */
  { re: /^\/entregas/, p: ['expedicao', 'pdv'] },
  /* [1.16] obras: material do dono, saldo e pagamentos */
  { re: /^\/obras/, p: 'obras' },
  /* [1.12] consulta a tabela NCM: quem cadastra produto, da entrada em nota ou cuida da NFC-e */
  { re: /^\/ncm/, p: ['produtos', 'entradaNota', 'fiscal'] },
  { re: /^\/produtos\/ncm\/resumo/, p: ['produtos', 'fiscal'] },
  { re: /^\/importar\/produtos/, p: 'produtos' },
  { re: /^\/importar\/clientes/, p: 'clientes' },
  { re: /^\/importar\/fornecedores/, p: 'fornecedores' },

  { m: 'POST', re: /^\/vendas\/\d+\/cancelar/, p: 'venda_cancelar' },
  { m: 'POST', re: /^\/vendas$/, p: 'pdv' },
  { re: /^\/vendas/, p: 'vendas' },

  { re: /^\/caixa/, p: 'caixa' },
  { re: /^\/receber/, p: 'receber' },
  { re: /^\/cartao\/resumo/, p: 'relDespesas' },
  { re: /^\/cartao/, p: 'cartao' },
  { re: /^\/operadoras/, p: 'operadoras' },
  { re: /^\/cp\/resumo/, p: 'relDespesas' },
  { re: /^\/cp\//, p: 'pagar' },
  { re: /^\/financeiro\/fluxo/, p: 'fluxo' },

  { m: 'POST', re: /^\/produtos\/reajuste/, p: 'preco_reajuste' },
  { m: 'DELETE', re: /^\/produtos/, p: 'excluir' },
  { m: 'DELETE', re: /^\/clientes/, p: 'excluir' },
  { m: 'DELETE', re: /^\/fornecedores/, p: 'excluir' },
  { m: 'DELETE', re: /^\/operadoras/, p: 'excluir' },
  { m: 'DELETE', re: /^\/categorias/, p: 'excluir' },

  { re: /^\/produtos/, p: 'produtos' },
  { re: /^\/categorias/, p: 'produtos' },
  { re: /^\/estoque/, p: 'estoque' },
  { re: /^\/clientes/, p: 'clientes' },
  { re: /^\/fornecedores/, p: 'fornecedores' },

  { re: /^\/relatorios\/vendas/, p: 'relVendas' },
  { re: /^\/relatorios\/produtos/, p: 'relProdutos' },
  { re: /^\/relatorios\/clientes/, p: 'relClientes' },
  { re: /^\/relatorios\/sugestao-compra/, p: 'relCompras' },

  { re: /^\/usuarios\/senha/, p: null },            // qualquer um troca a propria senha
  { re: /^\/usuarios/, p: 'usuarios' },
  { re: /^\/perfis/, p: 'usuarios' },
  { re: /^\/backup/, p: 'backup' },
  { re: /^\/log/, p: 'usuarios' },
  { m: 'POST', re: /^\/config/, p: 'config' },
  { re: /^\/impressora/, p: 'config' },

  /* NFC-e. Emitir e cancelar sao acoes do caixa; mexer no certificado, na
     numeracao e no CSC e coisa de administrador. */
  { m: 'POST', re: /^\/nfce\/emitir/, p: 'nfce_emitir' },
  { m: 'POST', re: /^\/nfce\/\d+\/cancelar/, p: 'nfce_cancelar' },
  { m: 'GET', re: /^\/nfce\/status-servico/, p: ['fiscal', 'nfce_emitir'] },
  { m: 'GET', re: /^\/nfce/, p: ['fiscal', 'vendas', 'nfce_emitir'] },
  { re: /^\/nfce/, p: 'fiscal' },
  { re: /^\/certificado/, p: 'fiscal' },
  /* [1.11] pacote para a contabilidade e aviso semanal: coisa do dono */
  { re: /^\/contabilidade/, p: 'fiscal' },
  { re: /^\/fiscal\//, p: 'fiscal' }
];

/* [1.14] O que a tela de login precisa saber antes de alguem entrar.
   Sem dados da loja: so a versao e se o sistema esta na internet. */
app.get('/api/info', (req, res) => {
  res.json({ versao: VERSAO, na_internet: NA_INTERNET, railway: NO_RAILWAY });
});

/** Porteiro unico: vale para TODAS as rotas /api, nao so para o menu. */
app.use('/api', (req, res, next) => {
  if (req.path === '/login' || req.path === '/info') return next();

  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const s = sessoes.get(token);
  if (!s || s.expira < agora()) return res.status(401).json({ erro: 'Sessao expirada. Faca login de novo.' });

  req.usuario = s;
  req.perm = permissoesDoUsuario(s.usuario);

  /* [1.14] na internet, senha padrao nao passa daqui: so o que e preciso
     para trocar a senha e sair */
  if (NA_INTERNET && s.trocar && !['/me', '/usuarios/senha', '/logout'].includes(req.path)) {
    return res.status(403).json({
      trocar_senha: true,
      erro: 'Troque a senha padrao antes de continuar. O sistema esta na internet e a senha de fabrica nao pode ficar.' });
  }

  const regra = REGRAS_PERMISSAO.find((r) =>
    (!r.m || r.m === req.method) && r.re.test(req.path));

  if (regra && regra.p && !pode(req, regra.p)) {
    return res.status(403).json({
      erro: `Seu perfil nao tem permissao para "${nomeDaPermissao(regra.p)}". Fale com o administrador.` });
  }
  next();
});

app.post('/api/login', (req, res) => {
  const usuario = txt(req.body.usuario).toLowerCase();
  const senha = txt(req.body.senha);
  const ip = ipDe(req);

  // [1.14] forca bruta: muitos erros seguidos = espera
  const minIp = bloqueioDeLogin('ip:' + ip);
  const minUsr = usuario ? bloqueioDeLogin('usr:' + usuario) : 0;
  const esperar = Math.max(minIp, minUsr);
  if (esperar) {
    return res.status(429).json({
      erro: `Muitas tentativas erradas. Espere ${esperar} minuto(s) e tente de novo.` });
  }

  const u = one('SELECT * FROM usuarios WHERE lower(usuario) = ? AND ativo = 1', [usuario]);
  if (!u || u.senha !== senhaHash(senha)) {
    const bloqueouIp = registrarErroDeLogin('ip:' + ip, LIMITE_POR_IP);
    const bloqueouUsr = usuario ? registrarErroDeLogin('usr:' + usuario, LIMITE_POR_USUARIO) : false;
    if (bloqueouIp || bloqueouUsr) {
      registrarLog(usuario || '?', 'login-bloqueado', `muitas tentativas erradas (ip ${ip})`);
      salvarBanco();
    }
    return res.status(401).json({ erro: 'Usuario ou senha invalidos.' });
  }
  ERROS_LOGIN.delete('ip:' + ip);
  ERROS_LOGIN.delete('usr:' + usuario);

  // [1.14] senha de fabrica: avisa em casa, obriga a trocar na internet
  const trocar = senhaPadrao(u.usuario, senha);
  const token = novaSessao(u, trocar, ip);
  registrarLog(u.usuario, 'login', ip ? 'de ' + ip : '');
  res.json({ token, usuario: u.usuario, nome: u.nome, perfil: u.perfil,
    trocar_senha: trocar, na_internet: NA_INTERNET });
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  sessoes.delete(token);
  run('DELETE FROM sessoes WHERE token = ?', [token]);
  salvarBanco();
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const perm = permissoesDoUsuario(req.usuario.usuario);
  const u = one('SELECT perfil_id FROM usuarios WHERE lower(usuario) = ?',
    [req.usuario.usuario.toLowerCase()]);
  const p = u && u.perfil_id ? one('SELECT nome FROM perfis WHERE id = ?', [u.perfil_id]) : null;
  res.json({ ...req.usuario, permissoes: perm, perfil_nome: p ? p.nome : req.usuario.perfil,
    trocar_senha: !!req.usuario.trocar, na_internet: NA_INTERNET });
});

/* ---------- catalogo de modulos e acoes, para montar a tela de perfis ---------- */
app.get('/api/permissoes', auth, (req, res) => res.json({ modulos: MODULOS, acoes: ACOES }));

/* ---------- perfis ---------- */
app.get('/api/perfis', auth, (req, res) => {
  const lista = all('SELECT * FROM perfis ORDER BY sistema DESC, nome');
  lista.forEach((p) => {
    try { p.permissoes = JSON.parse(p.permissoes) || {}; } catch (e) { p.permissoes = {}; }
    const u = one('SELECT COUNT(*) AS n FROM usuarios WHERE perfil_id = ?', [p.id]);
    p.usuarios = u ? u.n : 0;
    p.total_permissoes = p.permissoes.todos ? TODAS_CHAVES.length
      : Object.keys(p.permissoes).filter((k) => p.permissoes[k]).length;
  });
  res.json(lista);
});

app.post('/api/perfis', auth, exigir('usuarios'), (req, res) => {
  const b = req.body;
  const nome = txt(b.nome);
  if (!nome) return res.status(400).json({ erro: 'Informe o nome do perfil.' });

  // so grava chaves conhecidas — nao deixa entrar permissao inventada
  const perms = {};
  if (b.permissoes && b.permissoes.todos) perms.todos = true;
  else TODAS_CHAVES.forEach((c) => { if (b.permissoes && b.permissoes[c]) perms[c] = true; });

  const dup = one('SELECT id FROM perfis WHERE upper(nome) = ? AND id <> ?',
    [nome.toUpperCase(), b.id || 0]);
  if (dup) return res.status(400).json({ erro: 'Ja existe um perfil com esse nome.' });

  if (b.id) {
    const atual = one('SELECT * FROM perfis WHERE id = ?', [b.id]);
    if (!atual) return res.status(404).json({ erro: 'Perfil nao encontrado.' });

    // o perfil do administrador nao pode perder o acesso total, senao
    // ninguem mais consegue mexer em usuarios
    let permsAtuais = {};
    try { permsAtuais = JSON.parse(atual.permissoes || '{}'); } catch (e) { /* vazio */ }
    if (atual.sistema && permsAtuais.todos && !perms.todos) {
      return res.status(400).json({
        erro: 'O perfil Administrador precisa manter o acesso total. Crie outro perfil no lugar.' });
    }
    run('UPDATE perfis SET nome = ?, descricao = ?, permissoes = ? WHERE id = ?',
      [nome, txt(b.descricao), JSON.stringify(perms), b.id]);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'perfil-editar', nome);
    return res.json({ ok: true, id: b.id });
  }

  const id = inserir(
    'INSERT INTO perfis (nome, descricao, permissoes, sistema, criado_em) VALUES (?,?,?,0,?)',
    [nome, txt(b.descricao), JSON.stringify(perms), agora()]);
  registrarLog(req.usuario.usuario, 'perfil-novo', nome);
  res.json({ ok: true, id });
});

app.delete('/api/perfis/:id', auth, exigir('usuarios'), (req, res) => {
  const p = one('SELECT * FROM perfis WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ erro: 'Perfil nao encontrado.' });
  if (p.sistema) return res.status(400).json({ erro: 'Perfil do sistema nao pode ser excluido.' });

  const u = one('SELECT COUNT(*) AS n FROM usuarios WHERE perfil_id = ?', [p.id]);
  if (u && u.n) {
    return res.status(400).json({
      erro: `${u.n} usuario(s) usam esse perfil. Troque o perfil deles antes de excluir.` });
  }
  run('DELETE FROM perfis WHERE id = ?', [p.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'perfil-excluir', p.nome);
  res.json({ ok: true });
});

/* =========================================================================
   USUARIOS
   ========================================================================= */

app.get('/api/usuarios', auth, exigir('usuarios'), (req, res) => {
  res.json(all(`SELECT u.id, u.usuario, u.nome, u.perfil, u.perfil_id, u.ativo, u.criado_em,
                       p.nome AS perfil_nome
                FROM usuarios u LEFT JOIN perfis p ON p.id = u.perfil_id
                ORDER BY u.nome`));
});

/** Trava de seguranca: nunca deixar o sistema sem alguem que gerencie usuarios. */
function sobraAlguemQueGerencia(idIgnorado) {
  const ativos = all(`SELECT u.id, u.perfil, p.permissoes
                      FROM usuarios u LEFT JOIN perfis p ON p.id = u.perfil_id
                      WHERE u.ativo = 1 AND u.id <> ?`, [idIgnorado || 0]);
  return ativos.some((u) => {
    let perm = {};
    try { perm = JSON.parse(u.permissoes || '{}'); } catch (e) { /* vazio */ }
    if (!u.permissoes) return u.perfil === 'admin';
    return perm.todos === true || perm.usuarios === true;
  });
}

app.post('/api/usuarios', auth, exigir('usuarios'), (req, res) => {
  const b = req.body;
  const usuario = txt(b.usuario).toLowerCase();
  if (!usuario || !txt(b.nome)) return res.status(400).json({ erro: 'Informe usuario e nome.' });

  // o campo perfil (texto) vira reflexo do perfil escolhido, so para compatibilidade
  const perfilEscolhido = b.perfil_id
    ? one('SELECT * FROM perfis WHERE id = ?', [b.perfil_id]) : null;
  let permsEscolhidas = {};
  if (perfilEscolhido) {
    try { permsEscolhidas = JSON.parse(perfilEscolhido.permissoes || '{}'); } catch (e) { /* vazio */ }
  }
  const perfilTexto = permsEscolhidas.todos || permsEscolhidas.usuarios ? 'admin' : 'operador';

  if (b.id) {
    const antes = one('SELECT * FROM usuarios WHERE id = ?', [b.id]);
    if (!antes) return res.status(404).json({ erro: 'Usuario nao encontrado.' });

    const perdeuGestao = !(permsEscolhidas.todos || permsEscolhidas.usuarios) || !b.ativo;
    if (perdeuGestao && !sobraAlguemQueGerencia(b.id)) {
      return res.status(400).json({
        erro: 'Este e o unico usuario que consegue gerenciar usuarios. Dê esse acesso a outra pessoa antes de mudar o perfil ou desativar.' });
    }

    const campos = ['usuario = ?', 'nome = ?', 'perfil = ?', 'perfil_id = ?', 'ativo = ?'];
    const vals = [usuario, txt(b.nome), perfilTexto, b.perfil_id || null, b.ativo ? 1 : 0];
    if (txt(b.senha)) { campos.push('senha = ?'); vals.push(senhaHash(txt(b.senha))); }
    vals.push(b.id);
    run(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`, vals);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'usuario-editar',
      `${usuario} -> ${perfilEscolhido ? perfilEscolhido.nome : 'sem perfil'}`);
    return res.json({ ok: true, id: b.id });
  }

  const existe = one('SELECT id FROM usuarios WHERE lower(usuario) = ?', [usuario]);
  if (existe) return res.status(400).json({ erro: 'Ja existe um usuario com esse login.' });
  if (!txt(b.senha)) return res.status(400).json({ erro: 'Informe a senha.' });
  if (!b.perfil_id) return res.status(400).json({ erro: 'Escolha o perfil de acesso.' });

  const id = inserir(
    `INSERT INTO usuarios (usuario, senha, nome, perfil, perfil_id, ativo, criado_em)
     VALUES (?,?,?,?,?,?,?)`,
    [usuario, senhaHash(txt(b.senha)), txt(b.nome), perfilTexto, b.perfil_id,
     b.ativo === 0 ? 0 : 1, agora()]
  );
  registrarLog(req.usuario.usuario, 'usuario-novo',
    `${usuario} (${perfilEscolhido ? perfilEscolhido.nome : '-'})`);
  res.json({ ok: true, id });
});

app.post('/api/usuarios/senha', auth, (req, res) => {
  const atual = txt(req.body.atual);
  const nova = txt(req.body.nova);
  /* [1.14] a senha nova nao pode ser a de fabrica nem fraca demais: na
     internet e ela que separa a loja do resto do mundo */
  if (nova.length < 6) return res.status(400).json({ erro: 'A nova senha precisa de pelo menos 6 caracteres.' });
  if (senhaPadrao(req.usuario.usuario, nova)) {
    return res.status(400).json({ erro: 'Essa senha e fraca demais (igual ao login ou uma das senhas de fabrica). Escolha outra.' });
  }
  const u = one('SELECT * FROM usuarios WHERE usuario = ?', [req.usuario.usuario]);
  if (!u || u.senha !== senhaHash(atual)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
  run('UPDATE usuarios SET senha = ? WHERE id = ?', [senhaHash(nova), u.id]);

  // a sessao deixa de estar presa na troca de senha
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  const s = sessoes.get(token);
  if (s) { s.trocar = 0; run('UPDATE sessoes SET trocar = 0 WHERE token = ?', [token]); }
  salvarBanco();
  registrarLog(req.usuario.usuario, 'senha', 'trocou a propria senha');
  res.json({ ok: true });
});

/* =========================================================================
   CONFIGURACAO DA LOJA
   ========================================================================= */

function lerConfig() {
  const cfg = {};
  all('SELECT chave, valor FROM config').forEach((c) => { cfg[c.chave] = c.valor; });
  return cfg;
}

app.get('/api/config', auth, (req, res) => {
  const cfg = lerConfig();
  // o CSC nao viaja para a tela; manda so o aviso de que ja esta preenchido
  const marcas = {};
  CONFIG_SECRETA.forEach((k) => {
    marcas[k + '_preenchido'] = txt(cfg[k]) ? 1 : 0;
    /* [1.10.2] so o FORMATO do CSC (quantos caracteres, se tem hifen) — para a
       tela poder dizer "36 caracteres, com hifens" e a pessoa conferir com o
       portal sem o codigo em si sair daqui */
    if (/^nfce_csc_(homologacao|producao)$/.test(k)) {
      marcas[k + '_tamanho'] = txt(cfg[k]).length;
      marcas[k + '_hifens'] = (txt(cfg[k]).match(/-/g) || []).length;
    }
    delete cfg[k];
  });
  res.json({ ...cfg, ...marcas, versao: VERSAO });
});

app.post('/api/config', auth, exigir('config'), (req, res) => {
  const b = { ...(req.body || {}) };

  /* [1.9.4] O ID do CSC e o CSC entram limpos. O ID e um numero curto.
     Recusar aqui evita gravar algo que vai virar "NaN" no QR Code e derrubar
     a nota no schema da SEFAZ (225).
     [1.10.2] O CSC e gravado EXATAMENTE como o portal da SEFAZ mostra — so
     os espacos saem. Os hifens FAZEM PARTE do codigo (formato
     xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx): a SEFAZ calcula o hash do QR Code
     com eles, e tira-los era o que dava a rejeicao 464 nas versoes 1.9.4 a
     1.10.1. */
  for (const amb of ['homologacao', 'producao']) {
    const kId = 'nfce_csc_id_' + amb;
    const kCsc = 'nfce_csc_' + amb;
    if (b[kId] !== undefined && txt(b[kId]) !== '') {
      const id = txt(b[kId]);
      if (!/^\d{1,6}$/.test(id) || !(parseInt(id, 10) >= 1)) {
        return res.status(400).json({
          erro: `O ID do CSC de ${amb} e um numero curto (ex.: 1 ou 000001). ` +
                `"${id}" nao e um ID — confira se o ID e o codigo nao foram trocados de campo.` });
      }
      b[kId] = String(parseInt(id, 10)).padStart(6, '0');
    }
    if (b[kCsc] !== undefined && txt(b[kCsc]) !== '') {
      const csc = txt(b[kCsc]).replace(/\s/g, '');
      if (csc.length < 16 || csc.length > 64 || /[^A-Za-z0-9-]/.test(csc) || /^[-]+$/.test(csc)) {
        return res.status(400).json({
          erro: `O CSC de ${amb} parece errado: e um codigo de letras, numeros e hifens, com uns 32 a 36 caracteres. ` +
                'Copie de novo do portal da SEFAZ, exatamente como aparece la.' });
      }
      b[kCsc] = csc;
      // [1.12] CSC sem ID nao serve: exige o ID junto (digitado agora ou ja gravado)
      const idGravado = one('SELECT valor FROM config WHERE chave = ?', [kId]);
      if (txt(b[kId]) === '' && !(idGravado && txt(idGravado.valor))) {
        return res.status(400).json({
          erro: `Digite tambem o ID do CSC de ${amb} (o "Identificador do CSC" do portal da SEFAZ, normalmente 1). Sem ele a SEFAZ rejeita a nota (462).` });
      }
    }
  }
  // os campos antigos nao sao mais gravados por aqui
  delete b.nfce_csc; delete b.nfce_csc_id;

  // [1.10] tokens da Focus: sem espaco, so letras e numeros
  for (const amb of ['homologacao', 'producao']) {
    const k = 'focus_token_' + amb;
    if (b[k] !== undefined && txt(b[k]) !== '') {
      const t = txt(b[k]).replace(/\s/g, '');
      if (t.length < 16 || /[^A-Za-z0-9]/.test(t)) {
        return res.status(400).json({
          erro: `O token de ${amb} da Focus parece errado: e um codigo so de letras e numeros. Copie de novo do painel da Focus.` });
      }
      b[k] = t;
    }
  }
  if (b.nfce_modo !== undefined && !['direto', 'focus'].includes(txt(b.nfce_modo))) b.nfce_modo = 'direto';

  // [1.12] o NCM padrao da loja tambem precisa existir na tabela
  if (b.nfce_ncm_padrao !== undefined && txt(b.nfce_ncm_padrao) !== '') {
    const c = somenteDigitos(b.nfce_ncm_padrao);
    if (!ncm.valido(c)) return res.status(400).json({ erro: `O NCM padrao ${c} nao existe na tabela da Receita.` });
    b.nfce_ncm_padrao = c;
  }

  // [1.11] regra do aviso semanal: folga em % (0 a 100) e dia da semana (1 a 7)
  if (b.aviso_notas_margem !== undefined) {
    const m = Number(String(b.aviso_notas_margem).replace(',', '.'));
    if (!(m >= 0 && m <= 100)) return res.status(400).json({ erro: 'A folga sobre o cartao e uma porcentagem entre 0 e 100.' });
    b.aviso_notas_margem = String(m);
  }
  if (b.aviso_notas_dia !== undefined) {
    const d = parseInt(b.aviso_notas_dia, 10);
    b.aviso_notas_dia = String(d >= 1 && d <= 7 ? d : 1);
  }

  Object.entries(b).forEach(([k, v]) => {
    // campo secreto em branco = "nao mexi nele", nao "apague"
    if (CONFIG_SECRETA.includes(txt(k)) && !txt(v)) return;
    run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)', [txt(k), txt(v)]);
  });
  salvarBanco();
  registrarLog(req.usuario.usuario, 'config', 'dados da loja alterados');
  res.json({ ok: true });
});

/* =========================================================================
   CERTIFICADO DIGITAL A1

   O .pfx e a senha ficam no banco. A senha e cifrada com uma chave que o
   sistema gera sozinho no primeiro uso e guarda tambem no banco — isso
   impede leitura casual, mas quem tem o loja.db tem o certificado.
   Por isso o backup do banco tem que ser tratado como documento sigiloso.
   Nem o arquivo nem a senha saem por nenhuma rota da API.
   ========================================================================= */

/** Chave de cifra da senha do certificado. Criada uma unica vez. */
function chaveDeCifra() {
  let c = one("SELECT valor FROM config WHERE chave = 'cert_chave'");
  if (!c || !txt(c.valor)) {
    const nova = crypto.randomBytes(32).toString('hex');
    run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)', ['cert_chave', nova]);
    salvarBanco();
    return nova;
  }
  return c.valor;
}

/** Devolve o certificado aberto e pronto para assinar, ou null se nao houver. */
function certificadoAberto() {
  const c = one('SELECT * FROM certificado WHERE id = 1');
  if (!c || !txt(c.arquivo)) return null;
  const senha = fiscal.decifrar(c.senha, chaveDeCifra());
  return fiscal.abrirCertificado(c.arquivo, senha);
}

/** Dados do certificado para a tela — sem arquivo, sem senha. */
function certificadoResumo() {
  const c = one('SELECT * FROM certificado WHERE id = 1');
  if (!c || !txt(c.arquivo)) return { cadastrado: false };

  const ate = new Date(c.valido_ate);
  const dias = Math.floor((ate - new Date()) / 86400000);
  const cnpjLoja = somenteDigitos(lerConfig().loja_cnpj);

  return {
    cadastrado: true,
    nome_arquivo: c.nome_arquivo,
    titular: c.titular,
    cnpj: c.cnpj,
    emissor: c.emissor,
    numero_serie: c.numero_serie,
    valido_de: c.valido_de,
    valido_ate: c.valido_ate,
    dias_restantes: dias,
    vencido: dias < 0,
    vence_em_breve: dias >= 0 && dias <= 30,
    confere_com_a_loja: !cnpjLoja || cnpjLoja === somenteDigitos(c.cnpj),
    enviado_em: c.enviado_em,
    enviado_por: c.enviado_por
  };
}

app.get('/api/certificado', auth, (req, res) => res.json(certificadoResumo()));

app.post('/api/certificado', auth, (req, res) => {
  const arquivo = txt(req.body.arquivo);          // base64 do .pfx
  const senha = String(req.body.senha === undefined ? '' : req.body.senha);
  const nomeArquivo = txt(req.body.nome_arquivo) || 'certificado.pfx';

  if (!arquivo) return res.status(400).json({ erro: 'Escolha o arquivo do certificado (.pfx ou .p12).' });
  if (!senha) return res.status(400).json({ erro: 'Informe a senha do certificado.' });

  let aberto;
  try {
    aberto = fiscal.abrirCertificado(arquivo, senha);
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const i = aberto.info;
  if (i.vencido) {
    return res.status(400).json({
      erro: `Este certificado venceu em ${new Date(i.valido_ate).toLocaleDateString('pt-BR')}. ` +
            'Renove com a certificadora antes de cadastrar.' });
  }

  const cnpjLoja = somenteDigitos(lerConfig().loja_cnpj);
  if (cnpjLoja && somenteDigitos(i.cnpj) && cnpjLoja !== somenteDigitos(i.cnpj)) {
    return res.status(400).json({
      erro: `O certificado e do CNPJ ${i.cnpj}, mas a loja esta cadastrada com o CNPJ ${cnpjLoja}. ` +
            'A SEFAZ recusa a nota se os dois nao baterem.' });
  }

  run('DELETE FROM certificado WHERE id = 1');
  run(`INSERT INTO certificado
       (id, arquivo, senha, nome_arquivo, titular, cnpj, emissor, numero_serie,
        valido_de, valido_ate, enviado_em, enviado_por)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`,
    [arquivo, fiscal.cifrar(senha, chaveDeCifra()), nomeArquivo,
     i.titular, i.cnpj, i.emissor, i.serie,
     i.valido_de, i.valido_ate, agora(), req.usuario.usuario]);
  salvarBanco();

  registrarLog(req.usuario.usuario, 'certificado',
    `${i.titular} — vence em ${new Date(i.valido_ate).toLocaleDateString('pt-BR')}`);
  res.json({ ok: true, certificado: certificadoResumo() });
});

/** Confere se a senha guardada ainda abre o certificado. */
app.post('/api/certificado/testar', auth, (req, res) => {
  try {
    const a = certificadoAberto();
    if (!a) return res.status(400).json({ erro: 'Nenhum certificado cadastrado.' });
    // assina e confere um texto qualquer: prova que a chave privada funciona
    const md = crypto.createHash('sha256').update('teste-loja').digest();
    const assinatura = crypto.sign('sha256', md, a.pemChave);
    const ok = crypto.verify('sha256', md, a.pemCert, assinatura);
    res.json({ ok, mensagem: ok
      ? 'Certificado aberto e assinando normalmente.'
      : 'O certificado abriu, mas a assinatura nao conferiu.' });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.delete('/api/certificado', auth, (req, res) => {
  run('DELETE FROM certificado WHERE id = 1');
  run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('nfce_ativo','0')");
  salvarBanco();
  registrarLog(req.usuario.usuario, 'certificado', 'certificado removido');
  res.json({ ok: true });
});

/* =========================================================================
   NFC-e — EMISSAO, CONSULTA E CANCELAMENTO

   Regra de ouro deste bloco: a NFC-e NUNCA derruba a venda. A venda e o
   cupom interno continuam funcionando mesmo se a SEFAZ estiver fora, se o
   certificado vencer ou se faltar internet. A nota fica registrada como
   pendente e pode ser reenviada depois.
   ========================================================================= */

/** Junta o que esta no produto com o padrao da loja. */
function fiscalDoProduto(p, cfg) {
  return {
    ncm: somenteDigitos(p.ncm) || somenteDigitos(cfg.nfce_ncm_padrao) || '00000000',
    cfop: somenteDigitos(p.cfop) || somenteDigitos(cfg.nfce_cfop_padrao) || '5102',
    origem: txt(p.origem) || txt(cfg.nfce_origem_padrao) || '0',
    csosn: txt(p.csosn) || txt(cfg.nfce_csosn_padrao) || '102',
    cest: somenteDigitos(p.cest) || ''
  };
}

/** Junta tudo que a NFC-e precisa saber sobre a loja. */
function emitenteDaLoja(cfg) {
  /* O endereco esta gravado como uma linha so ("RUA X, 123"). A SEFAZ quer
     logradouro e numero separados, entao a virgula final vira o numero. */
  const endereco = txt(cfg.loja_endereco);
  const m = endereco.match(/^(.*?),\s*([^,]+)$/);
  return {
    cnpj: somenteDigitos(cfg.loja_cnpj),
    razao_social: txt(cfg.loja_nome),
    fantasia: txt(cfg.loja_fantasia) || txt(cfg.loja_nome),
    logradouro: m ? m[1].trim() : endereco,
    numero: m ? m[2].trim() : 'S/N',
    bairro: txt(cfg.loja_bairro) || 'CENTRO',
    municipio: txt(cfg.loja_cidade),
    municipio_ibge: somenteDigitos(cfg.nfce_municipio_ibge),
    uf: txt(cfg.loja_uf).toUpperCase(),
    cep: somenteDigitos(cfg.loja_cep),
    telefone: somenteDigitos(cfg.loja_telefone),
    ie: somenteDigitos(cfg.loja_ie),
    cnae: somenteDigitos(cfg.nfce_cnae),
    crt: txt(cfg.nfce_crt) || '1'
  };
}

const ambienteAtual = (cfg) => (txt(cfg.nfce_ambiente) === '1' ? 1 : 2);
const nomeAmbiente = (cfg) => (ambienteAtual(cfg) === 1 ? 'producao' : 'homologacao');

/** ID e CSC do ambiente que esta ligado. */
function cscDoAmbiente(cfg) {
  const sufixo = nomeAmbiente(cfg);
  return { id: txt(cfg['nfce_csc_id_' + sufixo]), csc: txt(cfg['nfce_csc_' + sufixo]) };
}

/** Confere o que impede a emissao. Devolve a mensagem do problema ou null. */
const modoFocus = (cfg) => txt(cfg.nfce_modo) === 'focus';

function podeEmitir(cfg) {
  if (txt(cfg.nfce_ativo) !== '1') return 'A emissao de NFC-e esta desligada nas configuracoes.';
  if (modoFocus(cfg)) {
    /* No modo Focus o certificado, o CSC e os enderecos ficam no painel da
       Focus. Daqui so precisa do token do ambiente e do CNPJ. */
    if (!somenteDigitos(cfg.loja_cnpj)) return 'A loja esta sem CNPJ nas configuracoes.';
    if (!focusToken(cfg)) {
      return `Falta o token de ${nomeAmbiente(cfg)} da Focus NFe. Cadastre em Sistema > NFC-e > Focus NFe.`;
    }
    return null;
  }
  if (!somenteDigitos(cfg.loja_ie)) return 'A loja esta sem inscricao estadual.';
  if (!somenteDigitos(cfg.nfce_municipio_ibge)) return 'Falta o codigo IBGE do municipio.';
  if (!fiscal.UF_CODIGO[txt(cfg.loja_uf).toUpperCase()]) return 'A UF da loja esta invalida.';
  if (txt(cfg.nfce_qrcode_versao) !== '3') {
    const par = cscDoAmbiente(cfg);
    const amb = nomeAmbiente(cfg);
    if (!par.csc || !par.id) {
      return `Falta o CSC de ${amb} (ID e codigo). Cadastre em Sistema > NFC-e > CSC, na coluna de ${amb}.`;
    }
    if (!(parseInt(par.id.replace(/\D/g, ''), 10) >= 1)) {
      return `O ID do CSC de ${amb} nao e um numero. Corrija em Sistema > NFC-e > CSC ` +
             '(o ID e curto, ex.: 000001; o codigo longo vai no campo CSC).';
    }
  }
  if (txt(cfg.nfce_qrcode_versao) === '3' && txt(cfg.nfce_contingencia) === '1') {
    return 'Contingencia offline exige QR Code versao 2 nesta versao do sistema. Desligue a contingencia ou mude para a versao 2.';
  }
  const c = one('SELECT * FROM certificado WHERE id = 1');
  if (!c || !txt(c.arquivo)) return 'Nenhum certificado digital cadastrado.';
  if (new Date(c.valido_ate) < new Date()) {
    return `O certificado digital venceu em ${new Date(c.valido_ate).toLocaleDateString('pt-BR')}.`;
  }
  return null;
}

/** Proximo numero da serie, reservado antes de montar a nota. */
function reservarNumero(cfg) {
  const numero = Math.max(1, parseInt(cfg.nfce_proximo_numero, 10) || 1);
  run("INSERT OR REPLACE INTO config (chave, valor) VALUES ('nfce_proximo_numero', ?)",
    [String(numero + 1)]);
  salvarBanco();
  return numero;
}

/** Monta a NFC-e de uma venda ja gravada e devolve o XML assinado. */
function prepararNfce(vendaId, cfg, opcoes = {}) {
  const venda = one('SELECT * FROM vendas WHERE id = ?', [vendaId]);
  if (!venda) throw new Error('Venda nao encontrada.');
  if (venda.situacao === 'cancelada') throw new Error('Esta venda foi cancelada.');

  const itens = all('SELECT * FROM venda_itens WHERE venda_id = ?', [vendaId]);
  if (!itens.length) throw new Error('A venda nao tem itens.');
  const pagamentos = all('SELECT * FROM venda_pagamentos WHERE venda_id = ?', [vendaId]);

  const cert = certificadoAberto();
  if (!cert) throw new Error('Nenhum certificado digital cadastrado.');

  const ambiente = ambienteAtual(cfg);
  const serie = Math.max(1, parseInt(cfg.nfce_serie, 10) || 1);
  const numero = opcoes.numero || reservarNumero(cfg);
  const cNF = fiscal.gerarCodigoNumerico(numero);
  const tpEmis = opcoes.tpEmis || (txt(cfg.nfce_contingencia) === '1' ? 9 : 1);
  const emitente = emitenteDaLoja(cfg);
  const dataEmissao = new Date();

  const chave = fiscal.montarChave({
    uf: emitente.uf, dataEmissao, cnpj: emitente.cnpj,
    serie, numero, tpEmis, cNF
  });

  /* O desconto geral da venda e rateado entre os itens: a NFC-e nao tem
     campo de "desconto no rodape", so desconto por item. A ultima linha
     recebe a sobra dos centavos para o total bater exatamente. */
  const descontoGeral = round2(venda.desconto);
  const somaItens = round2(itens.reduce((s, i) => s + num(i.quantidade) * num(i.preco_unit), 0));
  let rateado = 0;

  const itensNfce = itens.map((i, idx) => {
    const bruto = round2(num(i.quantidade) * num(i.preco_unit));
    let desconto = round2(num(i.desconto));
    if (descontoGeral > 0 && somaItens > 0) {
      const parte = idx === itens.length - 1
        ? round2(descontoGeral - rateado)
        : round2(descontoGeral * (bruto / somaItens));
      rateado = round2(rateado + parte);
      desconto = round2(desconto + parte);
    }
    const prod = one('SELECT codigo_barras FROM produtos WHERE id = ?', [i.produto_id]) || {};
    const ean = somenteDigitos(prod.codigo_barras);
    return {
      codigo: i.codigo || i.produto_id,
      /* GTIN so vai se tiver tamanho certo E digito verificador certo.
         Codigo de barras inventado (numero interno de 13 digitos) derruba a
         nota inteira na SEFAZ — melhor sair como SEM GTIN. */
      ean: fiscal.gtinValido(ean) ? ean : 'SEM GTIN',
      descricao: i.descricao,
      ncm: somenteDigitos(i.ncm) || somenteDigitos(cfg.nfce_ncm_padrao) || '00000000',
      cfop: somenteDigitos(i.cfop) || somenteDigitos(cfg.nfce_cfop_padrao) || '5102',
      cest: somenteDigitos(i.cest),
      unidade: i.unidade || 'UN',
      quantidade: num(i.quantidade),
      valor_unitario: num(i.preco_unit),
      desconto,
      origem: txt(i.origem) || txt(cfg.nfce_origem_padrao) || '0',
      csosn: txt(i.csosn) || txt(cfg.nfce_csosn_padrao) || '102',
      cst_pis: txt(cfg.nfce_cst_pis) || '49',
      cst_cofins: txt(cfg.nfce_cst_cofins) || '49'
    };
  });

  const dados = {
    chave, cNF, numero, serie, tpEmis, ambiente, crt: emitente.crt,
    dataEmissao,
    versaoSistema: 'LOJA ' + VERSAO.split(' ')[0],
    emitente,
    destinatario: somenteDigitos(venda.cliente_doc)
      ? { documento: somenteDigitos(venda.cliente_doc), nome: venda.cliente_nome }
      : null,
    itens: itensNfce,
    pagamentos: pagamentos.map((p) => ({
      forma: p.forma, valor: num(p.valor)
    })),
    troco: num(venda.troco),
    acrescimo: round2(venda.acrescimo),
    informacao: txt(cfg.nfce_info_complementar),
    contingenciaMotivo: opcoes.contingenciaMotivo,
    contingenciaEm: dataEmissao
  };

  const xml = fiscal.montarNfe(dados);
  let assinado = fiscal.assinarXml(xml, 'NFe' + chave, cert);

  /* [1.9.2] O QR Code e o endereco de consulta entram no XML, no bloco
     <infNFeSupl>, fora da assinatura. Ate a 1.9.1 o QR Code era calculado
     e guardado, mas NAO ia dentro do XML — e a SEFAZ recusava com a
     rejeicao 394. O QR precisa do DigestValue da assinatura (no modo
     offline), por isso vem depois de assinar. */
  const qr = qrDaNota(cfg, { chave, tpEmis }, assinado, round2(venda.total));
  assinado = fiscal.inserirInfNfeSupl(assinado, qr.qrcode, qr.url_consulta);

  return { venda, chave, cNF, numero, serie, tpEmis, ambiente, assinado, cert, dados, qr };
}

/** Grava o QR Code e a URL de consulta calculados para a nota. */
function qrDaNota(cfg, nota, xmlAssinado, valorTotal) {
  const ambiente = ambienteAtual(cfg);
  const sufixo = ambiente === 1 ? 'producao' : 'homologacao';
  const dia = String(new Date().getDate()).padStart(2, '0');

  return {
    qrcode: fiscal.qrCodeNfce({
      urlQrCode: txt(cfg[`nfce_url_qrcode_${sufixo}`]),
      versao: txt(cfg.nfce_qrcode_versao) || '2',
      chave: nota.chave,
      ambiente,
      cscId: cscDoAmbiente(cfg).id,
      csc: cscDoAmbiente(cfg).csc,
      offline: Number(nota.tpEmis) === 9,
      diaEmissao: dia,
      valorTotal,
      digestValue: fiscal.digestDoXml(xmlAssinado)
    }),
    url_consulta: txt(cfg[`nfce_url_consulta_${sufixo}`])
  };
}

/** Traduz as rejeicoes mais comuns para algo que o dono da loja entenda. */
function explicarRejeicao(codigo, motivoOriginal, itens) {
  /* A SEFAZ costuma apontar o item: "[nItem:3]". Traduzimos para o nome do
     produto, que e o que o operador consegue achar no cadastro. */
  let qualItem = '';
  const m = String(motivoOriginal || '').match(/nItem\s*:?\s*(\d+)/i);
  if (m && Array.isArray(itens)) {
    const it = itens[Number(m[1]) - 1];
    if (it) qualItem = ` Item ${m[1]}: ${it.descricao}.`;
  }
  const dicas = {
    204: 'Esta nota ja foi enviada antes (chave duplicada). Confira a lista de notas.',
    206: 'Este numero de nota ja foi usado. Ajuste o proximo numero nas configuracoes.',
    213: 'O CNPJ do certificado nao e o mesmo da loja.',
    225: 'O XML saiu fora do formato esperado — avise o suporte.',
    462: 'A SEFAZ deste ambiente nao conhece o ID do CSC que foi no QR Code. Quase sempre: ' +
         'o CSC usado e do OUTRO ambiente (homologacao e producao tem CSC e ID proprios, gerados em portais ' +
         'diferentes). Pela Focus, corrija no painel da Focus; direto, na coluna do ambiente em Sistema > NFC-e > CSC.',
    463: 'O CSC usado foi revogado no portal da SEFAZ. Gere um novo e cadastre aqui.',
    464: 'O hash do QR Code nao bateu: a SEFAZ conhece o ID, mas o CSC gravado aqui nao e exatamente o que ela tem ' +
         'para esse ID. Abra o portal da SEFAZ deste ambiente e digite o CSC de novo em Sistema > NFC-e > CSC, ' +
         'EXATAMENTE como aparece la: com os hifens (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), sem espaco, ' +
         'mesmas maiusculas e minusculas. Se o CSC foi revogado e gerado outro no portal, o antigo nao vale mais.',
    228: 'A data de emissao esta muito atrasada. Confira a data e a hora do computador.',
    229: 'A inscricao estadual da loja esta invalida.',
    233: 'O CSC informado nao confere com o da SEFAZ.',
    239: 'Esta SEFAZ nao aceita este modelo de nota.',
    242: 'O XML esta com problema de estrutura — avise o suporte.',
    252: 'O ambiente do sistema (teste/producao) esta diferente do da SEFAZ.',
    266: 'A serie da nota nao confere com a chave de acesso.',
    280: 'O certificado digital esta vencido ou invalido.',
    281: 'O certificado digital nao foi aceito pela SEFAZ.',
    282: 'O certificado nao tem CNPJ — precisa ser certificado de empresa, nao de pessoa.',
    286: 'A loja nao esta credenciada para emitir NFC-e nesta SEFAZ.',
    297: 'A assinatura do XML nao conferiu — avise o suporte.',
    301: 'A loja esta com a inscricao estadual irregular na SEFAZ.',
    338: 'A loja nao esta autorizada a emitir NFC-e. Peca o credenciamento ao contador.',
    373: 'Em homologacao o primeiro item precisa ter a descricao de teste da SEFAZ. ' +
         'Atualize o sistema: a partir da 1.9.1 isso e automatico.',
    610: 'A soma dos pagamentos nao bate com o total da nota — avise o suporte.',
    702: 'A nota foi para um autorizador que nao atende NFC-e da Bahia. ' +
         'Confira os enderecos da SEFAZ (a Bahia usa a SEFAZ Virtual do RS).',
    778: 'Um item esta com NCM que nao existe na tabela. Corrija no cadastro do produto.',
    882: 'O codigo de barras de um item nao esta no cadastro nacional de GTIN. ' +
         'Apague o codigo de barras desse produto (ou use o do fabricante) e reenvie.',
    883: 'O codigo de barras de um item esta invalido. Apague-o no cadastro do produto e reenvie.',
    1115: 'A SEFAZ passou a exigir os campos de IBS/CBS (reforma tributaria). ' +
          'O sistema precisa ser atualizado — avise o suporte.',
    394: 'O XML foi sem o bloco do QR Code — avise o suporte (a partir da 1.9.2 isso nao acontece).',
    404: 'Um item tem imposto incompativel com o regime da loja (confira o CSOSN).',
    478: 'Uma NFC-e nao pode ter valor acima do limite do estado para venda a consumidor.',
    509: 'O codigo do municipio esta invalido.',
    539: 'Ja existe uma nota com esta chave e conteudo diferente.',
    598: 'A loja esta bloqueada na SEFAZ por pendencia cadastral.'
  };
  const c = parseInt(codigo, 10);
  if (c === 225 && /qrCode/i.test(String(motivoOriginal))) {
    return 'O QR Code saiu fora do formato: quase sempre e o ID do CSC gravado errado ' +
           '(letra, hifen ou o codigo colado no campo do ID). Confira em Sistema > NFC-e > CSC. ' +
           `(SEFAZ ${codigo}: ${motivoOriginal})`;
  }
  return (dicas[c] ? `${dicas[c]}${qualItem} (SEFAZ ${codigo}: ${motivoOriginal})`
                   : `SEFAZ ${codigo}: ${motivoOriginal}${qualItem}`);
}

/** Envia a nota assinada e devolve o que a SEFAZ respondeu. */
async function transmitirNfce(cfg, xmlAssinado, cert) {
  const url = txt(cfg[`nfce_ws_${ambienteAtual(cfg) === 1 ? 'producao' : 'homologacao'}`]);
  if (!url) throw new Error('Falta o endereco do servico de autorizacao da SEFAZ.');

  const lote =
    `<enviNFe xmlns="${fiscal.NS_NFE}" versao="4.00">` +
    `<idLote>${Date.now()}</idLote><indSinc>1</indSinc>` +
    xmlAssinado.replace(/^<\?xml[^>]*\?>/, '') +
    '</enviNFe>';

  const c = one('SELECT arquivo, senha FROM certificado WHERE id = 1');
  const resposta = await fiscal.postarSefaz(
    url, fiscal.envelopeSoap(lote, 'NFeAutorizacao4'),
    c.arquivo, fiscal.decifrar(c.senha, chaveDeCifra()));

  /* A resposta sincrona traz o protNFe dentro do retEnviNFe. Se a SEFAZ
     recusar o lote inteiro, o status vem so no nivel de cima.
     O bloco vai INTEIRO (com as tags <protNFe>), porque e assim que ele
     entra no arquivo que a loja tem que guardar por cinco anos. */
  const protNFe = fiscal.extrairBloco(resposta, 'protNFe');
  const nivelNota = protNFe || resposta;

  return {
    xml: resposta,
    status: fiscal.extrair(nivelNota, 'cStat') || fiscal.extrair(resposta, 'cStat'),
    motivo: fiscal.extrair(nivelNota, 'xMotivo') || fiscal.extrair(resposta, 'xMotivo'),
    protocolo: fiscal.extrair(nivelNota, 'nProt'),
    dataAutorizacao: fiscal.extrair(nivelNota, 'dhRecbto'),
    protNFe
  };
}

/* =========================================================================
   [1.10] FOCUS NFe — transmissao pela API deles

   A Focus recebe a venda em JSON, monta o XML, assina com o certificado que
   a loja cadastrou NO PAINEL DELES, transmite, guarda o XML e devolve chave,
   numero, protocolo e QR Code. A numeracao e deles: o sistema nao manda
   numero nem serie, e grava o que voltar. O cupom termico continua sendo o
   nosso, com o QR Code que a Focus devolveu.
   ========================================================================= */

const FOCUS_URL = {
  homologacao: 'https://homologacao.focusnfe.com.br',
  producao: 'https://api.focusnfe.com.br'
};

function focusBase(cfg) {
  return txt(cfg.focus_base_url) || FOCUS_URL[nomeAmbiente(cfg)];
}

function focusToken(cfg) {
  return txt(cfg['focus_token_' + nomeAmbiente(cfg)]);
}

/** Chamada HTTP(S) na Focus com Basic auth (token como usuario, senha vazia). */
function focusRequest(cfg, metodo, caminho, corpo, tempoLimite = 40000) {
  return new Promise((pronto, falhou) => {
    let alvo;
    try { alvo = new URL(focusBase(cfg) + caminho); } catch (e) {
      return falhou(new Error('Endereco da Focus invalido: ' + focusBase(cfg)));
    }
    const lib = alvo.protocol === 'http:' ? require('http') : require('https');
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo), 'utf8');
    const req = lib.request({
      host: alvo.hostname, port: alvo.port || (alvo.protocol === 'http:' ? 80 : 443),
      path: alvo.pathname + alvo.search, method: metodo,
      headers: {
        Authorization: 'Basic ' + Buffer.from(focusToken(cfg) + ':').toString('base64'),
        Accept: 'application/json',
        ...(dados ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': dados.length } : {})
      }
    }, (resp) => {
      let texto = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { texto += c; });
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(texto); } catch (e) { /* nao era json */ }
        pronto({ status: resp.statusCode, json, texto });
      });
    });
    req.setTimeout(tempoLimite, () => {
      req.destroy();
      falhou(new Error('A Focus NFe nao respondeu a tempo. Verifique a internet da loja.'));
    });
    req.on('error', (e) => {
      const m = String(e.message || '');
      if (/ENOTFOUND|EAI_AGAIN/.test(m)) return falhou(new Error('Nao consegui achar o endereco da Focus NFe. Confira a internet da loja.'));
      if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET/.test(m)) return falhou(new Error('A Focus NFe recusou a conexao ou esta fora do ar. Tente de novo em instantes.'));
      falhou(new Error('Falha ao falar com a Focus NFe: ' + m));
    });
    if (dados) req.write(dados);
    req.end();
  });
}

/** Traduz a resposta de erro da Focus para uma frase que o caixa entende. */
function motivoFocus(r) {
  const j = r.json || {};
  if (r.status === 401 || r.status === 403 || j.codigo === 'permissao_negada' || j.codigo === 'nao_autorizado') {
    return 'A Focus NFe nao aceitou o token. Confira o token do ambiente em Sistema > NFC-e > Focus NFe.';
  }
  const partes = [];
  if (j.mensagem_sefaz) partes.push(j.mensagem_sefaz);
  if (Array.isArray(j.erros)) partes.push(...j.erros.map((e) => (e.campo ? e.campo + ': ' : '') + (e.mensagem || e.codigo)));
  if (!partes.length && j.mensagem) partes.push(j.mensagem);
  if (!partes.length && j.codigo) partes.push(j.codigo);
  if (!partes.length) partes.push(`HTTP ${r.status}: ${limpoTexto(r.texto, 200)}`);
  const status = txt(j.status_sefaz);
  return (status ? explicarRejeicao(status, partes.join(' | ')) : partes.join(' | '));
}

const limpoTexto = (v, n) => txt(v).replace(/\s+/g, ' ').slice(0, n);

/** Monta o JSON que a Focus espera para uma venda. */
function montarNfceFocus(venda, itens, pagamentos, cfg) {
  const ambiente = ambienteAtual(cfg);
  const descontoGeral = round2(venda.desconto);
  const somaItens = round2(itens.reduce((s, i) => s + num(i.quantidade) * num(i.preco_unit), 0));
  let rateado = 0;

  const items = itens.map((i, idx) => {
    const bruto = round2(num(i.quantidade) * num(i.preco_unit));
    let desconto = round2(num(i.desconto));
    if (descontoGeral > 0 && somaItens > 0) {
      const parte = idx === itens.length - 1
        ? round2(descontoGeral - rateado) : round2(descontoGeral * (bruto / somaItens));
      rateado = round2(rateado + parte);
      desconto = round2(desconto + parte);
    }
    const prod = one('SELECT codigo_barras FROM produtos WHERE id = ?', [i.produto_id]) || {};
    const ean = somenteDigitos(prod.codigo_barras);
    const item = {
      numero_item: String(idx + 1),
      codigo_produto: fiscal.limpo(i.codigo || i.produto_id, 60),
      /* Em homologacao vale a mesma regra da SEFAZ: o primeiro item leva a
         frase de teste. A Focus pode ate trocar sozinha; mandar certo nao
         atrapalha. */
      descricao: fiscal.limpo(ambiente === 2 && idx === 0 ? fiscal.FRASE_HOMOLOGACAO : i.descricao, 120),
      codigo_ncm: somenteDigitos(i.ncm) || somenteDigitos(cfg.nfce_ncm_padrao) || '00000000',
      cfop: somenteDigitos(i.cfop) || somenteDigitos(cfg.nfce_cfop_padrao) || '5102',
      unidade_comercial: fiscal.limpo(i.unidade || 'UN', 6),
      unidade_tributavel: fiscal.limpo(i.unidade || 'UN', 6),
      quantidade_comercial: num(i.quantidade),
      quantidade_tributavel: num(i.quantidade),
      valor_unitario_comercial: num(i.preco_unit),
      valor_unitario_tributavel: num(i.preco_unit),
      valor_bruto: bruto,
      icms_origem: txt(i.origem) || txt(cfg.nfce_origem_padrao) || '0',
      icms_situacao_tributaria: txt(i.csosn) || txt(cfg.nfce_csosn_padrao) || '102',
      pis_situacao_tributaria: txt(cfg.nfce_cst_pis) || '49',
      cofins_situacao_tributaria: txt(cfg.nfce_cst_cofins) || '49'
    };
    if (desconto > 0) item.valor_desconto = desconto;
    if (somenteDigitos(i.cest)) item.cest = somenteDigitos(i.cest);
    if (fiscal.gtinValido(ean)) { item.codigo_barras_comercial = ean; item.codigo_barras_tributavel = ean; }
    return item;
  });

  /* Pagamentos: o total da nota, sem troco. Dinheiro entra pelo valor da
     nota, nao pelo que o cliente entregou — a nota nao precisa do troco. */
  const totalNota = round2(venda.total);
  const pagos = pagamentos.map((p) => ({ forma: p.forma, valor: num(p.valor) }));
  const somaPagos = round2(pagos.reduce((s, p) => s + p.valor, 0));
  const troco = round2(somaPagos - totalNota);
  if (troco > 0) {
    // tira o troco do dinheiro
    const din = pagos.find((p) => /dinheiro/i.test(p.forma));
    if (din) din.valor = round2(din.valor - troco);
  }
  const formas_pagamento = pagos.filter((p) => p.valor > 0).map((p) => {
    const t = fiscal.codigoPagamento(p.forma);
    const f = { forma_pagamento: t, valor_pagamento: p.valor };
    // [1.14] cartao (03/04) E PIX (17/20) precisam do grupo com tpIntegra,
    // senao a SEFAZ rejeita (391). 2 = recebimento nao integrado ao sistema.
    if (['03', '04', '17', '20'].includes(t)) f.tipo_integracao = '2';
    return f;
  });

  const nota = {
    cnpj_emitente: somenteDigitos(cfg.loja_cnpj),
    data_emissao: fiscal.dataXml(new Date()),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    presenca_comprador: '1',
    modalidade_frete: '9',
    local_destino: '1',
    items,
    formas_pagamento
  };
  if (num(venda.acrescimo) > 0) nota.valor_outras_despesas = round2(venda.acrescimo);
  const doc = somenteDigitos(venda.cliente_doc);
  if (doc) {
    if (doc.length === 14) nota.cnpj_destinatario = doc; else nota.cpf_destinatario = doc;
    nota.nome_destinatario = fiscal.limpo(venda.cliente_nome || 'CONSUMIDOR', 60);
    nota.indicador_inscricao_estadual_destinatario = '9';
  }
  if (txt(cfg.nfce_info_complementar)) {
    nota.informacoes_adicionais_contribuinte = fiscal.limpo(cfg.nfce_info_complementar, 2000);
  }
  return nota;
}

/** Aplica ao registro local o que a Focus devolveu de uma nota autorizada. */
async function gravarAutorizadaFocus(cfg, notaId, j) {
  const chave = somenteDigitos(j.chave_nfe);
  let xml = null;
  if (txt(j.caminho_xml_nota_fiscal)) {
    try {
      const r = await focusRequest(cfg, 'GET', j.caminho_xml_nota_fiscal);
      if (r.status === 200 && /<nfeProc|<NFe/.test(r.texto)) xml = r.texto;
    } catch (e) { /* sem o XML local a nota continua valida — ele fica na Focus */ }
  }
  run(`UPDATE nfce SET situacao = 'autorizada', status = ?, motivo = ?, protocolo = ?,
       data_autorizacao = ?, chave = ?, numero = ?, serie = ?, qrcode = ?, url_consulta = ?,
       xml_autorizado = ?, xml_retorno = ?, atualizado_em = ? WHERE id = ?`,
    [txt(j.status_sefaz) || '100', txt(j.mensagem_sefaz) || 'Autorizado o uso da NF-e',
     txt(j.numero_protocolo) || null, agora(), chave || null,
     parseInt(j.numero, 10) || null, parseInt(j.serie, 10) || null,
     txt(j.qrcode_url) || null, txt(j.url_consulta_nf) || null,
     xml, JSON.stringify(j), agora(), notaId]);
  salvarBanco();
}

/** Emissao pela Focus. Devolve o que a rota responde. */
async function emitirPelaFocus(cfg, vendaId, usuario) {
  const venda = one('SELECT * FROM vendas WHERE id = ?', [vendaId]);
  if (!venda) return { status: 400, corpo: { erro: 'Venda nao encontrada.' } };
  if (venda.situacao === 'cancelada') return { status: 400, corpo: { erro: 'Esta venda foi cancelada.' } };
  const itens = all('SELECT * FROM venda_itens WHERE venda_id = ?', [vendaId]);
  if (!itens.length) return { status: 400, corpo: { erro: 'A venda nao tem itens.' } };
  const pagamentos = all('SELECT * FROM venda_pagamentos WHERE venda_id = ?', [vendaId]);
  const ambiente = ambienteAtual(cfg);

  /* Nota pendente com ref: antes de mandar outra, pergunta a Focus o que
     aconteceu com ela (a SEFAZ pode ter autorizado sem a gente saber). */
  const pendente = one(
    `SELECT * FROM nfce WHERE venda_id = ? AND modo = 'focus' AND ambiente = ?
     AND situacao IN ('pendente', 'erro') AND ref_externa IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [vendaId, ambiente]);
  if (pendente) {
    try {
      const c = await focusRequest(cfg, 'GET', `/v2/nfce/${encodeURIComponent(pendente.ref_externa)}?completa=1`);
      if (c.status === 200 && c.json && c.json.status === 'autorizado') {
        await gravarAutorizadaFocus(cfg, pendente.id, c.json);
        const n = one('SELECT * FROM nfce WHERE id = ?', [pendente.id]);
        return { status: 200, corpo: { ok: true, nfce_id: n.id, chave: n.chave, numero: n.numero,
          serie: n.serie, protocolo: n.protocolo, motivo: n.motivo } };
      }
      if (c.status === 200 && c.json && c.json.status === 'processando_autorizacao') {
        return { status: 400, corpo: { erro: 'A Focus ainda esta processando esta nota. Tente de novo em instantes.', nfce_id: pendente.id, pendente: true } };
      }
      // erro_autorizacao ou 404: segue para uma tentativa nova
    } catch (e) {
      return { status: 400, corpo: { erro: e.message, nfce_id: pendente.id, pendente: true } };
    }
  }

  const anteriores = one("SELECT COUNT(*) AS n FROM nfce WHERE venda_id = ? AND modo = 'focus'", [vendaId]);
  const tentativa = (anteriores ? anteriores.n : 0) + 1;
  const ref = `rvl-v${vendaId}-a${ambiente}` + (tentativa > 1 ? `-t${tentativa}` : '');

  let corpo;
  try {
    corpo = montarNfceFocus(venda, itens, pagamentos, cfg);
  } catch (e) {
    return { status: 400, corpo: { erro: e.message } };
  }

  const notaId = inserir(
    `INSERT INTO nfce (venda_id, ambiente, modelo, serie, numero, situacao, tp_emis, tentativas,
       criado_em, usuario, ref_externa, modo, xml_assinado)
     VALUES (?,?,65,NULL,NULL,'pendente',1,1,?,?,?,'focus',?)`,
    [vendaId, ambiente, agora(), usuario, ref, JSON.stringify(corpo)]);

  let r;
  try {
    r = await focusRequest(cfg, 'POST', `/v2/nfce?ref=${encodeURIComponent(ref)}&completa=1`, corpo);
  } catch (e) {
    run("UPDATE nfce SET situacao = 'erro', motivo = ?, atualizado_em = ? WHERE id = ?", [e.message, agora(), notaId]);
    salvarBanco();
    registrarLog(usuario, 'nfce', `venda ${vendaId} - focus falha: ${e.message}`);
    return { status: 400, corpo: { erro: e.message, nfce_id: notaId, pendente: true } };
  }

  let j = r.json || {};
  // a Focus costuma responder na hora; se ficar processando, espera um pouco
  let voltas = 0;
  while ((r.status === 201 || r.status === 200 || r.status === 202) && j.status === 'processando_autorizacao' && voltas < 6) {
    await new Promise((ok) => setTimeout(ok, 2000));
    voltas++;
    try {
      const c = await focusRequest(cfg, 'GET', `/v2/nfce/${encodeURIComponent(ref)}?completa=1`);
      if (c.json) { j = c.json; r = c; }
    } catch (e) { break; }
  }

  if ((r.status === 201 || r.status === 200) && j.status === 'autorizado') {
    await gravarAutorizadaFocus(cfg, notaId, j);
    const n = one('SELECT * FROM nfce WHERE id = ?', [notaId]);
    registrarLog(usuario, 'nfce', `venda ${vendaId} - autorizada pela Focus - nota ${n.serie}/${n.numero}`);
    return { status: 200, corpo: { ok: true, nfce_id: n.id, chave: n.chave, numero: n.numero,
      serie: n.serie, protocolo: n.protocolo, motivo: n.motivo } };
  }
  if (j.status === 'processando_autorizacao') {
    run("UPDATE nfce SET motivo = ?, xml_retorno = ?, atualizado_em = ? WHERE id = ?",
      ['A Focus ainda esta processando. Clique em Reenviar daqui a pouco para buscar o resultado.', JSON.stringify(j), agora(), notaId]);
    salvarBanco();
    return { status: 400, corpo: { erro: 'A Focus recebeu a nota e ainda esta processando. Clique em Reenviar daqui a pouco.', nfce_id: notaId, pendente: true } };
  }

  const motivo = `[Focus · ${nomeAmbiente(cfg)}] ` + motivoFocus(r);
  run(`UPDATE nfce SET situacao = 'rejeitada', status = ?, motivo = ?, xml_retorno = ?, atualizado_em = ? WHERE id = ?`,
    [txt(j.status_sefaz) || String(r.status), motivo, r.texto, agora(), notaId]);
  salvarBanco();
  registrarLog(usuario, 'nfce', `venda ${vendaId} - focus rejeitou: ${motivo}`);
  return { status: 400, corpo: { erro: motivo, nfce_id: notaId, status: txt(j.status_sefaz) || String(r.status) } };
}

/** Cancelamento pela Focus. */
async function cancelarPelaFocus(cfg, n, justificativa, usuario) {
  let r;
  try {
    r = await focusRequest(cfg, 'DELETE', `/v2/nfce/${encodeURIComponent(n.ref_externa)}`, { justificativa });
  } catch (e) {
    return { status: 400, corpo: { erro: e.message } };
  }
  const j = r.json || {};
  if ((r.status === 200 || r.status === 201) && j.status === 'cancelado') {
    // [1.11] a Focus devolve o caminho do XML do evento de cancelamento
    let xmlCanc = null;
    if (txt(j.caminho_xml_cancelamento)) {
      try {
        const x = await focusRequest(cfg, 'GET', j.caminho_xml_cancelamento);
        if (x.status === 200 && /<procEventoNFe|<retEvento|<evento/.test(x.texto)) xmlCanc = x.texto;
      } catch (e) { /* fica na Focus */ }
    }
    run(`UPDATE nfce SET situacao = 'cancelada', cancelamento_protocolo = ?, cancelamento_motivo = ?,
         cancelamento_em = ?, atualizado_em = ?, xml_cancelamento = ? WHERE id = ?`,
      [txt(j.numero_protocolo) || null, justificativa, agora(), agora(), xmlCanc, n.id]);
    salvarBanco();
    registrarLog(usuario, 'nfce-cancelar', `nota ${n.serie}/${n.numero} (focus) - ${justificativa}`);
    return { status: 200, corpo: { ok: true, mensagem: `NFC-e cancelada (${txt(j.mensagem_sefaz) || 'evento registrado'}).` } };
  }
  return { status: 400, corpo: { erro: motivoFocus(r) } };
}

/* ---------------- rotas ---------------- */

app.get('/api/nfce', auth, (req, res) => {
  const limite = Math.min(500, Math.max(1, parseInt(req.query.limite, 10) || 50));
  const filtros = [];
  const params = [];
  if (req.query.venda_id) { filtros.push('venda_id = ?'); params.push(req.query.venda_id); }
  if (req.query.situacao) { filtros.push('situacao = ?'); params.push(req.query.situacao); }
  const onde = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  res.json(all(
    `SELECT id, venda_id, ambiente, serie, numero, chave, situacao, status, motivo,
            protocolo, data_autorizacao, tp_emis, criado_em, usuario, modo, ref_externa
     FROM nfce ${onde} ORDER BY id DESC LIMIT ${limite}`, params));
});

app.get('/api/nfce/status-servico', auth, async (req, res) => {
  const cfg = lerConfig();
  if (modoFocus(cfg)) {
    if (!focusToken(cfg)) return res.status(400).json({ erro: `Falta o token de ${nomeAmbiente(cfg)} da Focus NFe.` });
    try {
      // uma ref que nao existe: 404 com JSON = token aceito; 401/403 = token errado
      const r = await focusRequest(cfg, 'GET', '/v2/nfce/rvl-teste-de-token-' + Date.now(), undefined, 15000);
      if (r.status === 401 || r.status === 403) return res.json({ ok: false, status: String(r.status), motivo: motivoFocus(r), ambiente: ambienteAtual(cfg) });
      return res.json({ ok: true, status: '107', motivo: `Focus NFe respondendo em ${nomeAmbiente(cfg)}; token aceito.`, ambiente: ambienteAtual(cfg) });
    } catch (e) {
      return res.status(400).json({ erro: e.message });
    }
  }
  const url = txt(cfg[`nfce_ws_status_${ambienteAtual(cfg) === 1 ? 'producao' : 'homologacao'}`]);
  if (!url) return res.status(400).json({ erro: 'Falta o endereco do servico de status da SEFAZ.' });

  const c = one('SELECT arquivo, senha FROM certificado WHERE id = 1');
  if (!c || !txt(c.arquivo)) {
    return res.status(400).json({ erro: 'Cadastre o certificado digital antes de testar a conexao.' });
  }

  const uf = fiscal.UF_CODIGO[txt(cfg.loja_uf).toUpperCase()];
  const corpo =
    `<consStatServ xmlns="${fiscal.NS_NFE}" versao="4.00">` +
    `<tpAmb>${ambienteAtual(cfg)}</tpAmb><cUF>${uf}</cUF><xServ>STATUS</xServ>` +
    '</consStatServ>';

  try {
    const resposta = await fiscal.postarSefaz(
      url, fiscal.envelopeSoap(corpo, 'NFeStatusServico4'),
      c.arquivo, fiscal.decifrar(c.senha, chaveDeCifra()), 20000);
    const status = fiscal.extrair(resposta, 'cStat');
    res.json({
      ok: status === '107',              // 107 = servico em operacao
      status,
      motivo: fiscal.extrair(resposta, 'xMotivo'),
      ambiente: ambienteAtual(cfg),
      tempo_medio: fiscal.extrair(resposta, 'tMed')
    });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

app.get('/api/nfce/:id', auth, (req, res) => {
  const n = one('SELECT * FROM nfce WHERE id = ?', [req.params.id]);
  if (!n) return res.status(404).json({ erro: 'Nota nao encontrada.' });
  delete n.xml_assinado;                  // pesado demais para a tela
  res.json(n);
});

app.get('/api/nfce/:id/xml', auth, (req, res) => {
  const n = one('SELECT * FROM nfce WHERE id = ?', [req.params.id]);
  if (!n) return res.status(404).send('Nota nao encontrada.');
  const xml = n.xml_autorizado || n.xml_assinado;
  if (!xml) return res.status(404).send('Esta nota ainda nao tem XML.');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${n.chave || 'nfce'}.xml"`);
  res.send(xml);
});

/** Emite (ou reenvia) a NFC-e de uma venda. */
app.post('/api/nfce/emitir', auth, async (req, res) => {
  const cfg = lerConfig();
  const vendaId = parseInt(req.body.venda_id, 10);
  if (!vendaId) return res.status(400).json({ erro: 'Informe a venda.' });

  const impedimento = podeEmitir(cfg);
  if (impedimento) return res.status(400).json({ erro: impedimento });

  const jaAutorizada = one(
    "SELECT id FROM nfce WHERE venda_id = ? AND situacao = 'autorizada'", [vendaId]);
  if (jaAutorizada) {
    return res.status(400).json({ erro: 'Esta venda ja tem NFC-e autorizada.' });
  }

  if (modoFocus(cfg)) {
    const r = await emitirPelaFocus(cfg, vendaId, req.usuario.usuario);
    return res.status(r.status).json(r.corpo);
  }

  /* [1.9.1] REJEICAO NAO CONSOME NUMERO. Quando a SEFAZ recusa a nota, ela
     nunca registrou aquele numero — entao o reenvio da mesma venda usa o
     MESMO numero, em vez de furar a sequencia a cada tentativa (cada buraco
     em producao precisa ser inutilizado depois, um por um).
     Nota que deu ERRO de comunicacao nao entra nesta regra: a SEFAZ pode ter
     recebido e autorizado sem o sistema saber, e reusar o numero daria
     duplicidade. Essa fica para inutilizacao. */
  const anterior = one(
    `SELECT id, numero FROM nfce
     WHERE venda_id = ? AND situacao = 'rejeitada' AND ambiente = ?
     ORDER BY id DESC LIMIT 1`, [vendaId, ambienteAtual(cfg)]);

  let preparada;
  try {
    preparada = prepararNfce(vendaId, cfg, anterior ? { numero: anterior.numero } : {});
  } catch (e) {
    return res.status(400).json({ erro: e.message });
  }

  const qr = preparada.qr;       // ja calculado e ja dentro do XML

  /* A nota entra no banco ANTES de ir para a SEFAZ. Se a luz cair no meio
     do caminho, o numero fica registrado e nao vira buraco na sequencia. */
  let notaId;
  if (anterior) {
    // reenvio: a mesma linha, com a chave nova e uma tentativa a mais
    run(`UPDATE nfce SET chave = ?, codigo_numerico = ?, tp_emis = ?, situacao = 'pendente',
         status = NULL, motivo = NULL, protocolo = NULL, data_autorizacao = NULL,
         digest_value = ?, qrcode = ?, url_consulta = ?, xml_assinado = ?,
         xml_autorizado = NULL, xml_retorno = NULL,
         tentativas = COALESCE(tentativas, 0) + 1, atualizado_em = ?, usuario = ?
         WHERE id = ?`,
      [preparada.chave, preparada.cNF, preparada.tpEmis,
       fiscal.digestDoXml(preparada.assinado), qr.qrcode, qr.url_consulta,
       preparada.assinado, agora(), req.usuario.usuario, anterior.id]);
    salvarBanco();
    notaId = anterior.id;
  } else {
    notaId = inserir(
      `INSERT INTO nfce
       (venda_id, ambiente, modelo, serie, numero, chave, codigo_numerico, tp_emis,
        situacao, digest_value, qrcode, url_consulta, xml_assinado, tentativas, criado_em, usuario)
       VALUES (?,?,65,?,?,?,?,?, 'pendente', ?,?,?,?,1,?,?)`,
      [vendaId, preparada.ambiente, preparada.serie, preparada.numero, preparada.chave,
       preparada.cNF, preparada.tpEmis, fiscal.digestDoXml(preparada.assinado),
       qr.qrcode, qr.url_consulta, preparada.assinado, agora(), req.usuario.usuario]);
  }

  try {
    const r = await transmitirNfce(cfg, preparada.assinado, preparada.cert);
    const autorizada = r.status === '100' || r.status === '150';   // 150 = autorizada fora do prazo

    let situacao = 'rejeitada';
    /* [1.10.1] A mensagem diz por onde a nota foi e com qual ID do CSC —
       assim um print da tela ja conta a historia inteira. */
    const etiqueta = `[direto · ${nomeAmbiente(cfg)}` +
      (txt(cfg.nfce_qrcode_versao) !== '3' ? ` · ID do CSC ${parseInt(cscDoAmbiente(cfg).id, 10) || '?'}` : ' · QR v3') + '] ';
    let motivo = etiqueta + explicarRejeicao(r.status, r.motivo, preparada.dados.itens);
    if (autorizada) { situacao = 'autorizada'; motivo = r.motivo; }

    /* XML de distribuicao: a nota assinada mais o protocolo, que e o que
       vale como documento fiscal e precisa ser guardado por 5 anos. */
    const xmlAutorizado = autorizada
      ? `<nfeProc xmlns="${fiscal.NS_NFE}" versao="4.00">` +
        preparada.assinado.replace(/^<\?xml[^>]*\?>/, '') + r.protNFe + '</nfeProc>'
      : null;

    run(`UPDATE nfce SET situacao = ?, status = ?, motivo = ?, protocolo = ?,
         data_autorizacao = ?, xml_autorizado = ?, xml_retorno = ?, atualizado_em = ?
         WHERE id = ?`,
      [situacao, r.status, motivo, r.protocolo || null,
       r.dataAutorizacao || null, xmlAutorizado, r.xml, agora(), notaId]);
    salvarBanco();

    registrarLog(req.usuario.usuario, 'nfce',
      `venda ${vendaId} - ${situacao} (${r.status}) - nota ${preparada.serie}/${preparada.numero}`);

    if (!autorizada) return res.status(400).json({ erro: motivo, nfce_id: notaId, status: r.status });

    res.json({
      ok: true, nfce_id: notaId, chave: preparada.chave,
      numero: preparada.numero, serie: preparada.serie,
      protocolo: r.protocolo, motivo
    });
  } catch (e) {
    /* Falha de comunicacao — a nota fica pendente e pode ser reenviada.
       A venda ja esta gravada; nada se perde. */
    run(`UPDATE nfce SET situacao = 'erro', motivo = ?, atualizado_em = ? WHERE id = ?`,
      [e.message, agora(), notaId]);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'nfce', `venda ${vendaId} - falha: ${e.message}`);
    res.status(400).json({ erro: e.message, nfce_id: notaId, pendente: true });
  }
});

/** Cancelamento — evento 110111. A SEFAZ so aceita dentro do prazo do estado. */
app.post('/api/nfce/:id/cancelar', auth, async (req, res) => {
  const cfg = lerConfig();
  const justificativa = txt(req.body.justificativa);
  if (justificativa.length < 15) {
    return res.status(400).json({ erro: 'A justificativa precisa de pelo menos 15 letras.' });
  }

  const n = one('SELECT * FROM nfce WHERE id = ?', [req.params.id]);
  if (!n) return res.status(404).json({ erro: 'Nota nao encontrada.' });
  if (n.situacao !== 'autorizada') {
    return res.status(400).json({ erro: 'So da para cancelar nota autorizada.' });
  }
  if (n.modo === 'focus') {
    if (!n.ref_externa) return res.status(400).json({ erro: 'Esta nota nao tem referencia na Focus.' });
    const r = await cancelarPelaFocus(cfg, n, justificativa, req.usuario.usuario);
    return res.status(r.status).json(r.corpo);
  }
  if (!n.protocolo) return res.status(400).json({ erro: 'Esta nota nao tem protocolo de autorizacao.' });

  const c = one('SELECT arquivo, senha FROM certificado WHERE id = 1');
  if (!c || !txt(c.arquivo)) return res.status(400).json({ erro: 'Nenhum certificado cadastrado.' });

  const cert = certificadoAberto();
  const uf = fiscal.UF_CODIGO[txt(cfg.loja_uf).toUpperCase()];
  const cnpj = somenteDigitos(cfg.loja_cnpj);
  const idEvento = `ID110111${n.chave}01`;
  const agoraXml = fiscal.dataXml(new Date());

  const infEvento =
    `<infEvento Id="${idEvento}">` +
    `<cOrgao>${uf}</cOrgao><tpAmb>${n.ambiente}</tpAmb><CNPJ>${cnpj}</CNPJ>` +
    `<chNFe>${n.chave}</chNFe><dhEvento>${agoraXml}</dhEvento>` +
    '<tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>' +
    '<detEvento versao="1.00"><descEvento>Cancelamento</descEvento>' +
    `<nProt>${n.protocolo}</nProt>` +
    `<xJust>${fiscal.limpo(justificativa, 255)}</xJust>` +
    '</detEvento></infEvento>';

  const eventoAssinado = fiscal.assinarEvento(
    `<evento xmlns="${fiscal.NS_NFE}" versao="1.00">${infEvento}</evento>`, idEvento, cert);

  const lote =
    `<envEvento xmlns="${fiscal.NS_NFE}" versao="1.00">` +
    `<idLote>${Date.now()}</idLote>${eventoAssinado}</envEvento>`;

  const url = txt(cfg[`nfce_ws_evento_${n.ambiente === 1 ? 'producao' : 'homologacao'}`]);
  if (!url) return res.status(400).json({ erro: 'Falta o endereco do servico de eventos da SEFAZ.' });

  try {
    const resposta = await fiscal.postarSefaz(
      url, fiscal.envelopeSoap(lote, 'NFeRecepcaoEvento4'),
      c.arquivo, fiscal.decifrar(c.senha, chaveDeCifra()));

    const retEvento = fiscal.extrairBloco(resposta, 'retEvento') || resposta;
    const status = fiscal.extrair(retEvento, 'cStat');
    const motivo = fiscal.extrair(retEvento, 'xMotivo');
    // 135 = evento registrado | 155 = registrado fora do prazo
    const aceito = status === '135' || status === '155';

    if (!aceito) {
      return res.status(400).json({ erro: explicarRejeicao(status, motivo) });
    }

    /* [1.11] procEventoNFe = evento assinado + resposta da SEFAZ. E o
       arquivo que a contabilidade guarda junto com a nota cancelada. */
    const retSemPrefixo = retEvento.replace(/<(\/?)\w+:/g, '<$1').replace(/\sxmlns:\w+="[^"]*"/g, '');
    const procEvento =
      `<procEventoNFe versao="1.00" xmlns="${fiscal.NS_NFE}">${eventoAssinado}${retSemPrefixo}</procEventoNFe>`;

    run(`UPDATE nfce SET situacao = 'cancelada', cancelamento_protocolo = ?,
         cancelamento_motivo = ?, cancelamento_em = ?, atualizado_em = ?, xml_cancelamento = ? WHERE id = ?`,
      [fiscal.extrair(retEvento, 'nProt'), justificativa, agora(), agora(), procEvento, n.id]);
    salvarBanco();

    registrarLog(req.usuario.usuario, 'nfce-cancelar',
      `nota ${n.serie}/${n.numero} - ${justificativa}`);
    res.json({ ok: true, mensagem: `NFC-e cancelada na SEFAZ (${motivo}).` });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

/* =========================================================================
   CATEGORIAS
   ========================================================================= */

app.get('/api/categorias', auth, (req, res) => {
  res.json(all('SELECT * FROM categorias WHERE ativo = 1 ORDER BY nome'));
});

app.post('/api/categorias', auth, (req, res) => {
  const nome = txt(req.body.nome).toUpperCase();
  if (!nome) return res.status(400).json({ erro: 'Informe o nome da categoria.' });
  if (req.body.id) {
    run('UPDATE categorias SET nome = ? WHERE id = ?', [nome, req.body.id]);
    salvarBanco();
    return res.json({ ok: true, id: req.body.id });
  }
  const existe = one('SELECT id FROM categorias WHERE nome = ? AND ativo = 1', [nome]);
  if (existe) return res.json({ ok: true, id: existe.id });
  const id = inserir('INSERT INTO categorias (nome, ativo) VALUES (?,1)', [nome]);
  res.json({ ok: true, id });
});

app.delete('/api/categorias/:id', auth, (req, res) => {
  const usada = one('SELECT COUNT(*) AS n FROM produtos WHERE categoria_id = ?', [req.params.id]);
  if (usada && usada.n) {
    run('UPDATE categorias SET ativo = 0 WHERE id = ?', [req.params.id]);
  } else {
    run('DELETE FROM categorias WHERE id = ?', [req.params.id]);
  }
  salvarBanco();
  res.json({ ok: true });
});

/* =========================================================================
   PRODUTOS
   ========================================================================= */

const SQL_PRODUTO = `
  SELECT p.*, c.nome AS categoria
  FROM produtos p
  LEFT JOIN categorias c ON c.id = p.categoria_id
`;

app.get('/api/produtos', auth, (req, res) => {
  const filtros = [];
  const params = [];

  if (req.query.ativo !== 'todos') filtros.push('p.ativo = 1');
  if (txt(req.query.categoria)) { filtros.push('p.categoria_id = ?'); params.push(req.query.categoria); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(p.descricao) LIKE ? OR upper(p.codigo) LIKE ? OR p.codigo_barras LIKE ?)');
    params.push(q, q, q);
  }
  if (req.query.abaixo_minimo === '1') filtros.push('p.estoque <= p.estoque_minimo');

  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  const lista = all(`${SQL_PRODUTO} ${where} ORDER BY p.descricao LIMIT 3000`, params);
  // [1.13] reservado = vendido e ainda nao entregue; disponivel = estoque - reservado
  const reservados = reservadosPorProduto();
  lista.forEach((p) => { p.reservado = reservados.get(p.id) || 0; p.disponivel = round2(num(p.estoque) - p.reservado); });
  res.json(lista);
});

/** Busca rapida do PDV: codigo exato, codigo de barras exato ou descricao. */
app.get('/api/produtos/busca', auth, (req, res) => {
  const q = txt(req.query.q);
  if (!q) return res.json([]);
  const digitos = somenteDigitos(q);

  if (digitos && digitos.length >= 6) {
    const exato = one(`${SQL_PRODUTO} WHERE p.codigo_barras = ? AND p.ativo = 1`, [digitos]);
    if (exato) return res.json([exato]);
  }
  const porCodigo = one(`${SQL_PRODUTO} WHERE upper(p.codigo) = ? AND p.ativo = 1`, [q.toUpperCase()]);
  if (porCodigo) return res.json([porCodigo]);

  const termo = '%' + q.toUpperCase() + '%';
  const lista = all(
    `${SQL_PRODUTO} WHERE p.ativo = 1 AND (upper(p.descricao) LIKE ? OR upper(p.codigo) LIKE ? OR p.codigo_barras LIKE ?)
     ORDER BY p.descricao LIMIT 40`,
    [termo, termo, termo]
  );
  lista.forEach((p) => { p.reservado = reservadoDoProduto(p.id); p.disponivel = round2(num(p.estoque) - p.reservado); });
  res.json(lista);
});

/* =========================================================================
   [1.12] NCM DOS PRODUTOS

   O NCM vai em cada item da NFC-e. Produto sem NCM sai com o padrao da loja
   (um codigo generico), o que e risco fiscal em producao. Aqui a loja ve de
   uma vez quem esta sem NCM, recebe sugestao (da nota de compra do
   fornecedor, de produto parecido ja preenchido ou por palavra-chave) e
   aplica em lote — ou manda a planilha para o contador conferir.
   ========================================================================= */

app.get('/api/ncm/busca', auth, (req, res) => {
  const limite = Math.min(60, Math.max(5, parseInt(req.query.limite, 10) || 30));
  res.json(ncm.buscar(txt(req.query.q), limite));
});

app.get('/api/ncm/:codigo', auth, (req, res) => {
  const c = somenteDigitos(req.params.codigo);
  res.json({ ncm: c, valido: ncm.valido(c), descricao: ncm.descricao(c), resumo: ncm.resumo(c) });
});

/** Situacao e sugestao de NCM para todos os produtos ativos. */
function analiseNcm() {
  const produtos = all(`SELECT p.id, p.codigo, p.descricao, p.ncm, p.unidade, p.fornecedor, p.estoque, p.preco_venda,
                               c.nome AS categoria
                        FROM produtos p LEFT JOIN categorias c ON c.id = p.categoria_id
                        WHERE p.ativo = 1 ORDER BY p.descricao`);

  const de = new Date(Date.now() - 180 * 86400000).toISOString();
  const vendas = new Map(all(
    `SELECT i.produto_id, SUM(i.quantidade) AS qtd, SUM(i.total) AS valor
     FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
     WHERE v.situacao <> 'cancelada' AND v.data >= ? AND i.produto_id IS NOT NULL GROUP BY i.produto_id`, [de])
    .map((r) => [r.produto_id, r]));

  // NCM que veio na ultima nota de compra de cada produto (a melhor fonte: e o que o fornecedor declarou)
  const daNota = new Map();
  all(`SELECT e.produto_id, e.ncm, n.numero, n.fornecedor
       FROM entrada_itens e JOIN entradas_nf n ON n.id = e.entrada_id
       WHERE e.produto_id IS NOT NULL AND length(e.ncm) = 8 ORDER BY e.entrada_id DESC`)
    .forEach((r) => { if (!daNota.has(r.produto_id) && ncm.valido(r.ncm)) daNota.set(r.produto_id, r); });

  // produtos parecidos: mesma palavra-chave e NCM valido ja preenchido, todos de acordo
  const porPalavra = new Map();
  produtos.forEach((p) => {
    if (!ncm.valido(p.ncm)) return;
    const k = ncm.palavraChave(p.descricao);
    if (!k) return;
    if (!porPalavra.has(k)) porPalavra.set(k, new Map());
    const m = porPalavra.get(k);
    m.set(somenteDigitos(p.ncm), (m.get(somenteDigitos(p.ncm)) || { n: 0, exemplo: p.descricao }));
    m.get(somenteDigitos(p.ncm)).n++;
  });

  const resumo = { ativos: produtos.length, ok: 0, sem: 0, invalido: 0, sugestao_nota: 0, sugestao_parecido: 0,
    sugestao_palavra: 0, sem_sugestao: 0, vendidos_sem_ncm: 0, divergente_nota: 0 };
  const lista = produtos.map((p) => {
    const atual = somenteDigitos(p.ncm);
    const v = vendas.get(p.id);
    const situacao = !atual ? 'sem' : (ncm.valido(atual) ? 'ok' : 'invalido');
    resumo[situacao]++;
    if (situacao !== 'ok' && v) resumo.vendidos_sem_ncm++;

    const nota = daNota.get(p.id) || null;
    let sugestao = null;
    if (situacao !== 'ok') {
      if (nota) {
        sugestao = { ncm: nota.ncm, fonte: 'nota', detalhe: `NF ${nota.numero || ''} de ${nota.fornecedor || 'fornecedor'}`.trim() };
      } else {
        const k = ncm.palavraChave(p.descricao);
        const m = k ? porPalavra.get(k) : null;
        if (m && m.size === 1) {
          const [cod, info] = [...m.entries()][0];
          sugestao = { ncm: cod, fonte: 'parecido', detalhe: `igual a "${info.exemplo}"` };
        } else {
          const r = ncm.sugerirPorDescricao(p.descricao);
          if (r) sugestao = { ncm: r.ncm, fonte: 'palavra', detalhe: r.regra };
        }
      }
      if (sugestao) {
        sugestao.descricao = ncm.resumo(sugestao.ncm);
        resumo['sugestao_' + sugestao.fonte]++;
      } else resumo.sem_sugestao++;
    } else if (nota && nota.ncm !== atual) {
      resumo.divergente_nota++;
    }

    return {
      id: p.id, codigo: p.codigo, descricao: p.descricao, unidade: p.unidade, fornecedor: p.fornecedor,
      categoria: p.categoria, estoque: round2(p.estoque),
      ncm: atual, situacao, ncm_descricao: situacao === 'ok' ? ncm.resumo(atual, 2) : '',
      nota_ncm: nota && nota.ncm !== atual ? nota.ncm : '',
      vendido_qtd: v ? round2(v.qtd) : 0, vendido_valor: v ? round2(v.valor) : 0,
      sugestao
    };
  });

  // os que vendem primeiro, depois os sem NCM, depois o resto
  lista.sort((a, b) => (b.vendido_valor - a.vendido_valor) || a.descricao.localeCompare(b.descricao));
  return { resumo, produtos: lista, ncm_padrao: txt(lerConfig().nfce_ncm_padrao), tabela: { total: ncm.total, fonte: ncm.fonte } };
}

app.get('/api/produtos/ncm/analise', auth, (req, res) => {
  res.json(analiseNcm());
});

/** So os numeros, para o passo a passo da NFC-e. */
app.get('/api/produtos/ncm/resumo', auth, (req, res) => {
  const a = analiseNcm();
  res.json({ ...a.resumo, ncm_padrao: a.ncm_padrao });
});

/** Aplica NCMs em lote: [{ id, ncm }]. So aceita codigo que existe na tabela. */
app.post('/api/produtos/ncm/aplicar', auth, (req, res) => {
  const itens = Array.isArray(req.body.itens) ? req.body.itens.slice(0, 5000) : [];
  if (!itens.length) return res.status(400).json({ erro: 'Nada para aplicar.' });
  let aplicados = 0;
  const recusados = [];
  itens.forEach((it) => {
    const c = somenteDigitos(it.ncm);
    const id = parseInt(it.id, 10);
    if (!id) return;
    if (!ncm.valido(c)) { recusados.push({ id, ncm: c, motivo: c.length === 8 ? 'NCM nao existe na tabela' : 'NCM precisa ter 8 digitos' }); return; }
    run('UPDATE produtos SET ncm = ?, atualizado_em = ? WHERE id = ?', [c, agora(), id]);
    aplicados++;
  });
  salvarBanco();
  registrarLog(req.usuario.usuario, 'produto-ncm', `${aplicados} produto(s) com NCM aplicado em lote`);
  res.json({ ok: true, aplicados, recusados });
});

/** Planilha para o contador conferir — e importar de volta em Produtos > Importar planilha. */
app.get('/api/produtos/ncm/planilha.xlsx', auth, (req, res) => {
  const a = analiseNcm();
  const wb = XLSX.utils.book_new();
  const fontes = { nota: 'sugestao: nota de compra', parecido: 'sugestao: produto parecido', palavra: 'sugestao: palavra-chave' };
  const linhas = [['Código', 'Descrição', 'NCM', 'Origem do NCM', 'Descrição do NCM', 'NCM da nota de compra',
    'Vendido 180 dias (qtd)', 'Estoque', 'Unidade', 'Fornecedor', 'Categoria']];
  a.produtos.forEach((p) => {
    const ncmPlan = p.situacao === 'ok' ? p.ncm : (p.sugestao ? p.sugestao.ncm : '');
    const origem = p.situacao === 'ok' ? 'cadastro' : (p.sugestao ? fontes[p.sugestao.fonte] : (p.situacao === 'invalido' ? 'INVALIDO: ' + p.ncm : 'VAZIO'));
    linhas.push([p.codigo, p.descricao, ncmPlan, origem, ncmPlan ? ncm.resumo(ncmPlan, 2) : '', p.nota_ncm,
      p.vendido_qtd, p.estoque, p.unidade, p.fornecedor || '', p.categoria || '']);
  });
  const ws = XLSX.utils.aoa_to_sheet(linhas);
  ws['!cols'] = [9, 42, 11, 26, 60, 12, 10, 9, 7, 24, 20].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Produtos');
  const leia = [['COMO USAR'], [],
    ['1. A coluna NCM traz o que esta no cadastro (Origem = cadastro) ou a sugestao do sistema (Origem = sugestao: ...).'],
    ['2. Corrija o que precisar na coluna NCM. Linhas com Origem VAZIO nao tiveram sugestao: preencha.'],
    ['3. Salve e importe de volta em Produtos > Importar planilha: o sistema casa pelo Codigo e atualiza o NCM.'],
    ['4. So entra NCM com 8 digitos que exista na tabela da Receita; o resto e recusado na importacao.'],
    [], ['Produtos ativos', a.resumo.ativos], ['Com NCM valido', a.resumo.ok], ['Sem NCM', a.resumo.sem], ['NCM invalido', a.resumo.invalido],
    ['Vendidos nos ultimos 180 dias sem NCM', a.resumo.vendidos_sem_ncm], ['NCM padrao da loja (usado quando o produto nao tem)', a.ncm_padrao],
    [], ['Tabela NCM usada', a.tabela.fonte]];
  const wsL = XLSX.utils.aoa_to_sheet(leia);
  wsL['!cols'] = [{ wch: 110 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, wsL, 'Leia-me');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ncm-produtos-${hoje()}.xlsx"`);
  res.send(buf);
});

app.get('/api/produtos/:id', auth, (req, res) => {
  const p = one(`${SQL_PRODUTO} WHERE p.id = ?`, [req.params.id]);
  if (!p) return res.status(404).json({ erro: 'Produto nao encontrado.' });
  res.json(p);
});

function proximoCodigoProduto() {
  const r = one("SELECT MAX(CAST(codigo AS INTEGER)) AS m FROM produtos WHERE codigo GLOB '[0-9]*'");
  const prox = (r && r.m ? r.m : 0) + 1;
  return String(prox).padStart(4, '0');
}

app.post('/api/produtos', auth, (req, res) => {
  const b = req.body;
  if (!txt(b.descricao)) return res.status(400).json({ erro: 'Informe a descricao do produto.' });

  const barras = somenteDigitos(b.codigo_barras);
  if (barras) {
    const dup = one('SELECT id, descricao FROM produtos WHERE codigo_barras = ? AND id <> ?',
      [barras, b.id || 0]);
    if (dup) return res.status(400).json({ erro: `Codigo de barras ja usado em: ${dup.descricao}` });
  }
  // [1.12] NCM que nao existe derruba a nota na SEFAZ (778): nem deixa gravar
  const ncmInformado = somenteDigitos(b.ncm);
  if (ncmInformado && !ncm.valido(ncmInformado)) {
    return res.status(400).json({ erro: ncmInformado.length === 8
      ? `O NCM ${ncmInformado} nao existe na tabela da Receita. Use a busca ao lado do campo.`
      : 'O NCM tem 8 digitos (ex.: 25232910). Use a busca ao lado do campo para achar o certo.' });
  }

  const dados = [
    txt(b.codigo) || proximoCodigoProduto(),
    barras,
    txt(b.descricao).toUpperCase(),
    b.categoria_id || null,
    txt(b.unidade).toUpperCase() || 'UN',
    somenteDigitos(b.ncm),
    round2(b.preco_custo),
    round2(b.preco_venda),
    num(b.estoque_minimo),
    b.fracionado ? 1 : 0,
    txt(b.localizacao),
    txt(b.fornecedor),
    b.ativo === 0 ? 0 : 1,
    // fiscais: em branco significa "usa o padrao da loja"
    somenteDigitos(b.cest),
    somenteDigitos(b.cfop),
    txt(b.origem),
    txt(b.csosn),
    txt(b.marca).toUpperCase()
  ];

  if (b.id) {
    run(`UPDATE produtos SET codigo=?, codigo_barras=?, descricao=?, categoria_id=?, unidade=?,
         ncm=?, preco_custo=?, preco_venda=?, estoque_minimo=?, fracionado=?, localizacao=?,
         fornecedor=?, ativo=?, cest=?, cfop=?, origem=?, csosn=?, marca=?, atualizado_em=? WHERE id=?`,
      [...dados, agora(), b.id]);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'produto-editar', `#${b.id} ${txt(b.descricao)}`);
    return res.json({ ok: true, id: b.id });
  }

  const id = inserir(
    `INSERT INTO produtos (codigo, codigo_barras, descricao, categoria_id, unidade, ncm,
      preco_custo, preco_venda, estoque_minimo, fracionado, localizacao, fornecedor, ativo,
      cest, cfop, origem, csosn, marca, estoque, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    [...dados, agora()], false
  );

  // estoque inicial vira um movimento de entrada, para nao "aparecer do nada"
  const inicial = num(b.estoque);
  if (inicial > 0) {
    lancarEstoque(id, 'entrada', inicial, round2(b.preco_custo), 'ESTOQUE INICIAL',
      'Cadastro do produto', req.usuario.usuario, false);
  }
  salvarBanco();
  registrarLog(req.usuario.usuario, 'produto-novo', txt(b.descricao));
  res.json({ ok: true, id });
});

app.delete('/api/produtos/:id', auth, (req, res) => {
  const vendido = one('SELECT COUNT(*) AS n FROM venda_itens WHERE produto_id = ?', [req.params.id]);
  if (vendido && vendido.n) {
    run('UPDATE produtos SET ativo = 0, atualizado_em = ? WHERE id = ?', [agora(), req.params.id]);
    salvarBanco();
    return res.json({ ok: true, inativado: true,
      aviso: 'O produto ja tem vendas, entao foi apenas INATIVADO para preservar o historico.' });
  }
  run('DELETE FROM estoque_mov WHERE produto_id = ?', [req.params.id]);
  run('DELETE FROM produtos WHERE id = ?', [req.params.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'produto-excluir', `#${req.params.id}`);
  res.json({ ok: true });
});

/** Reajuste de preco em lote (por categoria ou geral). */
app.post('/api/produtos/reajuste', auth, (req, res) => {
  const percentual = num(req.body.percentual);
  const campo = req.body.campo === 'custo' ? 'preco_custo' : 'preco_venda';
  if (!percentual) return res.status(400).json({ erro: 'Informe o percentual.' });

  const params = [];
  let where = 'WHERE ativo = 1';
  if (req.body.categoria_id) { where += ' AND categoria_id = ?'; params.push(req.body.categoria_id); }

  const fator = 1 + percentual / 100;
  const lista = all(`SELECT id, ${campo} AS v FROM produtos ${where}`, params);
  lista.forEach((p) => {
    run(`UPDATE produtos SET ${campo} = ?, atualizado_em = ? WHERE id = ?`,
      [round2(num(p.v) * fator), agora(), p.id]);
  });
  salvarBanco();
  registrarLog(req.usuario.usuario, 'reajuste',
    `${percentual}% em ${campo} (${lista.length} produtos)`);
  res.json({ ok: true, alterados: lista.length });
});

/* =========================================================================
   ESTOQUE
   ========================================================================= */

/* =========================================================================
   [1.13] EXPEDICAO — helpers

   Estoque fisico = produtos.estoque. Reservado = o que foi vendido e ainda
   nao saiu (entregas pendentes/parciais). Disponivel = fisico - reservado:
   e isso que o PDV olha para nao vender duas vezes a mesma mercadoria.
   ========================================================================= */

function reservadoDoProduto(produtoId) {
  const r = one(`SELECT COALESCE(SUM(i.quantidade - i.entregue), 0) AS q
                 FROM entrega_itens i JOIN entregas e ON e.id = i.entrega_id
                 WHERE i.produto_id = ? AND e.situacao IN ('pendente', 'parcial')`, [produtoId]);
  return round2(r ? Math.max(0, num(r.q)) : 0);
}

/** Mapa produto_id -> reservado, para listas (uma consulta so). */
function reservadosPorProduto() {
  const m = new Map();
  all(`SELECT i.produto_id, COALESCE(SUM(i.quantidade - i.entregue), 0) AS q
       FROM entrega_itens i JOIN entregas e ON e.id = i.entrega_id
       WHERE e.situacao IN ('pendente', 'parcial') GROUP BY i.produto_id`)
    .forEach((r) => m.set(r.produto_id, round2(Math.max(0, num(r.q)))));
  return m;
}

function entregaCompleta(id) {
  const e = one('SELECT * FROM entregas WHERE id = ?', [id]);
  if (!e) return null;
  e.itens = all('SELECT * FROM entrega_itens WHERE entrega_id = ? ORDER BY id', [id]);
  e.movimentos = all('SELECT * FROM entrega_movs WHERE entrega_id = ? ORDER BY id', [id])
    .map((m) => { try { m.itens = JSON.parse(m.itens || '[]'); } catch (x) { m.itens = []; } return m; });
  e.total_itens = e.itens.length;
  e.faltando = round2(e.itens.reduce((t, i) => t + Math.max(0, num(i.quantidade) - num(i.entregue)), 0));
  return e;
}

/**
 * Confirma a entrega (toda ou parte). Cada item entregue baixa o estoque
 * naquele momento, com o documento da venda. itensPedidos: [{ id, quantidade }]
 * com o id do entrega_item; vazio = tudo que falta.
 */
function confirmarEntrega(entregaId, itensPedidos, usuario, recebidoPor, observacao) {
  const e = entregaCompleta(entregaId);
  if (!e) throw new Error('Entrega nao encontrada.');
  if (e.situacao === 'cancelada') throw new Error('Esta venda foi cancelada.');
  if (e.situacao === 'entregue') throw new Error('Esta venda ja foi entregue por completo.');

  const pedidos = new Map();
  if (Array.isArray(itensPedidos) && itensPedidos.length) {
    itensPedidos.forEach((p) => { const q = round2(p.quantidade); if (q > 0) pedidos.set(parseInt(p.id, 10), q); });
  } else {
    e.itens.forEach((i) => { const falta = round2(num(i.quantidade) - num(i.entregue)); if (falta > 0) pedidos.set(i.id, falta); });
  }
  if (!pedidos.size) throw new Error('Informe o que foi entregue.');

  const feitos = [];
  for (const [itemId, q] of pedidos) {
    const it = e.itens.find((x) => x.id === itemId);
    if (!it) throw new Error('Item nao pertence a esta entrega.');
    const falta = round2(num(it.quantidade) - num(it.entregue));
    if (q > falta + 0.0001) throw new Error(`${it.descricao}: faltam ${falta} ${it.unidade}, nao da para entregar ${q}.`);
    feitos.push({ it, q });
  }

  const docVenda = `CUPOM ${e.venda_numero}`;
  feitos.forEach(({ it, q }) => {
    lancarEstoque(it.produto_id, 'saida', q, it.custo, docVenda,
      'Entrega ao cliente' + (q < round2(num(it.quantidade) - num(it.entregue)) ? ' (parcial)' : '') +
      (recebidoPor ? ' - recebido por ' + recebidoPor : ''), usuario, false);
    run('UPDATE entrega_itens SET entregue = ? WHERE id = ?', [round2(num(it.entregue) + q), it.id]);
  });

  run(`INSERT INTO entrega_movs (entrega_id, data, usuario, recebido_por, observacao, itens) VALUES (?,?,?,?,?,?)`,
    [e.id, agora(), txt(usuario), txt(recebidoPor), txt(observacao),
     JSON.stringify(feitos.map(({ it, q }) => ({ entrega_item_id: it.id, descricao: it.descricao, unidade: it.unidade, quantidade: q })))]);

  const depois = all('SELECT quantidade, entregue FROM entrega_itens WHERE entrega_id = ?', [e.id]);
  const completa = depois.every((i) => num(i.entregue) >= num(i.quantidade) - 0.0001);
  run('UPDATE entregas SET situacao = ?, concluida_em = ? WHERE id = ?',
    [completa ? 'entregue' : 'parcial', completa ? agora() : null, e.id]);
  return { completa, itens: feitos.map(({ it, q }) => ({ descricao: it.descricao, quantidade: q })) };
}

function lancarEstoque(produtoId, tipo, quantidade, custo, documento, obs, usuario, salvar = true) {
  const p = one('SELECT estoque FROM produtos WHERE id = ?', [produtoId]);
  if (!p) return null;

  const anterior = num(p.estoque);
  let novo = anterior;
  if (tipo === 'entrada') novo = anterior + Math.abs(num(quantidade));
  else if (tipo === 'saida') novo = anterior - Math.abs(num(quantidade));
  else novo = num(quantidade); // ajuste = saldo informado

  novo = round2(novo);
  run('UPDATE produtos SET estoque = ?, atualizado_em = ? WHERE id = ?', [novo, agora(), produtoId]);
  run(`INSERT INTO estoque_mov
       (produto_id, tipo, quantidade, saldo_anterior, saldo_novo, custo, documento, observacao, usuario, data)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [produtoId, tipo, round2(Math.abs(num(quantidade))), anterior, novo,
     round2(custo), txt(documento), txt(obs), txt(usuario), agora()]);

  if (salvar) salvarBanco();
  return novo;
}

app.post('/api/estoque/movimento', auth, (req, res) => {
  const b = req.body;
  const tipo = ['entrada', 'saida', 'ajuste'].includes(b.tipo) ? b.tipo : null;
  if (!tipo) return res.status(400).json({ erro: 'Tipo de movimento invalido.' });
  if (!b.produto_id) return res.status(400).json({ erro: 'Escolha o produto.' });
  if (tipo !== 'ajuste' && num(b.quantidade) <= 0) {
    return res.status(400).json({ erro: 'Informe uma quantidade maior que zero.' });
  }

  const saldo = lancarEstoque(b.produto_id, tipo, b.quantidade, b.custo,
    b.documento, b.observacao, req.usuario.usuario);

  if (saldo === null) return res.status(404).json({ erro: 'Produto nao encontrado.' });

  // entrada com custo atualiza o custo do produto
  if (tipo === 'entrada' && num(b.custo) > 0) {
    run('UPDATE produtos SET preco_custo = ? WHERE id = ?', [round2(b.custo), b.produto_id]);
    salvarBanco();
  }

  registrarLog(req.usuario.usuario, 'estoque-' + tipo,
    `produto #${b.produto_id} qtd ${b.quantidade} -> saldo ${saldo}`);
  res.json({ ok: true, saldo });
});

app.get('/api/estoque/movimentos', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.produto_id) { filtros.push('m.produto_id = ?'); params.push(req.query.produto_id); }
  if (req.query.tipo) { filtros.push('m.tipo = ?'); params.push(req.query.tipo); }
  if (req.query.de) { filtros.push('m.data >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('m.data <= ?'); params.push(req.query.ate + 'T23:59:59'); }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';

  res.json(all(`
    SELECT m.*, p.descricao, p.codigo, p.unidade
    FROM estoque_mov m
    LEFT JOIN produtos p ON p.id = m.produto_id
    ${where} ORDER BY m.id DESC LIMIT 1000`, params));
});

app.get('/api/estoque/resumo', auth, (req, res) => {
  const totais = one(`
    SELECT COUNT(*) AS produtos,
           SUM(estoque * preco_custo) AS valor_custo,
           SUM(estoque * preco_venda) AS valor_venda
    FROM produtos WHERE ativo = 1`);
  const criticos = all(`${SQL_PRODUTO}
    WHERE p.ativo = 1 AND p.estoque <= p.estoque_minimo
    ORDER BY (p.estoque - p.estoque_minimo) LIMIT 200`);
  res.json({
    produtos: totais ? totais.produtos : 0,
    valor_custo: round2(totais ? totais.valor_custo : 0),
    valor_venda: round2(totais ? totais.valor_venda : 0),
    criticos
  });
});

/* =========================================================================
   CLIENTES
   ========================================================================= */

app.get('/api/clientes', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.status && req.query.status !== 'todos') { filtros.push('status = ?'); params.push(req.query.status); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(nome) LIKE ? OR cpf_cnpj LIKE ? OR telefone LIKE ?)');
    params.push(q, q, q);
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  const lista = all(`SELECT * FROM clientes ${where} ORDER BY nome LIMIT 2000`, params);

  lista.forEach((c) => {
    const d = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS aberto
                   FROM receber WHERE cliente_id = ? AND situacao <> 'pago'`, [c.id]);
    const v = one(`SELECT COUNT(*) AS n, MAX(data) AS ultima, COALESCE(SUM(total),0) AS total
                   FROM vendas WHERE cliente_id = ? AND situacao = 'finalizada'`, [c.id]);
    c.saldo_devedor = round2(d ? d.aberto : 0);
    c.compras = v ? v.n : 0;
    c.ultima_compra = v ? v.ultima : null;
    c.total_comprado = round2(v ? v.total : 0);
    c.credito_disponivel = round2(num(c.limite_credito) - c.saldo_devedor);
  });
  res.json(lista);
});

app.get('/api/clientes/:id', auth, (req, res) => {
  const c = one('SELECT * FROM clientes WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ erro: 'Cliente nao encontrado.' });
  const d = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS aberto
                 FROM receber WHERE cliente_id = ? AND situacao <> 'pago'`, [c.id]);
  c.saldo_devedor = round2(d ? d.aberto : 0);
  c.credito_disponivel = round2(num(c.limite_credito) - c.saldo_devedor);
  res.json(c);
});

app.post('/api/clientes', auth, (req, res) => {
  const b = req.body;
  if (!txt(b.nome)) return res.status(400).json({ erro: 'Informe o nome do cliente.' });

  const doc = somenteDigitos(b.cpf_cnpj);
  if (doc) {
    const dup = one('SELECT id, nome FROM clientes WHERE cpf_cnpj = ? AND id <> ?', [doc, b.id || 0]);
    if (dup) return res.status(400).json({ erro: `CPF/CNPJ ja cadastrado em: ${dup.nome}` });
  }

  const dados = [
    txt(b.nome).toUpperCase(), txt(b.tipo) || 'F', doc, txt(b.rg_ie),
    txt(b.telefone), txt(b.email), somenteDigitos(b.cep), txt(b.logradouro),
    txt(b.numero), txt(b.complemento), txt(b.bairro), txt(b.cidade),
    txt(b.uf).toUpperCase(), round2(b.limite_credito), txt(b.observacao),
    txt(b.status) || 'ativo'
  ];

  if (b.id) {
    run(`UPDATE clientes SET nome=?, tipo=?, cpf_cnpj=?, rg_ie=?, telefone=?, email=?, cep=?,
         logradouro=?, numero=?, complemento=?, bairro=?, cidade=?, uf=?, limite_credito=?,
         observacao=?, status=? WHERE id=?`, [...dados, b.id]);
    salvarBanco();
    return res.json({ ok: true, id: b.id });
  }

  const id = inserir(
    `INSERT INTO clientes (nome, tipo, cpf_cnpj, rg_ie, telefone, email, cep, logradouro,
       numero, complemento, bairro, cidade, uf, limite_credito, observacao, status, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...dados, agora()]);
  registrarLog(req.usuario.usuario, 'cliente-novo', txt(b.nome));
  res.json({ ok: true, id });
});

app.delete('/api/clientes/:id', auth, (req, res) => {
  const v = one('SELECT COUNT(*) AS n FROM vendas WHERE cliente_id = ?', [req.params.id]);
  if (v && v.n) {
    run("UPDATE clientes SET status = 'inativo' WHERE id = ?", [req.params.id]);
    salvarBanco();
    return res.json({ ok: true, inativado: true,
      aviso: 'O cliente ja tem vendas, entao foi apenas INATIVADO para preservar o historico.' });
  }
  run('DELETE FROM clientes WHERE id = ?', [req.params.id]);
  salvarBanco();
  res.json({ ok: true });
});

/* =========================================================================
   CAIXA
   ========================================================================= */

function caixaAberto() {
  return one("SELECT * FROM caixas WHERE situacao = 'aberto' ORDER BY id DESC LIMIT 1");
}

function resumoCaixa(caixaId) {
  const cx = one('SELECT * FROM caixas WHERE id = ?', [caixaId]);
  if (!cx) return null;

  const formas = all(`
    SELECT vp.forma, COALESCE(SUM(vp.valor),0) AS valor, COUNT(DISTINCT vp.venda_id) AS vendas
    FROM venda_pagamentos vp
    JOIN vendas v ON v.id = vp.venda_id
    WHERE v.caixa_id = ? AND v.situacao = 'finalizada'
    GROUP BY vp.forma ORDER BY vp.forma`, [caixaId]);

  const vendas = one(`
    SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total, COALESCE(SUM(troco),0) AS troco
    FROM vendas WHERE caixa_id = ? AND situacao = 'finalizada'`, [caixaId]);

  const canceladas = one(`SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total
    FROM vendas WHERE caixa_id = ? AND situacao = 'cancelada'`, [caixaId]);

  const sangrias = one(`SELECT COALESCE(SUM(valor),0) AS v FROM caixa_mov
    WHERE caixa_id = ? AND tipo = 'sangria'`, [caixaId]);
  const suprimentos = one(`SELECT COALESCE(SUM(valor),0) AS v FROM caixa_mov
    WHERE caixa_id = ? AND tipo = 'suprimento'`, [caixaId]);

  // recebimentos de crediario feitos com o caixa aberto tambem entram no dinheiro
  const recebidos = all(`
    SELECT COALESCE(forma_pagto,'DINHEIRO') AS forma, COALESCE(SUM(valor_pago),0) AS valor
    FROM receber
    WHERE valor_pago > 0 AND pago_em IS NOT NULL
      AND pago_em >= ? ${cx.fechamento ? 'AND pago_em <= ?' : ''}
    GROUP BY forma`, cx.fechamento ? [cx.abertura, cx.fechamento] : [cx.abertura]);

  const dinheiroVendas = num((formas.find((f) => f.forma === 'DINHEIRO') || {}).valor);
  const dinheiroReceb = num((recebidos.find((f) => f.forma === 'DINHEIRO') || {}).valor);
  const trocoTotal = num(vendas ? vendas.troco : 0);

  const emCaixa = round2(
    num(cx.fundo) + dinheiroVendas + dinheiroReceb
    - trocoTotal + num(suprimentos ? suprimentos.v : 0) - num(sangrias ? sangrias.v : 0)
  );

  return {
    caixa: cx,
    formas,
    recebimentos: recebidos,
    vendas_qtd: vendas ? vendas.qtd : 0,
    vendas_total: round2(vendas ? vendas.total : 0),
    troco_total: round2(trocoTotal),
    canceladas_qtd: canceladas ? canceladas.qtd : 0,
    canceladas_total: round2(canceladas ? canceladas.total : 0),
    sangrias: round2(sangrias ? sangrias.v : 0),
    suprimentos: round2(suprimentos ? suprimentos.v : 0),
    dinheiro_esperado: emCaixa,
    movimentos: all('SELECT * FROM caixa_mov WHERE caixa_id = ? ORDER BY id DESC', [caixaId])
  };
}

app.get('/api/caixa/atual', auth, (req, res) => {
  const cx = caixaAberto();
  if (!cx) return res.json({ aberto: false });
  res.json({ aberto: true, ...resumoCaixa(cx.id) });
});

app.post('/api/caixa/abrir', auth, (req, res) => {
  if (caixaAberto()) return res.status(400).json({ erro: 'Ja existe um caixa aberto.' });
  const id = inserir(
    'INSERT INTO caixas (abertura, fundo, usuario_abertura, situacao) VALUES (?,?,?,?)',
    [agora(), round2(req.body.fundo), req.usuario.nome, 'aberto']);
  registrarLog(req.usuario.usuario, 'caixa-abrir', `fundo ${round2(req.body.fundo)}`);
  res.json({ ok: true, id });
});

app.post('/api/caixa/movimento', auth, (req, res) => {
  const cx = caixaAberto();
  if (!cx) return res.status(400).json({ erro: 'Nenhum caixa aberto.' });
  const tipo = ['sangria', 'suprimento'].includes(req.body.tipo) ? req.body.tipo : null;
  if (!tipo) return res.status(400).json({ erro: 'Tipo invalido.' });
  const valor = round2(req.body.valor);
  if (valor <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });
  if (!txt(req.body.motivo)) return res.status(400).json({ erro: 'Informe o motivo.' });

  if (tipo === 'sangria') {
    const r = resumoCaixa(cx.id);
    if (valor > r.dinheiro_esperado) {
      return res.status(400).json({
        erro: `Sangria maior que o dinheiro em caixa (R$ ${r.dinheiro_esperado.toFixed(2)}).` });
    }
  }

  inserir('INSERT INTO caixa_mov (caixa_id, tipo, valor, motivo, usuario, data) VALUES (?,?,?,?,?,?)',
    [cx.id, tipo, valor, txt(req.body.motivo), req.usuario.nome, agora()]);
  registrarLog(req.usuario.usuario, 'caixa-' + tipo, `${valor} - ${txt(req.body.motivo)}`);
  res.json({ ok: true });
});

app.post('/api/caixa/fechar', auth, (req, res) => {
  const cx = caixaAberto();
  if (!cx) return res.status(400).json({ erro: 'Nenhum caixa aberto.' });

  const r = resumoCaixa(cx.id);
  const informado = round2(req.body.valor_informado);
  const diferenca = round2(informado - r.dinheiro_esperado);

  run(`UPDATE caixas SET fechamento=?, usuario_fechamento=?, valor_informado=?,
       valor_sistema=?, diferenca=?, observacao=?, situacao='fechado' WHERE id=?`,
    [agora(), req.usuario.nome, informado, r.dinheiro_esperado, diferenca,
     txt(req.body.observacao), cx.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'caixa-fechar',
    `informado ${informado} / sistema ${r.dinheiro_esperado} / diferenca ${diferenca}`);
  res.json({ ok: true, id: cx.id, esperado: r.dinheiro_esperado, informado, diferenca });
});

app.get('/api/caixa/historico', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('abertura >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('abertura <= ?'); params.push(req.query.ate + 'T23:59:59'); }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  res.json(all(`SELECT * FROM caixas ${where} ORDER BY id DESC LIMIT 300`, params));
});

app.get('/api/caixa/:id/resumo', auth, (req, res) => {
  const r = resumoCaixa(req.params.id);
  if (!r) return res.status(404).json({ erro: 'Caixa nao encontrado.' });
  res.json(r);
});

/* =========================================================================
   VENDAS / PDV
   ========================================================================= */

const FORMAS = ['DINHEIRO', 'PIX', 'CARTAO DEBITO', 'CARTAO CREDITO', 'CREDIARIO', 'CHEQUE', 'TRANSFERENCIA'];

function proximoNumeroVenda() {
  const r = one('SELECT MAX(numero) AS m FROM vendas');
  return (r && r.m ? r.m : 0) + 1;
}

app.post('/api/vendas', auth, (req, res) => {
  const b = req.body;
  const cfg = lerConfig();

  const itens = Array.isArray(b.itens) ? b.itens : [];
  if (!itens.length) return res.status(400).json({ erro: 'A venda nao tem itens.' });

  const cx = caixaAberto();
  if (!cx && cfg.venda_exige_caixa_aberto === '1') {
    return res.status(400).json({ erro: 'Abra o caixa antes de vender.' });
  }

  /* ---- valida itens e estoque ---- */
  const preparados = [];
  for (const it of itens) {
    const p = one('SELECT * FROM produtos WHERE id = ?', [it.produto_id]);
    if (!p) return res.status(400).json({ erro: `Produto #${it.produto_id} nao existe mais.` });

    const qtd = round2(it.quantidade);
    if (qtd <= 0) return res.status(400).json({ erro: `Quantidade invalida em ${p.descricao}.` });
    if (!p.fracionado && Math.abs(qtd - Math.round(qtd)) > 0.0001) {
      return res.status(400).json({ erro: `${p.descricao} nao pode ser vendido fracionado.` });
    }
    // [1.13] disponivel = fisico - o que ja foi vendido e ainda nao saiu (entregas pendentes)
    const reservado = reservadoDoProduto(p.id);
    const disponivel = round2(num(p.estoque) - reservado);
    if (cfg.venda_permite_estoque_negativo !== '1' && qtd > disponivel) {
      return res.status(400).json({
        erro: `Estoque insuficiente de ${p.descricao}. Disponivel: ${disponivel} ${p.unidade}` +
              (reservado ? ` (${num(p.estoque)} no estoque, ${reservado} reservados para entregas pendentes).` : '.') });
    }

    const unit = round2(it.preco_unit !== undefined ? it.preco_unit : p.preco_venda);
    const desc = round2(it.desconto);
    const total = round2(qtd * unit - desc);
    if (total < 0) return res.status(400).json({ erro: `Desconto maior que o item em ${p.descricao}.` });

    preparados.push({
      produto: p, quantidade: qtd, preco_unit: unit, desconto: desc, total,
      custo: round2(p.preco_custo)
    });
  }

  const subtotal = round2(preparados.reduce((s, i) => s + i.total, 0));
  const descontoGeral = round2(b.desconto);
  const acrescimo = round2(b.acrescimo);
  const total = round2(subtotal - descontoGeral + acrescimo);
  if (total < 0) return res.status(400).json({ erro: 'O desconto deixou o total negativo.' });

  /* ---- pagamentos ---- */
  const pagamentos = (Array.isArray(b.pagamentos) ? b.pagamentos : [])
    .map((p) => ({
      forma: txt(p.forma).toUpperCase(),
      valor: round2(p.valor),
      parcelas: Math.max(1, parseInt(p.parcelas) || 1),
      detalhe: txt(p.detalhe),
      operadora_id: p.operadora_id || null
    }))
    .filter((p) => p.valor > 0);

  // cartao sem maquininha escolhida cai na que estiver marcada como padrao
  const opPadrao = one("SELECT id FROM operadoras WHERE padrao = 1 AND status = 'ativo'");
  pagamentos.forEach((p) => {
    if (p.forma.startsWith('CARTAO') && !p.operadora_id && opPadrao) {
      p.operadora_id = opPadrao.id;
    }
  });

  if (!pagamentos.length) return res.status(400).json({ erro: 'Informe a forma de pagamento.' });
  for (const p of pagamentos) {
    if (!FORMAS.includes(p.forma)) return res.status(400).json({ erro: `Forma de pagamento invalida: ${p.forma}` });
  }

  const pago = round2(pagamentos.reduce((s, p) => s + p.valor, 0));
  const dinheiro = round2(pagamentos.filter((p) => p.forma === 'DINHEIRO')
    .reduce((s, p) => s + p.valor, 0));
  const outros = round2(pago - dinheiro);

  if (outros > total + 0.001) {
    return res.status(400).json({ erro: 'A soma dos pagamentos que nao sao dinheiro passou do total da venda.' });
  }
  if (pago < total - 0.001) {
    return res.status(400).json({ erro: `Faltam R$ ${(total - pago).toFixed(2)} para fechar a venda.` });
  }
  const troco = round2(pago - total);

  /* ---- crediario ---- */
  const crediario = pagamentos.find((p) => p.forma === 'CREDIARIO');
  let cliente = null;
  if (b.cliente_id) cliente = one('SELECT * FROM clientes WHERE id = ?', [b.cliente_id]);

  if (crediario) {
    if (!cliente) return res.status(400).json({ erro: 'Venda no crediario exige um cliente cadastrado.' });
    if (cliente.status !== 'ativo') return res.status(400).json({ erro: 'Cliente inativo nao compra no crediario.' });

    const d = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS aberto
                   FROM receber WHERE cliente_id = ? AND situacao <> 'pago'`, [cliente.id]);
    const devedor = round2(d ? d.aberto : 0);
    const limite = num(cliente.limite_credito);
    if (limite > 0 && devedor + crediario.valor > limite + 0.001) {
      return res.status(400).json({
        erro: `Limite de credito excedido. Limite R$ ${limite.toFixed(2)}, ja em aberto R$ ${devedor.toFixed(2)}, disponivel R$ ${(limite - devedor).toFixed(2)}.` });
    }
  }

  /* ---- grava ---- */
  const numero = proximoNumeroVenda();
  const vendaId = inserir(
    `INSERT INTO vendas (numero, data, caixa_id, cliente_id, cliente_nome, cliente_doc, vendedor,
       subtotal, desconto, acrescimo, total, troco, situacao, observacao, usuario)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'finalizada',?,?)`,
    [numero, agora(), cx ? cx.id : null, cliente ? cliente.id : null,
     cliente ? cliente.nome : txt(b.cliente_nome) || 'CONSUMIDOR',
     cliente ? cliente.cpf_cnpj : somenteDigitos(b.cliente_doc),
     txt(b.vendedor) || req.usuario.nome,
     subtotal, descontoGeral, acrescimo, total, troco,
     txt(b.observacao), req.usuario.usuario], false);

  preparados.forEach((i) => {
    /* Os dados fiscais sao copiados para o item AGORA: se o NCM ou o CSOSN
       do cadastro mudar amanha, a nota emitida hoje continua conferindo. */
    const fis = fiscalDoProduto(i.produto, cfg);
    run(`INSERT INTO venda_itens
         (venda_id, produto_id, codigo, descricao, unidade, quantidade, preco_unit, desconto, total, custo,
          ncm, cfop, origem, csosn, cest)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [vendaId, i.produto.id, i.produto.codigo, i.produto.descricao, i.produto.unidade,
       i.quantidade, i.preco_unit, i.desconto, i.total, i.custo,
       fis.ncm, fis.cfop, fis.origem, fis.csosn, fis.cest]);
    i.venda_item_id = ultimoId();
  });

  /* [1.13] A venda NAO baixa o estoque. Ela cria a entrega; e a expedicao,
     ao confirmar que a mercadoria saiu, que baixa. Se o cliente levou na
     hora ('agora'), o proprio caixa confirma tudo neste instante. */
  const modoEntrega = ['agora', 'depois'].includes(txt(b.entrega)) ? txt(b.entrega) : (txt(cfg.venda_entrega_padrao) === 'agora' ? 'agora' : 'depois');
  const endereco = cliente
    ? [cliente.logradouro, cliente.numero, cliente.complemento, cliente.bairro, cliente.cidade ? cliente.cidade + (cliente.uf ? '/' + cliente.uf : '') : '']
        .map((x) => txt(x)).filter(Boolean).join(', ')
    : '';
  const entregaId = inserir(
    `INSERT INTO entregas (venda_id, venda_numero, data_venda, cliente_id, cliente_nome, telefone, endereco,
       previsao, situacao, observacao, criado_em, usuario)
     VALUES (?,?,?,?,?,?,?,?,'pendente',?,?,?)`,
    [vendaId, numero, agora(), cliente ? cliente.id : null,
     cliente ? cliente.nome : (txt(b.cliente_nome) || 'CONSUMIDOR'),
     cliente ? txt(cliente.telefone) : txt(b.cliente_telefone),
     txt(b.endereco_entrega) || endereco, txt(b.previsao_entrega).slice(0, 10) || null,
     txt(b.observacao_entrega), agora(), req.usuario.usuario], false);
  preparados.forEach((i) => {
    run(`INSERT INTO entrega_itens (entrega_id, venda_item_id, produto_id, codigo, descricao, unidade, quantidade, entregue, custo)
         VALUES (?,?,?,?,?,?,?,0,?)`,
      [entregaId, i.venda_item_id, i.produto.id, i.produto.codigo, i.produto.descricao, i.produto.unidade, i.quantidade, i.custo]);
  });
  if (modoEntrega === 'agora') {
    confirmarEntrega(entregaId, [], req.usuario.usuario, 'CLIENTE NO BALCAO', 'Levou na hora');
  }

  pagamentos.forEach((p) => {
    run(`INSERT INTO venda_pagamentos (venda_id, forma, valor, parcelas, detalhe, operadora_id)
         VALUES (?,?,?,?,?,?)`,
      [vendaId, p.forma, p.valor, p.parcelas, p.detalhe, p.operadora_id]);

    // cartao vira parcela a receber da operadora, ja com a taxa descontada
    if (p.forma.startsWith('CARTAO') && p.operadora_id) {
      gerarRecebiveisCartao({ id: vendaId, numero }, p, req.usuario.usuario);
    }
  });

  /* ---- titulos do crediario ---- */
  if (crediario) {
    const n = crediario.parcelas;
    const valorBase = Math.floor((crediario.valor / n) * 100) / 100;
    const intervalo = Math.max(1, parseInt(b.intervalo_dias) || 30);
    const primeiroVenc = txt(b.primeiro_vencimento)
      ? txt(b.primeiro_vencimento).slice(0, 10)
      : somarPrazo(hoje(), intervalo);

    for (let i = 1; i <= n; i++) {
      // ultima parcela absorve os centavos da divisao
      const valorParcela = (i === n)
        ? round2(crediario.valor - valorBase * (n - 1))
        : valorBase;

      const venc = somarPrazo(primeiroVenc, intervalo * (i - 1));

      run(`INSERT INTO receber (venda_id, cliente_id, cliente_nome, parcela, total_parcelas,
             documento, emissao, vencimento, valor, situacao, usuario)
           VALUES (?,?,?,?,?,?,?,?,?, 'aberto', ?)`,
        [vendaId, cliente.id, cliente.nome, i, n,
         `${numero}/${String(i).padStart(2, '0')}`, hoje(), venc, valorParcela,
         req.usuario.usuario]);
    }
  }

  /* fechou um orcamento? marca ele como convertido */
  let orcamentoFechado = null;
  if (b.orcamento_id) {
    const o = one('SELECT * FROM orcamentos WHERE id = ?', [b.orcamento_id]);
    if (o && o.situacao !== 'fechado') {
      run(`UPDATE orcamentos SET situacao='fechado', venda_id=?, venda_numero=?, fechado_em=?
           WHERE id=?`, [vendaId, numero, agora(), o.id]);
      orcamentoFechado = o.numero;
    }
  }

  salvarBanco();
  registrarLog(req.usuario.usuario, 'venda',
    `cupom ${numero} - R$ ${total.toFixed(2)}` +
    (orcamentoFechado ? ` (do orcamento ${orcamentoFechado})` : ''));
  res.json({ ok: true, id: vendaId, numero, total, troco, orcamento: orcamentoFechado,
    entrega: { id: entregaId, situacao: modoEntrega === 'agora' ? 'entregue' : 'pendente' } });
});

app.get('/api/vendas', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('v.data >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('v.data <= ?'); params.push(req.query.ate + 'T23:59:59'); }
  if (req.query.cliente_id) { filtros.push('v.cliente_id = ?'); params.push(req.query.cliente_id); }
  if (req.query.situacao && req.query.situacao !== 'todas') {
    filtros.push('v.situacao = ?'); params.push(req.query.situacao);
  }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(v.cliente_nome) LIKE ? OR CAST(v.numero AS TEXT) LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%');
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';

  const lista = all(`SELECT v.*, (SELECT e.situacao FROM entregas e WHERE e.venda_id = v.id) AS entrega_situacao,
                            (SELECT e.id FROM entregas e WHERE e.venda_id = v.id) AS entrega_id
                     FROM vendas v ${where} ORDER BY v.id DESC LIMIT 1000`, params);
  lista.forEach((v) => {
    v.formas = all('SELECT forma, valor FROM venda_pagamentos WHERE venda_id = ?', [v.id])
      .map((p) => p.forma).join(' + ');
    const it = one('SELECT COUNT(*) AS n FROM venda_itens WHERE venda_id = ?', [v.id]);
    v.itens_qtd = it ? it.n : 0;
  });
  res.json(lista);
});

function vendaCompleta(id) {
  const v = one('SELECT * FROM vendas WHERE id = ?', [id]);
  if (!v) return null;
  v.itens = all('SELECT * FROM venda_itens WHERE venda_id = ? ORDER BY id', [id]);
  v.pagamentos = all('SELECT * FROM venda_pagamentos WHERE venda_id = ? ORDER BY id', [id]);
  v.parcelas = all('SELECT * FROM receber WHERE venda_id = ? ORDER BY parcela', [id]);
  const e = one('SELECT * FROM entregas WHERE venda_id = ?', [id]);
  v.entrega = e ? entregaCompleta(e.id) : null;
  return v;
}

app.get('/api/vendas/:id', auth, (req, res) => {
  const v = vendaCompleta(req.params.id);
  if (!v) return res.status(404).json({ erro: 'Venda nao encontrada.' });
  res.json(v);
});

app.post('/api/vendas/:id/cancelar', auth, (req, res) => {
  const v = one('SELECT * FROM vendas WHERE id = ?', [req.params.id]);
  if (!v) return res.status(404).json({ erro: 'Venda nao encontrada.' });
  if (v.situacao === 'cancelada') return res.status(400).json({ erro: 'Essa venda ja esta cancelada.' });

  const motivo = txt(req.body.motivo);
  if (motivo.length < 5) return res.status(400).json({ erro: 'Descreva o motivo (minimo 5 caracteres).' });

  const pagos = one(`SELECT COUNT(*) AS n FROM receber WHERE venda_id = ? AND valor_pago > 0`, [v.id]);
  if (pagos && pagos.n) {
    return res.status(400).json({
      erro: 'Ha parcelas do crediario ja recebidas. Estorne o recebimento antes de cancelar a venda.' });
  }

  const cartaoPago = one(`SELECT COUNT(*) AS n FROM cartao_recebiveis
                          WHERE venda_id = ? AND valor_recebido > 0`, [v.id]);
  if (cartaoPago && cartaoPago.n) {
    return res.status(400).json({
      erro: 'A operadora do cartao ja depositou parcelas desta venda. Estorne em Recebiveis de Cartao antes de cancelar.' });
  }

  /* devolve o estoque: so o que de fato saiu. Venda com entrega (1.13) devolve
     o entregue de cada item; venda antiga (sem registro de entrega) tinha
     baixado tudo na hora, entao devolve tudo. */
  const entrega = one('SELECT * FROM entregas WHERE venda_id = ?', [v.id]);
  if (entrega) {
    all('SELECT * FROM entrega_itens WHERE entrega_id = ?', [entrega.id]).forEach((i) => {
      if (num(i.entregue) > 0) {
        lancarEstoque(i.produto_id, 'entrada', num(i.entregue), i.custo,
          `CANC CUPOM ${v.numero}`, 'Cancelamento de venda (devolucao do entregue)', req.usuario.usuario, false);
      }
    });
    run("UPDATE entregas SET situacao = 'cancelada' WHERE id = ?", [entrega.id]);
  } else {
    all('SELECT * FROM venda_itens WHERE venda_id = ?', [v.id]).forEach((i) => {
      lancarEstoque(i.produto_id, 'entrada', i.quantidade, i.custo,
        `CANC CUPOM ${v.numero}`, 'Cancelamento de venda', req.usuario.usuario, false);
    });
  }

  run('DELETE FROM receber WHERE venda_id = ?', [v.id]);
  run('DELETE FROM cartao_recebiveis WHERE venda_id = ?', [v.id]);
  run(`UPDATE vendas SET situacao='cancelada', cancelado_motivo=?, cancelado_por=?, cancelado_em=?
       WHERE id=?`, [motivo, req.usuario.nome, agora(), v.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'venda-cancelar', `cupom ${v.numero} - ${motivo}`);
  res.json({ ok: true });
});

/* =========================================================================
   [1.13] EXPEDICAO / ENTREGAS — rotas
   ========================================================================= */

app.get('/api/entregas', auth, (req, res) => {
  const filtros = [];
  const params = [];
  const sit = txt(req.query.situacao) || 'abertas';
  if (sit === 'abertas') filtros.push("e.situacao IN ('pendente', 'parcial')");
  else if (sit !== 'todas') { filtros.push('e.situacao = ?'); params.push(sit); }
  if (req.query.de) { filtros.push('e.data_venda >= ?'); params.push(txt(req.query.de)); }
  if (req.query.ate) { filtros.push('e.data_venda <= ?'); params.push(txt(req.query.ate) + 'T23:59:59'); }
  if (req.query.atrasadas === '1') { filtros.push("e.situacao IN ('pendente', 'parcial') AND e.previsao IS NOT NULL AND e.previsao < ?"); params.push(hoje()); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(e.cliente_nome) LIKE ? OR CAST(e.venda_numero AS TEXT) LIKE ? OR upper(e.endereco) LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%', q);
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  const lista = all(`SELECT e.*, v.total AS venda_total, v.situacao AS venda_situacao
                     FROM entregas e LEFT JOIN vendas v ON v.id = e.venda_id ${where}
                     ORDER BY CASE e.situacao WHEN 'parcial' THEN 0 WHEN 'pendente' THEN 1 ELSE 2 END, e.id DESC LIMIT 500`, params);
  lista.forEach((e) => {
    e.itens = all('SELECT id, produto_id, codigo, descricao, unidade, quantidade, entregue FROM entrega_itens WHERE entrega_id = ? ORDER BY id', [e.id]);
    e.faltando_itens = e.itens.filter((i) => num(i.entregue) < num(i.quantidade) - 0.0001).length;
    e.atrasada = ['pendente', 'parcial'].includes(e.situacao) && !!e.previsao && e.previsao < hoje();
  });
  const abertas = one(`SELECT COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total FROM entregas e JOIN vendas v ON v.id = e.venda_id
                       WHERE e.situacao IN ('pendente', 'parcial')`);
  const parciais = one("SELECT COUNT(*) AS n FROM entregas WHERE situacao = 'parcial'");
  const atrasadas = one("SELECT COUNT(*) AS n FROM entregas WHERE situacao IN ('pendente', 'parcial') AND previsao IS NOT NULL AND previsao < ?", [hoje()]);
  const hojeN = one("SELECT COUNT(DISTINCT entrega_id) AS n FROM entrega_movs WHERE substr(data, 1, 10) = ?", [hoje()]);
  res.json({
    resumo: { abertas: abertas ? abertas.n : 0, abertas_valor: round2(abertas ? abertas.total : 0),
      parciais: parciais ? parciais.n : 0, atrasadas: atrasadas ? atrasadas.n : 0, entregues_hoje: hojeN ? hojeN.n : 0 },
    entregas: lista
  });
});

app.get('/api/entregas/:id', auth, (req, res) => {
  const e = entregaCompleta(req.params.id);
  if (!e) return res.status(404).json({ erro: 'Entrega nao encontrada.' });
  const v = one('SELECT numero, total, cliente_doc, observacao, vendedor FROM vendas WHERE id = ?', [e.venda_id]);
  res.json({ ...e, venda: v });
});

/** Dados da entrega (endereco, telefone, previsao, observacao) — a expedicao ajusta. */
app.post('/api/entregas/:id/dados', auth, (req, res) => {
  const e = one('SELECT * FROM entregas WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ erro: 'Entrega nao encontrada.' });
  const b = req.body || {};
  run(`UPDATE entregas SET endereco = ?, telefone = ?, previsao = ?, observacao = ? WHERE id = ?`,
    [txt(b.endereco), txt(b.telefone), txt(b.previsao).slice(0, 10) || null, txt(b.observacao), e.id]);
  salvarBanco();
  res.json({ ok: true });
});

/** Confirma a entrega: toda (itens vazio) ou parcial ([{ id, quantidade }]). Aqui o estoque baixa. */
app.post('/api/entregas/:id/confirmar', auth, (req, res) => {
  const b = req.body || {};
  try {
    const r = confirmarEntrega(parseInt(req.params.id, 10), Array.isArray(b.itens) ? b.itens : [],
      req.usuario.usuario, txt(b.recebido_por), txt(b.observacao));
    salvarBanco();
    const e = one('SELECT venda_numero FROM entregas WHERE id = ?', [req.params.id]);
    registrarLog(req.usuario.usuario, 'entrega',
      `cupom ${e ? e.venda_numero : '?'} - ${r.completa ? 'entrega completa' : 'entrega parcial'}: ` +
      r.itens.map((i) => `${i.quantidade} ${i.descricao}`).join(', ').slice(0, 200));
    res.json({ ok: true, completa: r.completa, itens: r.itens });
  } catch (e) {
    res.status(400).json({ erro: e.message });
  }
});

/** Romaneio: a folha que vai com a mercadoria e volta assinada. */
app.get('/api/entregas/:id/romaneio', auth, (req, res) => {
  const e = entregaCompleta(req.params.id);
  if (!e) return res.status(404).send('Entrega nao encontrada.');
  const cfg = lerConfig();
  const v = one('SELECT * FROM vendas WHERE id = ?', [e.venda_id]) || {};
  const linhas = e.itens.map((i) => {
    const falta = round2(num(i.quantidade) - num(i.entregue));
    return `<tr><td>${escapeHtml(i.codigo)}</td><td>${escapeHtml(i.descricao)}</td><td class="c">${escapeHtml(i.unidade)}</td>
      <td class="n">${num(i.quantidade)}</td><td class="n">${num(i.entregue)}</td><td class="n"><strong>${falta}</strong></td><td class="box"></td></tr>`;
  }).join('');
  const movs = e.movimentos.map((m) =>
    `<li>${escapeHtml(new Date(m.data).toLocaleString('pt-BR'))} — ${m.itens.map((i) => `${i.quantidade} ${i.unidade} ${escapeHtml(i.descricao)}`).join(', ')}` +
    `${m.recebido_por ? ' — recebido por ' + escapeHtml(m.recebido_por) : ''}</li>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Romaneio ${e.venda_numero}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111;margin:18mm 14mm}
  h1{font-size:18px;margin:0 0 2px} .sub{color:#555;margin-bottom:12px}
  table{width:100%;border-collapse:collapse;margin:10px 0} th,td{border:1px solid #999;padding:5px 6px;text-align:left}
  th{background:#eee;font-size:11px;text-transform:uppercase} .n{text-align:right} .c{text-align:center} .box{width:60px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin:8px 0} .grid div b{display:inline-block;min-width:90px;color:#555}
  .ass{margin-top:36px;display:grid;grid-template-columns:1fr 1fr;gap:40px} .ass div{border-top:1px solid #333;padding-top:4px;text-align:center;font-size:12px}
  .aviso{border:1px dashed #999;padding:6px 8px;font-size:11px;color:#444;margin-top:10px}
  @media print{button{display:none}}
</style></head><body>
<button onclick="window.print()" style="float:right">Imprimir</button>
<h1>ROMANEIO DE ENTREGA — Cupom ${String(e.venda_numero).padStart(6, '0')}</h1>
<div class="sub">${escapeHtml(cfg.loja_fantasia || cfg.loja_nome || '')} · ${escapeHtml(cfg.loja_telefone || '')}</div>
<div class="grid">
  <div><b>Cliente</b> ${escapeHtml(e.cliente_nome)}</div><div><b>Telefone</b> ${escapeHtml(e.telefone || '-')}</div>
  <div><b>Endereço</b> ${escapeHtml(e.endereco || '— (retirada / a combinar)')}</div><div><b>Previsão</b> ${e.previsao ? escapeHtml(e.previsao.split('-').reverse().join('/')) : '-'}</div>
  <div><b>Venda</b> ${escapeHtml(new Date(e.data_venda).toLocaleString('pt-BR'))} · ${escapeHtml(v.vendedor || '')}</div><div><b>Situação</b> ${escapeHtml(e.situacao)}</div>
</div>
${e.observacao || v.observacao ? `<div class="aviso">Obs.: ${escapeHtml(e.observacao || '')} ${escapeHtml(v.observacao || '')}</div>` : ''}
<table><thead><tr><th>Cód.</th><th>Produto</th><th>Un</th><th>Vendido</th><th>Já entregue</th><th>Entregar</th><th>✓</th></tr></thead><tbody>${linhas}</tbody></table>
${movs ? `<div style="font-size:11px;color:#444"><strong>Entregas anteriores:</strong><ul>${movs}</ul></div>` : ''}
<div class="ass"><div>Entregue por (motorista / expedição)</div><div>Recebido por (nome legível e assinatura)</div></div>
<div class="aviso">Confira a mercadoria no ato. Documento interno de entrega — não substitui a nota fiscal.</div>
</body></html>`);
});

/* =========================================================================
   CUPOM (impressao em bobina 80mm) - DOCUMENTO SEM VALOR FISCAL
   ========================================================================= */

const escapeHtml = (s) => txt(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const brl = (v) => num(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtdFmt = (v) => num(v).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

function dataHoraBr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
function dataBr(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : iso;
}

function docFormatado(doc) {
  const d = somenteDigitos(doc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

/**
 * Estilo do cupom montado a partir da configuracao da impressora.
 * A bobina de 80mm cabe ~48 caracteres na fonte padrao; a de 58mm, ~32.
 */
function estiloCupom(cfg) {
  // ATENCAO: usar || aqui apagaria o zero (margem 0, 0 linhas no fim).
  const cfgNum = (v, padrao) => {
    const n = Number(txt(v));
    return txt(v) === '' || isNaN(n) ? padrao : n;
  };
  const mm = cfg.cupom_largura === '58' ? 58 : 80;
  return {
    largura: mm + 'mm',
    colunas: mm === 58 ? 32 : 48,
    fonte: Math.max(8, Math.min(16, cfgNum(cfg.cupom_fonte, 11))),
    margem: Math.max(0, Math.min(10, cfgNum(cfg.cupom_margem, 3))),
    vias: Math.max(1, Math.min(3, cfgNum(cfg.cupom_vias, 1))),
    linhasFim: Math.max(0, Math.min(12, cfgNum(cfg.cupom_linhas_fim, 4))),
    autoImprimir: cfg.cupom_auto_imprimir !== '0'
  };
}

function corpoCupom(v, cfg, e, via) {
  const linha = '-'.repeat(e.colunas);

  const itensHtml = v.itens.map((i, idx) => `
    <div class="item">
      <div class="item-desc">${String(idx + 1).padStart(3, '0')} ${escapeHtml(i.codigo)} ${escapeHtml(i.descricao)}</div>
      <div class="item-val">
        <span>${qtdFmt(i.quantidade)} ${escapeHtml(i.unidade)} x ${brl(i.preco_unit)}${num(i.desconto) > 0 ? ' - desc ' + brl(i.desconto) : ''}</span>
        <span class="b">${brl(i.total)}</span>
      </div>
    </div>`).join('');

  const pagHtml = v.pagamentos.map((p) => `
    <div class="lin"><span>${escapeHtml(p.forma)}${p.parcelas > 1 ? ' ' + p.parcelas + 'x' : ''}</span><span>${brl(p.valor)}</span></div>`
  ).join('');

  const parcelasHtml = v.parcelas && v.parcelas.length ? `
    <div class="sep">${linha}</div>
    <div class="c b">PARCELAS DO CREDIARIO</div>
    ${v.parcelas.map((p) => `<div class="lin"><span>${escapeHtml(p.documento)} venc ${dataBr(p.vencimento)}</span><span>${brl(p.valor)}</span></div>`).join('')}
  ` : '';

  // so mostra a linha de endereco se houver algo alem da UF sozinha
  const cidadeUf = txt(cfg.loja_cidade)
    ? [cfg.loja_cidade, cfg.loja_uf].filter(Boolean).join('/') : '';
  const enderecoLoja = [cfg.loja_endereco, cfg.loja_bairro, cidadeUf]
    .map(txt).filter(Boolean).join(' - ');

  return `
${cfg.cupom_cabecalho ? `<div class="c b">${escapeHtml(cfg.cupom_cabecalho)}</div>` : ''}
<div class="c b g">${escapeHtml(cfg.loja_fantasia || cfg.loja_nome)}</div>
<div class="c">${escapeHtml(cfg.loja_nome)}</div>
${cfg.loja_cnpj ? `<div class="c">CNPJ ${escapeHtml(docFormatado(cfg.loja_cnpj))}${cfg.loja_ie ? ' - IE ' + escapeHtml(cfg.loja_ie) : ''}</div>` : ''}
${enderecoLoja ? `<div class="c">${escapeHtml(enderecoLoja)}</div>` : ''}
${cfg.loja_telefone ? `<div class="c">Fone: ${escapeHtml(cfg.loja_telefone)}</div>` : ''}

<div class="sep">${linha}</div>
<div class="c b">CUPOM DE VENDA No ${String(v.numero).padStart(6, '0')}</div>
${via ? `<div class="c">${escapeHtml(via)}</div>` : ''}
<div class="sep">${linha}</div>

<div class="lin"><span>Data:</span><span>${dataHoraBr(v.data)}</span></div>
<div class="lin"><span>Operador:</span><span>${escapeHtml(v.usuario)}</span></div>
${v.vendedor ? `<div class="lin"><span>Vendedor:</span><span>${escapeHtml(v.vendedor)}</span></div>` : ''}
<div class="lin"><span>Cliente:</span><span>${escapeHtml(v.cliente_nome || 'CONSUMIDOR')}</span></div>
${v.cliente_doc ? `<div class="lin"><span>CPF/CNPJ:</span><span>${escapeHtml(docFormatado(v.cliente_doc))}</span></div>` : ''}

${v.situacao === 'cancelada' ? `<div class="cancelada">*** VENDA CANCELADA ***<br><span style="font-size:10px">${escapeHtml(v.cancelado_motivo || '')}</span></div>` : ''}

<div class="sep">${linha}</div>
<div class="b">ITEM COD DESCRICAO</div>
<div class="b" style="padding-left:12px">QTD UN x V.UNIT&nbsp;&nbsp;&nbsp;&nbsp;V.TOTAL</div>
<div class="sep">${linha}</div>
${itensHtml}
<div class="sep">${linha}</div>

<div class="lin"><span>Qtd. de itens:</span><span>${v.itens.length}</span></div>
<div class="lin"><span>Subtotal:</span><span>${brl(v.subtotal)}</span></div>
${num(v.desconto) > 0 ? `<div class="lin"><span>Desconto:</span><span>-${brl(v.desconto)}</span></div>` : ''}
${num(v.acrescimo) > 0 ? `<div class="lin"><span>Acrescimo:</span><span>${brl(v.acrescimo)}</span></div>` : ''}
<div class="total"><span>TOTAL R$</span><span>${brl(v.total)}</span></div>

${pagHtml}
${num(v.troco) > 0 ? `<div class="lin b"><span>TROCO</span><span>${brl(v.troco)}</span></div>` : ''}
${parcelasHtml}

${v.observacao ? `<div class="sep">${linha}</div><div>Obs: ${escapeHtml(v.observacao)}</div>` : ''}
${v.entrega && v.entrega.situacao !== 'entregue' && v.entrega.situacao !== 'cancelada'
  ? `<div class="sep">${linha}</div><div class="b" style="text-align:center">*** ENTREGA ${v.entrega.situacao === 'parcial' ? 'PARCIAL' : 'PENDENTE'} ***<br>
     <span style="font-size:10px">Mercadoria sai pela expedicao${v.entrega.previsao ? ' - previsao ' + escapeHtml(v.entrega.previsao.split('-').reverse().join('/')) : ''}</span></div>` : ''}

${v.nfce && v.nfce.situacao === 'autorizada'
  ? rodapeDanfeNfce(v.nfce, cfg, e, linha)
  : `<div class="tarja">
  DOCUMENTO SEM VALOR FISCAL<br>
  NAO E DOCUMENTO FISCAL - NAO SUBSTITUI A NOTA FISCAL<br>
  COMPROVANTE INTERNO DE VENDA
</div>`}

<div class="c">${escapeHtml(cfg.cupom_rodape || '')}</div>
<div class="c" style="margin-top:6px">${dataHoraBr(new Date().toISOString())}</div>
<div class="c" style="font-size:9px">v${VERSAO}</div>
${'<div class="c">.</div>'.repeat(e.linhasFim)}`;
}

/**
 * Rodape do DANFE NFC-e — o que a lei manda sair impresso quando a nota
 * foi autorizada: chave de acesso, protocolo, QR Code e o endereco de
 * consulta. Substitui a tarja de "sem valor fiscal".
 */
function rodapeDanfeNfce(n, cfg, e, linha) {
  const chaveEspacada = String(n.chave || '').replace(/(\d{4})(?=\d)/g, '$1 ');
  const homologacao = Number(n.ambiente) === 2;
  const contingencia = Number(n.tp_emis) === 9;

  return `
<div class="sep">${linha}</div>
<div class="c b">DANFE NFC-e</div>
<div class="c" style="font-size:${Math.max(8, e.fonte - 2)}px">
  Documento Auxiliar da Nota Fiscal de Consumidor Eletronica</div>
<div class="c">Nota ${String(n.numero).padStart(6, '0')} - Serie ${n.serie}</div>

${homologacao ? `<div class="cancelada" style="font-size:${e.fonte + 2}px">
  EMITIDA EM AMBIENTE DE HOMOLOGACAO<br>SEM VALOR FISCAL</div>` : ''}
${contingencia ? `<div class="tarja">EMITIDA EM CONTINGENCIA<br>
  PENDENTE DE AUTORIZACAO</div>` : ''}

<div class="sep">${linha}</div>
<div class="c b" style="font-size:${Math.max(8, e.fonte - 2)}px">CHAVE DE ACESSO</div>
<div class="c" style="word-break:break-all;font-size:${Math.max(8, e.fonte - 1)}px">${escapeHtml(chaveEspacada)}</div>
${n.url_consulta ? `<div class="c" style="font-size:${Math.max(8, e.fonte - 2)}px">
  Consulte em ${escapeHtml(n.url_consulta)}</div>` : ''}

${n.protocolo ? `<div class="c" style="font-size:${Math.max(8, e.fonte - 2)}px">
  Protocolo de autorizacao: ${escapeHtml(n.protocolo)}<br>
  ${n.data_autorizacao ? escapeHtml(dataHoraBr(n.data_autorizacao)) : ''}</div>` : ''}

<div class="sep">${linha}</div>
<div class="c">${escapeHtml(v_consumidor(n))}</div>
${n.qrcode_svg ? `<div class="c qr">${n.qrcode_svg}</div>` : ''}
<div class="sep">${linha}</div>`;
}

/** Linha do consumidor exigida no DANFE. */
function v_consumidor(n) {
  return n.consumidor_doc
    ? 'CONSUMIDOR CPF/CNPJ: ' + docFormatado(n.consumidor_doc)
    : 'CONSUMIDOR NAO IDENTIFICADO';
}

/** Casca do documento: estilo da bobina, vias e impressao automatica. */
function paginaCupom(titulo, cfg, corpos, autoImprimirForcado) {
  const e = estiloCupom(cfg);
  const auto = autoImprimirForcado === undefined ? e.autoImprimir : autoImprimirForcado;

  const paginas = corpos.map((c, i) => `
    <div class="via" ${i < corpos.length - 1 ? 'style="page-break-after:always"' : ''}>${c}</div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>${escapeHtml(titulo)}</title>
<style>
  @page { size: ${e.largura} auto; margin: ${e.margem}mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Courier New', monospace; font-size: ${e.fonte}px; line-height: 1.35;
         width: ${e.largura}; margin: 0 auto; padding: 4px; color: #000; background: #fff; }
  .c { text-align: center; }
  .r { text-align: right; }
  .b { font-weight: bold; }
  .g { font-size: ${e.fonte + 2}px; }
  .sep { white-space: nowrap; overflow: hidden; letter-spacing: -0.5px; }
  .lin { display: flex; justify-content: space-between; gap: 6px; }
  .item { margin: 2px 0; }
  .item-desc { word-break: break-word; }
  .item-val { display: flex; justify-content: space-between; padding-left: 12px; }
  .tarja { border: 2px solid #000; padding: 4px; margin: 6px 0; text-align: center;
           font-weight: bold; font-size: ${Math.max(8, e.fonte - 1)}px; }
  .total { border-top: 1px dashed #000; border-bottom: 1px dashed #000;
           padding: 3px 0; margin: 3px 0; font-size: ${e.fonte + 4}px; font-weight: bold;
           display: flex; justify-content: space-between; }
  .cancelada { text-align:center; font-size: ${e.fonte + 7}px; font-weight: bold; border: 3px solid #000;
               padding: 6px; margin: 6px 0; }
  .regua { white-space: pre; font-size: ${e.fonte}px; }
  .qr { margin: 6px 0; }
  .qr svg { width: 42mm; height: 42mm; display: inline-block; }
  .noprint { text-align: center; margin: 14px 0; }
  .noprint button { font: inherit; font-size: 13px; padding: 8px 18px; margin: 0 4px;
                    cursor: pointer; border: 1px solid #333; background: #eee; border-radius: 4px; }
  @media print { .noprint { display: none; } body { width: auto; } }
</style></head><body>
${paginas}
<div class="noprint">
  <button onclick="window.print()">Imprimir</button>
  <button onclick="window.close()">Fechar</button>
</div>
${auto ? `<script>
  /* A JANELA DO CUPOM NUNCA FECHA SOZINHA.
     Ela so manda imprimir. Quem fecha e o operador, no botao Fechar.
     Nao existe fechamento automatico neste arquivo - de proposito:
     cancelar a impressao nunca pode fazer o cupom sumir da tela. */
  window.addEventListener('load', function () {
    setTimeout(function () { window.print(); }, 350);
  });
</script>` : ''}
</body></html>`;
}

function montarCupom(v, cfg, via) {
  const e = estiloCupom(cfg);
  const corpos = [];

  if (via) {
    corpos.push(corpoCupom(v, cfg, e, via));
  } else {
    const rotulos = ['1a VIA - CLIENTE', '2a VIA - LOJA', '3a VIA'];
    for (let i = 0; i < e.vias; i++) {
      corpos.push(corpoCupom(v, cfg, e, e.vias > 1 ? rotulos[i] : ''));
    }
  }
  return paginaCupom('Cupom ' + v.numero, cfg, corpos);
}

app.get('/api/vendas/:id/cupom', auth, async (req, res) => {
  const v = vendaCompleta(req.params.id);
  if (!v) return res.status(404).send('Venda nao encontrada.');
  v.nfce = await notaDaVenda(v.id, v.cliente_doc);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(montarCupom(v, lerConfig(), txt(req.query.via)));
});

/**
 * NFC-e autorizada da venda, com o QR Code ja desenhado.
 * Devolve null quando a venda nao tem nota — ai sai o cupom interno normal.
 */
async function notaDaVenda(vendaId, clienteDoc) {
  const n = one(
    `SELECT id, serie, numero, chave, protocolo, data_autorizacao, situacao,
            ambiente, tp_emis, qrcode, url_consulta
     FROM nfce WHERE venda_id = ? AND situacao = 'autorizada'
     ORDER BY id DESC LIMIT 1`, [vendaId]);
  if (!n) return null;

  n.consumidor_doc = somenteDigitos(clienteDoc);
  if (n.qrcode) {
    try {
      n.qrcode_svg = await QRCode.toString(n.qrcode, {
        type: 'svg', margin: 0, errorCorrectionLevel: 'M',
        width: 160, color: { dark: '#000000', light: '#ffffff' }
      });
    } catch (e) {
      n.qrcode_svg = '';   // sem QR o cupom ainda sai, com a chave por extenso
    }
  }
  return n;
}

/* ---------- cupom de teste da impressora ---------- */
app.get('/api/impressora/teste', auth, (req, res) => {
  const cfg = lerConfig();
  const e = estiloCupom(cfg);
  const linha = '-'.repeat(e.colunas);

  // regua para conferir se a largura da bobina bate com a configuracao
  let regua = '';
  for (let i = 1; i <= e.colunas; i++) regua += (i % 10 === 0) ? String(i / 10) : '.';

  const corpo = `
<div class="c b g">${escapeHtml(cfg.loja_fantasia || cfg.loja_nome)}</div>
<div class="c">${escapeHtml(cfg.loja_nome)}</div>
<div class="sep">${linha}</div>
<div class="c b">TESTE DE IMPRESSAO</div>
<div class="sep">${linha}</div>

<div class="lin"><span>Impressora:</span><span>${escapeHtml(cfg.impressora_modelo || '-')}</span></div>
<div class="lin"><span>Nome no Windows:</span><span>${escapeHtml(cfg.impressora_nome || '-')}</span></div>
<div class="lin"><span>Bobina:</span><span>${e.largura} (${e.colunas} colunas)</span></div>
<div class="lin"><span>Fonte:</span><span>${e.fonte}px</span></div>
<div class="lin"><span>Margem:</span><span>${e.margem}mm</span></div>
<div class="lin"><span>Vias:</span><span>${e.vias}</span></div>
<div class="lin"><span>Data:</span><span>${dataHoraBr(new Date().toISOString())}</span></div>

<div class="sep">${linha}</div>
<div class="b">REGUA DE LARGURA</div>
<div class="regua">${regua}</div>
<div style="font-size:${Math.max(8, e.fonte - 2)}px">
  A regua acima tem que caber numa linha so, sem quebrar.
  Se quebrar, a bobina configurada esta maior que a real.
</div>

<div class="sep">${linha}</div>
<div class="b">EXEMPLO DE ITENS</div>
<div class="sep">${linha}</div>
<div class="item">
  <div class="item-desc">001 0001 CIMENTO CP II 50KG</div>
  <div class="item-val"><span>10 SC x 38,50</span><span class="b">385,00</span></div>
</div>
<div class="item">
  <div class="item-desc">002 0023 PORCELANATO ACETINADO 60X60 M2</div>
  <div class="item-val"><span>12,5 M2 x 69,90</span><span class="b">873,75</span></div>
</div>
<div class="sep">${linha}</div>
<div class="total"><span>TOTAL R$</span><span>1.258,75</span></div>
<div class="lin"><span>DINHEIRO</span><span>1.300,00</span></div>
<div class="lin b"><span>TROCO</span><span>41,25</span></div>

<div class="tarja">
  TESTE - NAO E DOCUMENTO FISCAL<br>
  SE VOCE ESTA LENDO ISTO NO PAPEL,<br>
  A IMPRESSORA ESTA OK
</div>

<div class="c">Acentuacao: cao, orcamento, joao, agua</div>
<div class="c" style="margin-top:4px">${escapeHtml(cfg.cupom_rodape || '')}</div>
${'<div class="c">.</div>'.repeat(e.linhasFim)}`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(paginaCupom('Teste de impressao', cfg, [corpo], true));
});

/* =========================================================================
   CONTAS A RECEBER / CREDIARIO
   ========================================================================= */

function situacaoTitulo(t) {
  if (t.situacao === 'pago') return 'pago';
  if (t.vencimento < hoje()) return 'vencido';
  if (t.vencimento === hoje()) return 'vence_hoje';
  return 'aberto';
}

app.get('/api/receber', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.cliente_id) { filtros.push('cliente_id = ?'); params.push(req.query.cliente_id); }
  if (req.query.de) { filtros.push('vencimento >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('vencimento <= ?'); params.push(req.query.ate); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(cliente_nome) LIKE ? OR documento LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%');
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  let lista = all(`SELECT * FROM receber ${where} ORDER BY vencimento, cliente_nome LIMIT 3000`, params);

  lista.forEach((t) => {
    t.status = situacaoTitulo(t);
    t.saldo = round2(num(t.valor) - num(t.valor_pago));
    t.dias = Math.floor((new Date(hoje()) - new Date(t.vencimento)) / 86400000);
  });

  const st = txt(req.query.situacao);
  if (st && st !== 'todas') {
    if (st === 'aberto') lista = lista.filter((t) => t.status !== 'pago');
    else lista = lista.filter((t) => t.status === st);
  }

  const abertos = lista.filter((t) => t.status !== 'pago');
  res.json({
    titulos: lista,
    totais: {
      em_aberto: round2(abertos.reduce((s, t) => s + t.saldo, 0)),
      vencidos: round2(abertos.filter((t) => t.status === 'vencido').reduce((s, t) => s + t.saldo, 0)),
      vence_hoje: round2(abertos.filter((t) => t.status === 'vence_hoje').reduce((s, t) => s + t.saldo, 0)),
      recebido: round2(lista.filter((t) => t.status === 'pago').reduce((s, t) => s + num(t.valor_pago), 0))
    }
  });
});

app.post('/api/receber/:id/baixar', auth, (req, res) => {
  const t = one('SELECT * FROM receber WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ erro: 'Titulo nao encontrado.' });
  if (t.situacao === 'pago') return res.status(400).json({ erro: 'Esse titulo ja esta baixado.' });

  const valor = round2(req.body.valor !== undefined && req.body.valor !== ''
    ? req.body.valor : num(t.valor) - num(t.valor_pago));
  if (valor <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });

  const pagoTotal = round2(num(t.valor_pago) + valor);
  const quitado = pagoTotal >= round2(num(t.valor)) - 0.001;

  // pago_em guarda a data do ULTIMO recebimento, mesmo quando e parcial —
  // e o que faz o dinheiro do crediario entrar no caixa do dia
  run(`UPDATE receber SET valor_pago = ?, pago_em = ?, forma_pagto = ?, situacao = ?, observacao = ?
       WHERE id = ?`,
    [pagoTotal, agora(), txt(req.body.forma).toUpperCase() || 'DINHEIRO',
     quitado ? 'pago' : 'parcial', txt(req.body.observacao), t.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'receber-baixa', `${t.documento} - R$ ${valor.toFixed(2)}`);
  res.json({ ok: true, quitado, pago: pagoTotal });
});

app.post('/api/receber/:id/estornar', auth, (req, res) => {
  const t = one('SELECT * FROM receber WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ erro: 'Titulo nao encontrado.' });
  if (num(t.valor_pago) <= 0) return res.status(400).json({ erro: 'Esse titulo nao tem baixa para estornar.' });

  run(`UPDATE receber SET valor_pago = 0, pago_em = NULL, forma_pagto = NULL,
       situacao = 'aberto' WHERE id = ?`, [t.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'receber-estorno', t.documento);
  res.json({ ok: true });
});

/* =========================================================================
   DASHBOARD E RELATORIOS
   ========================================================================= */

app.get('/api/dashboard', auth, (req, res) => {
  const d = hoje();
  const inicioMes = d.slice(0, 8) + '01';

  const vHoje = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t
    FROM vendas WHERE situacao='finalizada' AND substr(data,1,10) = ?`, [d]);
  const vMes = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS t
    FROM vendas WHERE situacao='finalizada' AND substr(data,1,10) >= ?`, [inicioMes]);

  const lucroMes = one(`
    SELECT COALESCE(SUM(i.total - (i.custo * i.quantidade)),0) AS l
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
    WHERE v.situacao='finalizada' AND substr(v.data,1,10) >= ?`, [inicioMes]);

  const receber = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v
    FROM receber WHERE situacao <> 'pago'`);
  const vencidos = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v, COUNT(*) AS n
    FROM receber WHERE situacao <> 'pago' AND vencimento < ?`, [d]);

  const cartao = one(`SELECT COALESCE(SUM(valor_liquido - valor_recebido),0) AS v, COUNT(*) AS n
    FROM cartao_recebiveis WHERE situacao <> 'recebido'`);
  const cartaoAtraso = one(`SELECT COALESCE(SUM(valor_liquido - valor_recebido),0) AS v, COUNT(*) AS n
    FROM cartao_recebiveis WHERE situacao <> 'recebido' AND previsao < ?`, [d]);
  const taxasMes = one(`SELECT COALESCE(SUM(valor_taxa),0) AS v
    FROM cartao_recebiveis WHERE data_venda >= ?`, [inicioMes]);

  const pagar = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v
    FROM cp_contas WHERE situacao <> 'pago'`);
  const pagarVencidas = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v, COUNT(*) AS n
    FROM cp_contas WHERE situacao <> 'pago' AND vencimento < ?`, [d]);
  const pagarHoje = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v, COUNT(*) AS n
    FROM cp_contas WHERE situacao <> 'pago' AND vencimento = ?`, [d]);
  const despesaMes = one(`SELECT COALESCE(SUM(valor_pago),0) AS v
    FROM cp_contas WHERE pago_em IS NOT NULL AND substr(pago_em,1,10) >= ?`, [inicioMes]);

  const orc = one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS v FROM orcamentos
    WHERE situacao = 'aberto' AND (validade IS NULL OR validade >= ?)`, [d]);

  const estoque = one(`SELECT COALESCE(SUM(estoque * preco_custo),0) AS v, COUNT(*) AS n
    FROM produtos WHERE ativo = 1`);
  const criticos = one(`SELECT COUNT(*) AS n FROM produtos
    WHERE ativo = 1 AND estoque <= estoque_minimo`);

  const cx = caixaAberto();

  // [1.13] entregas que a expedicao ainda nao confirmou
  const entregasAbertas = one(`SELECT COUNT(*) AS n, COALESCE(SUM(v.total), 0) AS total
    FROM entregas e JOIN vendas v ON v.id = e.venda_id WHERE e.situacao IN ('pendente', 'parcial')`);
  const entregasAtraso = one("SELECT COUNT(*) AS n FROM entregas WHERE situacao IN ('pendente', 'parcial') AND previsao IS NOT NULL AND previsao < ?", [d]);

  const ultimos7 = all(`
    SELECT substr(data,1,10) AS dia, COALESCE(SUM(total),0) AS total, COUNT(*) AS qtd
    FROM vendas WHERE situacao='finalizada' AND substr(data,1,10) >= ?
    GROUP BY dia ORDER BY dia`,
    [new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)]);

  const maisVendidos = all(`
    SELECT i.descricao, i.unidade, SUM(i.quantidade) AS qtd, SUM(i.total) AS total
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
    WHERE v.situacao='finalizada' AND substr(v.data,1,10) >= ?
    GROUP BY i.descricao, i.unidade ORDER BY total DESC LIMIT 10`, [inicioMes]);

  const painel = {
    hoje: { qtd: vHoje ? vHoje.n : 0, total: round2(vHoje ? vHoje.t : 0) },
    mes: { qtd: vMes ? vMes.n : 0, total: round2(vMes ? vMes.t : 0) },
    lucro_mes: round2(lucroMes ? lucroMes.l : 0),
    receber: round2(receber ? receber.v : 0),
    vencidos: { valor: round2(vencidos ? vencidos.v : 0), qtd: vencidos ? vencidos.n : 0 },
    orcamentos: { qtd: orc ? orc.n : 0, valor: round2(orc ? orc.v : 0) },
    cartao: round2(cartao ? cartao.v : 0),
    cartao_qtd: cartao ? cartao.n : 0,
    cartao_atraso: { valor: round2(cartaoAtraso ? cartaoAtraso.v : 0), qtd: cartaoAtraso ? cartaoAtraso.n : 0 },
    taxas_cartao_mes: round2(taxasMes ? taxasMes.v : 0),
    pagar: round2(pagar ? pagar.v : 0),
    pagar_vencidas: { valor: round2(pagarVencidas ? pagarVencidas.v : 0), qtd: pagarVencidas ? pagarVencidas.n : 0 },
    pagar_hoje: { valor: round2(pagarHoje ? pagarHoje.v : 0), qtd: pagarHoje ? pagarHoje.n : 0 },
    despesa_mes: round2(despesaMes ? despesaMes.v : 0),
    resultado_mes: round2((lucroMes ? lucroMes.l : 0) - (despesaMes ? despesaMes.v : 0)),
    estoque: { valor: round2(estoque ? estoque.v : 0), produtos: estoque ? estoque.n : 0 },
    criticos: criticos ? criticos.n : 0,
    entregas: { abertas: entregasAbertas ? entregasAbertas.n : 0, valor: round2(entregasAbertas ? entregasAbertas.total : 0),
      atrasadas: entregasAtraso ? entregasAtraso.n : 0 },
    caixa_aberto: !!cx,
    caixa: cx || null,
    ultimos7, mais_vendidos: maisVendidos
  };

  /* O painel mostra so o que o perfil tem permissao de ver. Quem cuida do
     estoque nao precisa enxergar o faturamento do dia. */
  const some = (...campos) => campos.forEach((c) => { delete painel[c]; });
  if (!pode(req, 'vendas') && !pode(req, 'pdv')) {
    some('hoje', 'mes', 'lucro_mes', 'resultado_mes', 'ultimos7', 'mais_vendidos');
  }
  if (!pode(req, 'orcamentos')) some('orcamentos');
  if (!pode(req, 'receber')) some('receber', 'vencidos');
  if (!pode(req, 'cartao')) some('cartao', 'cartao_qtd', 'cartao_atraso', 'taxas_cartao_mes');
  if (!pode(req, 'pagar')) some('pagar', 'pagar_vencidas', 'pagar_hoje', 'despesa_mes', 'resultado_mes');
  if (!pode(req, 'estoque') && !pode(req, 'produtos')) some('estoque', 'criticos');
  if (!pode(req, 'caixa')) some('caixa');

  res.json(painel);
});

function periodo(req) {
  const de = txt(req.query.de) || hoje();
  const ate = txt(req.query.ate) || hoje();
  return [de, ate + 'T23:59:59'];
}

app.get('/api/relatorios/vendas', auth, (req, res) => {
  const [de, ate] = periodo(req);
  const porDia = all(`
    SELECT substr(data,1,10) AS dia, COUNT(*) AS qtd,
           COALESCE(SUM(subtotal),0) AS subtotal,
           COALESCE(SUM(desconto),0) AS desconto,
           COALESCE(SUM(total),0) AS total
    FROM vendas WHERE situacao='finalizada' AND data >= ? AND data <= ?
    GROUP BY dia ORDER BY dia`, [de, ate]);

  const porForma = all(`
    SELECT vp.forma, COUNT(DISTINCT vp.venda_id) AS vendas, COALESCE(SUM(vp.valor),0) AS total
    FROM venda_pagamentos vp JOIN vendas v ON v.id = vp.venda_id
    WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?
    GROUP BY vp.forma ORDER BY total DESC`, [de, ate]);

  const porOperador = all(`
    SELECT COALESCE(vendedor,'-') AS vendedor, COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total
    FROM vendas WHERE situacao='finalizada' AND data >= ? AND data <= ?
    GROUP BY vendedor ORDER BY total DESC`, [de, ate]);

  const totais = one(`
    SELECT COUNT(*) AS qtd, COALESCE(SUM(total),0) AS total,
           COALESCE(SUM(desconto),0) AS desconto
    FROM vendas WHERE situacao='finalizada' AND data >= ? AND data <= ?`, [de, ate]);

  const lucro = one(`
    SELECT COALESCE(SUM(i.total),0) AS venda,
           COALESCE(SUM(i.custo * i.quantidade),0) AS custo
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
    WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?`, [de, ate]);

  const ticket = totais && totais.qtd ? round2(totais.total / totais.qtd) : 0;

  res.json({
    por_dia: porDia, por_forma: porForma, por_operador: porOperador,
    totais: {
      qtd: totais ? totais.qtd : 0,
      total: round2(totais ? totais.total : 0),
      desconto: round2(totais ? totais.desconto : 0),
      ticket_medio: ticket,
      custo: round2(lucro ? lucro.custo : 0),
      lucro: round2((lucro ? lucro.venda : 0) - (lucro ? lucro.custo : 0)),
      margem: lucro && lucro.venda ? round2(((lucro.venda - lucro.custo) / lucro.venda) * 100) : 0
    }
  });
});

app.get('/api/relatorios/produtos', auth, (req, res) => {
  const [de, ate] = periodo(req);
  const lista = all(`
    SELECT i.produto_id, i.codigo, i.descricao, i.unidade,
           SUM(i.quantidade) AS qtd, SUM(i.total) AS total,
           SUM(i.custo * i.quantidade) AS custo,
           c.nome AS categoria
    FROM venda_itens i
    JOIN vendas v ON v.id = i.venda_id
    LEFT JOIN produtos p ON p.id = i.produto_id
    LEFT JOIN categorias c ON c.id = p.categoria_id
    WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?
    GROUP BY i.produto_id, i.codigo, i.descricao, i.unidade, c.nome
    ORDER BY total DESC`, [de, ate]);

  const geral = lista.reduce((s, i) => s + num(i.total), 0);
  let acumulado = 0;
  lista.forEach((i) => {
    i.total = round2(i.total);
    i.custo = round2(i.custo);
    i.lucro = round2(i.total - i.custo);
    i.participacao = geral ? round2((i.total / geral) * 100) : 0;
    // a curva olha o acumulado ANTES do item, senao o 1o colocado sozinho
    // ja estoura os 80% e cairia em B
    const antes = acumulado;
    acumulado += i.participacao;
    i.acumulado = round2(acumulado);
    i.curva = antes < 80 ? 'A' : (antes < 95 ? 'B' : 'C');
  });

  const porCategoria = {};
  lista.forEach((i) => {
    const c = i.categoria || 'SEM CATEGORIA';
    porCategoria[c] = round2((porCategoria[c] || 0) + i.total);
  });

  res.json({
    produtos: lista,
    total_geral: round2(geral),
    por_categoria: Object.entries(porCategoria)
      .map(([nome, total]) => ({ nome, total, participacao: geral ? round2((total / geral) * 100) : 0 }))
      .sort((a, b) => b.total - a.total)
  });
});

/* =========================================================================
   [1.11] MAIS VENDIDOS POR FORNECEDOR + SUGESTAO DE COMPRA

   A ideia: comprar pela VELOCIDADE de venda, nao pelo "achismo". Para cada
   produto, quanto saiu por dia no periodo; com isso, quantos dias o estoque
   atual aguenta e quanto falta para atravessar o prazo de entrega mais a
   cobertura desejada. O que nao vende, nao entra na compra — e o que esta
   sobrando aparece como dinheiro parado.
   ========================================================================= */

const limitar = (v, min, max, padrao) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : padrao;
};

function sugestaoCompra(q) {
  const dias = limitar(q.dias, 7, 730, 90);              // periodo analisado
  const cobertura = limitar(q.cobertura, 1, 365, 30);    // dias de estoque desejados
  const prazo = limitar(q.prazo, 0, 120, 7);             // dias que o fornecedor leva para entregar
  const agrupar = txt(q.agrupar) === 'marca' ? 'marca' : 'categoria';
  const fornecedorFiltro = txt(q.fornecedor).toUpperCase();
  const de = new Date(Date.now() - dias * 86400000).toISOString();
  const horizonte = cobertura + prazo;

  const vendidos = all(
    `SELECT i.produto_id, SUM(i.quantidade) AS qtd, SUM(i.total) AS valor,
            SUM(i.custo * i.quantidade) AS custo_vendido, COUNT(DISTINCT v.id) AS vendas, MAX(v.data) AS ultima
     FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
     WHERE v.situacao <> 'cancelada' AND v.data >= ? AND i.produto_id IS NOT NULL
     GROUP BY i.produto_id`, [de]);
  const mapaVendas = new Map(vendidos.map((r) => [r.produto_id, r]));

  const produtos = all(`SELECT p.*, c.nome AS categoria FROM produtos p
                        LEFT JOIN categorias c ON c.id = p.categoria_id WHERE p.ativo = 1`);
  const reservados = reservadosPorProduto();   // [1.13] vendido e ainda nao entregue nao esta disponivel

  const linhas = [];
  const parados = [];
  produtos.forEach((p) => {
    const fornecedor = txt(p.fornecedor).toUpperCase() || 'SEM FORNECEDOR';
    if (fornecedorFiltro && fornecedor !== fornecedorFiltro) return;
    const v = mapaVendas.get(p.id) || { qtd: 0, valor: 0, custo_vendido: 0, vendas: 0, ultima: null };
    const qtdVendida = num(v.qtd);
    const estoque = round2(num(p.estoque) - (reservados.get(p.id) || 0));
    const custoUnit = num(p.preco_custo);
    /* produto cadastrado ha menos tempo que o periodo: a velocidade e sobre os
       dias em que ele existia, senao um produto novo pareceria vender pouco */
    const idade = p.criado_em ? (Date.now() - new Date(p.criado_em).getTime()) / 86400000 : dias;
    const diasEfetivos = Number.isFinite(idade) ? Math.max(7, Math.min(dias, Math.ceil(idade))) : dias;
    const velocidade = qtdVendida / diasEfetivos;                            // unidades por dia
    const diasEstoque = velocidade > 0 ? estoque / velocidade : (estoque > 0 ? Infinity : 0);
    const necessidade = Math.max(velocidade * horizonte, num(p.estoque_minimo));
    let comprar = Math.max(0, necessidade - estoque);
    comprar = p.fracionado ? round2(comprar) : Math.ceil(comprar - 1e-9);
    const excedente = Math.max(0, estoque - necessidade);

    let situacao;
    if (velocidade === 0 && estoque > 0) situacao = 'parado';
    else if (velocidade === 0) situacao = 'sem_venda';
    else if (estoque <= 0) situacao = 'falta';
    else if (diasEstoque < prazo) situacao = 'urgente';
    else if (comprar > 0) situacao = 'comprar';
    else if (diasEstoque > 2 * horizonte) situacao = 'excesso';
    else situacao = 'ok';

    const linha = {
      produto_id: p.id, codigo: p.codigo, descricao: p.descricao, unidade: p.unidade,
      fornecedor, categoria: txt(p.categoria).toUpperCase() || 'SEM CATEGORIA',
      marca: txt(p.marca).toUpperCase() || 'SEM MARCA',
      grupo: agrupar === 'marca' ? (txt(p.marca).toUpperCase() || 'SEM MARCA') : (txt(p.categoria).toUpperCase() || 'SEM CATEGORIA'),
      vendido_qtd: round2(qtdVendida), vendido_valor: round2(v.valor), vendas: v.vendas,
      dias_efetivos: diasEfetivos,
      lucro: round2(num(v.valor) - num(v.custo_vendido)),
      ultima_venda: v.ultima ? String(v.ultima).slice(0, 10) : null,
      media_semana: round2(velocidade * 7), media_mes: round2(velocidade * 30),
      estoque: round2(estoque), estoque_minimo: num(p.estoque_minimo),
      dias_estoque: diasEstoque === Infinity ? null : Math.round(diasEstoque),
      necessidade: p.fracionado ? round2(necessidade) : Math.ceil(necessidade - 1e-9),
      comprar, custo_unit: round2(custoUnit), custo_compra: round2(comprar * custoUnit),
      preco_venda: round2(num(p.preco_venda)),
      dinheiro_parado: round2(excedente * custoUnit),
      situacao
    };
    if (situacao === 'sem_venda') return;                 // nem vende nem tem estoque: nao interessa
    if (situacao === 'parado') { parados.push(linha); return; }
    linhas.push(linha);
  });

  linhas.sort((a, b) => b.vendido_valor - a.vendido_valor);
  parados.sort((a, b) => b.dinheiro_parado - a.dinheiro_parado);

  /* fornecedor > grupo (categoria ou marca) > produto */
  const porFornecedor = new Map();
  linhas.forEach((l) => {
    if (!porFornecedor.has(l.fornecedor)) {
      porFornecedor.set(l.fornecedor, { nome: l.fornecedor, vendido_valor: 0, vendido_qtd: 0, lucro: 0,
        custo_compra: 0, produtos: 0, a_comprar: 0, urgentes: 0, dinheiro_parado: 0, grupos: new Map() });
    }
    const f = porFornecedor.get(l.fornecedor);
    f.vendido_valor = round2(f.vendido_valor + l.vendido_valor);
    f.vendido_qtd = round2(f.vendido_qtd + l.vendido_qtd);
    f.lucro = round2(f.lucro + l.lucro);
    f.custo_compra = round2(f.custo_compra + l.custo_compra);
    f.dinheiro_parado = round2(f.dinheiro_parado + l.dinheiro_parado);
    f.produtos++;
    if (l.comprar > 0) f.a_comprar++;
    if (l.situacao === 'urgente' || l.situacao === 'falta') f.urgentes++;
    if (!f.grupos.has(l.grupo)) f.grupos.set(l.grupo, { nome: l.grupo, vendido_valor: 0, custo_compra: 0, produtos: [] });
    const g = f.grupos.get(l.grupo);
    g.vendido_valor = round2(g.vendido_valor + l.vendido_valor);
    g.custo_compra = round2(g.custo_compra + l.custo_compra);
    g.produtos.push(l);
  });
  const fornecedores = [...porFornecedor.values()]
    .map((f) => ({ ...f, grupos: [...f.grupos.values()].sort((a, b) => b.vendido_valor - a.vendido_valor) }))
    .sort((a, b) => b.vendido_valor - a.vendido_valor);

  const totalVendido = round2(linhas.reduce((s, l) => s + l.vendido_valor, 0));
  return {
    parametros: { dias, cobertura, prazo, horizonte, agrupar, fornecedor: fornecedorFiltro,
      de: de.slice(0, 10), ate: hoje() },
    resumo: {
      vendido: totalVendido,
      lucro: round2(linhas.reduce((s, l) => s + l.lucro, 0)),
      produtos_vendidos: linhas.length,
      a_comprar: linhas.filter((l) => l.comprar > 0).length,
      urgentes: linhas.filter((l) => l.situacao === 'urgente' || l.situacao === 'falta').length,
      custo_compra: round2(linhas.reduce((s, l) => s + l.custo_compra, 0)),
      em_excesso: linhas.filter((l) => l.situacao === 'excesso').length,
      dinheiro_parado: round2(linhas.reduce((s, l) => s + l.dinheiro_parado, 0) + parados.reduce((s, l) => s + l.dinheiro_parado, 0)),
      parados: parados.length,
      fornecedores: fornecedores.length
    },
    top: linhas.slice(0, 15),
    fornecedores,
    parados: parados.slice(0, 50),
    lista_fornecedores: [...new Set(produtos.map((p) => txt(p.fornecedor).toUpperCase() || 'SEM FORNECEDOR'))].sort()
  };
}

/* [1.19] RESUMO DO DIA — tudo que foi vendido no dia (caixa + saidas para
   obras), por produto. O material que saiu para as obras conta como venda do
   dia pelo valor que o dono paga (o custo da saida). */
app.get('/api/relatorios/vendas-dia', auth, (req, res) => {
  const dia = txt(req.query.dia) || hoje();
  const ateDia = dia + 'T23:59:59';

  // produtos vendidos no caixa (vendas finalizadas do dia) — a preco de venda
  const itensVenda = all(`
    SELECT i.produto_id, i.codigo, i.descricao, i.unidade,
           SUM(i.quantidade) AS qtd, SUM(i.total) AS total, SUM(i.custo * i.quantidade) AS custo
    FROM venda_itens i JOIN vendas v ON v.id = i.venda_id
    WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?
    GROUP BY i.produto_id, i.codigo, i.descricao, i.unidade`, [dia, ateDia]);

  const totVendas = one(`SELECT COUNT(*) AS cupons, COALESCE(SUM(total),0) AS total,
           COALESCE(SUM(desconto),0) AS desconto
    FROM vendas WHERE situacao='finalizada' AND data >= ? AND data <= ?`, [dia, ateDia]);

  const pagamentos = all(`SELECT p.forma, COALESCE(SUM(p.valor),0) AS valor, COUNT(*) AS qtd
    FROM venda_pagamentos p JOIN vendas v ON v.id = p.venda_id
    WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?
    GROUP BY p.forma ORDER BY valor DESC`, [dia, ateDia]);

  // quanto cada vendedor vendeu no dia (caixa)
  const vendedores = all(`SELECT COALESCE(NULLIF(TRIM(vendedor),''),'—') AS vendedor,
           COUNT(*) AS cupons, COALESCE(SUM(total),0) AS total
    FROM vendas WHERE situacao='finalizada' AND data >= ? AND data <= ?
    GROUP BY COALESCE(NULLIF(TRIM(vendedor),''),'—') ORDER BY total DESC`, [dia, ateDia]);

  // material que saiu para as obras no dia — valor = custo (o que o dono paga)
  const itensObra = all(`
    SELECT i.produto_id, i.codigo, i.descricao, i.unidade,
           SUM(i.quantidade) AS qtd, SUM(i.total) AS total
    FROM obra_saida_itens i JOIN obra_saidas s ON s.id = i.saida_id
    WHERE s.data = ?
    GROUP BY i.produto_id, i.codigo, i.descricao, i.unidade`, [dia]);
  const obrasPorNome = all(`SELECT o.nome, COALESCE(SUM(s.total),0) AS total, COUNT(*) AS saidas
    FROM obra_saidas s JOIN obras o ON o.id = s.obra_id WHERE s.data = ?
    GROUP BY o.nome ORDER BY total DESC`, [dia]);

  // junta os produtos das duas origens
  const mapa = new Map();
  const add = (it, origem) => {
    const key = it.produto_id || ('x:' + it.descricao);
    const e = mapa.get(key) || {
      codigo: it.codigo, descricao: it.descricao, unidade: it.unidade,
      qtd: 0, valor: 0, qtd_caixa: 0, valor_caixa: 0, qtd_obra: 0, valor_obra: 0
    };
    e.qtd = round2(e.qtd + num(it.qtd));
    e.valor = round2(e.valor + num(it.total));
    if (origem === 'caixa') { e.qtd_caixa = round2(e.qtd_caixa + num(it.qtd)); e.valor_caixa = round2(e.valor_caixa + num(it.total)); }
    else { e.qtd_obra = round2(e.qtd_obra + num(it.qtd)); e.valor_obra = round2(e.valor_obra + num(it.total)); }
    mapa.set(key, e);
  };
  itensVenda.forEach((i) => add(i, 'caixa'));
  itensObra.forEach((i) => add(i, 'obra'));
  const produtos = [...mapa.values()].sort((a, b) => b.valor - a.valor);

  const caixaTotal = round2(totVendas ? totVendas.total : 0);
  const caixaCusto = round2(itensVenda.reduce((s, i) => s + num(i.custo), 0));
  const obrasTotal = round2(itensObra.reduce((s, i) => s + num(i.total), 0));

  res.json({
    dia,
    caixa: {
      total: caixaTotal, custo: caixaCusto, lucro: round2(caixaTotal - caixaCusto),
      cupons: totVendas ? totVendas.cupons : 0, desconto: round2(totVendas ? totVendas.desconto : 0)
    },
    obras: { total: obrasTotal, saidas: obrasPorNome.reduce((s, o) => s + num(o.saidas), 0) },
    total_dia: round2(caixaTotal + obrasTotal),
    itens_qtd: round2(produtos.reduce((s, i) => s + i.qtd, 0)),
    linhas_qtd: produtos.length,
    pagamentos: pagamentos.map((p) => ({ forma: p.forma, valor: round2(p.valor), qtd: p.qtd })),
    vendedores: vendedores.map((v) => ({ vendedor: v.vendedor, cupons: v.cupons, total: round2(v.total) })),
    obras_detalhe: obrasPorNome.map((o) => ({ nome: o.nome, total: round2(o.total), saidas: o.saidas })),
    produtos
  });
});

app.get('/api/relatorios/sugestao-compra', auth, (req, res) => {
  res.json(sugestaoCompra(req.query));
});

/** A mesma sugestao em planilha: uma aba geral, uma por fornecedor (o pedido) e o estoque parado. */
app.get('/api/relatorios/sugestao-compra.xlsx', auth, (req, res) => {
  const r = sugestaoCompra(req.query);
  const p = r.parametros;
  const wb = XLSX.utils.book_new();
  const situ = { falta: 'FALTA (estoque zerado)', urgente: 'URGENTE (acaba antes da entrega)', comprar: 'Comprar',
    ok: 'OK', excesso: 'Excesso (dinheiro parado)', parado: 'Parado (sem venda)' };
  const cab = ['Fornecedor', p.agrupar === 'marca' ? 'Marca / modelo' : 'Categoria', 'Código', 'Produto', 'Un',
    `Vendido (${p.dias} dias)`, 'Vendido (R$)', 'Média / semana', 'Estoque', 'Dias de estoque',
    'COMPRAR', 'Custo unit. (R$)', 'Custo da compra (R$)', 'Situação'];
  const linha = (l) => [l.fornecedor, l.grupo, l.codigo, l.descricao, l.unidade, l.vendido_qtd, l.vendido_valor,
    l.media_semana, l.estoque, l.dias_estoque === null ? '' : l.dias_estoque, l.comprar, l.custo_unit, l.custo_compra, situ[l.situacao] || l.situacao];

  const geral = [[`SUGESTÃO DE COMPRA — vendas de ${p.de} a ${p.ate} (${p.dias} dias), cobertura ${p.cobertura} dias + entrega ${p.prazo} dias`], [], cab];
  r.fornecedores.forEach((f) => f.grupos.forEach((g) => g.produtos.forEach((l) => geral.push(linha(l)))));
  geral.push([], ['TOTAL', '', '', '', '', '', r.resumo.vendido, '', '', '', '', '', r.resumo.custo_compra, '']);
  const ws = XLSX.utils.aoa_to_sheet(geral);
  ws['!cols'] = [26, 22, 9, 40, 5, 12, 13, 12, 9, 10, 10, 12, 14, 26].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Sugestão');

  const resumo = [['Fornecedor', 'Produtos vendidos', 'Vendido (R$)', 'Lucro bruto (R$)', 'Itens a comprar', 'Urgentes', 'Custo da compra (R$)', 'Dinheiro parado (R$)']];
  r.fornecedores.forEach((f) => resumo.push([f.nome, f.produtos, f.vendido_valor, f.lucro, f.a_comprar, f.urgentes, f.custo_compra, f.dinheiro_parado]));
  const wsR = XLSX.utils.aoa_to_sheet(resumo);
  wsR['!cols'] = [30, 12, 14, 14, 12, 10, 16, 16].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsR, 'Por fornecedor');

  // uma aba por fornecedor com so o que comprar: e o pedido pronto para mandar
  r.fornecedores.filter((f) => f.a_comprar > 0).slice(0, 40).forEach((f) => {
    const ped = [[`PEDIDO SUGERIDO — ${f.nome}`], [], ['Código', 'Produto', 'Un', 'Comprar', 'Custo unit. (R$)', 'Total (R$)', 'Estoque hoje', 'Vendido no período', 'Situação']];
    f.grupos.forEach((g) => g.produtos.filter((l) => l.comprar > 0).forEach((l) =>
      ped.push([l.codigo, l.descricao, l.unidade, l.comprar, l.custo_unit, l.custo_compra, l.estoque, l.vendido_qtd, situ[l.situacao]])));
    ped.push([], ['', 'TOTAL', '', '', '', f.custo_compra, '', '', '']);
    const wsP = XLSX.utils.aoa_to_sheet(ped);
    wsP['!cols'] = [9, 44, 5, 9, 12, 12, 11, 12, 26].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsP, f.nome.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'FORNECEDOR');
  });

  const par = [['ESTOQUE PARADO — sem nenhuma venda no período'], [], ['Fornecedor', 'Código', 'Produto', 'Un', 'Estoque', 'Custo unit. (R$)', 'Dinheiro parado (R$)']];
  r.parados.forEach((l) => par.push([l.fornecedor, l.codigo, l.descricao, l.unidade, l.estoque, l.custo_unit, l.dinheiro_parado]));
  const wsPar = XLSX.utils.aoa_to_sheet(par);
  wsPar['!cols'] = [26, 9, 44, 5, 9, 12, 16].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, wsPar, 'Estoque parado');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="sugestao-compra-${hoje()}.xlsx"`);
  res.send(buf);
});

app.get('/api/relatorios/clientes', auth, (req, res) => {
  const [de, ate] = periodo(req);
  const lista = all(`
    SELECT COALESCE(v.cliente_nome,'CONSUMIDOR') AS cliente, v.cliente_id,
           COUNT(*) AS compras, COALESCE(SUM(v.total),0) AS total
    FROM vendas v WHERE v.situacao='finalizada' AND v.data >= ? AND v.data <= ?
    GROUP BY v.cliente_id, cliente ORDER BY total DESC`, [de, ate]);

  const geral = lista.reduce((s, i) => s + num(i.total), 0);
  lista.forEach((i) => {
    i.total = round2(i.total);
    i.ticket = i.compras ? round2(i.total / i.compras) : 0;
    i.participacao = geral ? round2((i.total / geral) * 100) : 0;
  });
  res.json({ clientes: lista, total_geral: round2(geral) });
});

/* =========================================================================
   OPERADORAS DE CARTAO (maquininhas) E RECEBIVEIS
   ========================================================================= */

app.get('/api/operadoras', auth, (req, res) => {
  const where = req.query.status === 'todos' ? '' : "WHERE status = 'ativo'";
  const lista = all(`SELECT * FROM operadoras ${where} ORDER BY padrao DESC, nome`);
  lista.forEach((o) => {
    const a = one(`SELECT COALESCE(SUM(valor_liquido - valor_recebido),0) AS v, COUNT(*) AS n
                   FROM cartao_recebiveis WHERE operadora_id = ? AND situacao <> 'recebido'`, [o.id]);
    const t = one(`SELECT COALESCE(SUM(valor_taxa),0) AS v FROM cartao_recebiveis WHERE operadora_id = ?`, [o.id]);
    o.a_receber = round2(a ? a.v : 0);
    o.parcelas_abertas = a ? a.n : 0;
    o.taxas_pagas = round2(t ? t.v : 0);
  });
  res.json(lista);
});

app.post('/api/operadoras', auth, (req, res) => {
  const b = req.body;
  if (!txt(b.nome)) return res.status(400).json({ erro: 'Informe o nome da maquininha.' });

  const dados = [
    txt(b.nome).toUpperCase(), txt(b.apelido),
    num(b.taxa_debito), num(b.taxa_credito), num(b.taxa_parcelado),
    Math.max(0, parseInt(b.prazo_debito) || 0),
    Math.max(0, parseInt(b.prazo_credito) || 0),
    Math.max(1, parseInt(b.prazo_parcela) || 30),
    b.padrao ? 1 : 0, txt(b.status) || 'ativo', txt(b.observacao)
  ];

  if (b.padrao) run('UPDATE operadoras SET padrao = 0');

  if (b.id) {
    run(`UPDATE operadoras SET nome=?, apelido=?, taxa_debito=?, taxa_credito=?, taxa_parcelado=?,
         prazo_debito=?, prazo_credito=?, prazo_parcela=?, padrao=?, status=?, observacao=?
         WHERE id=?`, [...dados, b.id]);
    run('UPDATE cartao_recebiveis SET operadora = ? WHERE operadora_id = ?', [dados[0], b.id]);
    salvarBanco();
    return res.json({ ok: true, id: b.id });
  }

  const id = inserir(
    `INSERT INTO operadoras (nome, apelido, taxa_debito, taxa_credito, taxa_parcelado,
       prazo_debito, prazo_credito, prazo_parcela, padrao, status, observacao, criado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [...dados, agora()]);
  registrarLog(req.usuario.usuario, 'operadora-nova', txt(b.nome));
  res.json({ ok: true, id });
});

app.delete('/api/operadoras/:id', auth, (req, res) => {
  const usada = one('SELECT COUNT(*) AS n FROM cartao_recebiveis WHERE operadora_id = ?', [req.params.id]);
  if (usada && usada.n) {
    run("UPDATE operadoras SET status = 'inativo', padrao = 0 WHERE id = ?", [req.params.id]);
    salvarBanco();
    return res.json({ ok: true, inativado: true,
      aviso: 'A maquininha ja tem vendas, entao foi apenas INATIVADA.' });
  }
  run('DELETE FROM operadoras WHERE id = ?', [req.params.id]);
  salvarBanco();
  res.json({ ok: true });
});

/**
 * Taxa e prazo que valem para um pagamento de cartao.
 * Credito em mais de uma parcela usa a taxa de parcelado (se houver).
 */
function regraCartao(op, forma, parcelas) {
  const debito = forma === 'CARTAO DEBITO';
  if (debito) {
    return { taxa: num(op.taxa_debito), prazo: parseInt(op.prazo_debito) || 0, prazoParcela: 0 };
  }
  const parcelado = parcelas > 1;
  const taxa = parcelado && num(op.taxa_parcelado) > 0 ? num(op.taxa_parcelado) : num(op.taxa_credito);
  return {
    taxa,
    prazo: parseInt(op.prazo_credito) || 30,
    prazoParcela: Math.max(1, parseInt(op.prazo_parcela) || 30)
  };
}

/** Gera as parcelas que a operadora vai depositar por causa de um pagamento. */
function gerarRecebiveisCartao(venda, pagamento, usuario) {
  const op = one('SELECT * FROM operadoras WHERE id = ?', [pagamento.operadora_id]);
  if (!op) return 0;

  const n = Math.max(1, pagamento.parcelas || 1);
  const r = regraCartao(op, pagamento.forma, n);

  const base = Math.floor((pagamento.valor / n) * 100) / 100;
  const dataVenda = hoje();

  for (let i = 1; i <= n; i++) {
    const bruto = (i === n) ? round2(pagamento.valor - base * (n - 1)) : base;
    const taxa = round2(bruto * (r.taxa / 100));
    const liquido = round2(bruto - taxa);
    const dias = pagamento.forma === 'CARTAO DEBITO'
      ? r.prazo
      : r.prazo + r.prazoParcela * (i - 1);

    run(`INSERT INTO cartao_recebiveis
         (venda_id, venda_numero, operadora_id, operadora, bandeira, forma,
          parcela, total_parcelas, data_venda, previsao,
          valor_bruto, taxa_percentual, valor_taxa, valor_liquido, situacao, usuario)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'aberto', ?)`,
      [venda.id, venda.numero, op.id, op.nome, txt(pagamento.detalhe), pagamento.forma,
       i, n, dataVenda, somarPrazo(dataVenda, dias),
       bruto, r.taxa, taxa, liquido, txt(usuario)]);
  }
  return n;
}

function situacaoRecebivel(t) {
  if (t.situacao === 'recebido') return 'recebido';
  if (t.previsao < hoje()) return 'atrasado';
  if (t.previsao === hoje()) return 'cai_hoje';
  return 'aberto';
}

app.get('/api/cartao/recebiveis', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('previsao >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('previsao <= ?'); params.push(req.query.ate); }
  if (req.query.operadora_id) { filtros.push('operadora_id = ?'); params.push(req.query.operadora_id); }
  if (req.query.forma) { filtros.push('forma = ?'); params.push(req.query.forma); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(operadora) LIKE ? OR CAST(venda_numero AS TEXT) LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%');
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  let lista = all(`SELECT * FROM cartao_recebiveis ${where}
                   ORDER BY previsao, operadora, venda_numero LIMIT 3000`, params);

  lista.forEach((t) => {
    t.status = situacaoRecebivel(t);
    t.saldo = round2(num(t.valor_liquido) - num(t.valor_recebido));
    t.dias = Math.floor((new Date(t.previsao) - new Date(hoje())) / 86400000);
  });

  const st = txt(req.query.situacao);
  if (st && st !== 'todas') {
    if (st === 'aberto') lista = lista.filter((t) => t.status !== 'recebido');
    else lista = lista.filter((t) => t.status === st);
  }

  const abertos = lista.filter((t) => t.status !== 'recebido');
  res.json({
    recebiveis: lista,
    totais: {
      a_receber: round2(abertos.reduce((s, t) => s + t.saldo, 0)),
      bruto: round2(lista.reduce((s, t) => s + num(t.valor_bruto), 0)),
      taxas: round2(lista.reduce((s, t) => s + num(t.valor_taxa), 0)),
      recebido: round2(lista.filter((t) => t.status === 'recebido')
        .reduce((s, t) => s + num(t.valor_recebido), 0)),
      atrasados: round2(abertos.filter((t) => t.status === 'atrasado').reduce((s, t) => s + t.saldo, 0)),
      cai_hoje: round2(abertos.filter((t) => t.status === 'cai_hoje').reduce((s, t) => s + t.saldo, 0)),
      qtd_atrasados: abertos.filter((t) => t.status === 'atrasado').length
    }
  });
});

app.post('/api/cartao/recebiveis/:id/receber', auth, (req, res) => {
  const t = one('SELECT * FROM cartao_recebiveis WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ erro: 'Parcela nao encontrada.' });
  if (t.situacao === 'recebido') return res.status(400).json({ erro: 'Essa parcela ja foi recebida.' });

  const valor = round2(req.body.valor !== undefined && req.body.valor !== ''
    ? req.body.valor : num(t.valor_liquido) - num(t.valor_recebido));
  if (valor <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });

  const total = round2(num(t.valor_recebido) + valor);
  const quitado = total >= round2(num(t.valor_liquido)) - 0.001;

  run(`UPDATE cartao_recebiveis SET valor_recebido = ?, recebido_em = ?, situacao = ?, observacao = ?
       WHERE id = ?`,
    [total, agora(), quitado ? 'recebido' : 'parcial', txt(req.body.observacao), t.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cartao-receber',
    `${t.operadora} venda ${t.venda_numero} parcela ${t.parcela} R$ ${valor.toFixed(2)}`);
  res.json({ ok: true, quitado });
});

/** Baixa em lote: tudo que a operadora depositou num dia so. */
app.post('/api/cartao/recebiveis/baixar-lote', auth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ erro: 'Marque pelo menos uma parcela.' });

  let baixadas = 0;
  let total = 0;
  ids.forEach((id) => {
    const t = one('SELECT * FROM cartao_recebiveis WHERE id = ?', [id]);
    if (!t || t.situacao === 'recebido') return;
    const saldo = round2(num(t.valor_liquido) - num(t.valor_recebido));
    run(`UPDATE cartao_recebiveis SET valor_recebido = ?, recebido_em = ?, situacao = 'recebido'
         WHERE id = ?`, [round2(num(t.valor_liquido)), agora(), t.id]);
    baixadas++;
    total += saldo;
  });
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cartao-baixa-lote',
    `${baixadas} parcela(s) - R$ ${round2(total).toFixed(2)}`);
  res.json({ ok: true, baixadas, total: round2(total) });
});

app.post('/api/cartao/recebiveis/:id/estornar', auth, (req, res) => {
  const t = one('SELECT * FROM cartao_recebiveis WHERE id = ?', [req.params.id]);
  if (!t) return res.status(404).json({ erro: 'Parcela nao encontrada.' });
  if (num(t.valor_recebido) <= 0) return res.status(400).json({ erro: 'Essa parcela nao tem baixa para estornar.' });

  run(`UPDATE cartao_recebiveis SET valor_recebido = 0, recebido_em = NULL, situacao = 'aberto'
       WHERE id = ?`, [t.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cartao-estorno', `${t.operadora} venda ${t.venda_numero}`);
  res.json({ ok: true });
});

app.get('/api/cartao/resumo', auth, (req, res) => {
  const de = txt(req.query.de) || '2000-01-01';
  const ate = txt(req.query.ate) || '2100-01-01';

  const porOperadora = all(`
    SELECT operadora AS nome, COUNT(*) AS qtd,
           COALESCE(SUM(valor_bruto),0) AS bruto,
           COALESCE(SUM(valor_taxa),0) AS taxa,
           COALESCE(SUM(valor_liquido),0) AS liquido,
           COALESCE(SUM(CASE WHEN situacao <> 'recebido' THEN valor_liquido - valor_recebido ELSE 0 END),0) AS aberto
    FROM cartao_recebiveis WHERE data_venda >= ? AND data_venda <= ?
    GROUP BY operadora ORDER BY bruto DESC`, [de, ate]);

  const porForma = all(`
    SELECT forma, COUNT(*) AS qtd,
           COALESCE(SUM(valor_bruto),0) AS bruto,
           COALESCE(SUM(valor_taxa),0) AS taxa
    FROM cartao_recebiveis WHERE data_venda >= ? AND data_venda <= ?
    GROUP BY forma ORDER BY bruto DESC`, [de, ate]);

  const arred = (l) => l.map((x) => ({
    ...x, bruto: round2(x.bruto), taxa: round2(x.taxa),
    liquido: round2(x.liquido), aberto: round2(x.aberto)
  }));

  const bruto = porOperadora.reduce((s, o) => s + num(o.bruto), 0);
  const taxa = porOperadora.reduce((s, o) => s + num(o.taxa), 0);

  res.json({
    por_operadora: arred(porOperadora),
    por_forma: arred(porForma),
    bruto: round2(bruto),
    taxa: round2(taxa),
    liquido: round2(bruto - taxa),
    taxa_media: bruto ? round2((taxa / bruto) * 100) : 0
  });
});

/* =========================================================================
   FORNECEDORES
   ========================================================================= */

app.get('/api/fornecedores', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.status && req.query.status !== 'todos') { filtros.push('status = ?'); params.push(req.query.status); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(nome) LIKE ? OR cnpj LIKE ? OR telefone LIKE ?)');
    params.push(q, q, q);
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  const lista = all(`SELECT * FROM fornecedores ${where} ORDER BY nome LIMIT 2000`, params);

  lista.forEach((f) => {
    const a = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v, COUNT(*) AS n
                   FROM cp_contas WHERE fornecedor_id = ? AND situacao <> 'pago'`, [f.id]);
    const t = one(`SELECT COALESCE(SUM(valor_pago),0) AS v FROM cp_contas WHERE fornecedor_id = ?`, [f.id]);
    f.em_aberto = round2(a ? a.v : 0);
    f.contas_abertas = a ? a.n : 0;
    f.total_pago = round2(t ? t.v : 0);
  });
  res.json(lista);
});

app.post('/api/fornecedores', auth, (req, res) => {
  const b = req.body;
  if (!txt(b.nome)) return res.status(400).json({ erro: 'Informe o nome do fornecedor.' });

  const cnpj = somenteDigitos(b.cnpj);
  if (cnpj) {
    const dup = one('SELECT id, nome FROM fornecedores WHERE cnpj = ? AND id <> ?', [cnpj, b.id || 0]);
    if (dup) return res.status(400).json({ erro: `CNPJ ja cadastrado em: ${dup.nome}` });
  }

  const dados = [
    txt(b.nome).toUpperCase(), cnpj, txt(b.telefone), txt(b.email), txt(b.contato),
    txt(b.cidade), txt(b.uf).toUpperCase(), txt(b.observacao), txt(b.status) || 'ativo'
  ];

  if (b.id) {
    run(`UPDATE fornecedores SET nome=?, cnpj=?, telefone=?, email=?, contato=?,
         cidade=?, uf=?, observacao=?, status=? WHERE id=?`, [...dados, b.id]);
    // mantem o nome gravado nas contas em sincronia
    run('UPDATE cp_contas SET fornecedor = ? WHERE fornecedor_id = ?', [dados[0], b.id]);
    salvarBanco();
    return res.json({ ok: true, id: b.id });
  }

  const id = inserir(
    `INSERT INTO fornecedores (nome, cnpj, telefone, email, contato, cidade, uf,
       observacao, status, criado_em) VALUES (?,?,?,?,?,?,?,?,?,?)`, [...dados, agora()]);
  registrarLog(req.usuario.usuario, 'fornecedor-novo', txt(b.nome));
  res.json({ ok: true, id });
});

app.delete('/api/fornecedores/:id', auth, (req, res) => {
  const c = one('SELECT COUNT(*) AS n FROM cp_contas WHERE fornecedor_id = ?', [req.params.id]);
  if (c && c.n) {
    run("UPDATE fornecedores SET status = 'inativo' WHERE id = ?", [req.params.id]);
    salvarBanco();
    return res.json({ ok: true, inativado: true,
      aviso: 'O fornecedor ja tem contas lancadas, entao foi apenas INATIVADO.' });
  }
  run('DELETE FROM fornecedores WHERE id = ?', [req.params.id]);
  salvarBanco();
  res.json({ ok: true });
});

/* =========================================================================
   CONTAS A PAGAR
   ========================================================================= */

app.get('/api/cp/categorias', auth, (req, res) => {
  res.json(all('SELECT * FROM cp_categorias WHERE ativo = 1 ORDER BY nome'));
});

app.post('/api/cp/categorias', auth, (req, res) => {
  const nome = txt(req.body.nome).toUpperCase();
  if (!nome) return res.status(400).json({ erro: 'Informe o nome da categoria.' });
  const existe = one('SELECT id FROM cp_categorias WHERE nome = ? AND ativo = 1', [nome]);
  if (existe) return res.json({ ok: true, id: existe.id });
  const id = inserir('INSERT INTO cp_categorias (nome, ativo) VALUES (?,1)', [nome]);
  res.json({ ok: true, id });
});

app.delete('/api/cp/categorias/:id', auth, (req, res) => {
  const usada = one('SELECT COUNT(*) AS n FROM cp_contas WHERE categoria_id = ?', [req.params.id]);
  if (usada && usada.n) run('UPDATE cp_categorias SET ativo = 0 WHERE id = ?', [req.params.id]);
  else run('DELETE FROM cp_categorias WHERE id = ?', [req.params.id]);
  salvarBanco();
  res.json({ ok: true });
});

function situacaoConta(c) {
  if (c.situacao === 'pago') return 'pago';
  if (c.vencimento < hoje()) return 'vencido';
  if (c.vencimento === hoje()) return 'vence_hoje';
  return 'aberto';
}

app.get('/api/cp/contas', auth, (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('c.vencimento >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('c.vencimento <= ?'); params.push(req.query.ate); }
  if (req.query.fornecedor_id) { filtros.push('c.fornecedor_id = ?'); params.push(req.query.fornecedor_id); }
  if (req.query.categoria_id) { filtros.push('c.categoria_id = ?'); params.push(req.query.categoria_id); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(c.fornecedor) LIKE ? OR upper(c.descricao) LIKE ? OR upper(c.documento) LIKE ?)');
    params.push(q, q, q);
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';

  let lista = all(`
    SELECT c.*, cat.nome AS categoria
    FROM cp_contas c LEFT JOIN cp_categorias cat ON cat.id = c.categoria_id
    ${where} ORDER BY c.vencimento, c.fornecedor LIMIT 3000`, params);

  // [1.16] marca quais contas tem boleto anexado (sem trazer o arquivo)
  const comBoleto = new Set(all('SELECT conta_id FROM cp_anexos').map((a) => a.conta_id));
  lista.forEach((c) => {
    c.status = situacaoConta(c);
    c.saldo = round2(num(c.valor) - num(c.valor_pago));
    c.dias = Math.floor((new Date(hoje()) - new Date(c.vencimento)) / 86400000);
    c.tem_boleto = comBoleto.has(c.id) ? 1 : 0;
  });

  const st = txt(req.query.situacao);
  if (st && st !== 'todas') {
    if (st === 'aberto') lista = lista.filter((c) => c.status !== 'pago');
    else lista = lista.filter((c) => c.status === st);
  }

  const abertas = lista.filter((c) => c.status !== 'pago');
  res.json({
    contas: lista,
    totais: {
      em_aberto: round2(abertas.reduce((s, c) => s + c.saldo, 0)),
      vencidas: round2(abertas.filter((c) => c.status === 'vencido').reduce((s, c) => s + c.saldo, 0)),
      vence_hoje: round2(abertas.filter((c) => c.status === 'vence_hoje').reduce((s, c) => s + c.saldo, 0)),
      pago: round2(lista.reduce((s, c) => s + num(c.valor_pago), 0)),
      qtd_vencidas: abertas.filter((c) => c.status === 'vencido').length
    }
  });
});

app.post('/api/cp/contas', auth, (req, res) => {
  const b = req.body;
  const valorTotal = round2(b.valor);
  if (valorTotal <= 0) return res.status(400).json({ erro: 'Informe o valor da conta.' });
  if (!txt(b.descricao) && !txt(b.fornecedor) && !b.fornecedor_id) {
    return res.status(400).json({ erro: 'Informe pelo menos o fornecedor ou a descricao.' });
  }
  if (!txt(b.vencimento)) return res.status(400).json({ erro: 'Informe o vencimento.' });

  let fornecedorNome = txt(b.fornecedor).toUpperCase();
  if (b.fornecedor_id) {
    const f = one('SELECT nome FROM fornecedores WHERE id = ?', [b.fornecedor_id]);
    if (f) fornecedorNome = f.nome;
  }

  // [1.16] como pretende pagar (boleto/pix/outro) e, no PIX, os dados para pagar
  const formaPrevista = ['BOLETO', 'PIX', 'OUTRO'].includes(txt(b.forma_prevista).toUpperCase())
    ? txt(b.forma_prevista).toUpperCase() : '';
  const pixDados = formaPrevista === 'PIX' ? txt(b.pix_dados) : '';
  // [1.17] a linha digitavel/codigo de barras do boleto (so quando for boleto)
  const boletoLinha = formaPrevista === 'BOLETO' ? txt(b.boleto_linha) : '';

  /* ---- edicao de uma parcela existente ---- */
  if (b.id) {
    const atual = one('SELECT * FROM cp_contas WHERE id = ?', [b.id]);
    if (!atual) return res.status(404).json({ erro: 'Conta nao encontrada.' });
    if (atual.situacao === 'pago') {
      return res.status(400).json({ erro: 'Conta ja paga. Estorne o pagamento antes de editar.' });
    }
    run(`UPDATE cp_contas SET fornecedor_id=?, fornecedor=?, categoria_id=?, documento=?,
         descricao=?, emissao=?, vencimento=?, valor=?, observacao=?, forma_prevista=?, pix_dados=?, boleto_linha=? WHERE id=?`,
      [b.fornecedor_id || null, fornecedorNome, b.categoria_id || null, txt(b.documento),
       txt(b.descricao), txt(b.emissao) || hoje(), txt(b.vencimento).slice(0, 10),
       valorTotal, txt(b.observacao), formaPrevista, pixDados, boletoLinha, b.id]);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'cp-editar', `#${b.id} ${fornecedorNome} ${valorTotal}`);
    return res.json({ ok: true, id: b.id });
  }

  /* ---- lancamento novo, com ou sem parcelamento ---- */
  const n = Math.max(1, Math.min(120, parseInt(b.parcelas) || 1));
  const intervalo = Math.max(1, parseInt(b.intervalo_dias) || 30);
  const primeiro = txt(b.vencimento).slice(0, 10);
  const emissao = txt(b.emissao) || hoje();
  const grupo = n > 1 ? 'G' + Date.now() + '-' + Math.floor(num(valorTotal) * 100) : null;

  const valorBase = Math.floor((valorTotal / n) * 100) / 100;
  const ids = [];

  for (let i = 1; i <= n; i++) {
    const valorParcela = (i === n) ? round2(valorTotal - valorBase * (n - 1)) : valorBase;
    const venc = somarPrazo(primeiro, intervalo * (i - 1));
    const doc = n > 1 && txt(b.documento)
      ? `${txt(b.documento)}/${String(i).padStart(2, '0')}` : txt(b.documento);

    run(`INSERT INTO cp_contas (fornecedor_id, fornecedor, categoria_id, documento, descricao,
           emissao, vencimento, valor, parcela, total_parcelas, grupo, observacao,
           forma_prevista, pix_dados, boleto_linha, situacao, usuario, criado_em)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'aberto', ?, ?)`,
      [b.fornecedor_id || null, fornecedorNome, b.categoria_id || null, doc, txt(b.descricao),
       emissao, venc, valorParcela, i, n, grupo, txt(b.observacao),
       // cada parcela tem um boleto com codigo diferente: no parcelamento nao repete
       formaPrevista, pixDados, (n === 1 ? boletoLinha : ''), req.usuario.usuario, agora()]);
    ids.push(ultimoId());
  }

  salvarBanco();
  registrarLog(req.usuario.usuario, 'cp-novo',
    `${fornecedorNome} ${txt(b.documento)} R$ ${valorTotal.toFixed(2)} em ${n}x`);
  res.json({ ok: true, ids, parcelas: n });
});

app.post('/api/cp/contas/:id/pagar', auth, (req, res) => {
  const c = one('SELECT * FROM cp_contas WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ erro: 'Conta nao encontrada.' });
  if (c.situacao === 'pago') return res.status(400).json({ erro: 'Essa conta ja esta paga.' });

  const juros = round2(req.body.juros);
  const desconto = round2(req.body.desconto);
  const saldo = round2(num(c.valor) - num(c.valor_pago));
  const valor = round2(req.body.valor !== undefined && req.body.valor !== ''
    ? req.body.valor : saldo + juros - desconto);
  if (valor <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });

  const forma = txt(req.body.forma).toUpperCase() || 'DINHEIRO';
  if (!FORMAS.includes(forma)) return res.status(400).json({ erro: 'Forma de pagamento invalida.' });

  // o que abate a divida e o valor pago menos juros mais desconto
  const abatido = round2(valor - juros + desconto);
  const pagoTotal = round2(num(c.valor_pago) + abatido);
  const quitado = pagoTotal >= round2(num(c.valor)) - 0.001;

  // pagamento em dinheiro pode sair da gaveta do caixa
  let sangria = false;
  if (forma === 'DINHEIRO' && req.body.sair_do_caixa) {
    const cx = caixaAberto();
    if (!cx) return res.status(400).json({ erro: 'Nenhum caixa aberto para tirar o dinheiro. Feche a opcao "sair do caixa" ou abra o caixa.' });
    const r = resumoCaixa(cx.id);
    if (valor > r.dinheiro_esperado) {
      return res.status(400).json({
        erro: `Nao ha esse dinheiro no caixa (disponivel R$ ${r.dinheiro_esperado.toFixed(2)}).` });
    }
    run('INSERT INTO caixa_mov (caixa_id, tipo, valor, motivo, usuario, data) VALUES (?,?,?,?,?,?)',
      [cx.id, 'sangria', valor,
       `Pagamento: ${txt(c.fornecedor) || txt(c.descricao)} ${txt(c.documento)}`.trim(),
       req.usuario.nome, agora()]);
    sangria = true;
  }

  run(`UPDATE cp_contas SET valor_pago = ?, juros = ?, desconto = ?, pago_em = ?,
       forma_pagto = ?, situacao = ?, observacao = ? WHERE id = ?`,
    [pagoTotal, round2(num(c.juros) + juros), round2(num(c.desconto) + desconto), agora(),
     forma, quitado ? 'pago' : 'parcial',
     txt(req.body.observacao) || txt(c.observacao), c.id]);
  salvarBanco();

  registrarLog(req.usuario.usuario, 'cp-pagar',
    `${c.fornecedor} ${c.documento} R$ ${valor.toFixed(2)} em ${forma}${sangria ? ' (saiu do caixa)' : ''}`);
  res.json({ ok: true, quitado, pago: pagoTotal, sangria });
});

app.post('/api/cp/contas/:id/estornar', auth, (req, res) => {
  const c = one('SELECT * FROM cp_contas WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ erro: 'Conta nao encontrada.' });
  if (num(c.valor_pago) <= 0) return res.status(400).json({ erro: 'Essa conta nao tem pagamento para estornar.' });

  run(`UPDATE cp_contas SET valor_pago = 0, juros = 0, desconto = 0, pago_em = NULL,
       forma_pagto = NULL, situacao = 'aberto' WHERE id = ?`, [c.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cp-estorno', `${c.fornecedor} ${c.documento}`);
  res.json({ ok: true,
    aviso: 'Pagamento estornado. Se ele tinha saido do caixa, lance um suprimento para acertar a gaveta.' });
});

app.delete('/api/cp/contas/:id', auth, (req, res) => {
  const c = one('SELECT * FROM cp_contas WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ erro: 'Conta nao encontrada.' });
  if (num(c.valor_pago) > 0) {
    return res.status(400).json({ erro: 'Conta com pagamento lancado. Estorne antes de excluir.' });
  }

  // excluir o parcelamento inteiro
  if (req.query.grupo === '1' && c.grupo) {
    const pagas = one(`SELECT COUNT(*) AS n FROM cp_contas WHERE grupo = ? AND valor_pago > 0`, [c.grupo]);
    if (pagas && pagas.n) {
      return res.status(400).json({ erro: 'Ha parcelas ja pagas nesse parcelamento. Estorne antes.' });
    }
    const idsGrupo = all('SELECT id FROM cp_contas WHERE grupo = ?', [c.grupo]).map((x) => x.id);
    const qtd = idsGrupo.length;
    run('DELETE FROM cp_contas WHERE grupo = ?', [c.grupo]);
    idsGrupo.forEach((id) => run('DELETE FROM cp_anexos WHERE conta_id = ?', [id]));  // [1.16]
    salvarBanco();
    registrarLog(req.usuario.usuario, 'cp-excluir-grupo', `${c.fornecedor} ${c.documento}`);
    return res.json({ ok: true, excluidas: qtd || 1 });
  }

  run('DELETE FROM cp_contas WHERE id = ?', [c.id]);
  run('DELETE FROM cp_anexos WHERE conta_id = ?', [c.id]);   // [1.16] tira o boleto junto
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cp-excluir', `${c.fornecedor} ${c.documento}`);
  res.json({ ok: true, excluidas: 1 });
});

/* ---------- [1.16] boleto anexado a uma conta a pagar ---------- */
const TIPOS_BOLETO = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/cp/contas/:id/boleto', auth, (req, res) => {
  const c = one('SELECT id, fornecedor, documento FROM cp_contas WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ erro: 'Conta nao encontrada.' });
  const tipo = txt(req.body.tipo);
  const nome = txt(req.body.nome) || 'boleto';
  const dados = txt(req.body.dados);   // base64 (sem o prefixo data:)
  if (!dados) return res.status(400).json({ erro: 'Nenhum arquivo recebido.' });
  if (!TIPOS_BOLETO[tipo]) return res.status(400).json({ erro: 'Anexe um PDF ou uma imagem (JPG, PNG).' });
  // ~4 MB de arquivo = ~5,6 MB em base64
  if (dados.length > 5.6 * 1024 * 1024) return res.status(400).json({ erro: 'O arquivo e grande demais (limite de 4 MB).' });

  run(`INSERT INTO cp_anexos (conta_id, nome, tipo, dados, enviado_em, usuario)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(conta_id) DO UPDATE SET nome=excluded.nome, tipo=excluded.tipo,
         dados=excluded.dados, enviado_em=excluded.enviado_em, usuario=excluded.usuario`,
    [c.id, nome, tipo, dados, agora(), req.usuario.usuario]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'cp-boleto', `#${c.id} ${c.fornecedor} ${c.documento}`);
  res.json({ ok: true });
});

app.get('/api/cp/contas/:id/boleto', auth, (req, res) => {
  const a = one('SELECT * FROM cp_anexos WHERE conta_id = ?', [req.params.id]);
  if (!a) return res.status(404).json({ erro: 'Essa conta nao tem boleto anexado.' });
  const ext = TIPOS_BOLETO[a.tipo] || 'bin';
  const buf = Buffer.from(txt(a.dados), 'base64');
  res.setHeader('Content-Type', a.tipo);
  const inline = txt(req.query.inline) === '1';
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="boleto-conta-${req.params.id}.${ext}"`);
  res.send(buf);
});

app.delete('/api/cp/contas/:id/boleto', auth, (req, res) => {
  run('DELETE FROM cp_anexos WHERE conta_id = ?', [req.params.id]);
  salvarBanco();
  res.json({ ok: true });
});

app.get('/api/cp/resumo', auth, (req, res) => {
  const de = txt(req.query.de) || '2000-01-01';
  const ate = txt(req.query.ate) || '2100-01-01';

  const porCategoria = all(`
    SELECT COALESCE(cat.nome,'SEM CATEGORIA') AS nome,
           COALESCE(SUM(c.valor),0) AS total,
           COALESCE(SUM(c.valor_pago),0) AS pago,
           COUNT(*) AS qtd
    FROM cp_contas c LEFT JOIN cp_categorias cat ON cat.id = c.categoria_id
    WHERE c.vencimento >= ? AND c.vencimento <= ?
    GROUP BY nome ORDER BY total DESC`, [de, ate]);

  const porFornecedor = all(`
    SELECT COALESCE(fornecedor,'-') AS nome, COALESCE(SUM(valor),0) AS total,
           COALESCE(SUM(valor - valor_pago),0) AS aberto, COUNT(*) AS qtd
    FROM cp_contas WHERE vencimento >= ? AND vencimento <= ?
    GROUP BY nome ORDER BY total DESC LIMIT 50`, [de, ate]);

  const porMes = all(`
    SELECT substr(vencimento,1,7) AS mes, COALESCE(SUM(valor),0) AS total,
           COALESCE(SUM(valor - valor_pago),0) AS aberto
    FROM cp_contas WHERE vencimento >= ? AND vencimento <= ?
    GROUP BY mes ORDER BY mes`, [de, ate]);

  const geral = porCategoria.reduce((s, c) => s + num(c.total), 0);
  porCategoria.forEach((c) => {
    c.total = round2(c.total);
    c.pago = round2(c.pago);
    c.participacao = geral ? round2((c.total / geral) * 100) : 0;
  });

  res.json({
    por_categoria: porCategoria,
    por_fornecedor: porFornecedor.map((f) => ({
      ...f, total: round2(f.total), aberto: round2(f.aberto)
    })),
    por_mes: porMes.map((m) => ({ ...m, total: round2(m.total), aberto: round2(m.aberto) })),
    total_geral: round2(geral)
  });
});

/* =========================================================================
   [1.16] OBRAS — material (a preco de custo) que sai para as obras do dono.
   Nao e venda fiscal, nao passa pelo caixa; o estoque baixa na saida.
   Cada obra acumula um saldo (retirado - pago) que o dono acerta com a loja.
   ========================================================================= */

function obraResumo(obraId) {
  const r = one('SELECT COALESCE(SUM(total),0) AS t FROM obra_saidas WHERE obra_id = ?', [obraId]);
  const p = one('SELECT COALESCE(SUM(valor),0) AS t FROM obra_pagamentos WHERE obra_id = ?', [obraId]);
  const retirado = round2(r ? r.t : 0);
  const pago = round2(p ? p.t : 0);
  return { retirado, pago, saldo: round2(retirado - pago) };
}

app.get('/api/obras', auth, (req, res) => {
  const st = txt(req.query.status);
  let obras = all('SELECT * FROM obras ORDER BY status, nome').map((o) => ({ ...o, ...obraResumo(o.id) }));
  if (st === 'andamento' || st === 'concluida') obras = obras.filter((o) => o.status === st);
  res.json({
    obras,
    totais: {
      retirado: round2(obras.reduce((s, o) => s + o.retirado, 0)),
      pago: round2(obras.reduce((s, o) => s + o.pago, 0)),
      saldo: round2(obras.reduce((s, o) => s + o.saldo, 0)),
      qtd: obras.length
    }
  });
});

app.post('/api/obras', auth, (req, res) => {
  const b = req.body;
  if (!txt(b.nome)) return res.status(400).json({ erro: 'Informe o nome da obra.' });
  const status = txt(b.status) === 'concluida' ? 'concluida' : 'andamento';
  if (b.id) {
    const o = one('SELECT id FROM obras WHERE id = ?', [b.id]);
    if (!o) return res.status(404).json({ erro: 'Obra nao encontrada.' });
    run(`UPDATE obras SET nome=?, responsavel=?, endereco=?, telefone=?, observacao=?, status=? WHERE id=?`,
      [txt(b.nome), txt(b.responsavel), txt(b.endereco), txt(b.telefone), txt(b.observacao), status, b.id]);
    salvarBanco();
    registrarLog(req.usuario.usuario, 'obra-editar', txt(b.nome));
    return res.json({ ok: true, id: b.id });
  }
  const id = inserir(`INSERT INTO obras (nome, responsavel, endereco, telefone, observacao, status, criado_em, usuario)
       VALUES (?,?,?,?,?,?,?,?)`,
    [txt(b.nome), txt(b.responsavel), txt(b.endereco), txt(b.telefone), txt(b.observacao), status, agora(), req.usuario.usuario]);
  registrarLog(req.usuario.usuario, 'obra-nova', txt(b.nome));
  res.json({ ok: true, id });
});

/* estornos (rotas com dois segmentos: declaradas antes de /obras/:id) */
app.delete('/api/obras/saida/:id', auth, (req, res) => {
  const s = one('SELECT * FROM obra_saidas WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ erro: 'Saida nao encontrada.' });
  const itens = all('SELECT * FROM obra_saida_itens WHERE saida_id = ?', [s.id]);
  itens.forEach((it) => {
    if (it.produto_id) {
      lancarEstoque(it.produto_id, 'entrada', it.quantidade, it.custo_unit,
        `OBRA #${s.obra_id} CANC`, 'Estorno de saida para obra', req.usuario.usuario, false);
    }
  });
  run('DELETE FROM obra_saida_itens WHERE saida_id = ?', [s.id]);
  run('DELETE FROM obra_saidas WHERE id = ?', [s.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'obra-saida-estorno', `saida #${s.id} obra #${s.obra_id} (devolveu ${itens.length} item ao estoque)`);
  res.json({ ok: true, itens: itens.length });
});

app.delete('/api/obras/pagamento/:id', auth, (req, res) => {
  const p = one('SELECT * FROM obra_pagamentos WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ erro: 'Pagamento nao encontrado.' });
  run('DELETE FROM obra_pagamentos WHERE id = ?', [p.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'obra-pagto-estorno', `pagamento #${p.id} obra #${p.obra_id}`);
  res.json({ ok: true });
});

app.post('/api/obras/:id/saida', auth, (req, res) => {
  const obra = one('SELECT * FROM obras WHERE id = ?', [req.params.id]);
  if (!obra) return res.status(404).json({ erro: 'Obra nao encontrada.' });
  const b = req.body;
  const itens = Array.isArray(b.itens) ? b.itens : [];
  if (!itens.length) return res.status(400).json({ erro: 'Adicione ao menos um material.' });
  const cfg = lerConfig();

  const preparados = [];
  for (const it of itens) {
    const p = one('SELECT * FROM produtos WHERE id = ?', [it.produto_id]);
    if (!p) return res.status(400).json({ erro: `Produto #${it.produto_id} nao existe mais.` });
    const qtd = round2(it.quantidade);
    if (qtd <= 0) return res.status(400).json({ erro: `Quantidade invalida em ${p.descricao}.` });
    if (!p.fracionado && Math.abs(qtd - Math.round(qtd)) > 0.0001) {
      return res.status(400).json({ erro: `${p.descricao} nao pode sair fracionado.` });
    }
    const reservado = reservadoDoProduto(p.id);
    const disp = round2(num(p.estoque) - reservado);
    if (cfg.venda_permite_estoque_negativo !== '1' && qtd > disp) {
      return res.status(400).json({
        erro: `Estoque insuficiente de ${p.descricao}. Disponivel: ${disp} ${p.unidade}` +
              (reservado ? ` (${num(p.estoque)} no estoque, ${reservado} reservados para entregas).` : '.') });
    }
    // sai a preco de CUSTO (o padrao); o custo pode ser ajustado item a item
    const custo = round2(num(it.custo_unit !== undefined && it.custo_unit !== '' ? it.custo_unit : p.preco_custo));
    preparados.push({ p, qtd, custo, total: round2(qtd * custo) });
  }

  const total = round2(preparados.reduce((s, i) => s + i.total, 0));
  const data = txt(b.data).slice(0, 10) || hoje();
  const saidaId = inserir(`INSERT INTO obra_saidas (obra_id, data, observacao, total, usuario, criado_em)
       VALUES (?,?,?,?,?,?)`,
    [obra.id, data, txt(b.observacao), total, req.usuario.usuario, agora()], false);

  preparados.forEach((i) => {
    run(`INSERT INTO obra_saida_itens (saida_id, produto_id, codigo, descricao, unidade, quantidade, custo_unit, total)
         VALUES (?,?,?,?,?,?,?,?)`,
      [saidaId, i.p.id, i.p.codigo, i.p.descricao, i.p.unidade, i.qtd, i.custo, i.total]);
    lancarEstoque(i.p.id, 'saida', i.qtd, i.custo, `OBRA #${obra.id}`,
      `Saida para obra: ${obra.nome}`, req.usuario.usuario, false);
  });
  salvarBanco();
  registrarLog(req.usuario.usuario, 'obra-saida',
    `obra #${obra.id} ${obra.nome} R$ ${total.toFixed(2)} (${preparados.length} item)`);
  res.json({ ok: true, id: saidaId, total });
});

app.post('/api/obras/:id/pagamento', auth, (req, res) => {
  const obra = one('SELECT * FROM obras WHERE id = ?', [req.params.id]);
  if (!obra) return res.status(404).json({ erro: 'Obra nao encontrada.' });
  const valor = round2(req.body.valor);
  if (valor <= 0) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });
  const forma = txt(req.body.forma).toUpperCase() || 'DINHEIRO';
  const data = txt(req.body.data).slice(0, 10) || hoje();
  const id = inserir(`INSERT INTO obra_pagamentos (obra_id, data, valor, forma, observacao, usuario, criado_em)
       VALUES (?,?,?,?,?,?,?)`,
    [obra.id, data, valor, forma, txt(req.body.observacao), req.usuario.usuario, agora()]);
  registrarLog(req.usuario.usuario, 'obra-pagamento', `obra #${obra.id} ${obra.nome} R$ ${valor.toFixed(2)} ${forma}`);
  res.json({ ok: true, id });
});

app.get('/api/obras/:id/extrato', auth, (req, res) => {
  const obra = one('SELECT * FROM obras WHERE id = ?', [req.params.id]);
  if (!obra) return res.status(404).send('Obra nao encontrada.');
  const cfg = lerConfig();
  const saidas = all('SELECT * FROM obra_saidas WHERE obra_id = ? ORDER BY data, id', [obra.id]);
  saidas.forEach((s) => { s.itens = all('SELECT * FROM obra_saida_itens WHERE saida_id = ? ORDER BY id', [s.id]); });
  const pagamentos = all('SELECT * FROM obra_pagamentos WHERE obra_id = ? ORDER BY data, id', [obra.id]);
  const r = obraResumo(obra.id);
  const brData = (iso) => { const s = txt(iso).slice(0, 10).split('-'); return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : txt(iso); };

  const blocoSaidas = saidas.map((s) => `
    <div class="bloco">
      <div class="bl-cab">Saída de ${brData(s.data)} — total R$ ${brl(s.total)}${s.observacao ? ' · ' + escapeHtml(s.observacao) : ''}</div>
      <table><thead><tr><th>Material</th><th class="c">Un.</th><th class="n">Qtd.</th><th class="n">Custo</th><th class="n">Total</th></tr></thead>
      <tbody>${s.itens.map((i) => `<tr><td>${escapeHtml(i.descricao)}</td><td class="c">${escapeHtml(i.unidade)}</td>
        <td class="n">${qtdFmt(i.quantidade)}</td><td class="n">${brl(i.custo_unit)}</td><td class="n">${brl(i.total)}</td></tr>`).join('')}</tbody></table>
    </div>`).join('') || '<p>Nenhuma saída registrada.</p>';

  const blocoPag = pagamentos.length ? `
    <table><thead><tr><th>Data</th><th>Forma</th><th>Observação</th><th class="n">Valor</th></tr></thead>
    <tbody>${pagamentos.map((p) => `<tr><td>${brData(p.data)}</td><td>${escapeHtml(p.forma)}</td>
      <td>${escapeHtml(p.observacao)}</td><td class="n">${brl(p.valor)}</td></tr>`).join('')}</tbody></table>` : '<p>Nenhum pagamento registrado.</p>';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<title>Extrato da obra — ${escapeHtml(obra.nome)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:780px;margin:0 auto;padding:18px}
  h1{font-size:20px;margin:0 0 2px} .sub{color:#555;font-size:13px;margin-bottom:12px}
  .resumo{display:flex;gap:10px;margin:12px 0}
  .resumo div{flex:1;border:1px solid #ccc;border-radius:8px;padding:8px 10px}
  .resumo .rot{font-size:11px;color:#555;text-transform:uppercase}
  .resumo .val{font-size:18px;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0 14px}
  th,td{border-bottom:1px solid #e3e3e3;padding:5px 7px;text-align:left}
  th{background:#f3f3f3} .n{text-align:right} .c{text-align:center}
  .bloco{margin-bottom:12px} .bl-cab{font-weight:700;font-size:13px;margin:10px 0 2px}
  h2{font-size:15px;border-bottom:2px solid #111;padding-bottom:3px;margin-top:20px}
  .saldo{font-size:17px;font-weight:700;text-align:right;margin-top:6px}
  .noprint{margin-top:18px} @media print{.noprint{display:none}}
</style></head><body>
<h1>${escapeHtml(cfg.loja_fantasia || cfg.loja_nome || 'Loja')}</h1>
<div class="sub">Extrato de materiais — Obra: <strong>${escapeHtml(obra.nome)}</strong>
${obra.responsavel ? ' · Responsável: ' + escapeHtml(obra.responsavel) : ''}
${obra.endereco ? ' · ' + escapeHtml(obra.endereco) : ''}<br>Emitido em ${new Date().toLocaleString('pt-BR')}</div>
<div class="resumo">
  <div><div class="rot">Retirado (custo)</div><div class="val">R$ ${brl(r.retirado)}</div></div>
  <div><div class="rot">Pago</div><div class="val">R$ ${brl(r.pago)}</div></div>
  <div><div class="rot">Saldo a pagar</div><div class="val">R$ ${brl(r.saldo)}</div></div>
</div>
<h2>Materiais retirados</h2>
${blocoSaidas}
<h2>Pagamentos</h2>
${blocoPag}
<div class="saldo">Saldo a pagar: R$ ${brl(r.saldo)}</div>
<div class="noprint"><button onclick="window.print()">Imprimir</button></div>
<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},350)})</script>
</body></html>`);
});

app.get('/api/obras/:id', auth, (req, res) => {
  const obra = one('SELECT * FROM obras WHERE id = ?', [req.params.id]);
  if (!obra) return res.status(404).json({ erro: 'Obra nao encontrada.' });
  const saidas = all('SELECT * FROM obra_saidas WHERE obra_id = ? ORDER BY data DESC, id DESC', [obra.id]);
  saidas.forEach((s) => { s.itens = all('SELECT * FROM obra_saida_itens WHERE saida_id = ? ORDER BY id', [s.id]); });
  const pagamentos = all('SELECT * FROM obra_pagamentos WHERE obra_id = ? ORDER BY data DESC, id DESC', [obra.id]);
  const porProduto = all(`SELECT i.descricao, i.unidade, SUM(i.quantidade) AS quantidade, SUM(i.total) AS total
    FROM obra_saida_itens i JOIN obra_saidas s ON s.id = i.saida_id
    WHERE s.obra_id = ? GROUP BY i.produto_id, i.descricao, i.unidade ORDER BY total DESC`, [obra.id]);
  res.json({
    obra, resumo: obraResumo(obra.id), saidas, pagamentos,
    por_produto: porProduto.map((p) => ({ ...p, quantidade: round2(p.quantidade), total: round2(p.total) }))
  });
});

app.delete('/api/obras/:id', auth, (req, res) => {
  const obra = one('SELECT * FROM obras WHERE id = ?', [req.params.id]);
  if (!obra) return res.status(404).json({ erro: 'Obra nao encontrada.' });
  const s = one('SELECT COUNT(*) AS n FROM obra_saidas WHERE obra_id = ?', [obra.id]);
  const p = one('SELECT COUNT(*) AS n FROM obra_pagamentos WHERE obra_id = ?', [obra.id]);
  if ((s && s.n) || (p && p.n)) {
    return res.status(400).json({
      erro: 'Essa obra tem saidas ou pagamentos. Marque como concluida em vez de excluir (ou estorne tudo antes).' });
  }
  run('DELETE FROM obras WHERE id = ?', [obra.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'obra-excluir', obra.nome);
  res.json({ ok: true });
});

/* =========================================================================
   FLUXO DE CAIXA — a receber contra a pagar
   ========================================================================= */

app.get('/api/financeiro/fluxo', auth, (req, res) => {
  const d = hoje();
  const faixas = [
    { chave: 'vencido', rotulo: 'Vencidos', de: '2000-01-01', ate: somarPrazo(d, -1) },
    { chave: 'hoje', rotulo: 'Hoje', de: d, ate: d },
    { chave: 'd7', rotulo: 'Próximos 7 dias', de: somarPrazo(d, 1), ate: somarPrazo(d, 7) },
    { chave: 'd15', rotulo: '8 a 15 dias', de: somarPrazo(d, 8), ate: somarPrazo(d, 15) },
    { chave: 'd30', rotulo: '16 a 30 dias', de: somarPrazo(d, 16), ate: somarPrazo(d, 31) },
    { chave: 'd60', rotulo: '31 a 60 dias', de: somarPrazo(d, 32), ate: somarPrazo(d, 61) },
    { chave: 'acima', rotulo: 'Acima de 60 dias', de: somarPrazo(d, 62), ate: '2100-01-01' }
  ];

  const linhas = faixas.map((f) => {
    const r = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v FROM receber
                   WHERE situacao <> 'pago' AND vencimento >= ? AND vencimento <= ?`, [f.de, f.ate]);
    const c = one(`SELECT COALESCE(SUM(valor_liquido - valor_recebido),0) AS v FROM cartao_recebiveis
                   WHERE situacao <> 'recebido' AND previsao >= ? AND previsao <= ?`, [f.de, f.ate]);
    const p = one(`SELECT COALESCE(SUM(valor - valor_pago),0) AS v FROM cp_contas
                   WHERE situacao <> 'pago' AND vencimento >= ? AND vencimento <= ?`, [f.de, f.ate]);
    const crediario = round2(r ? r.v : 0);
    const cartao = round2(c ? c.v : 0);
    const pagar = round2(p ? p.v : 0);
    const receber = round2(crediario + cartao);
    return { ...f, crediario, cartao, receber, pagar, saldo: round2(receber - pagar) };
  });

  const porMes = {};
  const linhaMes = (mes) => {
    if (!porMes[mes]) porMes[mes] = { mes, crediario: 0, cartao: 0, receber: 0, pagar: 0 };
    return porMes[mes];
  };
  all(`SELECT substr(vencimento,1,7) AS mes, COALESCE(SUM(valor - valor_pago),0) AS v
       FROM receber WHERE situacao <> 'pago' GROUP BY mes`)
    .forEach((m) => { linhaMes(m.mes).crediario = round2(m.v); });
  all(`SELECT substr(previsao,1,7) AS mes, COALESCE(SUM(valor_liquido - valor_recebido),0) AS v
       FROM cartao_recebiveis WHERE situacao <> 'recebido' GROUP BY mes`)
    .forEach((m) => { linhaMes(m.mes).cartao = round2(m.v); });
  all(`SELECT substr(vencimento,1,7) AS mes, COALESCE(SUM(valor - valor_pago),0) AS v
       FROM cp_contas WHERE situacao <> 'pago' GROUP BY mes`)
    .forEach((m) => { linhaMes(m.mes).pagar = round2(m.v); });

  const meses = Object.values(porMes)
    .map((m) => {
      const receber = round2(m.crediario + m.cartao);
      return { ...m, receber, saldo: round2(receber - m.pagar) };
    })
    .sort((a, b) => a.mes.localeCompare(b.mes));

  const totalReceber = round2(linhas.reduce((s, l) => s + l.receber, 0));
  const totalPagar = round2(linhas.reduce((s, l) => s + l.pagar, 0));

  res.json({
    faixas: linhas, meses,
    total_crediario: round2(linhas.reduce((s, l) => s + l.crediario, 0)),
    total_cartao: round2(linhas.reduce((s, l) => s + l.cartao, 0)),
    total_receber: totalReceber,
    total_pagar: totalPagar,
    saldo: round2(totalReceber - totalPagar)
  });
});

/* =========================================================================
   ENTRADA DE NOTA FISCAL DE COMPRA (XML da NF-e)
   O XML e o arquivo que o fornecedor manda por e-mail junto com o DANFE.
   Dele saem: o fornecedor, os produtos, o custo, o estoque e as parcelas.
   ========================================================================= */

const parserXml = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, trimValues: true
});

const emArray = (x) => (x === undefined || x === null ? [] : (Array.isArray(x) ? x : [x]));

function textoXml(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return txt(v['#text'] || '');
  return txt(v);
}

/** Le o XML da NF-e e devolve os dados que interessam para a entrada. */
function lerNotaXml(xml) {
  const obj = parserXml.parse(xml);
  const inf = (obj.nfeProc && obj.nfeProc.NFe && obj.nfeProc.NFe.infNFe)
    || (obj.NFe && obj.NFe.infNFe) || obj.infNFe;
  if (!inf) throw new Error('Isso nao parece um XML de NF-e. Envie o arquivo .xml que o fornecedor mandou.');

  const ide = inf.ide || {};
  const emit = inf.emit || {};
  const dest = inf.dest || {};
  const end = emit.enderEmit || {};
  const tot = (inf.total && inf.total.ICMSTot) || {};
  const cobr = inf.cobr || {};

  const chave = somenteDigitos(inf['@Id'] || '');
  const emissao = textoXml(ide.dhEmi || ide.dEmi).slice(0, 10);

  const itens = emArray(inf.det).map((d, i) => {
    const p = d.prod || {};
    const ean = somenteDigitos(textoXml(p.cEAN));
    return {
      seq: i + 1,
      codigo_fornecedor: textoXml(p.cProd),
      codigo_barras: [8, 12, 13, 14].includes(ean.length) ? ean : '',
      descricao: textoXml(p.xProd).toUpperCase(),
      ncm: somenteDigitos(textoXml(p.NCM)),
      cfop: textoXml(p.CFOP),
      unidade: textoXml(p.uCom).toUpperCase().slice(0, 6) || 'UN',
      quantidade: round2(num(textoXml(p.qCom))),
      custo_unitario: Math.round(num(textoXml(p.vUnCom)) * 10000) / 10000,
      total: round2(num(textoXml(p.vProd))),
      desconto: round2(num(textoXml(p.vDesc)))
    };
  });

  const duplicatas = emArray(cobr.dup).map((d, i) => ({
    numero: textoXml(d.nDup) || String(i + 1).padStart(3, '0'),
    vencimento: textoXml(d.dVenc).slice(0, 10),
    valor: round2(num(textoXml(d.vDup)))
  })).filter((d) => d.valor > 0);

  return {
    chave,
    numero: textoXml(ide.nNF),
    serie: textoXml(ide.serie),
    emissao,
    fornecedor: {
      cnpj: somenteDigitos(textoXml(emit.CNPJ) || textoXml(emit.CPF)),
      nome: textoXml(emit.xNome).toUpperCase(),
      fantasia: textoXml(emit.xFant),
      ie: textoXml(emit.IE),
      telefone: textoXml(end.fone),
      cidade: textoXml(end.xMun),
      uf: textoXml(end.UF)
    },
    destinatario: {
      cnpj: somenteDigitos(textoXml(dest.CNPJ) || textoXml(dest.CPF)),
      nome: textoXml(dest.xNome)
    },
    valor_produtos: round2(num(textoXml(tot.vProd))),
    valor_desconto: round2(num(textoXml(tot.vDesc))),
    valor_total: round2(num(textoXml(tot.vNF))),
    itens,
    duplicatas
  };
}

/** Procura no cadastro o produto que corresponde ao item da nota. */
function acharProduto(item, fornecedorId) {
  if (item.codigo_barras) {
    const p = one('SELECT * FROM produtos WHERE codigo_barras = ?', [item.codigo_barras]);
    if (p) return { produto: p, por: 'código de barras' };
  }
  if (item.codigo_fornecedor) {
    const p = one('SELECT * FROM produtos WHERE upper(codigo) = ?',
      [item.codigo_fornecedor.toUpperCase()]);
    if (p) return { produto: p, por: 'código' };
  }
  const p = one('SELECT * FROM produtos WHERE upper(descricao) = ?', [item.descricao.toUpperCase()]);
  if (p) return { produto: p, por: 'descrição' };
  return { produto: null, por: null };
}

app.post('/api/entrada-nota/analisar', auth, exigir('entradaNota'), (req, res) => {
  const xml = txt(req.body.xml);
  if (!xml) return res.status(400).json({ erro: 'Envie o arquivo XML da nota.' });

  let nota;
  try { nota = lerNotaXml(xml); }
  catch (e) { return res.status(400).json({ erro: e.message }); }

  const jaEntrou = nota.chave
    ? one('SELECT * FROM entradas_nf WHERE chave = ?', [nota.chave]) : null;

  const fornecedor = nota.fornecedor.cnpj
    ? one('SELECT * FROM fornecedores WHERE cnpj = ?', [nota.fornecedor.cnpj]) : null;

  const cfg = lerConfig();
  const cnpjLoja = somenteDigitos(cfg.loja_cnpj);
  const paraOutraEmpresa = cnpjLoja && nota.destinatario.cnpj && cnpjLoja !== nota.destinatario.cnpj;

  nota.itens.forEach((i) => {
    const achado = acharProduto(i, fornecedor ? fornecedor.id : null);
    if (achado.produto) {
      i.produto_id = achado.produto.id;
      i.encontrado_por = achado.por;
      i.produto_atual = {
        codigo: achado.produto.codigo,
        descricao: achado.produto.descricao,
        estoque: num(achado.produto.estoque),
        preco_custo: num(achado.produto.preco_custo),
        preco_venda: num(achado.produto.preco_venda),
        unidade: achado.produto.unidade
      };
      i.acao = 'vincular';
    } else {
      i.produto_id = null;
      i.acao = 'novo';
    }
  });

  res.json({
    nota,
    ja_entrou: jaEntrou ? {
      data: jaEntrou.data_entrada, usuario: jaEntrou.usuario, id: jaEntrou.id
    } : null,
    fornecedor_cadastrado: fornecedor || null,
    para_outra_empresa: !!paraOutraEmpresa,
    resumo: {
      itens: nota.itens.length,
      novos: nota.itens.filter((i) => i.acao === 'novo').length,
      vinculados: nota.itens.filter((i) => i.acao === 'vincular').length,
      parcelas: nota.duplicatas.length
    }
  });
});

app.post('/api/entrada-nota/confirmar', auth, exigir('entradaNota'), (req, res) => {
  const b = req.body;
  const nota = b.nota;
  if (!nota || !Array.isArray(nota.itens) || !nota.itens.length) {
    return res.status(400).json({ erro: 'Nota sem itens para dar entrada.' });
  }

  if (nota.chave && !b.forcar) {
    const ja = one('SELECT id FROM entradas_nf WHERE chave = ?', [nota.chave]);
    if (ja) return res.status(409).json({ erro: 'Essa nota ja teve entrada. Confirme se quer lancar de novo.' });
  }

  /* ---- fornecedor ---- */
  let fornecedorId = b.fornecedor_id || null;
  if (!fornecedorId && nota.fornecedor && nota.fornecedor.cnpj) {
    const f = one('SELECT id FROM fornecedores WHERE cnpj = ?', [nota.fornecedor.cnpj]);
    fornecedorId = f ? f.id
      : inserir(`INSERT INTO fornecedores (nome, cnpj, telefone, cidade, uf, status, criado_em)
                 VALUES (?,?,?,?,?, 'ativo', ?)`,
        [nota.fornecedor.nome, nota.fornecedor.cnpj, nota.fornecedor.telefone,
         nota.fornecedor.cidade, nota.fornecedor.uf, agora()], false);
  }
  const fornNome = nota.fornecedor ? nota.fornecedor.nome : '';

  const margem = num(b.margem);
  const atualizarPreco = !!b.atualizar_preco && margem > 0;
  const documento = `NF ${nota.numero || ''}`.trim();

  /* [1.11] O XML original fica guardado para o pacote da contabilidade.
     So e aceito se for mesmo a nota que a tela analisou (mesma chave). */
  let xmlGuardado = null;
  if (txt(b.xml)) {
    try {
      const conferida = lerNotaXml(txt(b.xml));
      if (!nota.chave || conferida.chave === nota.chave) xmlGuardado = txt(b.xml);
    } catch (e) { /* XML ilegivel: a entrada segue, so nao guarda o arquivo */ }
  }

  const entradaId = inserir(
    `INSERT INTO entradas_nf (chave, numero, serie, fornecedor_id, fornecedor, cnpj, emissao,
       valor_total, valor_produtos, valor_desconto, itens_qtd, parcelas_qtd,
       gerou_contas, atualizou_preco, observacao, usuario, data_entrada, xml)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [nota.chave, nota.numero, nota.serie, fornecedorId, fornNome,
     nota.fornecedor ? nota.fornecedor.cnpj : '', nota.emissao,
     round2(nota.valor_total), round2(nota.valor_produtos), round2(nota.valor_desconto),
     nota.itens.length, (nota.duplicatas || []).length,
     b.gerar_contas ? 1 : 0, atualizarPreco ? 1 : 0,
     txt(b.observacao), req.usuario.usuario, agora(), xmlGuardado], false);

  /* ---- itens: cria ou vincula, da entrada no estoque ---- */
  let criados = 0;
  let atualizados = 0;
  const semPreco = [];

  nota.itens.forEach((i) => {
    if (i.ignorar) return;

    const qtd = round2(i.quantidade);
    const custo = round2(i.custo_unitario);
    if (qtd <= 0) return;

    let produtoId = i.produto_id || null;
    let criou = 0;
    let precoNovo = null;

    if (!produtoId) {
      const unidade = txt(i.unidade).toUpperCase() || 'UN';
      precoNovo = margem > 0 ? round2(custo * (1 + margem / 100)) : 0;
      produtoId = inserir(
        `INSERT INTO produtos (codigo, codigo_barras, descricao, categoria_id, unidade, ncm,
           preco_custo, preco_venda, estoque, estoque_minimo, fracionado, fornecedor,
           ativo, criado_em)
         VALUES (?,?,?,?,?,?,?,?,0,0,?,?,1,?)`,
        [txt(i.codigo_fornecedor) || proximoCodigoProduto(), txt(i.codigo_barras),
         txt(i.descricao).toUpperCase(), b.categoria_id || null, unidade, txt(i.ncm),
         custo, precoNovo, ['M3', 'M2', 'KG', 'M', 'LT'].includes(unidade) ? 1 : 0,
         fornNome, agora()], false);
      criados++;
      criou = 1;
      if (!precoNovo) semPreco.push(txt(i.descricao));
    } else {
      run('UPDATE produtos SET preco_custo = ?, fornecedor = ?, atualizado_em = ? WHERE id = ?',
        [custo, fornNome, agora(), produtoId]);
      if (atualizarPreco) {
        precoNovo = round2(custo * (1 + margem / 100));
        run('UPDATE produtos SET preco_venda = ? WHERE id = ?', [precoNovo, produtoId]);
      }
      atualizados++;
    }

    lancarEstoque(produtoId, 'entrada', qtd, custo, documento,
      `Entrada NF ${nota.numero} - ${fornNome}`.trim(), req.usuario.usuario, false);

    run(`INSERT INTO entrada_itens (entrada_id, produto_id, codigo_fornecedor, descricao,
           ncm, unidade, quantidade, custo_unitario, total, preco_venda_novo, criou_produto)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [entradaId, produtoId, txt(i.codigo_fornecedor), txt(i.descricao), txt(i.ncm),
       txt(i.unidade), qtd, custo, round2(i.total), precoNovo, criou]);
  });

  /* ---- parcelas viram contas a pagar ---- */
  let contas = 0;
  if (b.gerar_contas) {
    const catMerc = one("SELECT id FROM cp_categorias WHERE nome LIKE 'MERCADORIA%'");
    const dups = (nota.duplicatas || []).filter((d) => num(d.valor) > 0);
    const lista = dups.length ? dups
      : [{ numero: '001', vencimento: nota.emissao, valor: round2(nota.valor_total) }];
    const grupo = lista.length > 1 ? 'NF' + (nota.chave || nota.numero) : null;

    lista.forEach((d, i) => {
      run(`INSERT INTO cp_contas (fornecedor_id, fornecedor, categoria_id, documento, descricao,
             emissao, vencimento, valor, parcela, total_parcelas, grupo, situacao, usuario, criado_em)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 'aberto', ?, ?)`,
        [fornecedorId, fornNome, catMerc ? catMerc.id : null,
         `${documento}/${String(d.numero).slice(-3).padStart(2, '0')}`,
         `Mercadoria - NF ${nota.numero}`,
         nota.emissao, txt(d.vencimento).slice(0, 10) || nota.emissao,
         round2(d.valor), i + 1, lista.length, grupo, req.usuario.usuario, agora()]);
      contas++;
    });
  }

  salvarBanco();
  registrarLog(req.usuario.usuario, 'entrada-nf',
    `NF ${nota.numero} ${fornNome} - ${criados} novo(s), ${atualizados} atualizado(s), ${contas} conta(s)`);

  res.json({
    ok: true, id: entradaId, criados, atualizados, contas,
    sem_preco: semPreco,
    aviso: semPreco.length
      ? `${semPreco.length} produto(s) entraram sem preço de venda. Defina o preço antes de vender.`
      : ''
  });
});

app.get('/api/entrada-nota/historico', auth, exigir('entradaNota'), (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('data_entrada >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('data_entrada <= ?'); params.push(req.query.ate + 'T23:59:59'); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(fornecedor) LIKE ? OR numero LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%');
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  // o XML e pesado e nao interessa a lista: vai so a marca de que existe
  res.json(all(`SELECT id, chave, numero, serie, fornecedor_id, fornecedor, cnpj, emissao,
                       valor_total, valor_produtos, valor_desconto, itens_qtd, parcelas_qtd,
                       gerou_contas, atualizou_preco, observacao, usuario, data_entrada,
                       CASE WHEN xml IS NULL OR xml = '' THEN 0 ELSE 1 END AS tem_xml
                FROM entradas_nf ${where} ORDER BY id DESC LIMIT 500`, params));
});

/* [1.11] XML original da nota de compra (quando foi guardado). */
app.get('/api/entrada-nota/:id/xml', auth, exigir('entradaNota'), (req, res) => {
  const e = one('SELECT chave, numero, xml FROM entradas_nf WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).send('Entrada nao encontrada.');
  if (!txt(e.xml)) return res.status(404).send('Esta entrada foi lancada antes da versao 1.11 e nao tem o XML guardado.');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${e.chave ? e.chave + '-nfe' : 'nf-' + e.numero}.xml"`);
  res.send(e.xml);
});

app.get('/api/entrada-nota/:id', auth, exigir('entradaNota'), (req, res) => {
  const e = one('SELECT * FROM entradas_nf WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ erro: 'Entrada nao encontrada.' });
  e.tem_xml = txt(e.xml) ? 1 : 0;
  delete e.xml;
  e.itens = all('SELECT * FROM entrada_itens WHERE entrada_id = ? ORDER BY id', [e.id]);
  res.json(e);
});

/* =========================================================================
   [1.11] CONTABILIDADE: BALANCO DO MES, AVISO SEMANAL E PACOTE DE XMLs

   Tres perguntas que o dono faz todo mes:
     - quanto entrou de compra com nota?
     - quanto passou no cartao? (a operadora informa tudo a SEFAZ)
     - quanto de NFC-e ja foi emitido — e quanto falta para cobrir o cartao?
   E, virado o mes, o pacote com os XMLs para a contabilidade.
   ========================================================================= */

/** 'AAAA-MM' valido ou o mes atual. */
function mesValido(v) {
  const m = txt(v).match(/^(\d{4})-(\d{2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return m[0];
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Limites do mes no fuso do computador da loja, em ISO UTC (que e como as
 * datas com hora ficam gravadas). 'ate' e exclusivo.
 */
function limitesDoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return {
    de: new Date(a, m - 1, 1, 0, 0, 0).toISOString(),
    ate: new Date(a, m, 1, 0, 0, 0).toISOString(),
    // janela com 1 dia de folga para cada lado: o SQL pre-filtra por texto e o
    // JS decide o mes certo (as datas vem em dois formatos: UTC 'Z' do sistema
    // e hora local com fuso da SEFAZ, tipo 2026-09-30T22:30:00-03:00)
    deFolga: new Date(a, m - 1, 0, 0, 0, 0).toISOString(),
    ateFolga: new Date(a, m, 2, 0, 0, 0).toISOString(),
    dias: new Date(a, m, 0).getDate()
  };
}

/** Mes ('AAAA-MM') de uma data com hora, no fuso do computador da loja. */
function mesLocalDe(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return txt(iso).slice(0, 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dataLocalIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Compras com nota x cartao x NFC-e emitidas, num mes. */
function balancoFiscal(mes, cfg) {
  const lim = limitesDoMes(mes);
  const hojeLocal = dataLocalIso(new Date());
  const mesAtual = hojeLocal.slice(0, 7) === mes;

  const compras = one(
    `SELECT COUNT(*) AS qtd, COALESCE(SUM(valor_total), 0) AS total FROM entradas_nf
     WHERE substr(COALESCE(NULLIF(emissao, ''), data_entrada), 1, 7) = ?`, [mes]) || { qtd: 0, total: 0 };

  const porForma = {};
  all(`SELECT p.forma, p.valor, v.data
       FROM venda_pagamentos p JOIN vendas v ON v.id = p.venda_id
       WHERE v.situacao <> 'cancelada' AND v.data >= ? AND v.data < ?`, [lim.deFolga, lim.ateFolga])
    .filter((r) => mesLocalDe(r.data) === mes)
    .forEach((r) => { porForma[r.forma] = round2((porForma[r.forma] || 0) + num(r.valor)); });

  // crediario que o cliente pagou no cartao tambem passa pela operadora
  const crediarioNoCartao = round2(
    all(`SELECT valor_pago, pago_em FROM receber
         WHERE forma_pagto LIKE 'CARTAO%' AND pago_em >= ? AND pago_em < ?`, [lim.deFolga, lim.ateFolga])
      .filter((r) => mesLocalDe(r.pago_em) === mes)
      .reduce((t, r) => t + num(r.valor_pago), 0));

  const debito = porForma['CARTAO DEBITO'] || 0;
  const credito = porForma['CARTAO CREDITO'] || 0;
  const pix = porForma.PIX || 0;
  const cartao = round2(debito + credito + crediarioNoCartao);
  const incluirPix = txt(cfg.aviso_notas_incluir_pix) === '1';
  const baseMinimo = round2(cartao + (incluirPix ? pix : 0));

  const notas = { autorizadas_qtd: 0, autorizadas: 0, canceladas_qtd: 0, canceladas: 0 };
  all(`SELECT n.situacao, n.data_autorizacao, v.total
       FROM nfce n JOIN vendas v ON v.id = n.venda_id
       WHERE n.ambiente = 1 AND n.situacao IN ('autorizada', 'cancelada')
         AND n.data_autorizacao >= ? AND n.data_autorizacao < ?`, [lim.deFolga, lim.ateFolga])
    .filter((r) => mesLocalDe(r.data_autorizacao) === mes)
    .forEach((r) => {
      if (r.situacao === 'autorizada') { notas.autorizadas_qtd++; notas.autorizadas = round2(notas.autorizadas + num(r.total)); }
      else { notas.canceladas_qtd++; notas.canceladas = round2(notas.canceladas + num(r.total)); }
    });

  // vendas do mes que nao tem NFC-e autorizada em producao — o que ainda da para emitir
  const semNotaLista = all(
    `SELECT v.total, v.data,
            EXISTS (SELECT 1 FROM venda_pagamentos p WHERE p.venda_id = v.id AND p.forma LIKE 'CARTAO%') AS tem_cartao
     FROM vendas v
     WHERE v.situacao <> 'cancelada' AND v.data >= ? AND v.data < ?
       AND NOT EXISTS (SELECT 1 FROM nfce n WHERE n.venda_id = v.id AND n.ambiente = 1 AND n.situacao = 'autorizada')`,
    [lim.deFolga, lim.ateFolga]).filter((r) => mesLocalDe(r.data) === mes);
  const semNota = { qtd: semNotaLista.length, total: semNotaLista.reduce((t, r) => t + num(r.total), 0) };
  // [1.12] venda no cartao sem nota e a pior situacao: a operadora ja contou para a SEFAZ
  const cartaoSemNota = semNotaLista.filter((r) => r.tem_cartao);
  semNota.cartao_qtd = cartaoSemNota.length;
  semNota.cartao_total = round2(cartaoSemNota.reduce((t, r) => t + num(r.total), 0));

  const margem = Math.max(0, num(cfg.aviso_notas_margem));
  const minimo = round2(baseMinimo * (1 + margem / 100));
  const falta = round2(Math.max(0, minimo - notas.autorizadas));
  const diaHoje = Number(hojeLocal.slice(8, 10));
  const diasRestantes = mesAtual ? Math.max(1, lim.dias - diaHoje + 1) : 0;

  return {
    mes,
    nome_mes: pacote.nomeDoMes(mes),
    mes_atual: mesAtual,
    dias_no_mes: lim.dias,
    dias_restantes: diasRestantes,
    compras: { qtd: compras.qtd, total: round2(compras.total) },
    cartao: { debito, credito, crediario: crediarioNoCartao, total: cartao },
    pix,
    pix_conta: incluirPix,
    outras_formas: {
      dinheiro: porForma.DINHEIRO || 0, crediario: porForma.CREDIARIO || 0,
      cheque: porForma.CHEQUE || 0, transferencia: porForma.TRANSFERENCIA || 0
    },
    vendas_total: round2(Object.values(porForma).reduce((s, v) => s + v, 0)),
    notas,
    vendas_sem_nota: { qtd: semNota.qtd, total: round2(semNota.total) },
    margem,
    minimo,
    falta,
    media_dia: diasRestantes ? round2(falta / diasRestantes) : 0,
    ambiente_producao: ambienteAtual(cfg) === 1,
    nfce_ativa: txt(cfg.nfce_ativo) === '1'
  };
}

app.get('/api/fiscal/balanco', auth, (req, res) => {
  res.json(balancoFiscal(mesValido(req.query.mes), lerConfig()));
});

/** Data (local) do ultimo "dia do aviso" que ja chegou: identifica a semana. */
function chaveDaSemana(cfg) {
  const diaAviso = Math.min(7, Math.max(1, parseInt(cfg.aviso_notas_dia, 10) || 1));   // 1 = segunda ... 7 = domingo
  const h = new Date(); h.setHours(12, 0, 0, 0);
  const dow = h.getDay() === 0 ? 7 : h.getDay();
  h.setDate(h.getDate() - ((dow - diaAviso + 7) % 7));
  return dataLocalIso(h);
}

/** O pacote do mes anterior ja foi baixado? (marcado na config quando baixa) */
function pacotePendente(mes) {
  const anterior = mesAnterior(mes);
  const baixado = one('SELECT valor FROM config WHERE chave = ?', ['pacote_baixado:' + anterior]);
  if (baixado && txt(baixado.valor)) return null;
  const lim = limitesDoMes(anterior);
  const c = one(`SELECT COUNT(*) AS n FROM entradas_nf WHERE substr(COALESCE(NULLIF(emissao, ''), data_entrada), 1, 7) = ?`, [anterior]);
  const v = all(`SELECT data_autorizacao FROM nfce WHERE ambiente = 1 AND situacao IN ('autorizada', 'cancelada')
                 AND data_autorizacao >= ? AND data_autorizacao < ?`, [lim.deFolga, lim.ateFolga])
    .filter((r) => mesLocalDe(r.data_autorizacao) === anterior).length;
  const n = (c ? c.n : 0) + v;
  return n ? { mes: anterior, nome_mes: pacote.nomeDoMes(anterior), notas: n } : null;
}

/**
 * O que a tela pergunta ao abrir: "tem aviso para mostrar hoje?".
 * Mostra uma vez por semana, por usuario, a partir do dia configurado.
 */
app.get('/api/fiscal/aviso-semanal', auth, (req, res) => {
  const cfg = lerConfig();
  const mes = mesValido();
  const semana = chaveDaSemana(cfg);
  const visto = one('SELECT valor FROM config WHERE chave = ?', ['aviso_notas_visto:' + req.usuario.usuario.toLowerCase()]);
  const ativo = txt(cfg.aviso_notas_ativo) !== '0';
  const mostrar = ativo && (!visto || txt(visto.valor) !== semana);
  res.json({
    mostrar,
    ativo,
    semana,
    balanco: balancoFiscal(mes, cfg),
    pacote_pendente: Number(dataLocalIso(new Date()).slice(8, 10)) <= 15 ? pacotePendente(mes) : null
  });
});

app.post('/api/fiscal/aviso-semanal/visto', auth, (req, res) => {
  const cfg = lerConfig();
  run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)',
    ['aviso_notas_visto:' + req.usuario.usuario.toLowerCase(), chaveDaSemana(cfg)]);
  salvarBanco();
  res.json({ ok: true });
});

/** Le tudo que entra no pacote de um mes. */
function dadosDoPacote(mes, cfg, comXml) {
  const lim = limitesDoMes(mes);
  const colunasCompra = `id, chave, numero, serie, fornecedor, cnpj, emissao, valor_total, valor_produtos,
                         valor_desconto, itens_qtd, data_entrada, usuario` + (comXml ? ', xml' : ", CASE WHEN xml IS NULL OR xml = '' THEN 0 ELSE 1 END AS tem_xml");
  const compras = all(
    `SELECT ${colunasCompra} FROM entradas_nf
     WHERE substr(COALESCE(NULLIF(emissao, ''), data_entrada), 1, 7) = ? ORDER BY emissao, id`, [mes]);
  if (comXml) compras.forEach((c) => { c.tem_xml = txt(c.xml) ? 1 : 0; });

  const vendas = all(
    `SELECT n.id, n.chave, n.numero, n.serie, n.situacao, n.protocolo, n.data_autorizacao,
            n.cancelamento_em, n.cancelamento_motivo, v.numero AS venda_numero, v.total AS valor,
            v.cliente_nome, v.cliente_doc
            ${comXml ? ', n.xml_autorizado AS xml, n.xml_cancelamento' : ", CASE WHEN n.xml_autorizado IS NULL OR n.xml_autorizado = '' THEN 0 ELSE 1 END AS tem_xml"}
     FROM nfce n JOIN vendas v ON v.id = n.venda_id
     WHERE n.ambiente = 1 AND n.situacao IN ('autorizada', 'cancelada')
       AND n.data_autorizacao >= ? AND n.data_autorizacao < ?
     ORDER BY n.serie, n.numero`, [lim.deFolga, lim.ateFolga])
    .filter((v) => mesLocalDe(v.data_autorizacao) === mes);
  vendas.forEach((v) => {
    v.cliente = [v.cliente_nome, somenteDigitos(v.cliente_doc)].filter(Boolean).join(' - ');
    if (comXml) v.tem_xml = txt(v.xml) ? 1 : 0;
  });

  return {
    mes,
    nome_mes: pacote.nomeDoMes(mes),
    versao: VERSAO.split(' ')[0],
    gerado_em: new Date().toLocaleString('pt-BR'),
    loja: { nome: txt(cfg.loja_nome), cnpj: txt(cfg.loja_cnpj), ie: txt(cfg.loja_ie) },
    compras,
    vendas
  };
}

/** Previa: o que vai no pacote, para a tela mostrar antes de baixar. */
app.get('/api/contabilidade/pacote/previa', auth, (req, res) => {
  const mes = mesValido(req.query.mes);
  const d = dadosDoPacote(mes, lerConfig(), false);
  const autorizadas = d.vendas.filter((v) => v.situacao === 'autorizada');
  const canceladas = d.vendas.filter((v) => v.situacao === 'cancelada');
  const baixado = one('SELECT valor FROM config WHERE chave = ?', ['pacote_baixado:' + mes]);
  res.json({
    mes, nome_mes: d.nome_mes,
    compras: { qtd: d.compras.length, total: round2(d.compras.reduce((s, c) => s + num(c.valor_total), 0)),
               com_xml: d.compras.filter((c) => c.tem_xml).length,
               sem_xml: d.compras.filter((c) => !c.tem_xml).map((c) => ({ numero: c.numero, fornecedor: c.fornecedor, chave: c.chave, valor: round2(c.valor_total) })) },
    vendas: { autorizadas_qtd: autorizadas.length, autorizadas: round2(autorizadas.reduce((s, v) => s + num(v.valor), 0)),
              canceladas_qtd: canceladas.length, canceladas: round2(canceladas.reduce((s, v) => s + num(v.valor), 0)),
              sem_xml: d.vendas.filter((v) => !v.tem_xml).length },
    baixado_em: baixado ? txt(baixado.valor) : ''
  });
});

/** O ZIP em si. */
app.get('/api/contabilidade/pacote', auth, (req, res) => {
  const mes = mesValido(req.query.mes);
  const cfg = lerConfig();
  const d = dadosDoPacote(mes, cfg, true);
  if (!d.compras.length && !d.vendas.length) {
    return res.status(404).json({ erro: `Nao ha nota de compra nem de venda em ${d.nome_mes}.` });
  }
  let r;
  try { r = pacote.montarPacote(d); }
  catch (e) { return res.status(500).json({ erro: 'Nao consegui montar o pacote: ' + e.message }); }

  run('INSERT OR REPLACE INTO config (chave, valor) VALUES (?,?)', ['pacote_baixado:' + mes, agora()]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'contabilidade',
    `pacote ${mes}: ${d.compras.length} compra(s), ${d.vendas.length} NFC-e`);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${r.nome}"`);
  res.send(r.zip);
});

/* =========================================================================
   IMPORTACAO DE PLANILHA (produtos, clientes e fornecedores)
   ========================================================================= */

/** Aceita o cabecalho escrito de varios jeitos: "Razao Social", "razao_social", "NOME"... */
function normalizar(s) {
  return txt(s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const MAPA_IMPORT = {
  produtos: {
    titulo: 'Produtos',
    campos: [
      { chave: 'codigo', nomes: ['codigo', 'cod', 'codigointerno', 'referencia', 'ref'], rotulo: 'Código' },
      { chave: 'codigo_barras', nomes: ['codigobarras', 'barras', 'ean', 'gtin', 'codigodebarras', 'codbarras'], rotulo: 'Código de barras' },
      { chave: 'descricao', nomes: ['descricao', 'produto', 'nome', 'item', 'mercadoria'], rotulo: 'Descrição', obrigatorio: true },
      { chave: 'categoria', nomes: ['categoria', 'grupo', 'secao', 'departamento'], rotulo: 'Categoria' },
      { chave: 'unidade', nomes: ['unidade', 'un', 'und', 'unid', 'medida'], rotulo: 'Unidade' },
      { chave: 'ncm', nomes: ['ncm', 'ncmsh'], rotulo: 'NCM' },
      { chave: 'preco_custo', nomes: ['precocusto', 'custo', 'valorcusto', 'precodecusto', 'valordecusto'], rotulo: 'Preço de custo' },
      { chave: 'preco_venda', nomes: ['precovenda', 'venda', 'preco', 'valorvenda', 'precodevenda', 'valordevenda'], rotulo: 'Preço de venda' },
      { chave: 'estoque', nomes: ['estoque', 'saldo', 'quantidade', 'qtd', 'estoqueatual'], rotulo: 'Estoque' },
      { chave: 'estoque_minimo', nomes: ['estoqueminimo', 'estoqueminimo', 'minimo', 'estminimo', 'estoquemin'], rotulo: 'Estoque mínimo' },
      { chave: 'localizacao', nomes: ['localizacao', 'local', 'prateleira', 'endereco'], rotulo: 'Localização' },
      { chave: 'fornecedor', nomes: ['fornecedor'], rotulo: 'Fornecedor' },
      { chave: 'marca', nomes: ['marca', 'modelo', 'marcamodelo', 'linha', 'fabricante'], rotulo: 'Marca / modelo' }
    ]
  },
  clientes: {
    titulo: 'Clientes',
    campos: [
      { chave: 'nome', nomes: ['nome', 'cliente', 'razaosocial', 'nomecliente'], rotulo: 'Nome', obrigatorio: true },
      { chave: 'cpf_cnpj', nomes: ['cpfcnpj', 'cnpj', 'cpf', 'documento', 'cnpjcpf'], rotulo: 'CPF/CNPJ' },
      { chave: 'rg_ie', nomes: ['rgie', 'ie', 'rg', 'inscricaoestadual'], rotulo: 'RG / IE' },
      { chave: 'telefone', nomes: ['telefone', 'fone', 'celular', 'whatsapp', 'contato'], rotulo: 'Telefone' },
      { chave: 'email', nomes: ['email', 'mail'], rotulo: 'E-mail' },
      { chave: 'cep', nomes: ['cep'], rotulo: 'CEP' },
      { chave: 'logradouro', nomes: ['logradouro', 'endereco', 'rua'], rotulo: 'Endereço' },
      { chave: 'numero', nomes: ['numero', 'nro', 'num'], rotulo: 'Número' },
      { chave: 'bairro', nomes: ['bairro', 'distrito'], rotulo: 'Bairro' },
      { chave: 'cidade', nomes: ['cidade', 'municipio'], rotulo: 'Cidade' },
      { chave: 'uf', nomes: ['uf', 'estado'], rotulo: 'UF' },
      { chave: 'limite_credito', nomes: ['limitecredito', 'limitedecredito', 'limite', 'credito'], rotulo: 'Limite de crédito' },
      { chave: 'observacao', nomes: ['observacao', 'obs', 'anotacao'], rotulo: 'Observação' }
    ]
  },
  fornecedores: {
    titulo: 'Fornecedores',
    campos: [
      { chave: 'nome', nomes: ['nome', 'fornecedor', 'razaosocial', 'empresa'], rotulo: 'Nome', obrigatorio: true },
      { chave: 'cnpj', nomes: ['cnpj', 'cpfcnpj', 'documento'], rotulo: 'CNPJ' },
      { chave: 'telefone', nomes: ['telefone', 'fone', 'celular', 'whatsapp'], rotulo: 'Telefone' },
      { chave: 'email', nomes: ['email', 'mail'], rotulo: 'E-mail' },
      { chave: 'contato', nomes: ['contato', 'vendedor', 'representante'], rotulo: 'Contato' },
      { chave: 'cidade', nomes: ['cidade', 'municipio'], rotulo: 'Cidade' },
      { chave: 'uf', nomes: ['uf', 'estado'], rotulo: 'UF' },
      { chave: 'observacao', nomes: ['observacao', 'obs'], rotulo: 'Observação' }
    ]
  }
};

/** Le CSV ou XLSX e devolve uma matriz de linhas ja com as colunas identificadas. */
function lerPlanilha(base64, nomeArquivo, tipo) {
  const buf = Buffer.from(base64, 'base64');
  let linhas;

  if (/\.csv$|\.txt$/i.test(nomeArquivo)) {
    let texto = buf.toString('utf8');
    if (texto.includes('�')) texto = buf.toString('latin1');  // planilha salva em ANSI
    const sep = (texto.split('\n')[0].match(/;/g) || []).length >=
                (texto.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    linhas = texto.split(/\r?\n/).filter((l) => l.trim())
      .map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, '').trim()));
  } else {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const aba = wb.Sheets[wb.SheetNames[0]];
    linhas = XLSX.utils.sheet_to_json(aba, { header: 1, raw: false, defval: '' })
      .filter((l) => l.some((c) => txt(c)));
  }

  if (linhas.length < 2) throw new Error('A planilha precisa ter o cabecalho e pelo menos uma linha.');

  const cabecalho = linhas[0].map(normalizar);
  const campos = MAPA_IMPORT[tipo].campos;
  const colunas = {};
  const naoUsadas = [];

  cabecalho.forEach((c, i) => {
    const campo = campos.find((f) => f.nomes.includes(c));
    if (campo && colunas[campo.chave] === undefined) colunas[campo.chave] = i;
    else if (c) naoUsadas.push(linhas[0][i]);
  });

  const registros = linhas.slice(1).map((l) => {
    const r = {};
    Object.entries(colunas).forEach(([chave, i]) => { r[chave] = txt(l[i]); });
    return r;
  }).filter((r) => Object.values(r).some((v) => v));

  return { colunas, registros, naoUsadas, cabecalhoOriginal: linhas[0] };
}

/** Aceita "1.234,56", "1234.56" e "R$ 89,90". */
function valorPlanilha(v) {
  const s = txt(v).replace(/[R$\s]/gi, '');
  if (!s) return 0;
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return isNaN(n) ? 0 : n;
}

app.post('/api/importar/:tipo/analisar', auth, (req, res) => {
  const tipo = req.params.tipo;
  if (!MAPA_IMPORT[tipo]) return res.status(400).json({ erro: 'Tipo de importacao invalido.' });
  if (!pode(req, tipo === 'produtos' ? 'produtos' : tipo)) {
    return res.status(403).json({ erro: 'Seu perfil nao pode importar isso.' });
  }

  let lido;
  try { lido = lerPlanilha(txt(req.body.arquivo), txt(req.body.nome), tipo); }
  catch (e) { return res.status(400).json({ erro: e.message }); }

  const campos = MAPA_IMPORT[tipo].campos;
  const faltando = campos.filter((c) => c.obrigatorio && lido.colunas[c.chave] === undefined);
  if (faltando.length) {
    return res.status(400).json({
      erro: `A planilha precisa ter a coluna "${faltando.map((f) => f.rotulo).join('", "')}". ` +
            `Colunas encontradas: ${lido.cabecalhoOriginal.filter(Boolean).join(', ')}` });
  }

  // marca o que ja existe, para o usuario ver antes de confirmar
  lido.registros.forEach((r, i) => {
    r._linha = i + 2;
    let existente = null;
    if (tipo === 'produtos') {
      if (r.codigo_barras) existente = one('SELECT id, descricao FROM produtos WHERE codigo_barras = ?', [somenteDigitos(r.codigo_barras)]);
      if (!existente && r.codigo) existente = one('SELECT id, descricao FROM produtos WHERE upper(codigo) = ?', [r.codigo.toUpperCase()]);
      if (!existente && r.descricao) existente = one('SELECT id, descricao FROM produtos WHERE upper(descricao) = ?', [r.descricao.toUpperCase()]);
    } else if (tipo === 'clientes') {
      if (r.cpf_cnpj) existente = one('SELECT id, nome FROM clientes WHERE cpf_cnpj = ?', [somenteDigitos(r.cpf_cnpj)]);
      if (!existente && r.nome) existente = one('SELECT id, nome FROM clientes WHERE upper(nome) = ?', [r.nome.toUpperCase()]);
    } else {
      if (r.cnpj) existente = one('SELECT id, nome FROM fornecedores WHERE cnpj = ?', [somenteDigitos(r.cnpj)]);
      if (!existente && r.nome) existente = one('SELECT id, nome FROM fornecedores WHERE upper(nome) = ?', [r.nome.toUpperCase()]);
    }
    r._existente_id = existente ? existente.id : null;
    r._acao = existente ? 'atualizar' : 'novo';
    r._erro = '';
    const obrig = campos.find((c) => c.obrigatorio);
    if (obrig && !txt(r[obrig.chave])) r._erro = `sem ${obrig.rotulo.toLowerCase()}`;
  });

  res.json({
    tipo,
    colunas_lidas: Object.keys(lido.colunas),
    colunas_ignoradas: lido.naoUsadas,
    registros: lido.registros.slice(0, 500),
    total: lido.registros.length,
    resumo: {
      novos: lido.registros.filter((r) => r._acao === 'novo' && !r._erro).length,
      atualizar: lido.registros.filter((r) => r._acao === 'atualizar' && !r._erro).length,
      erros: lido.registros.filter((r) => r._erro).length
    }
  });
});

app.post('/api/importar/:tipo/confirmar', auth, (req, res) => {
  const tipo = req.params.tipo;
  if (!MAPA_IMPORT[tipo]) return res.status(400).json({ erro: 'Tipo de importacao invalido.' });
  if (!pode(req, tipo === 'produtos' ? 'produtos' : tipo)) {
    return res.status(403).json({ erro: 'Seu perfil nao pode importar isso.' });
  }

  let lido;
  try { lido = lerPlanilha(txt(req.body.arquivo), txt(req.body.nome), tipo); }
  catch (e) { return res.status(400).json({ erro: e.message }); }

  const soNovos = !!req.body.somente_novos;
  let criados = 0;
  let atualizados = 0;
  let pulados = 0;
  const problemas = [];

  lido.registros.forEach((r, idx) => {
    const linha = idx + 2;
    try {
      if (tipo === 'produtos') {
        if (!txt(r.descricao)) { pulados++; return; }
        const barras = somenteDigitos(r.codigo_barras);
        let p = null;
        if (barras) p = one('SELECT * FROM produtos WHERE codigo_barras = ?', [barras]);
        if (!p && txt(r.codigo)) p = one('SELECT * FROM produtos WHERE upper(codigo) = ?', [r.codigo.toUpperCase()]);
        if (!p) p = one('SELECT * FROM produtos WHERE upper(descricao) = ?', [r.descricao.toUpperCase()]);
        if (p && soNovos) { pulados++; return; }

        let categoriaId = null;
        if (txt(r.categoria)) {
          const nomeCat = r.categoria.toUpperCase();
          const c = one('SELECT id FROM categorias WHERE nome = ?', [nomeCat]);
          categoriaId = c ? c.id : inserir('INSERT INTO categorias (nome, ativo) VALUES (?,1)', [nomeCat], false);
        }
        const unidade = txt(r.unidade).toUpperCase() || 'UN';
        const custo = valorPlanilha(r.preco_custo);
        const venda = valorPlanilha(r.preco_venda);
        // [1.12] NCM so entra se existir na tabela; errado vira aviso e fica como estava
        let ncmPlanilha = somenteDigitos(r.ncm);
        if (ncmPlanilha && !ncm.valido(ncmPlanilha)) {
          problemas.push(`Linha ${linha}: NCM ${ncmPlanilha} nao existe na tabela (ignorado)`);
          ncmPlanilha = '';
        }

        if (p) {
          run(`UPDATE produtos SET descricao=?, codigo_barras=?, categoria_id=COALESCE(?, categoria_id),
               unidade=?, ncm=?, preco_custo=?, preco_venda=?, estoque_minimo=?,
               localizacao=?, fornecedor=?, marca=?, atualizado_em=? WHERE id=?`,
            [r.descricao.toUpperCase(), barras || p.codigo_barras, categoriaId, unidade,
             ncmPlanilha || p.ncm, custo || num(p.preco_custo), venda || num(p.preco_venda),
             valorPlanilha(r.estoque_minimo) || num(p.estoque_minimo),
             txt(r.localizacao) || p.localizacao, txt(r.fornecedor) || p.fornecedor,
             txt(r.marca).toUpperCase() || p.marca || '',
             agora(), p.id]);
          const saldo = valorPlanilha(r.estoque);
          if (txt(r.estoque) !== '' && saldo !== num(p.estoque)) {
            lancarEstoque(p.id, 'ajuste', saldo, custo, 'IMPORTACAO',
              'Saldo vindo da planilha', req.usuario.usuario, false);
          }
          atualizados++;
        } else {
          const novoId = inserir(
            `INSERT INTO produtos (codigo, codigo_barras, descricao, categoria_id, unidade, ncm,
               preco_custo, preco_venda, estoque, estoque_minimo, fracionado, localizacao,
               fornecedor, marca, ativo, criado_em)
             VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,1,?)`,
            [txt(r.codigo) || proximoCodigoProduto(), barras, r.descricao.toUpperCase(),
             categoriaId, unidade, ncmPlanilha, custo, venda,
             valorPlanilha(r.estoque_minimo),
             ['M3', 'M2', 'KG', 'M', 'LT'].includes(unidade) ? 1 : 0,
             txt(r.localizacao), txt(r.fornecedor), txt(r.marca).toUpperCase(), agora()], false);
          const saldo = valorPlanilha(r.estoque);
          if (saldo > 0) {
            lancarEstoque(novoId, 'entrada', saldo, custo, 'IMPORTACAO',
              'Estoque inicial da planilha', req.usuario.usuario, false);
          }
          criados++;
        }

      } else if (tipo === 'clientes') {
        if (!txt(r.nome)) { pulados++; return; }
        const doc = somenteDigitos(r.cpf_cnpj);
        let c = doc ? one('SELECT * FROM clientes WHERE cpf_cnpj = ?', [doc]) : null;
        if (!c) c = one('SELECT * FROM clientes WHERE upper(nome) = ?', [r.nome.toUpperCase()]);
        if (c && soNovos) { pulados++; return; }

        const dados = [
          r.nome.toUpperCase(), doc.length === 14 ? 'J' : 'F', doc, txt(r.rg_ie),
          txt(r.telefone), txt(r.email), somenteDigitos(r.cep), txt(r.logradouro),
          txt(r.numero), txt(r.bairro), txt(r.cidade), txt(r.uf).toUpperCase().slice(0, 2),
          valorPlanilha(r.limite_credito), txt(r.observacao)
        ];
        if (c) {
          run(`UPDATE clientes SET nome=?, tipo=?, cpf_cnpj=?, rg_ie=?, telefone=?, email=?,
               cep=?, logradouro=?, numero=?, bairro=?, cidade=?, uf=?, limite_credito=?,
               observacao=? WHERE id=?`, [...dados, c.id]);
          atualizados++;
        } else {
          inserir(`INSERT INTO clientes (nome, tipo, cpf_cnpj, rg_ie, telefone, email, cep,
                     logradouro, numero, bairro, cidade, uf, limite_credito, observacao,
                     status, criado_em)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ativo', ?)`,
            [...dados, agora()], false);
          criados++;
        }

      } else {
        if (!txt(r.nome)) { pulados++; return; }
        const cnpj = somenteDigitos(r.cnpj);
        let f = cnpj ? one('SELECT * FROM fornecedores WHERE cnpj = ?', [cnpj]) : null;
        if (!f) f = one('SELECT * FROM fornecedores WHERE upper(nome) = ?', [r.nome.toUpperCase()]);
        if (f && soNovos) { pulados++; return; }

        const dados = [r.nome.toUpperCase(), cnpj, txt(r.telefone), txt(r.email),
          txt(r.contato), txt(r.cidade), txt(r.uf).toUpperCase().slice(0, 2), txt(r.observacao)];
        if (f) {
          run(`UPDATE fornecedores SET nome=?, cnpj=?, telefone=?, email=?, contato=?,
               cidade=?, uf=?, observacao=? WHERE id=?`, [...dados, f.id]);
          atualizados++;
        } else {
          inserir(`INSERT INTO fornecedores (nome, cnpj, telefone, email, contato, cidade, uf,
                     observacao, status, criado_em) VALUES (?,?,?,?,?,?,?,?, 'ativo', ?)`,
            [...dados, agora()], false);
          criados++;
        }
      }
    } catch (e) {
      problemas.push(`Linha ${linha}: ${e.message}`);
    }
  });

  salvarBanco();
  registrarLog(req.usuario.usuario, 'importar-' + tipo,
    `${criados} novo(s), ${atualizados} atualizado(s), ${pulados} pulado(s)`);
  res.json({ ok: true, criados, atualizados, pulados, problemas: problemas.slice(0, 20) });
});

/** Modelo de planilha para o usuario preencher. */
app.get('/api/importar/:tipo/modelo', auth, (req, res) => {
  const tipo = req.params.tipo;
  if (!MAPA_IMPORT[tipo]) return res.status(400).send('Tipo invalido.');

  const campos = MAPA_IMPORT[tipo].campos;
  const exemplos = {
    produtos: ['0001', '7891000000011', 'CIMENTO CP II 50KG', 'CIMENTO E ARGAMASSA', 'SC',
      '25232910', '28,90', '38,50', '320', '50', 'Corredor 1', 'VOTORANTIM', 'VOTORAN CP-II'],
    clientes: ['JOSE DA SILVA', '123.456.789-00', '', '(75) 98888-1234', 'jose@email.com',
      '45490-000', 'Rua Principal', '100', 'Centro', 'Laje', 'BA', '1000', ''],
    fornecedores: ['DHT TINTAS E COMPLEMENTOS LTDA', '42.460.701/0001-53', '(71) 99999-8858',
      'contato@dht.com.br', 'Carlos', 'Feira de Santana', 'BA', '']
  };

  const linhas = [
    campos.map((c) => c.rotulo).join(';'),
    (exemplos[tipo] || []).join(';')
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="modelo-${tipo}.csv"`);
  res.send('﻿' + linhas);   // BOM para o Excel abrir com acento certo
});

/* =========================================================================
   ORCAMENTOS
   Proposta de preco para o cliente. NAO mexe em estoque, NAO gera titulo
   e NAO tem valor fiscal — so vira movimento quando fecha em venda.
   ========================================================================= */

function proximoNumeroOrcamento() {
  const r = one('SELECT MAX(numero) AS m FROM orcamentos');
  return (r && r.m ? r.m : 0) + 1;
}

function situacaoOrcamento(o) {
  if (o.situacao === 'fechado' || o.situacao === 'cancelado') return o.situacao;
  if (o.validade && o.validade < hoje()) return 'expirado';
  return 'aberto';
}

function orcamentoCompleto(id) {
  const o = one('SELECT * FROM orcamentos WHERE id = ?', [id]);
  if (!o) return null;
  o.itens = all('SELECT * FROM orcamento_itens WHERE orcamento_id = ? ORDER BY id', [id]);
  o.status = situacaoOrcamento(o);
  o.dias_restantes = o.validade
    ? Math.round((new Date(o.validade) - new Date(hoje())) / 86400000) : null;

  // o preco pode ter mudado desde que o orcamento foi feito
  o.itens.forEach((i) => {
    const p = one('SELECT preco_venda, estoque FROM produtos WHERE id = ?', [i.produto_id]);
    i.preco_atual = p ? round2(p.preco_venda) : null;
    i.estoque_atual = p ? num(p.estoque) : null;
    i.preco_mudou = p ? Math.abs(num(p.preco_venda) - num(i.preco_unit)) > 0.009 : false;
  });
  return o;
}

app.get('/api/orcamentos', auth, exigir('orcamentos'), (req, res) => {
  const filtros = [];
  const params = [];
  if (req.query.de) { filtros.push('data >= ?'); params.push(req.query.de); }
  if (req.query.ate) { filtros.push('data <= ?'); params.push(req.query.ate + 'T23:59:59'); }
  if (req.query.cliente_id) { filtros.push('cliente_id = ?'); params.push(req.query.cliente_id); }
  if (txt(req.query.q)) {
    const q = '%' + txt(req.query.q).toUpperCase() + '%';
    filtros.push('(upper(cliente_nome) LIKE ? OR CAST(numero AS TEXT) LIKE ?)');
    params.push(q, '%' + txt(req.query.q) + '%');
  }
  const where = filtros.length ? 'WHERE ' + filtros.join(' AND ') : '';
  let lista = all(`SELECT * FROM orcamentos ${where} ORDER BY id DESC LIMIT 1000`, params);

  lista.forEach((o) => {
    o.status = situacaoOrcamento(o);
    o.dias_restantes = o.validade
      ? Math.round((new Date(o.validade) - new Date(hoje())) / 86400000) : null;
    const it = one('SELECT COUNT(*) AS n FROM orcamento_itens WHERE orcamento_id = ?', [o.id]);
    o.itens_qtd = it ? it.n : 0;
  });

  const st = txt(req.query.situacao);
  if (st && st !== 'todas') lista = lista.filter((o) => o.status === st);

  const abertos = lista.filter((o) => o.status === 'aberto');
  const fechados = lista.filter((o) => o.status === 'fechado');
  res.json({
    orcamentos: lista,
    totais: {
      abertos: abertos.length,
      valor_aberto: round2(abertos.reduce((s, o) => s + num(o.total), 0)),
      fechados: fechados.length,
      valor_fechado: round2(fechados.reduce((s, o) => s + num(o.total), 0)),
      expirados: lista.filter((o) => o.status === 'expirado').length,
      // quantos viraram venda, em porcentagem
      conversao: (abertos.length + fechados.length)
        ? round2((fechados.length / (abertos.length + fechados.length)) * 100) : 0
    }
  });
});

app.get('/api/orcamentos/:id', auth, exigir('orcamentos'), (req, res) => {
  const o = orcamentoCompleto(req.params.id);
  if (!o) return res.status(404).json({ erro: 'Orcamento nao encontrado.' });
  res.json(o);
});

app.post('/api/orcamentos', auth, exigir('orcamentos'), (req, res) => {
  const b = req.body;
  const itens = Array.isArray(b.itens) ? b.itens : [];
  if (!itens.length) return res.status(400).json({ erro: 'O orcamento precisa de pelo menos um item.' });

  const preparados = [];
  for (const it of itens) {
    const p = one('SELECT * FROM produtos WHERE id = ?', [it.produto_id]);
    if (!p) return res.status(400).json({ erro: `Produto #${it.produto_id} nao existe mais.` });
    const qtd = round2(it.quantidade);
    if (qtd <= 0) return res.status(400).json({ erro: `Quantidade invalida em ${p.descricao}.` });

    const unit = round2(it.preco_unit !== undefined ? it.preco_unit : p.preco_venda);
    const desc = round2(it.desconto);
    const total = round2(qtd * unit - desc);
    if (total < 0) return res.status(400).json({ erro: `Desconto maior que o item em ${p.descricao}.` });
    preparados.push({ produto: p, quantidade: qtd, preco_unit: unit, desconto: desc, total });
  }

  const subtotal = round2(preparados.reduce((s, i) => s + i.total, 0));
  const descontoGeral = round2(b.desconto);
  const acrescimo = round2(b.acrescimo);
  const total = round2(subtotal - descontoGeral + acrescimo);
  if (total < 0) return res.status(400).json({ erro: 'O desconto deixou o total negativo.' });

  let cliente = null;
  if (b.cliente_id) cliente = one('SELECT * FROM clientes WHERE id = ?', [b.cliente_id]);

  const dias = Math.max(1, Math.min(365, parseInt(b.validade_dias) || 15));
  const dataBase = txt(b.data).slice(0, 10) || hoje();
  // validade conta DIAS CORRIDOS: "vale por 30 dias" nao e "vale ate o mes que vem"
  const validade = somarDiasCorridos(dataBase, dias);

  const dados = [
    b.cliente_id || null,
    cliente ? cliente.nome : txt(b.cliente_nome).toUpperCase() || 'CONSUMIDOR',
    cliente ? cliente.cpf_cnpj : somenteDigitos(b.cliente_doc),
    cliente ? cliente.telefone : txt(b.cliente_telefone),
    txt(b.vendedor) || req.usuario.nome,
    txt(b.condicao_pagamento), txt(b.prazo_entrega),
    subtotal, descontoGeral, acrescimo, total,
    txt(b.observacao), dias, validade
  ];

  let orcamentoId;
  if (b.id) {
    const atual = one('SELECT * FROM orcamentos WHERE id = ?', [b.id]);
    if (!atual) return res.status(404).json({ erro: 'Orcamento nao encontrado.' });
    if (atual.situacao === 'fechado') {
      return res.status(400).json({ erro: 'Esse orcamento ja virou venda e nao pode mais ser alterado.' });
    }
    if (atual.situacao === 'cancelado') {
      return res.status(400).json({ erro: 'Esse orcamento esta cancelado.' });
    }
    run(`UPDATE orcamentos SET cliente_id=?, cliente_nome=?, cliente_doc=?, cliente_telefone=?,
         vendedor=?, condicao_pagamento=?, prazo_entrega=?, subtotal=?, desconto=?, acrescimo=?,
         total=?, observacao=?, validade_dias=?, validade=?, atualizado_em=? WHERE id=?`,
      [...dados, agora(), b.id]);
    run('DELETE FROM orcamento_itens WHERE orcamento_id = ?', [b.id]);
    orcamentoId = b.id;
  } else {
    const numero = proximoNumeroOrcamento();
    orcamentoId = inserir(
      `INSERT INTO orcamentos (numero, data, cliente_id, cliente_nome, cliente_doc, cliente_telefone,
         vendedor, condicao_pagamento, prazo_entrega, subtotal, desconto, acrescimo, total,
         observacao, validade_dias, validade, situacao, usuario, criado_em)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'aberto', ?, ?)`,
      [numero, dataBase + 'T' + agora().slice(11), ...dados, req.usuario.usuario, agora()], false);
  }

  preparados.forEach((i) => {
    run(`INSERT INTO orcamento_itens (orcamento_id, produto_id, codigo, descricao, unidade,
           quantidade, preco_unit, desconto, total) VALUES (?,?,?,?,?,?,?,?,?)`,
      [orcamentoId, i.produto.id, i.produto.codigo, i.produto.descricao, i.produto.unidade,
       i.quantidade, i.preco_unit, i.desconto, i.total]);
  });

  salvarBanco();
  const o = one('SELECT numero FROM orcamentos WHERE id = ?', [orcamentoId]);
  registrarLog(req.usuario.usuario, b.id ? 'orcamento-editar' : 'orcamento-novo',
    `nº ${o ? o.numero : orcamentoId} - R$ ${total.toFixed(2)}`);
  res.json({ ok: true, id: orcamentoId, numero: o ? o.numero : null, total });
});

app.post('/api/orcamentos/:id/cancelar', auth, exigir('orcamentos'), (req, res) => {
  const o = one('SELECT * FROM orcamentos WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ erro: 'Orcamento nao encontrado.' });
  if (o.situacao === 'fechado') {
    return res.status(400).json({ erro: 'Esse orcamento ja virou venda. Cancele a venda, se for o caso.' });
  }
  const motivo = txt(req.body.motivo);
  if (motivo.length < 3) return res.status(400).json({ erro: 'Diga o motivo do cancelamento.' });

  run(`UPDATE orcamentos SET situacao='cancelado', cancelado_motivo=?, cancelado_em=? WHERE id=?`,
    [motivo, agora(), o.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'orcamento-cancelar', `nº ${o.numero} - ${motivo}`);
  res.json({ ok: true });
});

app.post('/api/orcamentos/:id/reabrir', auth, exigir('orcamentos'), (req, res) => {
  const o = one('SELECT * FROM orcamentos WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ erro: 'Orcamento nao encontrado.' });
  if (o.situacao === 'fechado') return res.status(400).json({ erro: 'Orcamento ja virou venda.' });

  const dias = Math.max(1, Math.min(365, parseInt(req.body.validade_dias) || o.validade_dias || 15));
  run(`UPDATE orcamentos SET situacao='aberto', cancelado_motivo=NULL, cancelado_em=NULL,
       validade_dias=?, validade=?, atualizado_em=? WHERE id=?`,
    [dias, somarDiasCorridos(hoje(), dias), agora(), o.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'orcamento-reabrir', `nº ${o.numero} por mais ${dias} dias`);
  res.json({ ok: true, validade: somarDiasCorridos(hoje(), dias) });
});

app.delete('/api/orcamentos/:id', auth, exigir('orcamentos'), (req, res) => {
  const o = one('SELECT * FROM orcamentos WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ erro: 'Orcamento nao encontrado.' });
  if (o.situacao === 'fechado') {
    return res.status(400).json({ erro: 'Orcamento que virou venda nao pode ser excluido.' });
  }
  if (!pode(req, 'excluir')) {
    return res.status(403).json({ erro: 'Seu perfil nao pode excluir. Use o cancelamento.' });
  }
  run('DELETE FROM orcamento_itens WHERE orcamento_id = ?', [o.id]);
  run('DELETE FROM orcamentos WHERE id = ?', [o.id]);
  salvarBanco();
  registrarLog(req.usuario.usuario, 'orcamento-excluir', 'nº ' + o.numero);
  res.json({ ok: true });
});

/* ---------- impressao da proposta, em folha A4 ---------- */
app.get('/api/orcamentos/:id/impressao', auth, exigir('orcamentos'), (req, res) => {
  const o = orcamentoCompleto(req.params.id);
  if (!o) return res.status(404).send('Orcamento nao encontrado.');
  const cfg = lerConfig();

  const enderecoLoja = [cfg.loja_endereco, cfg.loja_bairro,
    txt(cfg.loja_cidade) ? [cfg.loja_cidade, cfg.loja_uf].filter(Boolean).join('/') : '']
    .map(txt).filter(Boolean).join(' - ');

  const html = `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Orcamento ${o.numero}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; margin: 0; }
  .cab { display: flex; gap: 14px; border: 2px solid #111; padding: 10px; align-items: center; }
  .cab .loja { flex: 1; }
  .cab .loja h1 { font-size: 17px; margin: 0 0 3px; }
  .cab .loja div { font-size: 11px; line-height: 1.45; }
  .cab .doc { text-align: center; border-left: 2px solid #111; padding-left: 14px; min-width: 170px; }
  .cab .doc .t { font-size: 15px; font-weight: bold; letter-spacing: .5px; }
  .cab .doc .n { font-size: 26px; font-weight: bold; line-height: 1.1; }
  .cab .doc .d { font-size: 11px; }
  .bloco { border: 1px solid #111; border-top: 0; padding: 7px 10px; }
  .bloco .tit { font-size: 10px; text-transform: uppercase; letter-spacing: .6px; color: #555; }
  .linhas { display: flex; gap: 18px; flex-wrap: wrap; }
  .linhas > div { font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th { background: #eee; border: 1px solid #111; padding: 5px; font-size: 10.5px;
       text-transform: uppercase; text-align: left; }
  td { border: 1px solid #999; padding: 5px; font-size: 11.5px; }
  .num { text-align: right; white-space: nowrap; }
  .centro { text-align: center; }
  .totais { margin-top: 10px; margin-left: auto; width: 300px; border: 1px solid #111; }
  .totais div { display: flex; justify-content: space-between; padding: 5px 9px; font-size: 12.5px; }
  .totais .grande { border-top: 2px solid #111; font-size: 17px; font-weight: bold; background: #eee; }
  .validade { border: 2px solid #111; padding: 8px; margin-top: 12px; text-align: center;
              font-size: 13px; font-weight: bold; }
  .aviso { margin-top: 10px; border: 1px dashed #666; padding: 8px; font-size: 10.5px;
           line-height: 1.6; color: #333; }
  .assin { margin-top: 34px; display: flex; gap: 40px; }
  .assin div { flex: 1; border-top: 1px solid #111; padding-top: 5px; text-align: center; font-size: 11px; }
  .noprint { text-align: center; margin: 18px 0; }
  .noprint button { font: inherit; font-size: 13px; padding: 8px 18px; margin: 0 4px;
                    cursor: pointer; border: 1px solid #333; background: #eee; border-radius: 4px; }
  @media print { .noprint { display: none; } }
</style></head><body>

<div class="cab">
  <div class="loja">
    <h1>${escapeHtml(cfg.loja_fantasia || cfg.loja_nome)}</h1>
    <div>
      ${escapeHtml(cfg.loja_nome)}<br>
      ${cfg.loja_cnpj ? 'CNPJ ' + escapeHtml(docFormatado(cfg.loja_cnpj)) : ''}
      ${cfg.loja_ie ? ' &nbsp;•&nbsp; IE ' + escapeHtml(cfg.loja_ie) : ''}<br>
      ${escapeHtml(enderecoLoja)}<br>
      ${cfg.loja_telefone ? 'Fone: ' + escapeHtml(cfg.loja_telefone) : ''}
    </div>
  </div>
  <div class="doc">
    <div class="t">ORÇAMENTO</div>
    <div class="n">${String(o.numero).padStart(5, '0')}</div>
    <div class="d">Emitido em ${dataBr(o.data)}</div>
  </div>
</div>

<div class="bloco">
  <div class="tit">Cliente</div>
  <div class="linhas">
    <div><strong>${escapeHtml(o.cliente_nome || 'CONSUMIDOR')}</strong></div>
    ${o.cliente_doc ? `<div>CPF/CNPJ: ${escapeHtml(docFormatado(o.cliente_doc))}</div>` : ''}
    ${o.cliente_telefone ? `<div>Fone: ${escapeHtml(o.cliente_telefone)}</div>` : ''}
  </div>
</div>

<div class="bloco">
  <div class="linhas">
    <div><span class="tit">Vendedor:</span> ${escapeHtml(o.vendedor || '-')}</div>
    ${o.condicao_pagamento ? `<div><span class="tit">Condição de pagamento:</span> ${escapeHtml(o.condicao_pagamento)}</div>` : ''}
    ${o.prazo_entrega ? `<div><span class="tit">Prazo de entrega:</span> ${escapeHtml(o.prazo_entrega)}</div>` : ''}
  </div>
</div>

<table>
  <thead><tr>
    <th style="width:34px">Item</th><th style="width:70px">Código</th><th>Descrição</th>
    <th class="centro" style="width:42px">Un.</th><th class="num" style="width:64px">Qtd.</th>
    <th class="num" style="width:80px">V. Unit.</th><th class="num" style="width:70px">Desc.</th>
    <th class="num" style="width:88px">Total</th>
  </tr></thead>
  <tbody>
  ${o.itens.map((i, idx) => `<tr>
    <td class="centro">${String(idx + 1).padStart(2, '0')}</td>
    <td>${escapeHtml(i.codigo)}</td>
    <td>${escapeHtml(i.descricao)}</td>
    <td class="centro">${escapeHtml(i.unidade)}</td>
    <td class="num">${qtdFmt(i.quantidade)}</td>
    <td class="num">${brl(i.preco_unit)}</td>
    <td class="num">${num(i.desconto) > 0 ? brl(i.desconto) : '—'}</td>
    <td class="num"><strong>${brl(i.total)}</strong></td>
  </tr>`).join('')}
  </tbody>
</table>

<div class="totais">
  <div><span>Subtotal</span><span>${brl(o.subtotal)}</span></div>
  ${num(o.desconto) > 0 ? `<div><span>Desconto</span><span>− ${brl(o.desconto)}</span></div>` : ''}
  ${num(o.acrescimo) > 0 ? `<div><span>Acréscimo</span><span>${brl(o.acrescimo)}</span></div>` : ''}
  <div class="grande"><span>TOTAL</span><span>R$ ${brl(o.total)}</span></div>
</div>

<div class="validade">
  PROPOSTA VÁLIDA ATÉ ${dataBr(o.validade)}
  &nbsp;•&nbsp; ${o.validade_dias} DIA(S) A PARTIR DA EMISSÃO
</div>

${o.observacao ? `<div class="bloco" style="border-top:1px solid #111;margin-top:10px">
  <div class="tit">Observações</div><div>${escapeHtml(o.observacao)}</div></div>` : ''}

<div class="aviso">
  <strong>Este documento é um orçamento — uma proposta de preço.</strong>
  Não é documento fiscal, não substitui a nota fiscal e não representa venda
  realizada nem reserva de mercadoria.
  Os preços valem até a data acima e dependem da disponibilidade em estoque no
  momento da compra. Após o vencimento, consulte-nos para nova cotação.
</div>

<div class="assin">
  <div>${escapeHtml(cfg.loja_fantasia || cfg.loja_nome)}</div>
  <div>Aceite do cliente</div>
</div>

<div class="noprint">
  <button onclick="window.print()">Imprimir</button>
  <button onclick="window.close()">Fechar</button>
</div>
<script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 350); });</script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/api/log', auth, exigir('usuarios'), (req, res) => {
  res.json(all('SELECT * FROM log ORDER BY id DESC LIMIT 500'));
});

/* ---------- backup ---------- */
app.get('/api/backup', auth, exigir('backup'), (req, res) => {
  salvarBanco();
  registrarLog(req.usuario.usuario, 'backup', 'baixou o banco');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `attachment; filename="backup-loja-${hoje()}.db"`);
  res.send(Buffer.from(db.export()));
});

/* [1.14] onde os dados estao, o que tem neles e as copias automaticas */
app.get('/api/backup/info', auth, exigir('backup'), (req, res) => {
  let tamanho = 0;
  try { tamanho = fs.statSync(DB_FILE).size; } catch (e) { /* ainda nao gravado */ }
  res.json({
    na_internet: NA_INTERNET,
    railway: NO_RAILWAY,
    pasta: NA_INTERNET ? '(servidor) ' + DATA_DIR : DATA_DIR,
    arquivo: DB_FILE,
    tamanho,
    espaco_livre: espacoLivre(DATA_DIR),
    resumo: resumoDoBanco(db),
    copias: listarCopias()
  });
});

/**
 * [1.14] RESTAURAR UM BACKUP
 * O arquivo vem inteiro no corpo (binario). Com ?previa=1 so confere e
 * devolve o resumo do que tem dentro; sem previa, troca o banco em uso pelo
 * arquivo — depois de guardar uma copia do atual em backups/. E assim que o
 * loja.db da loja vai para o Railway no primeiro dia.
 */
app.post('/api/backup/restaurar', auth, exigir('backup'),
  express.raw({ type: () => true, limit: '500mb' }), (req, res) => {
    const r = conferirArquivoDeBanco(req.body);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    const atual = resumoDoBanco(db);
    if (txt(req.query.previa) === '1') return res.json({ arquivo: r.resumo, atual });

    let copia = '';
    try { copia = copiaAntesDeRestaurar(); }
    catch (e) { return res.status(500).json({ erro: 'Nao consegui guardar a copia do banco atual antes de restaurar: ' + e.message }); }

    const antigo = db;
    try {
      db = new SQL.Database(req.body);
      criarEstrutura();   // o arquivo pode ser de uma versao anterior: ganha as tabelas e colunas novas
      semear();
    } catch (e) {
      try { db.close(); } catch (e2) { /* ja fechado */ }
      db = antigo;
      return res.status(500).json({ erro: 'O arquivo abriu, mas nao deu para preparar o banco: ' + e.message + '. Nada foi alterado.' });
    }
    try { antigo.close(); } catch (e) { /* ja fechado */ }

    // sessoes: as do arquivo restaurado + a de quem esta restaurando (para nao cair)
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    const minha = req.usuario;
    restaurarSessoes();
    sessoes.set(token, minha);
    run('INSERT OR REPLACE INTO sessoes (token, usuario, nome, perfil, expira, trocar, ip) VALUES (?,?,?,?,?,?,?)',
      [token, minha.usuario, minha.nome, minha.perfil, minha.expira, minha.trocar ? 1 : 0, ipDe(req)]);

    registrarLog(minha.usuario, 'restaurar-backup',
      `trocou o banco por um arquivo (${r.resumo.vendas} vendas, ${r.resumo.produtos} produtos); copia do anterior em ${path.basename(copia)}`);
    salvarBanco();
    console.log('Banco restaurado por ' + minha.usuario + '. Copia do anterior: ' + copia);
    res.json({ ok: true, arquivo: r.resumo, antes: atual, copia: path.basename(copia) });
  });

/* =========================================================================
   ARQUIVOS ESTATICOS E START
   ========================================================================= */

/* [1.14] O Railway (ou qualquer monitor) pergunta aqui se o sistema esta de pe.
   Sem login, sem dados da loja. */
app.get('/saude', (req, res) => {
  let banco = 'ok';
  try { one('SELECT 1 AS um'); } catch (e) { banco = 'erro'; }
  res.status(banco === 'ok' ? 200 : 500).json({ ok: banco === 'ok', versao: VERSAO, banco });
});

/* [1.14] Os arquivos da tela sempre sao conferidos com o servidor (no-cache =
   "pergunte antes de usar o que esta guardado"): depois de uma atualizacao o
   navegador pega o .js novo sozinho, sem Ctrl+Shift+R. */
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erro: 'Rota nao encontrada.' });
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'O arquivo enviado e grande demais.' });
  }
  console.error('ERRO:', err);
  res.status(500).json({ erro: 'Erro interno: ' + err.message });
});

/**
 * [1.14] Recuperar o acesso quando ninguem mais entra: devolve admin/admin
 * com acesso total. Em casa: node server.js --resetar-admin. No Railway:
 * variavel RESETAR_ADMIN=1 (depois apague a variavel).
 */
function resetarAdmin() {
  const perfilAdmin = one("SELECT id FROM perfis WHERE nome = 'Administrador'");
  const u = one("SELECT id FROM usuarios WHERE lower(usuario) = 'admin'");
  if (u) {
    run('UPDATE usuarios SET senha = ?, ativo = 1, perfil = ?, perfil_id = ? WHERE id = ?',
      [senhaHash('admin'), 'admin', perfilAdmin ? perfilAdmin.id : null, u.id]);
  } else {
    run(`INSERT INTO usuarios (usuario, senha, nome, perfil, perfil_id, ativo, criado_em)
         VALUES (?,?,?,?,?,1,?)`,
      ['admin', senhaHash('admin'), 'Administrador', 'admin', perfilAdmin ? perfilAdmin.id : null, agora()]);
  }
  run("DELETE FROM sessoes WHERE lower(usuario) = 'admin'");
  registrarLog('sistema', 'resetar-admin', 'login admin devolvido com a senha admin');
  salvarBanco();
  avisoGrande([
    'ACESSO RECUPERADO: usuario admin, senha admin, acesso total.',
    'Entre e troque a senha na hora.',
    process.env.RESETAR_ADMIN === '1' ? 'Agora APAGUE a variavel RESETAR_ADMIN' + (NO_RAILWAY ? ' no Railway' : '') + ', senao a senha volta a cada reinicio.' : ''
  ].filter(Boolean));
}

(async () => {
  SQL = await initSqlJs();

  conferirPastaDoBanco();
  abrirBanco();

  criarEstrutura();
  semear();
  restaurarSessoes();

  if (process.argv.includes('--resetar-admin')) {
    resetarAdmin();
    process.exit(0);
  }
  if (process.env.RESETAR_ADMIN === '1') resetarAdmin();

  // [1.12] tabela NCM (dados/ncm.json): valida e sugere o NCM dos produtos
  try { console.log('Tabela NCM carregada: ' + ncm.carregar() + ' codigos.'); }
  catch (e) { console.error('ATENCAO: a tabela NCM (dados/ncm.json) nao carregou: ' + e.message); }

  // salva de tempos em tempos, por seguranca
  setInterval(salvarBanco, 60000);
  process.on('SIGINT', () => { salvarBanco(); process.exit(0); });
  process.on('SIGTERM', () => { salvarBanco(); process.exit(0); });

  // [1.14] uma copia do banco por dia em backups/ (confere a cada hora)
  copiaDiaria();
  setInterval(copiaDiaria, 60 * 60000);

  const servidor = app.listen(PORT, () => {
    console.log('==================================================');
    console.log('  SISTEMA LOJA DE MATERIAL DE CONSTRUCAO');
    console.log('  VERSAO ' + VERSAO);
    if (NA_INTERNET) {
      console.log('  NA INTERNET' + (NO_RAILWAY ? ' (Railway)' : '') + ' - porta ' + PORT);
      console.log('  Dados em: ' + DATA_DIR);
      console.log('  Fuso: ' + process.env.TZ + '   Agora: ' + new Date().toLocaleString('pt-BR'));
    } else {
      console.log('  http://localhost:' + PORT);
      console.log('  usuario: admin   senha: admin');
    }
    console.log('==================================================');
  });
  servidor.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      avisoGrande([
        'A PORTA ' + PORT + ' JA ESTA EM USO.',
        'O sistema provavelmente ja esta aberto em outra janela preta.',
        'Feche esta janela e use a que ja estava aberta (http://localhost:' + PORT + ').'
      ]);
      process.exit(3);
    }
    console.error('ERRO ao subir o servidor:', e.message);
    process.exit(1);
  });
})();
