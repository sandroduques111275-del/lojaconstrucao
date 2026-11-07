/* ==========================================================================
   core.js — sessão, navegação, utilitários, painel e configurações
   ========================================================================== */

let TOKEN = localStorage.getItem('lc_token') || '';
let USUARIO = null;
let CONFIG = {};
let CATEGORIAS = [];
let SECAO_ATUAL = 'dashboard';
let PERM = {};
let INFO = { na_internet: false };   // [1.14] /api/info: o sistema esta na internet?
let SENHA_DIGITADA = '';             // [1.14] so para a troca obrigatoria da senha de fabrica

/** O usuário pode usar este módulo/ação? */
function podeVer(chave) {
  return PERM.todos === true || PERM[chave] === true;
}

/**
 * Esconde do menu tudo que o perfil não alcança e apaga os títulos de grupo
 * que ficaram sem nenhum item. O bloqueio de verdade é no servidor — isto
 * aqui é só para o operador não ver porta que não abre.
 */
function aplicarPermissoesNoMenu() {
  document.querySelectorAll('.menu a[data-secao]').forEach((a) => {
    a.style.display = podeVer(a.dataset.secao) ? '' : 'none';
  });

  const filhos = [...document.querySelector('.menu').children];
  filhos.forEach((el2, i) => {
    if (!el2.classList.contains('grupo-tit')) return;
    let temItem = false;
    for (let j = i + 1; j < filhos.length; j++) {
      if (filhos[j].classList.contains('grupo-tit')) break;
      if (filhos[j].style.display !== 'none') { temItem = true; break; }
    }
    el2.style.display = temItem ? '' : 'none';
  });
}

/** Primeira seção que o usuário realmente pode abrir. */
function primeiraSecaoPermitida() {
  const a = [...document.querySelectorAll('.menu a[data-secao]')]
    .find((x) => x.style.display !== 'none');
  return a ? a.dataset.secao : null;
}

/* ---------------- utilidades ---------------- */

const R$ = (v) => 'R$ ' + (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const N = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const Q = (v) => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

/** Aceita "1.234,56" e "1234.56". */
function valor(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/[R$\s]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

const esc = (s) => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function dataBr(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : iso;
}
function dataHoraBr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
function hojeIso() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function somaDias(iso, dias) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}
function docFmt(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}
const el = (id) => document.getElementById(id);
const val = (id) => (el(id) ? el(id).value.trim() : '');
function setVal(id, v) { if (el(id)) el(id).value = v === null || v === undefined ? '' : v; }

/* ---------------- toast ---------------- */
function toast(msg, tipo = 'ok', ms = 3800) {
  const d = document.createElement('div');
  d.className = 'toast ' + tipo;
  d.innerHTML = msg;
  el('toasts').appendChild(d);
  setTimeout(() => {
    d.style.transition = 'opacity .25s';
    d.style.opacity = '0';
    setTimeout(() => d.remove(), 250);
  }, ms);
}
const ok = (m) => toast('✅ ' + m, 'ok');
const erro = (m) => toast('❌ ' + m, 'erro', 6000);
const alerta = (m) => toast('⚠️ ' + m, 'alerta', 5000);

/* ---------------- API ---------------- */
async function api(rota, opcoes = {}) {
  const cfg = {
    method: opcoes.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }
  };
  if (opcoes.body) cfg.body = JSON.stringify(opcoes.body);

  const r = await fetch(rota, cfg);

  if (r.status === 401) {
    localStorage.removeItem('lc_token');
    location.reload();
    throw new Error('Sessão expirada');
  }
  const texto = await r.text();
  let dados;
  try { dados = texto ? JSON.parse(texto) : {}; } catch (e) { dados = { erro: texto }; }
  // [1.14] na internet, senha de fabrica nao passa: abre a troca de senha
  if (r.status === 403 && dados && dados.trocar_senha) abrirSenhaPadrao(true);
  if (!r.ok) throw new Error(dados.erro || 'Erro na operação');
  return dados;
}

/* ---------------- login ---------------- */

/** [1.14] Antes de entrar: a tela de login sabe se o sistema esta na internet. */
async function carregarInfo() {
  try {
    const r = await fetch('/api/info');
    if (r.ok) INFO = await r.json();
  } catch (e) { /* servidor fora: a tela de login explica */ }
  if (el('loginDicaPadrao')) el('loginDicaPadrao').style.display = INFO.na_internet ? 'none' : '';
  if (el('loginRodapeInternet')) el('loginRodapeInternet').style.display = INFO.na_internet ? '' : 'none';
  if (el('loginVersao')) el('loginVersao').textContent = 'v' + String(INFO.versao || '').split(' ')[0];
}

async function entrar(ev) {
  ev.preventDefault();
  el('loginErro').style.display = 'none';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: val('loginUsuario'), senha: el('loginSenha').value })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.erro || 'Não foi possível entrar');
    TOKEN = d.token;
    localStorage.setItem('lc_token', TOKEN);
    USUARIO = d;
    SENHA_DIGITADA = d.trocar_senha ? el('loginSenha').value : '';
    el('loginSenha').value = '';
    await iniciar();
  } catch (e) {
    const semServidor = /failed to fetch|networkerror|load failed/i.test(e.message);
    el('loginErro').innerHTML = !semServidor ? esc(e.message)
      : INFO.na_internet
        ? `<div><strong>Não consegui falar com o servidor.</strong><br>
           Confira a sua internet e tente de novo em instantes.</div>`
        : `<div><strong>Não consegui falar com o servidor.</strong><br>
           Confira se a janela preta do <code>iniciar.bat</code> ainda está aberta.
           Se você fechou, é só rodar o <code>iniciar.bat</code> de novo.</div>`;
    el('loginErro').style.display = 'block';
  }
}

