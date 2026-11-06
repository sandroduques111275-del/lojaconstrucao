/* ==========================================================================
   financeiro.js — contas a pagar, fornecedores, fluxo de caixa e despesas
   ========================================================================== */

let CP_CATEGORIAS = [];

async function carregarCategoriasCp() {
  CP_CATEGORIAS = await api('/api/cp/categorias');
  const opts = CP_CATEGORIAS.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
  if (el('cp_categoria_id')) el('cp_categoria_id').innerHTML = '<option value="">— sem categoria —</option>' + opts;
  if (el('cpCategoria')) el('cpCategoria').innerHTML = '<option value="">Todas as categorias</option>' + opts;
}

/* ============================ CONTAS A PAGAR ============================ */

/* [1.15] guardo o que veio do servidor para ordenar/agrupar na tela, sem
   precisar consultar de novo a cada clique. */
let CP_CONTAS = [];
let CP_TOTAIS = {};
let CP_ORD = { col: 'vencimento', dir: 1 };   // coluna e sentido (1 crescente, -1 decrescente)
let CP_AGRUPAR = false;
const CP_GRUPOS_FECHADOS = new Set();          // nomes de fornecedor recolhidos

/* como ordenar cada coluna: 'texto', 'numero' ou 'data' */
const CP_COLUNAS = {
  vencimento: { rotulo: 'Vencimento', tipo: 'data', valor: (c) => c.vencimento },
  atraso:     { rotulo: 'Atraso', classe: 'centro', tipo: 'numero', valor: (c) => (c.status === 'vencido' ? Number(c.dias) : -1) },
  fornecedor: { rotulo: 'Fornecedor', tipo: 'texto', valor: (c) => c.fornecedor || '' },
  descricao:  { rotulo: 'Descrição', tipo: 'texto', valor: (c) => c.descricao || '' },
  categoria:  { rotulo: 'Categoria', tipo: 'texto', valor: (c) => c.categoria || '' },
  documento:  { rotulo: 'Documento', tipo: 'texto', valor: (c) => c.documento || '' },
  valor:      { rotulo: 'Valor', classe: 'num', tipo: 'numero', valor: (c) => Number(c.valor) },
  pago:       { rotulo: 'Pago', classe: 'num', tipo: 'numero', valor: (c) => Number(c.valor_pago) },
  saldo:      { rotulo: 'Saldo', classe: 'num', tipo: 'numero', valor: (c) => (c.status === 'pago' ? 0 : Number(c.saldo)) },
  situacao:   { rotulo: 'Situação', classe: 'centro', tipo: 'texto', valor: (c) => c.status || '' }
};

async function carregarPagar() {
  try {
    if (!CP_CATEGORIAS.length) await carregarCategoriasCp();

    const p = new URLSearchParams();
    if (val('cpDe')) p.set('de', val('cpDe'));
    if (val('cpAte')) p.set('ate', val('cpAte'));
    if (val('cpSituacao')) p.set('situacao', val('cpSituacao'));
    if (val('cpCategoria')) p.set('categoria_id', val('cpCategoria'));
    if (val('cpBusca')) p.set('q', val('cpBusca'));

    const r = await api('/api/cp/contas?' + p.toString());
    CP_CONTAS = r.contas || [];
    CP_TOTAIS = r.totais || {};

    el('cpTotais').innerHTML = `
      ${tile('Em aberto', R$(CP_TOTAIS.em_aberto), 'total a pagar no filtro', '')}
      ${tile('Vencidas', R$(CP_TOTAIS.vencidas), CP_TOTAIS.qtd_vencidas + ' conta(s) em atraso',
        CP_TOTAIS.vencidas > 0 ? 'vermelho' : 'verde')}
      ${tile('Vencem hoje', R$(CP_TOTAIS.vence_hoje), 'pagar hoje', 'laranja')}
      ${tile('Já pago', R$(CP_TOTAIS.pago), 'no filtro atual', 'verde')}`;

    renderPagar();
  } catch (e) { erro(e.message); }
}

/** Ordena uma cópia das contas pela coluna/sentido atuais. */
function cpOrdenadas(contas) {
  const def = CP_COLUNAS[CP_ORD.col] || CP_COLUNAS.vencimento;
  const arr = contas.slice();
  arr.sort((a, b) => {
    let x = def.valor(a), y = def.valor(b);
    let cmp;
    if (def.tipo === 'numero' || def.tipo === 'data') {
      if (def.tipo === 'data') { x = String(x || ''); y = String(y || ''); cmp = x < y ? -1 : x > y ? 1 : 0; }
      else cmp = (Number(x) || 0) - (Number(y) || 0);
    } else {
      cmp = String(x).localeCompare(String(y), 'pt-BR', { sensitivity: 'base', numeric: true });
    }
    if (cmp === 0) {   // desempate estável pelo vencimento e id
      cmp = String(a.vencimento || '').localeCompare(String(b.vencimento || '')) || (a.id - b.id);
      return cmp;
    }
    return cmp * CP_ORD.dir;
  });
  return arr;
}

function cpClicarColuna(col) {
  if (CP_ORD.col === col) CP_ORD.dir = -CP_ORD.dir;
  else { CP_ORD.col = col; CP_ORD.dir = 1; }
  renderPagar();
}

function alternarAgruparCp() {
  CP_AGRUPAR = !CP_AGRUPAR;
  const b = el('cpBtnAgrupar');
  if (b) {
    b.classList.toggle('primario', CP_AGRUPAR);
    b.innerHTML = CP_AGRUPAR ? '👥 Agrupado por fornecedor ✓' : '👥 Agrupar por fornecedor';
  }
  renderPagar();
}

function cpAlternarGrupo(nome) {
  if (CP_GRUPOS_FECHADOS.has(nome)) CP_GRUPOS_FECHADOS.delete(nome);
  else CP_GRUPOS_FECHADOS.add(nome);
  renderPagar();
}

