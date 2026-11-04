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

    el('cpTotais').innerHTML = `
      ${tile('Em aberto', R$(r.totais.em_aberto), 'total a pagar no filtro', '')}
      ${tile('Vencidas', R$(r.totais.vencidas), r.totais.qtd_vencidas + ' conta(s) em atraso',
        r.totais.vencidas > 0 ? 'vermelho' : 'verde')}
      ${tile('Vencem hoje', R$(r.totais.vence_hoje), 'pagar hoje', 'laranja')}
      ${tile('Já pago', R$(r.totais.pago), 'no filtro atual', 'verde')}`;

    const pill = { pago: 'verde', vencido: 'vermelha', vence_hoje: 'amarela', aberto: 'azul' };
    const rot = { pago: 'pago', vencido: 'vencida', vence_hoje: 'vence hoje', aberto: 'em aberto' };

    el('cpLista').innerHTML = r.contas.length ? `
      <table><thead><tr>
        <th>Vencimento</th><th class="centro">Atraso</th><th>Fornecedor</th><th>Descrição</th>
        <th>Categoria</th><th>Documento</th><th class="num">Valor</th><th class="num">Pago</th>
        <th class="num">Saldo</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${r.contas.map((c) => `<tr>
        <td style="white-space:nowrap;${c.status === 'vencido' ? 'color:var(--vermelho);font-weight:700' : ''}">${dataBr(c.vencimento)}</td>
        <td class="centro">${c.status === 'vencido' ? c.dias + ' d' : '—'}</td>
        <td><strong>${esc(c.fornecedor || '—')}</strong></td>
        <td>${esc(c.descricao || '—')}
          ${c.total_parcelas > 1 ? `<span class="pill cinza">${c.parcela}/${c.total_parcelas}</span>` : ''}</td>
        <td style="font-size:12px">${esc(c.categoria || '—')}</td>
        <td>${esc(c.documento || '—')}</td>
        <td class="num">${N(c.valor)}</td>
        <td class="num">${Number(c.valor_pago) > 0 ? N(c.valor_pago) : '—'}</td>
        <td class="num"><strong>${c.status === 'pago' ? '—' : N(c.saldo)}</strong></td>
        <td class="centro"><span class="pill ${pill[c.status]}">${rot[c.status]}</span></td>
        <td class="centro" style="white-space:nowrap">
          ${c.status !== 'pago'
            ? `<button class="btn pequeno verde" onclick='abrirPagarConta(${JSON.stringify(c).replace(/'/g, "&#39;")})'>💸 Pagar</button>
               <button class="btn-ic" onclick="abrirConta(${c.id})" title="Editar">✏️</button>`
            : `<button class="btn-ic" onclick="estornarConta(${c.id})" title="Estornar pagamento">↺</button>`}
          <button class="btn-ic" onclick="excluirConta(${c.id}, ${c.total_parcelas > 1 ? 1 : 0})" title="Excluir">🗑️</button>
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="6">${r.contas.length} conta(s)</td>
        <td class="num">${N(r.contas.reduce((s, c) => s + Number(c.valor), 0))}</td>
        <td class="num">${N(r.totais.pago)}</td>
        <td class="num">${N(r.totais.em_aberto)}</td>
        <td colspan="2"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">💸</span>Nenhuma conta no filtro.</div>';
  } catch (e) { erro(e.message); }
}

async function abrirConta(id) {
  if (!CP_CATEGORIAS.length) await carregarCategoriasCp();

  ['cp_fornecedor_busca', 'cp_descricao', 'cp_documento', 'cp_valor', 'cp_observacao']
    .forEach((c) => setVal(c, ''));
  setVal('cp_id', '');
  setVal('cp_fornecedor_id', '');
  setVal('cp_categoria_id', '');
  setVal('cp_emissao', hojeIso());
  setVal('cp_vencimento', somaDias(hojeIso(), 30));
  setVal('cp_parcelas', '1');
  setVal('cp_intervalo', '30');
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
      el('cp_linha_parcelas').style.display = 'none';
      el('contaTitulo').textContent = c.total_parcelas > 1
        ? `Editar parcela ${c.parcela} de ${c.total_parcelas}`
        : 'Editar conta a pagar';
    } catch (e) { erro(e.message); return; }
  }

  abrirModal('modalConta');
  setTimeout(() => el('cp_fornecedor_busca').focus(), 100);
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

async function salvarConta() {
  if (valor(el('cp_valor').value) <= 0) { alerta('Informe o valor da conta.'); return; }
  if (!val('cp_vencimento')) { alerta('Informe o vencimento.'); return; }
  if (!val('cp_fornecedor_busca') && !val('cp_descricao')) {
    alerta('Informe o fornecedor ou a descrição.'); return;
  }
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
        observacao: val('cp_observacao')
      }
    });
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
  setVal('pgForma', 'DINHEIRO');
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
    </div>`;
  el('modalPagarConta').dataset.saldo = c.saldo;
  mostrarSairCaixa();
  abrirModal('modalPagarConta');
  setTimeout(() => el('pgValor').select(), 100);
}

function recalcPagarConta() {
  const saldo = Number(el('modalPagarConta').dataset.saldo) || 0;
  const juros = valor(el('pgJuros').value);
  const desc = valor(el('pgDesconto').value);
  setVal('pgValor', Math.max(0, saldo + juros - desc).toFixed(2));
}

function mostrarSairCaixa() {
  el('pgSairCaixa').style.display = val('pgForma') === 'DINHEIRO' ? 'block' : 'none';
}

async function salvarPagarConta() {
  try {
    const r = await api(`/api/cp/contas/${val('pgId')}/pagar`, {
      method: 'POST',
      body: {
        valor: valor(el('pgValor').value),
        juros: valor(el('pgJuros').value),
        desconto: valor(el('pgDesconto').value),
        forma: val('pgForma'),
        sair_do_caixa: val('pgForma') === 'DINHEIRO' && el('pgSaiCaixa').checked,
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