/* ---------------- [1.14] senha de fabrica ---------------- */

/** Abre a troca de senha. Obrigatoria (sem "Agora nao") quando o sistema esta na internet. */
function abrirSenhaPadrao(obrigatoria) {
  if (!el('modalSenhaPadrao')) return;
  if (el('modalSenhaPadrao').classList.contains('aberto')) return;
  el('senhaPadraoDepois').style.display = obrigatoria ? 'none' : '';
  el('senhaPadraoAviso').innerHTML = obrigatoria
    ? `<span>🔒</span><div>Você entrou com a <strong>senha de fábrica</strong> e o sistema está
       <strong>na internet</strong>: qualquer pessoa que descubra o endereço entraria com ela.
       Escolha uma senha sua para continuar.</div>`
    : `<span>⚠️</span><div>Você entrou com a <strong>senha de fábrica</strong>. Vale escolher uma senha
       sua — principalmente antes de colocar o sistema na internet.</div>`;
  setVal('senhaPadraoNova', ''); setVal('senhaPadraoRepete', '');
  el('senhaPadraoErro').style.display = 'none';
  abrirModal('modalSenhaPadrao');
  setTimeout(() => el('senhaPadraoNova').focus(), 100);
}

async function salvarSenhaPadrao() {
  const nova = el('senhaPadraoNova').value;
  const repete = el('senhaPadraoRepete').value;
  const mostrarErro = (m) => { el('senhaPadraoErro').textContent = m; el('senhaPadraoErro').style.display = 'block'; };
  if (nova.length < 6) return mostrarErro('A nova senha precisa de pelo menos 6 caracteres.');
  if (nova !== repete) return mostrarErro('As duas senhas não são iguais.');
  if (!SENHA_DIGITADA) {
    // a pagina foi recarregada e a senha digitada no login se perdeu: pede
    const atual = prompt('Digite a senha ATUAL (a de fábrica) para confirmar:');
    if (!atual) return;
    SENHA_DIGITADA = atual;
  }
  try {
    await api('/api/usuarios/senha', { method: 'POST', body: { atual: SENHA_DIGITADA, nova } });
    SENHA_DIGITADA = '';
    fecharModal('modalSenhaPadrao');
    ok('Senha trocada. Use a nova a partir do próximo login.');
    if (USUARIO) USUARIO.trocar_senha = false;
    // se a tela ficou presa esperando a troca, recarrega tudo
    if (INFO.na_internet) location.reload();
  } catch (e) { mostrarErro(e.message); }
}

async function sair() {
  if (!confirm('Deseja sair do sistema?')) return;
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignora */ }
  localStorage.removeItem('lc_token');
  location.reload();
}

/* ---------------- navegação ---------------- */
/* telas que nao sao modulo proprio: valem pela permissao de outro modulo */
const SECAO_PERMISSAO = { ncm: 'produtos', relDia: 'relVendas' };

function irPara(secao) {
  if (!podeVer(SECAO_PERMISSAO[secao] || secao)) {
    alerta('Seu perfil não tem acesso a essa tela.');
    return;
  }
  SECAO_ATUAL = secao;
  document.querySelectorAll('.secao').forEach((s) => s.classList.remove('ativa'));
  const alvo = el('sec-' + secao);
  if (alvo) alvo.classList.add('ativa');
  document.querySelectorAll('.menu a').forEach((a) => {
    a.classList.toggle('ativo', a.dataset.secao === secao);
  });
  document.querySelector('.menu').classList.remove('aberto');
  window.scrollTo(0, 0);

  const acoes = {
    dashboard: carregarDashboard,
    pdv: prepararPdv,
    vendas: carregarVendas,
    orcamentos: carregarOrcamentos,
    caixa: carregarCaixa,
    entradaNota: carregarEntradaNota,
    expedicao: carregarExpedicao,
    obras: carregarObras,
    receber: carregarReceber,
    cartao: carregarCartao,
    operadoras: carregarOperadoras,
    pagar: carregarPagar,
    fluxo: carregarFluxo,
    produtos: carregarProdutos,
    estoque: carregarEstoque,
    clientes: carregarClientes,
    fornecedores: carregarFornecedores,
    relDia: carregarVendasDia,
    relVendas: carregarRelVendas,
    relProdutos: carregarRelProdutos,
    relClientes: carregarRelClientes,
    relDespesas: carregarRelDespesas,
    relCompras: carregarSugestaoCompra,
    ncm: carregarNcm,
    fiscal: carregarFiscalTela,
    config: carregarConfigTela
  };
  if (acoes[secao]) acoes[secao]();
}

/* --------------------------------------------------------------------------
   Empilhamento das janelas.
   Todas as janelas nascem com o mesmo z-index no CSS, entao quem estivesse
   escrito depois no HTML ficava por cima — era por isso que a busca de produto
   abria ATRAS da janela do orçamento. Aqui cada janela que abre recebe um
   z-index maior que o da anterior, na ordem em que foi aberta.
   -------------------------------------------------------------------------- */
let Z_JANELA = 200;

function abrirModal(id) {
  const m = el(id);
  if (!m) return;
  Z_JANELA += 10;
  m.style.zIndex = Z_JANELA;
  m.classList.add('aberto');
}