/** Cabeçalho da tabela, com as setas de ordenação. */
function cpThead() {
  const th = (col) => {
    const d = CP_COLUNAS[col];
    const ativa = CP_ORD.col === col;
    const seta = ativa ? (CP_ORD.dir === 1 ? '▲' : '▼') : '↕';
    return `<th class="ord ${d.classe || ''} ${ativa ? 'ativa' : ''}" onclick="cpClicarColuna('${col}')" title="Ordenar por ${esc(d.rotulo)}">${esc(d.rotulo)}<span class="seta">${seta}</span></th>`;
  };
  return `<thead><tr>
    ${th('vencimento')}${th('atraso')}${th('fornecedor')}${th('descricao')}
    ${th('categoria')}${th('documento')}${th('valor')}${th('pago')}
    ${th('saldo')}${th('situacao')}<th></th>
  </tr></thead>`;
}

const CP_PILL = { pago: 'verde', vencido: 'vermelha', vence_hoje: 'amarela', aberto: 'azul' };
const CP_ROT = { pago: 'pago', vencido: 'vencida', vence_hoje: 'vence hoje', aberto: 'em aberto' };

/** Uma linha de conta (11 colunas). Clicar na linha abre os dados para pagamento. */
function cpLinha(c) {
  const p = 'event.stopPropagation();';   // nos botões: não abrir os dados ao clicar neles
  return `<tr class="cp-clicavel" style="cursor:pointer" onclick="verDadosPagamento(${c.id})" title="Clique para ver os dados de pagamento">
    <td style="white-space:nowrap;${c.status === 'vencido' ? 'color:var(--vermelho);font-weight:700' : ''}">${dataBr(c.vencimento)}</td>
    <td class="centro">${c.status === 'vencido' ? c.dias + ' d' : '—'}</td>
    <td><strong>${esc(c.fornecedor || '—')}</strong></td>
    <td>${esc(c.descricao || '—')}
      ${c.total_parcelas > 1 ? `<span class="pill cinza">${c.parcela}/${c.total_parcelas}</span>` : ''}
      ${c.forma_prevista === 'PIX' ? '<span class="pill azul" title="Pagar via PIX">🔑 PIX</span>' : ''}
      ${c.forma_prevista === 'BOLETO' ? '<span class="pill cinza">boleto</span>' : ''}</td>
    <td style="font-size:12px">${esc(c.categoria || '—')}</td>
    <td>${esc(c.documento || '—')}
      ${c.tem_boleto ? `<button class="btn-ic" onclick='${p}verBoleto(${c.id})' title="Ver boleto">📎</button>` : ''}</td>
    <td class="num">${N(c.valor)}</td>
    <td class="num">${Number(c.valor_pago) > 0 ? N(c.valor_pago) : '—'}</td>
    <td class="num"><strong>${c.status === 'pago' ? '—' : N(c.saldo)}</strong></td>
    <td class="centro"><span class="pill ${CP_PILL[c.status]}">${CP_ROT[c.status]}</span></td>
    <td class="centro" style="white-space:nowrap">
      ${c.status !== 'pago'
        ? `<button class="btn pequeno verde" onclick='${p}abrirPagarConta(${JSON.stringify(c).replace(/'/g, "&#39;")})'>💸 Pagar</button>
           <button class="btn-ic" onclick="${p}abrirConta(${c.id})" title="Editar">✏️</button>`
        : `<button class="btn-ic" onclick="${p}estornarConta(${c.id})" title="Estornar pagamento">↺</button>`}
      <button class="btn-ic" onclick='${p}duplicarConta(${JSON.stringify(c).replace(/'/g, "&#39;")})' title="Duplicar esta conta">⧉</button>
      <button class="btn-ic" onclick="${p}excluirConta(${c.id}, ${c.total_parcelas > 1 ? 1 : 0})" title="Excluir">🗑️</button>
    </td></tr>`;
}

/** Modal "Dados para pagamento": abre ao clicar na linha da conta. Mostra o
 *  código de barras do boleto, os dados do PIX e o boleto anexado, com Copiar. */
let DP_CONTA = null;
function verDadosPagamento(id) {
  const c = (typeof CP_CONTAS !== 'undefined' ? CP_CONTAS : []).find((x) => x.id === id);
  if (!c) return;
  DP_CONTA = c;
  const pix = txtPix(c);
  let h = `<div style="background:#f5f7fa;border-radius:6px;padding:11px;font-size:13.5px;line-height:1.8">
      <div><strong>${esc(c.fornecedor || c.descricao || 'Conta')}</strong></div>
      ${c.descricao && c.fornecedor ? `<div>${esc(c.descricao)}</div>` : ''}
      <div>${c.documento ? 'Documento ' + esc(c.documento) + ' • ' : ''}venc. ${dataBr(c.vencimento)}
        ${c.status === 'vencido' ? `<span class="pill vermelha">${c.dias} dias em atraso</span>` : ''}</div>
      <div style="margin-top:5px;font-size:16px"><strong>Saldo: ${R$(c.saldo)}</strong></div>
    </div>`;
  if (c.boleto_linha) h += `<div style="margin-top:10px;background:#eef2f7;border-radius:6px;padding:9px 11px">
      <div style="font-size:11px;color:var(--texto-fraco);text-transform:uppercase;font-weight:700">📶 Código de barras do boleto</div>
      <div style="word-break:break-all;font-variant-numeric:tabular-nums;font-size:15px">${esc(c.boleto_linha)}</div>
      <button class="btn pequeno" style="margin-top:6px" onclick="copiarPix('${esc(c.boleto_linha).replace(/'/g, "\\'")}')">Copiar código de barras</button></div>`;
  if (pix) h += `<div style="margin-top:10px;background:#eef2f7;border-radius:6px;padding:9px 11px">
      <div style="font-size:11px;color:var(--texto-fraco);text-transform:uppercase;font-weight:700">🔑 Dados do PIX</div>
      <div style="word-break:break-all;font-size:15px">${esc(pix)}</div>
      <button class="btn pequeno" style="margin-top:6px" onclick="copiarPix('${esc(pix).replace(/'/g, "\\'")}')">Copiar dados do PIX</button></div>`;
  if (c.tem_boleto) h += `<div style="margin-top:10px"><button class="btn" onclick="verBoleto(${c.id})">📎 Ver boleto (PDF/foto)</button></div>`;
  if (!c.boleto_linha && !pix && !c.tem_boleto) h += `<div class="aviso info" style="margin-top:10px"><span>ℹ️</span>
      <div>Essa conta não tem boleto nem PIX cadastrado. Clique em Pagar para pagar, ou no ✏️ (Editar) para anexar o boleto ou os dados do PIX.</div></div>`;
  h += `<div class="modal-acoes" style="margin-top:14px">
      <button class="btn" onclick="fecharModal('modalDadosPagto')">Fechar</button>
      ${c.status !== 'pago' ? `<button class="btn verde" onclick="pagarDosDados()">💸 Pagar</button>` : ''}
    </div>`;
  el('dpCorpo').innerHTML = h;
  abrirModal('modalDadosPagto');
}
function pagarDosDados() { fecharModal('modalDadosPagto'); if (DP_CONTA) abrirPagarConta(DP_CONTA); }

/** Desenha a tabela a partir de CP_CONTAS, respeitando ordenação e agrupamento. */
function renderPagar() {
  if (!CP_CONTAS.length) {
    el('cpLista').innerHTML = '<div class="vazio"><span class="ic">💸</span>Nenhuma conta no filtro.</div>';
    return;
  }

  const somaValor = CP_CONTAS.reduce((s, c) => s + Number(c.valor), 0);
  let corpo;

  if (!CP_AGRUPAR) {
    corpo = cpOrdenadas(CP_CONTAS).map(cpLinha).join('');
  } else {
    /* agrupa por fornecedor. Dentro do grupo, usa a ordenação escolhida.
       Os grupos ficam em ordem de maior saldo em aberto (o que mais importa
       no Contas a Pagar); se a ordenação for por fornecedor, vão em A–Z. */
    const grupos = new Map();
    CP_CONTAS.forEach((c) => {
      const nome = c.fornecedor || '— sem fornecedor —';
      if (!grupos.has(nome)) grupos.set(nome, []);
      grupos.get(nome).push(c);
    });
    const lista = [...grupos.entries()].map(([nome, contas]) => {
      const aberto = contas.reduce((s, c) => s + (c.status === 'pago' ? 0 : Number(c.saldo)), 0);
      const total = contas.reduce((s, c) => s + Number(c.valor), 0);
      return { nome, contas, aberto, total };
    });
    if (CP_ORD.col === 'fornecedor') lista.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }) * CP_ORD.dir);
    else lista.sort((a, b) => b.aberto - a.aberto || b.total - a.total);

    corpo = lista.map((g) => {
      const fechado = CP_GRUPOS_FECHADOS.has(g.nome);
      const nomeAttr = JSON.stringify(g.nome).replace(/'/g, "&#39;").replace(/"/g, '&quot;');
      const cab = `<tr class="grupo-forn" onclick="cpAlternarGrupo(${nomeAttr})"><td colspan="11">
        <div class="grupo-linha">
          <span>${fechado ? '▸' : '▾'} <strong>${esc(g.nome)}</strong>
            <span class="pill cinza">${g.contas.length} conta(s)</span></span>
          <span class="grupo-tot">total ${N(g.total)} · em aberto
            <strong style="${g.aberto > 0 ? 'color:var(--vermelho)' : ''}">${N(g.aberto)}</strong></span>
        </div></td></tr>`;
      const linhas = fechado ? '' : cpOrdenadas(g.contas).map(cpLinha).join('');
      return cab + linhas;
    }).join('');
  }

  el('cpLista').innerHTML = `
    <table>${cpThead()}<tbody>${corpo}</tbody>
    <tfoot><tr>
      <td colspan="6">${CP_CONTAS.length} conta(s)${CP_AGRUPAR ? ' em ' + new Set(CP_CONTAS.map((c) => c.fornecedor || '—')).size + ' fornecedor(es)' : ''}</td>
      <td class="num">${N(somaValor)}</td>
      <td class="num">${N(CP_TOTAIS.pago)}</td>
      <td class="num">${N(CP_TOTAIS.em_aberto)}</td>
      <td colspan="2"></td>
    </tr></tfoot></table>`;
}

async function abrirConta(id) {
  if (!CP_CATEGORIAS.length) await carregarCategoriasCp();

  ['cp_fornecedor_busca', 'cp_descricao', 'cp_documento', 'cp_valor', 'cp_observacao', 'cp_pix_dados', 'cp_boleto_linha']
    .forEach((c) => setVal(c, ''));
  setVal('cp_id', '');
  setVal('cp_fornecedor_id', '');
  setVal('cp_categoria_id', '');
  setVal('cp_emissao', hojeIso());
  setVal('cp_vencimento', somaDias(hojeIso(), 30));
  setVal('cp_parcelas', '1');
  setVal('cp_intervalo', '30');
  setVal('cp_forma_prevista', '');
  if (el('cp_boleto_arq')) el('cp_boleto_arq').value = '';
  if (el('cp_boleto_atual')) el('cp_boleto_atual').innerHTML = '';
  aplicarFormaPrevista();
  el('cp_forn_sel').textContent = '';
  el('cp_forn_resultado').style.display = 'none';
  el('cp_preview').innerHTML = '';
  el('cp_linha_parcelas').style.display = 'flex';
  el('contaTitulo').textContent = 'Lançar conta a pagar';

  if (id) {
    try {
      const r = await api('/api/cp/contas?situacao=todas&de=2000-01-01&ate=2100-01-01');
      const c = r.contas.find((x) => x.id === id);
      if (!c) { erro('Conta não encontrada.'); return; }
      setVal('cp_id', c.id);
      setVal('cp_fornecedor_busca', c.fornecedor || '');
      setVal('cp_fornecedor_id', c.fornecedor_id || '');
      setVal('cp_categoria_id', c.categoria_id || '');
      setVal('cp_descricao', c.descricao || '');
      setVal('cp_documento', c.documento || '');
      setVal('cp_valor', Number(c.valor).toFixed(2));
      setVal('cp_emissao', (c.emissao || '').slice(0, 10));
      setVal('cp_vencimento', (c.vencimento || '').slice(0, 10));
      setVal('cp_observacao', c.observacao || '');
      setVal('cp_forma_prevista', c.forma_prevista || '');
      setVal('cp_pix_dados', c.pix_dados || '');
      setVal('cp_boleto_linha', c.boleto_linha || '');
      aplicarFormaPrevista();
      if (c.tem_boleto && el('cp_boleto_atual')) {
        el('cp_boleto_atual').innerHTML = `✅ boleto anexado —
          <a href="#" onclick="verBoleto(${c.id});return false">ver</a> ·
          <a href="#" onclick="removerBoleto(${c.id});return false">remover</a>`;
      }
      el('cp_linha_parcelas').style.display = 'none';
      el('contaTitulo').textContent = c.total_parcelas > 1
        ? `Editar parcela ${c.parcela} de ${c.total_parcelas}`
        : 'Editar conta a pagar';
    } catch (e) { erro(e.message); return; }
  }

  abrirModal('modalConta');
  setTimeout(() => el('cp_fornecedor_busca').focus(), 100);
}