function fecharModal(id) {
  const m = el(id);
  if (!m) return;
  m.classList.remove('aberto');
  m.style.zIndex = '';
  // sem nenhuma janela aberta, volta a contagem para nao crescer sem fim
  if (!document.querySelectorAll('.modal.aberto').length) Z_JANELA = 200;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // fecha a janela que está por cima — pelo z-index, não pela ordem do HTML
    const abertos = [...document.querySelectorAll('.modal.aberto')]
      .sort((a, b) => (Number(a.style.zIndex) || 0) - (Number(b.style.zIndex) || 0));
    if (abertos.length) { fecharModal(abertos[abertos.length - 1].id); e.preventDefault(); }
  }
});

/* ---------------- período: atalhos ---------------- */
function montarAtalhos(containerId, idDe, idAte, aoAplicar, padrao = 'mes') {
  const c = el(containerId);
  if (!c) return;
  const opcoes = [
    ['hoje', 'Hoje'], ['ontem', 'Ontem'], ['semana', 'Semana'],
    ['mes', 'Este mês'], ['mespassado', 'Mês passado'], ['ano', 'Este ano'], ['tudo', 'Tudo']
  ];
  c.innerHTML = opcoes.map(([k, r]) =>
    `<button data-p="${k}" onclick="aplicarPeriodo('${containerId}','${idDe}','${idAte}','${k}',${aoAplicar.name})">${r}</button>`
  ).join('');
  aplicarPeriodo(containerId, idDe, idAte, padrao, null);
}

function aplicarPeriodo(containerId, idDe, idAte, chave, fn) {
  const h = new Date();
  const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  let de = iso(h), ate = iso(h);

  if (chave === 'ontem') { const d = new Date(h); d.setDate(d.getDate() - 1); de = ate = iso(d); }
  else if (chave === 'semana') { const d = new Date(h); d.setDate(d.getDate() - 6); de = iso(d); }
  else if (chave === 'mes') {
    // [1.15] "Este mês" = do dia 1 ao ULTIMO dia do mes (dia 0 do mes seguinte),
    // nao so ate hoje — senao conta a vencer ainda neste mes nao aparece
    de = iso(new Date(h.getFullYear(), h.getMonth(), 1));
    ate = iso(new Date(h.getFullYear(), h.getMonth() + 1, 0));
  }
  else if (chave === 'mespassado') {
    de = iso(new Date(h.getFullYear(), h.getMonth() - 1, 1));
    ate = iso(new Date(h.getFullYear(), h.getMonth(), 0));
  } else if (chave === 'ano') {
    // [1.15] "Este ano" ate 31/dez, mesma logica do mes
    de = iso(new Date(h.getFullYear(), 0, 1));
    ate = iso(new Date(h.getFullYear(), 11, 31));
  }
  else if (chave === 'tudo') { de = '2000-01-01'; ate = iso(new Date(h.getFullYear() + 1, 0, 1)); }

  setVal(idDe, de);
  setVal(idAte, ate);
  const c = el(containerId);
  if (c) c.querySelectorAll('button').forEach((b) => b.classList.toggle('ativo', b.dataset.p === chave));
  if (fn) fn();
}