/* [1.18] Duplicar uma conta: abre o "Lançar conta" já preenchido com os dados
   dela, mas como conta NOVA (sem id), com o vencimento jogado para o próximo
   mês. O usuário confere, ajusta e salva. Não copia o arquivo do boleto. */
async function duplicarConta(c) {
  await abrirConta();                 // abre em branco (modo "nova conta")
  setVal('cp_id', '');                // garante que salva como NOVA
  setVal('cp_fornecedor_id', c.fornecedor_id || '');
  setVal('cp_fornecedor_busca', c.fornecedor || '');
  setVal('cp_categoria_id', c.categoria_id || '');
  setVal('cp_descricao', c.descricao || '');
  setVal('cp_documento', c.documento || '');
  setVal('cp_valor', Number(c.valor || 0).toFixed(2));
  setVal('cp_emissao', hojeIso());
  // próximo mês a partir do vencimento atual (para contas que se repetem)
  setVal('cp_vencimento', somaDias((c.vencimento ? String(c.vencimento).slice(0, 10) : hojeIso()), 30));
  setVal('cp_parcelas', '1');
  setVal('cp_intervalo', '30');
  setVal('cp_forma_prevista', c.forma_prevista || '');
  setVal('cp_pix_dados', c.pix_dados || '');
  setVal('cp_boleto_linha', c.boleto_linha || '');
  aplicarFormaPrevista();
  if (el('cp_boleto_atual')) el('cp_boleto_atual').innerHTML = '';   // boleto não é copiado
  if (el('cp_forn_sel')) el('cp_forn_sel').textContent = '';
  el('cp_linha_parcelas').style.display = 'flex';
  el('contaTitulo').textContent = 'Duplicar conta a pagar';
  el('cp_preview').innerHTML = '';
  setTimeout(() => { if (el('cp_vencimento')) el('cp_vencimento').focus(); }, 120);
}

let timerForn = null;
function buscarFornecedorConta() {
  setVal('cp_fornecedor_id', '');
  el('cp_forn_sel').textContent = '';
  clearTimeout(timerForn);
  timerForn = setTimeout(async () => {
    const t = val('cp_fornecedor_busca');
    const c = el('cp_forn_resultado');
    if (t.length < 2) { c.style.display = 'none'; return; }
    try {
      const lista = await api('/api/fornecedores?status=ativo&q=' + encodeURIComponent(t));
      c.style.display = 'block';
      c.innerHTML = lista.length
        ? lista.slice(0, 20).map((f) => `
            <div class="item" onclick='escolherFornecedorConta(${JSON.stringify(f).replace(/'/g, "&#39;")})'>
              <div class="d"><div class="nome">${esc(f.nome)}</div>
                <div class="sub">${f.cnpj ? docFmt(f.cnpj) + ' • ' : ''}${esc(f.telefone || 'sem telefone')}</div></div>
              ${Number(f.em_aberto) > 0 ? `<div class="preco" style="color:var(--vermelho);font-size:12px">deve<br>${R$(f.em_aberto)}</div>` : ''}
            </div>`).join('')
        : `<div style="padding:12px;font-size:13px;color:var(--texto-fraco)">
             Nenhum fornecedor com esse nome. Pode deixar assim mesmo — a conta guarda o nome digitado —
             ou <a href="#" onclick="cadastrarFornecedorRapido();return false"><strong>cadastrar agora</strong></a>.
           </div>`;
    } catch (e) { erro(e.message); }
  }, 220);
}

function escolherFornecedorConta(f) {
  setVal('cp_fornecedor_id', f.id);
  setVal('cp_fornecedor_busca', f.nome);
  el('cp_forn_resultado').style.display = 'none';
  el('cp_forn_sel').innerHTML = Number(f.em_aberto) > 0
    ? `Já em aberto com ele: <strong style="color:var(--vermelho)">${R$(f.em_aberto)}</strong> em ${f.contas_abertas} conta(s)`
    : 'Nenhuma conta em aberto com este fornecedor.';
}

async function cadastrarFornecedorRapido() {
  const nome = val('cp_fornecedor_busca');
  try {
    const r = await api('/api/fornecedores', { method: 'POST', body: { nome } });
    const lista = await api('/api/fornecedores?q=' + encodeURIComponent(nome));
    const f = lista.find((x) => x.id === r.id);
    if (f) escolherFornecedorConta(f);
    ok('Fornecedor cadastrado.');
  } catch (e) { erro(e.message); }
}

function previewParcelas() {
  const total = valor(el('cp_valor').value);
  const n = Math.max(1, parseInt(el('cp_parcelas').value) || 1);
  const intervalo = Math.max(1, parseInt(el('cp_intervalo').value) || 30);
  const primeiro = val('cp_vencimento');
  const box = el('cp_preview');

  if (n <= 1 || !total || !primeiro) { box.innerHTML = ''; return; }

  const base = Math.floor((total / n) * 100) / 100;
  const linhas = [];
  for (let i = 1; i <= n; i++) {
    const v = i === n ? Math.round((total - base * (n - 1)) * 100) / 100 : base;
    linhas.push({ i, v, venc: somarPrazoJs(primeiro, intervalo * (i - 1)) });
  }

  box.innerHTML = `
    <div class="aviso info" style="margin-top:6px"><span>📆</span><div>
      Vai lançar <strong>${n} parcelas</strong> de ${R$(base)}${linhas[n - 1].v !== base ? ` (a última de ${R$(linhas[n - 1].v)})` : ''}:
      <div style="margin-top:7px;display:flex;flex-wrap:wrap;gap:6px">
        ${linhas.map((l) => `<span class="pill cinza">${l.i}ª ${dataBr(l.venc)} — ${R$(l.v)}</span>`).join('')}
      </div>
    </div></div>`;
}