/* ---------------- painel ---------------- */
async function carregarDashboard() {
  try {
    const d = await api('/api/dashboard');

    /* O servidor manda so o que o perfil pode ver. Cada bloco abaixo so
       aparece se o dado veio — por isso os testes de existencia. */
    const avisos = [];
    if (d.caixa !== undefined && !d.caixa_aberto && podeVer('caixa')) {
      avisos.push(`<div class="aviso alerta"><span>💵</span><div><strong>Nenhum caixa aberto.</strong>
         Abra o caixa antes de começar as vendas do dia.
         <button class="btn pequeno" style="margin-left:8px" onclick="irPara('caixa')">Ir para o caixa</button></div></div>`);
    }
    if (d.pagar_vencidas && d.pagar_vencidas.qtd > 0) {
      avisos.push(`<div class="aviso erro"><span>💸</span><div>
        <strong>${d.pagar_vencidas.qtd} conta(s) vencida(s)</strong> somando ${R$(d.pagar_vencidas.valor)}.
        <button class="btn pequeno" style="margin-left:8px" onclick="irPara('pagar')">Ver contas a pagar</button></div></div>`);
    }
    if (d.cartao_atraso && d.cartao_atraso.qtd > 0) {
      avisos.push(`<div class="aviso alerta"><span>💳</span><div>
        <strong>${d.cartao_atraso.qtd} parcela(s) de cartão</strong> passaram da data prevista e
        somam ${R$(d.cartao_atraso.valor)}. Confira o extrato da maquininha.
        <button class="btn pequeno" style="margin-left:8px" onclick="irPara('cartao')">Ver recebíveis</button></div></div>`);
    }
    if (d.pagar_hoje && d.pagar_hoje.qtd > 0) {
      avisos.push(`<div class="aviso alerta"><span>📅</span><div>
        <strong>${d.pagar_hoje.qtd} conta(s) vencem hoje</strong> — ${R$(d.pagar_hoje.valor)}.
        <button class="btn pequeno" style="margin-left:8px" onclick="irPara('pagar')">Ver</button></div></div>`);
    }
    el('dashAviso').innerHTML = avisos.join('');

    const cards = [];
    if (d.hoje) {
      cards.push(tile('Vendas de hoje (loja)', R$(d.hoje.caixa), d.hoje.qtd + ' cupom(ns)', 'verde'));
      cards.push(tile('Vendas do mês (loja)', R$(d.mes.caixa), d.mes.qtd + ' cupom(ns)', ''));
      if (podeVer('obras')) {
        cards.push(tile('Obras de hoje', R$(d.hoje.obra), 'no mês: ' + R$(d.mes.obra) + ' (a custo)', 'laranja'));
      }
      cards.push(tile('Lucro bruto do mês', R$(d.lucro_mes), 'venda menos custo da mercadoria', 'verde'));
    }
    if (d.despesa_mes !== undefined) {
      cards.push(tile('Despesas pagas no mês', R$(d.despesa_mes), 'contas quitadas',
        d.despesa_mes > 0 ? 'laranja' : ''));
    }
    if (d.resultado_mes !== undefined) {
      cards.push(tile('Resultado do mês', R$(d.resultado_mes),
        d.resultado_mes >= 0 ? 'lucro menos despesas' : 'no vermelho',
        d.resultado_mes >= 0 ? 'verde' : 'vermelho'));
    }
    if (d.orcamentos !== undefined && d.orcamentos.qtd > 0) {
      cards.push(tile('Orçamentos em aberto', d.orcamentos.qtd,
        R$(d.orcamentos.valor) + ' aguardando resposta', 'laranja'));
    }
    if (d.receber !== undefined) {
      cards.push(tile('A receber (crediário)', R$(d.receber),
        d.vencidos.qtd + ' parcela(s) vencida(s)', d.vencidos.valor > 0 ? 'vermelho' : ''));
    }
    if (d.fiado !== undefined && (d.fiado.valor > 0 || d.fiado.qtd > 0)) {
      cards.push(tile('A receber (fiado)', R$(d.fiado.valor),
        d.fiado.qtd + ' em aberto', d.fiado.valor > 0 ? 'laranja' : ''));
    }
    if (d.cartao !== undefined) {
      cards.push(tile('A receber (cartão)', R$(d.cartao), d.cartao_qtd + ' parcela(s) da maquininha', ''));
    }
    if (d.pagar !== undefined) {
      cards.push(tile('A pagar', R$(d.pagar), d.pagar_vencidas.qtd + ' conta(s) vencida(s)',
        d.pagar_vencidas.valor > 0 ? 'vermelho' : ''));
    }
    if (d.caixa !== undefined) {
      cards.push(tile('Caixa', d.caixa_aberto ? 'ABERTO' : 'FECHADO',
        d.caixa_aberto ? 'desde ' + dataHoraBr(d.caixa.abertura) : 'abra para vender',
        d.caixa_aberto ? 'verde' : 'laranja'));
    }
    if (d.entregas !== undefined && podeVer('expedicao')) {
      cards.push(tile('Entregas a fazer', d.entregas.abertas,
        R$(d.entregas.valor) + (d.entregas.atrasadas ? ` · ${d.entregas.atrasadas} atrasada(s)` : ' em mercadoria vendida'),
        d.entregas.atrasadas ? 'vermelho' : (d.entregas.abertas ? 'laranja' : '')));
      const bd = el('badgeEntregas');
      if (bd) { bd.textContent = d.entregas.abertas; bd.style.display = d.entregas.abertas ? '' : 'none'; }
    }
    if (d.estoque !== undefined) {
      cards.push(tile('Estoque (custo)', R$(d.estoque.valor), d.estoque.produtos + ' produtos ativos', ''));
      cards.push(tile('Estoque baixo', d.criticos, 'produtos no mínimo', d.criticos > 0 ? 'laranja' : ''));
    }
    el('dashTiles').innerHTML = cards.join('');

    const cartaoGrafico = el('dashGrafico').closest('.card');
    const cartaoTop = el('dashTop').closest('.card');
    if (d.ultimos7) {
      if (cartaoGrafico) cartaoGrafico.style.display = '';
      if (cartaoTop) cartaoTop.style.display = '';
      const maxTotal = Math.max(...d.ultimos7.map((x) => Number(x.total)), 1);
      el('dashGrafico').innerHTML = d.ultimos7.length
        ? d.ultimos7.map((x) => `
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px">
            <div style="width:76px;font-size:12px;color:var(--texto-fraco)">${dataBr(x.dia)}</div>
            <div style="flex:1;background:#eef1f5;border-radius:4px;height:22px;position:relative;overflow:hidden">
              <div style="width:${(x.total / maxTotal) * 100}%;background:var(--laranja);height:100%;border-radius:4px"></div>
            </div>
            <div style="width:110px;text-align:right;font-weight:700;font-size:12.5px">${R$(x.total)}</div>
          </div>`).join('')
        : '<div class="vazio"><span class="ic">📊</span>Nenhuma venda nos últimos 7 dias.</div>';

      el('dashTop').innerHTML = d.mais_vendidos.length ? `
        <table><thead><tr><th>Produto</th><th class="num">Qtd.</th><th class="num">Total</th></tr></thead><tbody>
        ${d.mais_vendidos.map((p) => `<tr><td>${esc(p.descricao)}</td>
          <td class="num">${Q(p.qtd)} ${esc(p.unidade || '')}</td>
          <td class="num">${R$(p.total)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="vazio"><span class="ic">🏆</span>Sem vendas no mês.</div>';
    } else {
      if (cartaoGrafico) cartaoGrafico.style.display = 'none';
      if (cartaoTop) cartaoTop.style.display = 'none';
    }

    const cartaoCriticos = el('dashCriticos').closest('.card');
    if (podeVer('estoque') || podeVer('produtos')) {
      if (cartaoCriticos) cartaoCriticos.style.display = '';
      el('dashCriticos').innerHTML = await tabelaCriticos();
    } else if (cartaoCriticos) {
      cartaoCriticos.style.display = 'none';
    }

    atualizarBadges(d);
  } catch (e) { erro(e.message); }
}

function tile(rot, valorTxt, obs, classe) {
  return `<div class="tile ${classe}"><div class="rot">${rot}</div>
    <div class="val">${valorTxt}</div><div class="obs">${obs}</div></div>`;
}

async function tabelaCriticos() {
  const r = await api('/api/estoque/resumo');
  if (!r.criticos.length) return '<div class="vazio"><span class="ic">✅</span>Nenhum produto no estoque mínimo.</div>';
  return `<table><thead><tr>
      <th>Código</th><th>Produto</th><th>Categoria</th>
      <th class="num">Saldo</th><th class="num">Mínimo</th><th class="num">Repor</th>
    </tr></thead><tbody>
    ${r.criticos.slice(0, 30).map((p) => `<tr>
      <td>${esc(p.codigo)}</td><td>${esc(p.descricao)}</td><td>${esc(p.categoria || '-')}</td>
      <td class="num" style="color:var(--vermelho);font-weight:700">${Q(p.estoque)} ${esc(p.unidade)}</td>
      <td class="num">${Q(p.estoque_minimo)}</td>
      <td class="num">${Q(Math.max(0, Number(p.estoque_minimo) * 2 - Number(p.estoque)))}</td>
    </tr>`).join('')}</tbody></table>`;
}

function atualizarBadges(d) {
  const badge = (id, qtd) => {
    const b = el(id);
    if (!b) return;
    if (qtd > 0) { b.textContent = qtd; b.style.display = 'inline-block'; }
    else b.style.display = 'none';
  };
  badge('badgeVencidos', d.vencidos ? d.vencidos.qtd : 0);
  badge('badgePagar', d.pagar_vencidas ? d.pagar_vencidas.qtd : 0);
  badge('badgeCartao', d.cartao_atraso ? d.cartao_atraso.qtd : 0);
  if (d.caixa !== undefined) marcarTopoCaixa(d.caixa_aberto);
}

/** Selo de caixa aberto/fechado no topo — chamado por todas as telas que mexem no caixa. */
function marcarTopoCaixa(aberto) {
  el('topoCaixa').innerHTML = aberto
    ? '<span class="pill verde">CAIXA ABERTO</span>'
    : '<span class="pill amarela">CAIXA FECHADO</span>';
}

/* ---------------- configurações ---------------- */
const CAMPOS_CFG = [
  'loja_nome', 'loja_fantasia', 'loja_cnpj', 'loja_ie', 'loja_telefone',
  'loja_endereco', 'loja_bairro', 'loja_cidade', 'loja_uf', 'loja_cep',
  'cupom_rodape', 'cupom_cabecalho',
  'impressora_modelo', 'impressora_nome', 'cupom_largura', 'cupom_fonte',
  'cupom_margem', 'cupom_vias', 'cupom_linhas_fim', 'cupom_auto_imprimir',
  'venda_permite_estoque_negativo', 'venda_exige_caixa_aberto', 'venda_entrega_padrao'
];

/** Ajusta a largura da bobina sozinho quando o modelo é conhecido. */
function aplicarPerfilImpressora() {
  const m = val('cfg_impressora_modelo');
  if (m.includes('58')) setVal('cfg_cupom_largura', '58');
  else if (m.includes('A4')) setVal('cfg_cupom_largura', '80');
  else setVal('cfg_cupom_largura', '80');

  if (m.startsWith('EPSON TM-T20') && !val('cfg_impressora_nome')) {
    setVal('cfg_impressora_nome', 'EPSON TM-T20 Receipt');
  }
}

function imprimirTeste() {
  const j = window.open('/api/impressora/teste?token=' + encodeURIComponent(TOKEN),
    'testeimpressora', 'width=420,height=700');
  if (!j) alerta('O navegador bloqueou a janela. Libere os pop-ups deste site.');
  else toast('🧪 Cupom de teste enviado. Confira se a régua coube numa linha só.', 'ok', 6000);
}

async function carregarConfig() {
  CONFIG = await api('/api/config');
  el('topoFantasia').textContent = CONFIG.loja_fantasia || CONFIG.loja_nome || 'Material de Construção';
  // [1.15] no topo só o número (v1.15); a descrição completa fica no título/rodapé
  if (el('topoVersao') && CONFIG.versao) {
    el('topoVersao').textContent = 'v' + String(CONFIG.versao).split(' ')[0];
    el('topoVersao').title = CONFIG.versao;
  }
  document.title = (CONFIG.loja_fantasia || 'Sistema de Vendas') + ' — PDV';
}

function carregarConfigTela() {
  CAMPOS_CFG.forEach((c) => setVal('cfg_' + c, CONFIG[c] || ''));
  const gereUsuarios = podeVer('usuarios');
  el('cardUsuarios').style.display = gereUsuarios ? '' : 'none';
  el('cardPerfis').style.display = gereUsuarios ? '' : 'none';
  el('cardBackup').style.display = podeVer('backup') ? '' : 'none';
  if (gereUsuarios) { carregarPerfis().then(carregarUsuarios); }
  carregarBackupInfo();   // [1.14]
}

async function salvarConfig() {
  const body = {};
  CAMPOS_CFG.forEach((c) => { body[c] = val('cfg_' + c); });
  try {
    await api('/api/config', { method: 'POST', body });
    await carregarConfig();
    ok('Configurações salvas.');
  } catch (e) { erro(e.message); }
}

async function carregarUsuarios() {
  try {
    const lista = await api('/api/usuarios');
    el('usuariosLista').innerHTML = `
      <table><thead><tr><th>Login</th><th>Nome</th><th>Perfil</th><th class="centro">Situação</th><th></th></tr></thead>
      <tbody>${lista.map((u) => `<tr class="${u.ativo ? '' : 'inativa'}">
        <td><strong>${esc(u.usuario)}</strong></td><td>${esc(u.nome)}</td>
        <td><span class="pill ${u.perfil === 'admin' ? 'azul' : 'cinza'}">${esc(u.perfil_nome || u.perfil)}</span></td>
        <td class="centro"><span class="pill ${u.ativo ? 'verde' : 'cinza'}">${u.ativo ? 'ativo' : 'inativo'}</span></td>
        <td class="centro"><button class="btn-ic" onclick='abrirUsuario(${JSON.stringify(u)})' title="Editar">✏️</button></td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) { erro(e.message); }
}

function abrirUsuario(u) {
  setVal('usr_id', u ? u.id : '');
  setVal('usr_usuario', u ? u.usuario : '');
  setVal('usr_nome', u ? u.nome : '');
  setVal('usr_senha', '');
  setVal('usr_perfil_id', u && u.perfil_id ? u.perfil_id : '');
  el('usr_ativo').checked = u ? !!u.ativo : true;
  el('usuarioTitulo').textContent = u ? 'Editar usuário' : 'Novo usuário';
  mostrarResumoPerfil();
  abrirModal('modalUsuario');
}

async function salvarUsuario() {
  try {
    await api('/api/usuarios', {
      method: 'POST',
      body: {
        id: val('usr_id') || null, usuario: val('usr_usuario'), nome: val('usr_nome'),
        senha: val('usr_senha'), perfil_id: val('usr_perfil_id') || null,
        ativo: el('usr_ativo').checked ? 1 : 0
      }
    });
    fecharModal('modalUsuario');
    carregarUsuarios();
    carregarPerfis();
    ok('Usuário salvo.');
  } catch (e) { erro(e.message); }
}

async function trocarSenha() {
  try {
    await api('/api/usuarios/senha', {
      method: 'POST',
      body: { atual: val('senhaAtual'), nova: val('senhaNova') }
    });
    setVal('senhaAtual', ''); setVal('senhaNova', '');
    ok('Senha alterada.');
  } catch (e) { erro(e.message); }
}

function baixarBackup() {
  const a = document.createElement('a');
  a.href = '/api/backup?token=' + encodeURIComponent(TOKEN);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  ok('Backup gerado. Guarde o arquivo em local seguro.');
}

/* ---------------- [1.14] backup: onde estao os dados e restauracao ---------------- */

const MB = (b) => (Number(b) / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' MB';

function htmlResumoBanco(r, titulo) {
  if (!r) return '';
  return `<div class="card" style="margin:0;padding:10px 12px;flex:1;min-width:230px">
    <div style="font-weight:700;margin-bottom:4px">${esc(titulo)}</div>
    <div style="font-size:12.5px;line-height:1.7">
      <div>${esc(r.loja_nome || '(loja sem nome)')} ${r.loja_cnpj ? '· ' + esc(docFmt(r.loja_cnpj)) : ''}</div>
      <div><strong>${Q(r.vendas)}</strong> vendas ${r.ultima_venda ? '(última em ' + esc(dataHoraBr(r.ultima_venda)) + ')' : ''}</div>
      <div><strong>${Q(r.produtos)}</strong> produtos · <strong>${Q(r.clientes)}</strong> clientes · <strong>${Q(r.usuarios)}</strong> usuários</div>
      <div>NFC-e de produção: <strong>${Q(r.nfce_producao)}</strong>${r.nfce_ultimo_numero ? ' (última nº ' + Q(r.nfce_ultimo_numero) + ')' : ''}</div>
      <div>${r.certificado ? '✅ certificado' : '— sem certificado'} · ${r.csc_producao ? '✅ CSC de produção' : '— sem CSC de produção'}</div>
      ${r.entregas_abertas ? `<div>🚚 ${Q(r.entregas_abertas)} entrega(s) em aberto</div>` : ''}
    </div></div>`;
}

async function carregarBackupInfo() {
  if (!el('backupInfo') || !podeVer('backup')) return;
  try {
    const i = await api('/api/backup/info');
    const copias = (i.copias || []).slice(0, 3)
      .map((c) => `${esc(c.nome)} (${MB(c.tamanho)})`).join(', ');
    el('backupInfo').innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px">
        ${htmlResumoBanco(i.resumo, i.na_internet ? '☁️ Banco que está no servidor (internet)' : '💻 Banco deste computador')}
      </div>
      <div>📁 Arquivo: <code>${esc(i.arquivo)}</code> · ${MB(i.tamanho)}${i.espaco_livre !== null && i.espaco_livre !== undefined ? ' · espaço livre: ' + MB(i.espaco_livre) : ''}</div>
      <div>🗓️ Cópias automáticas (uma por dia, as 7 últimas, na pasta <code>backups</code>): ${copias || 'nenhuma ainda'}</div>
      ${i.na_internet ? `<div style="margin-top:6px">☁️ O sistema está <strong>na internet</strong>: os dados ficam no servidor
        (volume do Railway). Mesmo assim, <strong>baixe o backup</strong> de vez em quando — é a sua cópia fora de lá.</div>` : ''}`;
  } catch (e) { el('backupInfo').innerHTML = `<span class="pill vermelha">${esc(e.message)}</span>`; }
}

/** Le o arquivo escolhido e manda para o servidor (binario). */
async function enviarArquivoDeBanco(previa) {
  const inp = el('restArquivo');
  if (!inp || !inp.files || !inp.files[0]) throw new Error('Escolha o arquivo do banco primeiro (loja.db ou backup-loja-….db).');
  const arquivo = inp.files[0];
  const r = await fetch('/api/backup/restaurar' + (previa ? '?previa=1' : ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + TOKEN },
    body: arquivo
  });
  const texto = await r.text();
  let d; try { d = texto ? JSON.parse(texto) : {}; } catch (e) { d = { erro: texto }; }
  if (r.status === 401) { localStorage.removeItem('lc_token'); location.reload(); throw new Error('Sessão expirada'); }
  if (!r.ok) throw new Error(d.erro || 'Erro ao enviar o arquivo');
  return d;
}

async function conferirRestauracao() {
  el('btnRestaurar').style.display = 'none';
  el('restPrevia').innerHTML = '<span class="pill cinza">Conferindo o arquivo…</span>';
  try {
    const d = await enviarArquivoDeBanco(true);
    const a = d.arquivo, b = d.atual;
    const avisos = [];
    if (a.loja_cnpj && b.loja_cnpj && a.loja_cnpj !== b.loja_cnpj) avisos.push('O CNPJ do arquivo é diferente do CNPJ do banco atual.');
    if (Number(a.vendas) < Number(b.vendas)) avisos.push(`O arquivo tem MENOS vendas (${Q(a.vendas)}) do que o banco atual (${Q(b.vendas)}): as vendas a mais seriam perdidas.`);
    if (a.ultima_venda && b.ultima_venda && a.ultima_venda < b.ultima_venda) avisos.push('A última venda do arquivo é mais antiga que a do banco atual.');
    if (Number(a.nfce_ultimo_numero) < Number(b.nfce_ultimo_numero)) avisos.push(`A numeração da NFC-e voltaria de ${Q(b.nfce_ultimo_numero)} para ${Q(a.nfce_ultimo_numero)} — a SEFAZ rejeita número repetido.`);
    el('restPrevia').innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${htmlResumoBanco(a, '📄 O arquivo escolhido')}
        ${htmlResumoBanco(b, INFO.na_internet ? '☁️ O banco que está no servidor hoje' : '💻 O banco deste computador hoje')}
      </div>
      ${avisos.length ? `<div class="aviso erro" style="margin-top:10px"><span>⚠️</span><div>${avisos.map(esc).join('<br>')}</div></div>`
        : `<div class="aviso info" style="margin-top:10px"><span>✅</span><div>Arquivo válido. Restaurar troca o banco atual pelo arquivo; uma cópia do atual fica em <code>backups</code>.</div></div>`}`;
    el('btnRestaurar').style.display = '';
  } catch (e) {
    el('restPrevia').innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`;
  }
}

async function restaurarBackup() {
  const palavra = prompt('Isto troca TODOS os dados do sistema pelos do arquivo. Para confirmar, digite RESTAURAR:');
  if (!palavra || palavra.trim().toUpperCase() !== 'RESTAURAR') return;
  el('btnRestaurar').disabled = true;
  try {
    const d = await enviarArquivoDeBanco(false);
    alert(`Banco restaurado: ${Q(d.arquivo.vendas)} vendas e ${Q(d.arquivo.produtos)} produtos.\n` +
      `Os usuários e senhas agora são os do arquivo. Cópia do banco anterior: ${d.copia}.\n\nA tela vai recarregar.`);
    location.reload();
  } catch (e) {
    erro(e.message);
    el('btnRestaurar').disabled = false;
  }
}

/* ==========================================================================
   [1.15] CELULAR: tabela vira cartão
   Cada célula das tabelas de listagem (.tabela-wrap) recebe um data-label com
   o nome da coluna (lido do cabeçalho). No celular o CSS usa esse rótulo para
   montar os cartões. Roda sozinho toda vez que uma tabela é (re)desenhada.
   ========================================================================== */
let _obsTabelas = null;

function rotularTabelas() {
  document.querySelectorAll('.tabela-wrap table').forEach((tab) => {
    const ths = [...tab.querySelectorAll('thead th')].map((th) =>
      th.textContent.replace(/[↕▲▼]/g, '').trim());
    if (!ths.length) return;
    tab.querySelectorAll('tbody tr').forEach((tr) => {
      if (tr.classList.contains('grupo-forn')) return;   // faixa de grupo: não é cartão
      const tds = tr.children;
      if (tds.length !== ths.length) return;             // linha com colspan: ignora
      for (let i = 0; i < tds.length; i++) {
        const lab = ths[i] || '';
        if (tds[i].getAttribute('data-label') !== lab) tds[i].setAttribute('data-label', lab);
        if (!lab) tds[i].classList.add('acoes');
      }
    });
  });
}

function iniciarRotulosTabelas() {
  if (_obsTabelas) { rotularTabelas(); return; }
  const alvo = document.body;
  const run = () => {
    _obsTabelas.disconnect();
    try { rotularTabelas(); } catch (e) { /* nunca derruba a tela */ }
    _obsTabelas.observe(alvo, { childList: true, subtree: true });
  };
  _obsTabelas = new MutationObserver(() => {
    clearTimeout(_obsTabelas._t);
    _obsTabelas._t = setTimeout(run, 80);
  });
  run();
}

/* ---------------- start ---------------- */
async function iniciar() {
  el('telaLogin').style.display = 'none';
  el('app').classList.add('ativo');

  USUARIO = await api('/api/me');
  PERM = USUARIO.permissoes || {};

  /* [1.14] senha de fabrica na internet: nada carrega ate trocar (o servidor
     tambem nao deixa). Em casa so lembra, mais abaixo. */
  if (USUARIO.trocar_senha && USUARIO.na_internet) {
    el('topoUsuario').textContent = USUARIO.nome || USUARIO.usuario;
    abrirSenhaPadrao(true);
    return;
  }
  aplicarPermissoesNoMenu();
  el('topoUsuario').textContent = USUARIO.nome + ' (' + (USUARIO.perfil_nome || USUARIO.perfil) + ')';
  el('topoData').textContent = new Date().toLocaleDateString('pt-BR',
    { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });

  await carregarConfig();
  // um 403 aqui nao pode derrubar o login: o perfil so nao alcanca esse dado
  const seDer = async (fn) => { try { return await fn(); } catch (e) { return null; } };
  CATEGORIAS = (await seDer(() => api('/api/categorias'))) || [];
  preencherCategorias();

  // datas padrão dos filtros
  montarAtalhos('atalhosVendas', 'vendasDe', 'vendasAte', carregarVendas, 'hoje');
  montarAtalhos('atalhosRelVendas', 'relVDe', 'relVAte', carregarRelVendas, 'mes');
  montarAtalhos('atalhosRelProd', 'relPDe', 'relPAte', carregarRelProdutos, 'mes');
  montarAtalhos('atalhosRelCli', 'relCDe', 'relCAte', carregarRelClientes, 'mes');
  montarAtalhos('atalhosRelDesp', 'relDDe', 'relDAte', carregarRelDespesas, 'mes');
  montarAtalhos('atalhosPagar', 'cpDe', 'cpAte', carregarPagar, 'tudo');
  montarAtalhos('atalhosOrc', 'orcDe', 'orcAte', carregarOrcamentos, 'mes');
  montarAtalhos('atalhosCartao', 'crDe', 'crAte', carregarCartao, 'tudo');
  setVal('recDe', '2000-01-01');
  setVal('recAte', somaDias(hojeIso(), 365));

  if (podeVer('pagar')) await seDer(carregarCategoriasCp);
  if (podeVer('cartao') || podeVer('pdv') || podeVer('operadoras')) await seDer(carregarOperadorasLista);

  irPara(podeVer('dashboard') ? 'dashboard' : (primeiraSecaoPermitida() || 'dashboard'));
  setInterval(() => { if (SECAO_ATUAL === 'dashboard') carregarDashboard(); }, 120000);

  // [1.11] uma vez por semana: compras com nota x cartao x NFC-e emitidas
  if (typeof verificarAvisoSemanal === 'function') setTimeout(verificarAvisoSemanal, 800);

  // [1.15] celular: tabelas viram cartoes (injeta os rotulos e observa mudancas)
  iniciarRotulosTabelas();

  // [1.14] em casa, senha de fabrica so lembra (na internet ja parou la em cima)
  if (USUARIO.trocar_senha) setTimeout(() => abrirSenhaPadrao(false), 400);
}

function preencherCategorias() {
  const opts = '<option value="">— sem categoria —</option>' +
    CATEGORIAS.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  if (el('prod_categoria_id')) el('prod_categoria_id').innerHTML = opts;
  if (el('prodCategoria')) el('prodCategoria').innerHTML =
    '<option value="">Todas as categorias</option>' +
    CATEGORIAS.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  if (el('rjCategoria')) el('rjCategoria').innerHTML =
    '<option value="">Todas as categorias</option>' +
    CATEGORIAS.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
}

/* --------------------------------------------------------------------------
   Proteção contra abrir o index.html direto (file://).
   O sistema tem servidor: o banco roda no Node, não dentro do navegador.
   Aberto como arquivo solto, o fetch morre em CORS e o usuário só via
   "Failed to fetch". Aqui a tela explica o que fazer.
   -------------------------------------------------------------------------- */
function avisarModoArquivo() {
  document.getElementById('telaLogin').innerHTML = `
    <div class="login-box" style="max-width:520px">
      <div class="login-logo" style="background:var(--vermelho)">⚠️</div>
      <h1>O sistema não foi iniciado</h1>
      <p class="sub">Você abriu o arquivo direto, sem ligar o servidor.</p>

      <div class="aviso alerta" style="margin-bottom:16px">
        <span>ℹ️</span>
        <div>Este sistema guarda os dados num banco que roda no <strong>Node.js</strong>.
        Abrindo o <code>index.html</code> solto, a tela aparece mas não tem servidor
        para responder — por isso o erro.</div>
      </div>

      <p style="font-weight:700;margin-bottom:8px">Para abrir do jeito certo:</p>
      <ol style="font-size:14px;line-height:2;padding-left:20px;margin-bottom:16px">
        <li>Feche esta janela</li>
        <li>Vá até a pasta <code>loja-construcao</code> (a de cima, não a <code>public</code>)</li>
        <li>Dê dois cliques em <strong>iniciar.bat</strong></li>
        <li>Deixe a janela preta aberta — é o servidor rodando</li>
        <li>O navegador abre sozinho em <strong>http://localhost:3000</strong></li>
      </ol>

      <div class="aviso info">
        <span>💡</span>
        <div>Se o <code>iniciar.bat</code> abrir e fechar na hora, falta instalar o
        <strong>Node.js</strong>: baixe a versão LTS em
        <a href="https://nodejs.org" target="_blank">nodejs.org</a>, instale e tente de novo.</div>
      </div>

      <button class="btn primario" style="width:100%;justify-content:center;padding:11px;margin-top:16px"
              onclick="location.href='http://localhost:3000'">
        Já iniciei o servidor — abrir o sistema
      </button>
    </div>`;
}

/* auto-login se já houver token */
(async function () {
  if (location.protocol === 'file:') { avisarModoArquivo(); return; }
  await carregarInfo();   // [1.14]
  if (!TOKEN) return;
  try { await iniciar(); }
  catch (e) {
    // [1.14] sessao presa na troca de senha nao e token ruim: a janela ja abriu
    if (el('modalSenhaPadrao') && el('modalSenhaPadrao').classList.contains('aberto')) return;
    localStorage.removeItem('lc_token');
    el('telaLogin').style.display = '';
    el('app').classList.remove('ativo');
  }
})();