/** Mesma regra do servidor: prazo múltiplo de 30 anda de mês em mês. */
function somarPrazoJs(iso, dias) {
  const [a, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!a || !m || !d) return iso;
  if (dias === 0) return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (dias % 30 === 0) {
    let mes = m - 1 + dias / 30;
    const ano = a + Math.floor(mes / 12);
    mes = ((mes % 12) + 12) % 12;
    const ultimo = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
    return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
  }
  const dt = new Date(Date.UTC(a, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

/* [1.16] mostra o campo certo conforme "como vai pagar" */
function aplicarFormaPrevista() {
  const f = val('cp_forma_prevista');
  if (el('cp_boleto_box')) el('cp_boleto_box').style.display = f === 'BOLETO' ? '' : 'none';
  if (el('cp_boleto_linha_box')) el('cp_boleto_linha_box').style.display = f === 'BOLETO' ? '' : 'none';
  if (el('cp_pix_box')) el('cp_pix_box').style.display = f === 'PIX' ? '' : 'none';
}

/* lê um arquivo escolhido como base64 (sem o prefixo data:) */
function lerBoletoBase64(input) {
  return new Promise((resolve, reject) => {
    const f = input && input.files && input.files[0];
    if (!f) { resolve(null); return; }
    if (f.size > 4 * 1024 * 1024) { reject(new Error('O arquivo tem mais de 4 MB. Use um menor.')); return; }
    const fr = new FileReader();
    fr.onload = () => resolve({ nome: f.name, tipo: f.type, dados: String(fr.result).split(',')[1] || '' });
    fr.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    fr.readAsDataURL(f);
  });
}

function verBoleto(id) {
  window.open('/api/cp/contas/' + id + '/boleto?inline=1&token=' + encodeURIComponent(TOKEN), '_blank');
}
async function removerBoleto(id) {
  if (!confirm('Remover o boleto anexado?')) return;
  try {
    await api('/api/cp/contas/' + id + '/boleto', { method: 'DELETE' });
    if (el('cp_boleto_atual')) el('cp_boleto_atual').innerHTML = '';
    carregarPagar();
    ok('Boleto removido.');
  } catch (e) { erro(e.message); }
}

async function salvarConta() {
  if (valor(el('cp_valor').value) <= 0) { alerta('Informe o valor da conta.'); return; }
  if (!val('cp_vencimento')) { alerta('Informe o vencimento.'); return; }
  if (!val('cp_fornecedor_busca') && !val('cp_descricao')) {
    alerta('Informe o fornecedor ou a descrição.'); return;
  }
  let boleto = null;
  try { boleto = await lerBoletoBase64(el('cp_boleto_arq')); }
  catch (e) { erro(e.message); return; }
  try {
    const r = await api('/api/cp/contas', {
      method: 'POST',
      body: {
        id: val('cp_id') || null,
        fornecedor_id: val('cp_fornecedor_id') || null,
        fornecedor: val('cp_fornecedor_busca'),
        categoria_id: val('cp_categoria_id') || null,
        documento: val('cp_documento'),
        descricao: val('cp_descricao'),
        emissao: val('cp_emissao'),
        vencimento: val('cp_vencimento'),
        valor: valor(el('cp_valor').value),
        parcelas: parseInt(val('cp_parcelas')) || 1,
        intervalo_dias: parseInt(val('cp_intervalo')) || 30,
        observacao: val('cp_observacao'),
        forma_prevista: val('cp_forma_prevista'),
        pix_dados: val('cp_pix_dados'),
        boleto_linha: val('cp_boleto_linha')
      }
    });
    // [1.16] anexa o boleto, se escolhido (na conta editada, ou na 1ª parcela da nova)
    if (boleto) {
      const alvo = r.id || (r.ids && r.ids[0]);
      if (alvo) {
        try {
          await api('/api/cp/contas/' + alvo + '/boleto', { method: 'POST', body: boleto });
        } catch (e) { alerta('Conta salva, mas o boleto não subiu: ' + e.message); }
      }
    }
    fecharModal('modalConta');
    carregarPagar();
    ok(r.parcelas > 1 ? `${r.parcelas} parcelas lançadas.` : 'Conta lançada.');
  } catch (e) { erro(e.message); }
}

function abrirPagarConta(c) {
  setVal('pgId', c.id);
  setVal('pgJuros', '0');
  setVal('pgDesconto', '0');
  setVal('pgValor', Number(c.saldo).toFixed(2));
  if (el('pgSaiCaixa')) el('pgSaiCaixa').checked = false;
  setVal('pgObs', '');
  el('pgInfo').innerHTML = `
    <div style="background:#f5f7fa;border-radius:6px;padding:11px;font-size:13.5px;line-height:1.8">
      <div><strong>${esc(c.fornecedor || c.descricao || 'Conta')}</strong></div>
      ${c.descricao && c.fornecedor ? `<div>${esc(c.descricao)}</div>` : ''}
      <div>${c.documento ? 'Documento ' + esc(c.documento) + ' • ' : ''}
        ${c.total_parcelas > 1 ? `parcela ${c.parcela} de ${c.total_parcelas} • ` : ''}
        venc. ${dataBr(c.vencimento)}
        ${c.status === 'vencido' ? `<span class="pill vermelha">${c.dias} dias em atraso</span>` : ''}</div>
      <div style="margin-top:5px;font-size:16px"><strong>Saldo: ${R$(c.saldo)}</strong></div>
      ${c.forma_prevista === 'PIX' && txtPix(c) ? `<div style="margin-top:7px;background:#eef2f7;border-radius:6px;padding:8px 10px">
        <div style="font-size:11px;color:var(--texto-fraco);text-transform:uppercase;font-weight:700">🔑 Dados do PIX</div>
        <div style="word-break:break-all">${esc(txtPix(c))}</div>
        <button class="btn pequeno" style="margin-top:6px" onclick="copiarPix('${esc(txtPix(c)).replace(/'/g, "\\'")}')">Copiar</button></div>` : ''}
      ${c.boleto_linha ? `<div style="margin-top:7px;background:#eef2f7;border-radius:6px;padding:8px 10px">
        <div style="font-size:11px;color:var(--texto-fraco);text-transform:uppercase;font-weight:700">📶 Código de barras do boleto</div>
        <div style="word-break:break-all;font-variant-numeric:tabular-nums">${esc(c.boleto_linha)}</div>
        <button class="btn pequeno" style="margin-top:6px" onclick="copiarPix('${esc(c.boleto_linha).replace(/'/g, "\\'")}')">Copiar</button></div>` : ''}
      ${c.tem_boleto ? `<div style="margin-top:7px"><button class="btn" onclick="verBoleto(${c.id})">📎 Ver boleto</button></div>` : ''}
    </div>`;
  el('modalPagarConta').dataset.saldo = c.saldo;
  abrirModal('modalPagarConta');
  setTimeout(() => el('pgValor').select(), 100);
}

function txtPix(c) { return c.pix_dados || ''; }
function copiarPix(t) {
  if (navigator.clipboard) { navigator.clipboard.writeText(t).then(() => ok('Dados do PIX copiados.'), () => alerta('Copie manualmente.')); }
  else alerta('Copie manualmente: ' + t);
}

function recalcPagarConta() {
  const saldo = Number(el('modalPagarConta').dataset.saldo) || 0;
  const juros = valor(el('pgJuros').value);
  const desc = valor(el('pgDesconto').value);
  setVal('pgValor', Math.max(0, saldo + juros - desc).toFixed(2));
}

// campo "Forma" removido do pagar conta — a caixinha "tirar do caixa" controla a sangria

async function salvarPagarConta() {
  try {
    const r = await api(`/api/cp/contas/${val('pgId')}/pagar`, {
      method: 'POST',
      body: {
        valor: valor(el('pgValor').value),
        juros: valor(el('pgJuros').value),
        desconto: valor(el('pgDesconto').value),
        forma: 'DINHEIRO',
        sair_do_caixa: el('pgSaiCaixa').checked,
        observacao: val('pgObs')
      }
    });
    fecharModal('modalPagarConta');
    carregarPagar();
    ok((r.quitado ? 'Conta paga.' : 'Pagamento parcial registrado.') +
       (r.sangria ? ' Sangria lançada no caixa.' : ''));
  } catch (e) { erro(e.message); }
}

async function estornarConta(id) {
  if (!confirm('Estornar o pagamento desta conta? Ela volta para em aberto.')) return;
  try {
    const r = await api(`/api/cp/contas/${id}/estornar`, { method: 'POST' });
    carregarPagar();
    alerta(r.aviso || 'Pagamento estornado.');
  } catch (e) { erro(e.message); }
}

async function excluirConta(id, temGrupo) {
  let grupo = false;
  if (temGrupo) {
    const r = confirm('Essa conta faz parte de um parcelamento.\n\nOK = excluir TODAS as parcelas\nCancelar = escolher outra opção');
    if (r) grupo = true;
    else if (!confirm('Excluir somente esta parcela?')) return;
  } else if (!confirm('Excluir esta conta?')) return;

  try {
    const r = await api(`/api/cp/contas/${id}${grupo ? '?grupo=1' : ''}`, { method: 'DELETE' });
    carregarPagar();
    ok(`${r.excluidas} conta(s) excluída(s).`);
  } catch (e) { erro(e.message); }
}

/* ---------------- categorias de despesa ---------------- */
function abrirCategoriasCp() { renderCategoriasCp(); abrirModal('modalCategoriasCp'); }

function renderCategoriasCp() {
  el('catCpLista').innerHTML = `<table><tbody>
    ${CP_CATEGORIAS.map((c) => `<tr><td>${esc(c.nome)}</td>
      <td class="centro" style="width:44px"><button class="btn-ic" onclick="excluirCategoriaCp(${c.id})">🗑️</button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function salvarCategoriaCp() {
  if (!val('catCpNova')) return;
  try {
    await api('/api/cp/categorias', { method: 'POST', body: { nome: val('catCpNova') } });
    setVal('catCpNova', '');
    await carregarCategoriasCp();
    renderCategoriasCp();
    ok('Categoria adicionada.');
  } catch (e) { erro(e.message); }
}

async function excluirCategoriaCp(id) {
  if (!confirm('Excluir esta categoria?')) return;
  try {
    await api('/api/cp/categorias/' + id, { method: 'DELETE' });
    await carregarCategoriasCp();
    renderCategoriasCp();
  } catch (e) { erro(e.message); }
}

/* ============================ FORNECEDORES ============================ */

async function carregarFornecedores() {
  try {
    const p = new URLSearchParams();
    if (val('fornBusca')) p.set('q', val('fornBusca'));
    p.set('status', val('fornStatus'));
    const lista = await api('/api/fornecedores?' + p.toString());

    el('fornLista').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Nome</th><th>CNPJ</th><th>Telefone</th><th>Contato</th><th>Cidade</th>
        <th class="num">Em aberto</th><th class="centro">Contas</th><th class="num">Já pago</th>
        <th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${lista.map((f) => `<tr class="${f.status === 'ativo' ? '' : 'inativa'}">
        <td><strong>${esc(f.nome)}</strong></td>
        <td>${docFmt(f.cnpj) || '—'}</td>
        <td>${esc(f.telefone || '—')}</td>
        <td>${esc(f.contato || '—')}</td>
        <td>${esc(f.cidade || '—')}${f.uf ? '/' + esc(f.uf) : ''}</td>
        <td class="num" style="${Number(f.em_aberto) > 0 ? 'color:var(--vermelho);font-weight:700' : ''}">${N(f.em_aberto)}</td>
        <td class="centro">${f.contas_abertas}</td>
        <td class="num">${N(f.total_pago)}</td>
        <td class="centro"><span class="pill ${f.status === 'ativo' ? 'verde' : 'cinza'}">${esc(f.status)}</span></td>
        <td class="centro" style="white-space:nowrap">
          <button class="btn-ic" onclick='abrirFornecedor(${JSON.stringify(f).replace(/'/g, "&#39;")})' title="Editar">✏️</button>
          <button class="btn-ic" onclick="verContasFornecedor('${esc(f.nome).replace(/'/g, '')}')" title="Contas dele">💸</button>
          <button class="btn-ic" onclick="excluirFornecedor(${f.id}, '${esc(f.nome).replace(/'/g, '')}')" title="Excluir">🗑️</button>
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="5">${lista.length} fornecedor(es)</td>
        <td class="num">${N(lista.reduce((s, f) => s + Number(f.em_aberto), 0))}</td>
        <td colspan="4"></td></tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">🚚</span>Nenhum fornecedor cadastrado.</div>';
  } catch (e) { erro(e.message); }
}

function abrirFornecedor(f) {
  ['forn_nome', 'forn_cnpj', 'forn_telefone', 'forn_email', 'forn_contato',
   'forn_cidade', 'forn_uf', 'forn_observacao'].forEach((c) => setVal(c, ''));
  setVal('forn_id', '');
  setVal('forn_status', 'ativo');
  setVal('forn_uf', CONFIG.loja_uf || 'BA');
  el('fornecedorTitulo').textContent = 'Novo fornecedor';

  if (f && f.id) {
    Object.keys(f).forEach((k) => { if (el('forn_' + k)) setVal('forn_' + k, f[k]); });
    setVal('forn_id', f.id);
    el('fornecedorTitulo').textContent = 'Editar fornecedor';
  }
  abrirModal('modalFornecedor');
  setTimeout(() => el('forn_nome').focus(), 100);
}

async function salvarFornecedor() {
  if (!val('forn_nome')) { alerta('Informe o nome.'); return; }
  try {
    await api('/api/fornecedores', {
      method: 'POST',
      body: {
        id: val('forn_id') || null, nome: val('forn_nome'), cnpj: val('forn_cnpj'),
        telefone: val('forn_telefone'), email: val('forn_email'), contato: val('forn_contato'),
        cidade: val('forn_cidade'), uf: val('forn_uf'),
        observacao: val('forn_observacao'), status: val('forn_status')
      }
    });
    fecharModal('modalFornecedor');
    if (SECAO_ATUAL === 'fornecedores') carregarFornecedores();
    ok('Fornecedor salvo.');
  } catch (e) { erro(e.message); }
}

async function excluirFornecedor(id, nome) {
  if (!confirm(`Excluir o fornecedor "${nome}"?\n\nSe ele já tiver contas, será apenas inativado.`)) return;
  try {
    const r = await api('/api/fornecedores/' + id, { method: 'DELETE' });
    carregarFornecedores();
    if (r.aviso) alerta(r.aviso); else ok('Fornecedor excluído.');
  } catch (e) { erro(e.message); }
}

/** Abre o Contas a Pagar já filtrado no fornecedor, com o histórico todo. */
function verContasFornecedor(nome) {
  irPara('pagar');
  setTimeout(() => {
    setVal('cpSituacao', 'todas');
    setVal('cpDe', '2000-01-01');
    setVal('cpAte', somaDias(hojeIso(), 3650));
    setVal('cpCategoria', '');
    setVal('cpBusca', nome);
    el('atalhosPagar').querySelectorAll('button').forEach((b) => b.classList.remove('ativo'));
    carregarPagar();
  }, 150);
}

/* ============================ FLUXO DE CAIXA ============================ */

async function carregarFluxo() {
  try {
    const f = await api('/api/financeiro/fluxo');
    const maior = Math.max(...f.faixas.map((l) => Math.max(l.receber, l.pagar)), 1);

    el('fluxoSaida').innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        ${tile('A receber (crediário)', R$(f.total_crediario), 'clientes a prazo', 'verde')}
        ${tile('A receber (cartão)', R$(f.total_cartao), 'maquininhas, já sem taxa', 'verde')}
        ${tile('Total a pagar', R$(f.total_pagar), 'contas em aberto', 'vermelho')}
        ${tile('Saldo projetado', R$(f.saldo), f.saldo >= 0 ? 'sobra prevista' : 'falta prevista',
          f.saldo >= 0 ? 'verde' : 'vermelho')}
      </div>

      <div class="card"><h3>⏱️ Por prazo</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Prazo</th><th class="num">Crediário</th><th class="num">Cartão</th>
            <th class="num">Entra</th><th class="num">Sai</th>
            <th class="num">Saldo</th><th style="width:210px">Comparativo</th></tr></thead>
          <tbody>${f.faixas.map((l) => `<tr>
            <td><strong>${esc(l.rotulo)}</strong>
              <div style="font-size:11px;color:var(--texto-fraco)">${dataBr(l.de)} a ${dataBr(l.ate)}</div></td>
            <td class="num">${l.crediario ? N(l.crediario) : '—'}</td>
            <td class="num">${l.cartao ? N(l.cartao) : '—'}</td>
            <td class="num" style="color:var(--verde)"><strong>${l.receber ? N(l.receber) : '—'}</strong></td>
            <td class="num" style="color:var(--vermelho)"><strong>${l.pagar ? N(l.pagar) : '—'}</strong></td>
            <td class="num"><strong style="color:${l.saldo >= 0 ? 'var(--verde)' : 'var(--vermelho)'}">${N(l.saldo)}</strong></td>
            <td>
              ${barra((l.receber / maior) * 100, 'var(--verde)')}
              <div style="height:3px"></div>
              ${barra((l.pagar / maior) * 100, 'var(--vermelho)')}
            </td></tr>`).join('')}
          </tbody>
          <tfoot><tr><td>TOTAL</td>
            <td class="num">${N(f.total_crediario)}</td>
            <td class="num">${N(f.total_cartao)}</td>
            <td class="num">${N(f.total_receber)}</td>
            <td class="num">${N(f.total_pagar)}</td>
            <td class="num">${N(f.saldo)}</td><td></td></tr></tfoot>
        </table></div>
        <div style="margin-top:9px;font-size:12px;color:var(--texto-fraco)">
          Barra <span style="color:var(--verde)">verde</span> = entra • barra
          <span style="color:var(--vermelho)">vermelha</span> = sai
        </div>
      </div>

      <div class="card"><h3>📅 Mês a mês</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Mês</th><th class="num">Crediário</th><th class="num">Cartão</th>
            <th class="num">Entra</th><th class="num">Sai</th>
            <th class="num">Saldo do mês</th><th class="num">Saldo acumulado</th></tr></thead>
          <tbody>${(() => {
            let ac = 0;
            return f.meses.map((m) => {
              ac += m.saldo;
              const [a, mes] = m.mes.split('-');
              return `<tr>
                <td>${mes}/${a}</td>
                <td class="num">${m.crediario ? N(m.crediario) : '—'}</td>
                <td class="num">${m.cartao ? N(m.cartao) : '—'}</td>
                <td class="num" style="color:var(--verde)">${m.receber ? N(m.receber) : '—'}</td>
                <td class="num" style="color:var(--vermelho)">${m.pagar ? N(m.pagar) : '—'}</td>
                <td class="num"><strong style="color:${m.saldo >= 0 ? 'var(--verde)' : 'var(--vermelho)'}">${N(m.saldo)}</strong></td>
                <td class="num" style="color:${ac >= 0 ? 'var(--verde)' : 'var(--vermelho)'}">${N(ac)}</td>
              </tr>`;
            }).join('');
          })() || '<tr><td colspan="7" class="centro" style="padding:20px">Nada em aberto.</td></tr>'}
          </tbody></table></div>
      </div>`;
  } catch (e) { erro(e.message); }
}

/* ============================ RELATÓRIO DE DESPESAS ============================ */

async function carregarRelDespesas() {
  try {
    const r = await api(`/api/cp/resumo?de=${val('relDDe')}&ate=${val('relDAte')}`);
    const rv = await api(`/api/relatorios/vendas?de=${val('relDDe')}&ate=${val('relDAte')}`);

    const lucroBruto = rv.totais.lucro;
    const resultado = lucroBruto - r.total_geral;

    el('relDespesasSaida').innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        ${tile('Total de despesas', R$(r.total_geral), 'no período', 'vermelho')}
        ${tile('Lucro bruto das vendas', R$(lucroBruto), 'venda menos custo da mercadoria', 'verde')}
        ${tile('Resultado', R$(resultado), resultado >= 0 ? 'a loja fechou no azul' : 'a loja fechou no vermelho',
          resultado >= 0 ? 'verde' : 'vermelho')}
        ${tile('Despesa sobre a venda', rv.totais.total ? ((r.total_geral / rv.totais.total) * 100).toFixed(1) + '%' : '—',
          'quanto do faturamento vira despesa', 'laranja')}
      </div>

      <div class="card"><h3>🗂️ Despesas por categoria</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Categoria</th><th class="centro">Contas</th><th class="num">Total</th>
            <th class="num">Já pago</th><th class="num">Em aberto</th><th style="width:180px">Participação</th></tr></thead>
          <tbody>${r.por_categoria.map((c) => `<tr>
            <td><strong>${esc(c.nome)}</strong></td>
            <td class="centro">${c.qtd}</td>
            <td class="num"><strong>${N(c.total)}</strong></td>
            <td class="num">${N(c.pago)}</td>
            <td class="num">${N(c.total - c.pago)}</td>
            <td>${barra(c.participacao, 'var(--vermelho)')}<small>${c.participacao.toFixed(1)}%</small></td>
          </tr>`).join('') || '<tr><td colspan="6" class="centro" style="padding:20px">Nenhuma despesa no período.</td></tr>'}
          </tbody>
          <tfoot><tr><td colspan="2">TOTAL</td><td class="num">${N(r.total_geral)}</td>
            <td colspan="3"></td></tr></tfoot>
        </table></div>
      </div>

      <div class="grid g2">
        <div class="card"><h3>🚚 Por fornecedor</h3>
          <div class="tabela-wrap"><table>
            <thead><tr><th>Fornecedor</th><th class="centro">Contas</th>
              <th class="num">Total</th><th class="num">Em aberto</th></tr></thead>
            <tbody>${r.por_fornecedor.map((f) => `<tr>
              <td>${esc(f.nome)}</td><td class="centro">${f.qtd}</td>
              <td class="num"><strong>${N(f.total)}</strong></td>
              <td class="num" style="${f.aberto > 0 ? 'color:var(--vermelho)' : ''}">${N(f.aberto)}</td>
            </tr>`).join('') || '<tr><td colspan="4" class="centro" style="padding:20px">Sem dados.</td></tr>'}
            </tbody></table></div>
        </div>

        <div class="card"><h3>📅 Por mês de vencimento</h3>
          <div class="tabela-wrap"><table>
            <thead><tr><th>Mês</th><th class="num">Total</th><th class="num">Em aberto</th></tr></thead>
            <tbody>${r.por_mes.map((m) => {
              const [a, mes] = m.mes.split('-');
              return `<tr><td>${mes}/${a}</td><td class="num"><strong>${N(m.total)}</strong></td>
                <td class="num">${N(m.aberto)}</td></tr>`;
            }).join('') || '<tr><td colspan="3" class="centro" style="padding:20px">Sem dados.</td></tr>'}
            </tbody></table></div>
        </div>
      </div>`;
  } catch (e) { erro(e.message); }
}
