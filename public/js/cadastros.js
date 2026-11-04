/* ==========================================================================
   cadastros.js — produtos, categorias, estoque e clientes
   ========================================================================== */

/* ============================ PRODUTOS ============================ */

async function carregarProdutos() {
  try {
    const p = new URLSearchParams();
    if (val('prodBusca')) p.set('q', val('prodBusca'));
    if (val('prodCategoria')) p.set('categoria', val('prodCategoria'));
    if (val('prodAtivo') === 'todos') p.set('ativo', 'todos');
    if (el('prodCriticos').checked) p.set('abaixo_minimo', '1');

    const lista = await api('/api/produtos?' + p.toString());
    el('prodLista').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Código</th><th>Descrição</th><th>Categoria</th><th class="centro">Un.</th>
        <th class="num">Custo</th><th class="num">Venda</th><th class="num">Margem</th>
        <th class="num">Estoque</th><th class="num">Mín.</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${lista.map((x) => {
        const margem = Number(x.preco_custo) > 0
          ? ((Number(x.preco_venda) - Number(x.preco_custo)) / Number(x.preco_custo)) * 100 : 0;
        const baixo = Number(x.estoque) <= Number(x.estoque_minimo);
        return `<tr class="${x.ativo ? '' : 'inativa'}">
          <td>${esc(x.codigo)}${x.codigo_barras ? `<div style="font-size:10.5px;color:var(--texto-fraco)">${esc(x.codigo_barras)}</div>` : ''}</td>
          <td><strong>${esc(x.descricao)}</strong>${x.localizacao ? `<div style="font-size:11px;color:var(--texto-fraco)">📍 ${esc(x.localizacao)}</div>` : ''}</td>
          <td>${esc(x.categoria || '-')}</td>
          <td class="centro">${esc(x.unidade)}</td>
          <td class="num">${N(x.preco_custo)}</td>
          <td class="num"><strong>${N(x.preco_venda)}</strong></td>
          <td class="num" style="color:${margem >= 20 ? 'var(--verde)' : 'var(--laranja-esc)'}">${margem.toFixed(0)}%</td>
          <td class="num" style="${baixo ? 'color:var(--vermelho);font-weight:700' : ''}">${Q(x.estoque)}${Number(x.reservado) > 0
            ? `<div style="font-size:10.5px;color:var(--laranja-esc);font-weight:400" title="vendido e ainda não entregue">${Q(x.reservado)} a entregar · ${Q(x.disponivel)} livre</div>` : ''}</td>
          <td class="num">${Q(x.estoque_minimo)}</td>
          <td class="centro">${x.ativo ? '<span class="pill verde">ativo</span>' : '<span class="pill cinza">inativo</span>'}</td>
          <td class="centro" style="white-space:nowrap">
            <button class="btn-ic" onclick="abrirProduto(${x.id})" title="Editar">✏️</button>
            ${podeVer('excluir') ? `<button class="btn-ic" onclick="excluirProduto(${x.id}, '${esc(x.descricao).replace(/'/g, '')}')" title="Excluir">🗑️</button>` : ''}
          </td></tr>`;
      }).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="7">${lista.length} produto(s)</td>
        <td class="num">${Q(lista.reduce((s, x) => s + Number(x.estoque), 0))}</td>
        <td colspan="3"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">📦</span>Nenhum produto encontrado.</div>';
  } catch (e) { erro(e.message); }
}

async function abrirProduto(id) {
  ['prod_codigo', 'prod_codigo_barras', 'prod_descricao', 'prod_ncm', 'prod_localizacao',
   'prod_fornecedor', 'prod_marca', 'prod_margem',
   'prod_cest', 'prod_cfop', 'prod_origem', 'prod_csosn'].forEach((c) => setVal(c, ''));
  el('prodFiscal').open = false;
  setVal('prod_id', '');
  setVal('prod_preco_custo', '0');
  setVal('prod_preco_venda', '0');
  setVal('prod_estoque', '0');
  setVal('prod_estoque_minimo', '0');
  setVal('prod_unidade', 'UN');
  setVal('prod_categoria_id', '');
  el('prod_fracionado').checked = false;
  el('prod_ativo').checked = true;
  el('prod_estoque').readOnly = false;
  el('prodAvisoEstoque').innerHTML = '';
  el('produtoTitulo').textContent = 'Novo produto';

  if (id) {
    try {
      const p = await api('/api/produtos/' + id);
      setVal('prod_id', p.id);
      setVal('prod_codigo', p.codigo);
      setVal('prod_codigo_barras', p.codigo_barras);
      setVal('prod_descricao', p.descricao);
      setVal('prod_categoria_id', p.categoria_id || '');
      setVal('prod_unidade', p.unidade);
      setVal('prod_ncm', p.ncm);
      if (typeof mostrarDescricaoNcm === 'function') mostrarDescricaoNcm('prod_ncm', 'prodNcmDica');
      setVal('prod_cest', p.cest || '');
      setVal('prod_cfop', p.cfop || '');
      setVal('prod_origem', p.origem || '');
      setVal('prod_csosn', p.csosn || '');
      // ja abre a parte fiscal quando o produto tem tributacao propria
      el('prodFiscal').open = !!(p.cest || p.cfop || p.origem || p.csosn);
      setVal('prod_preco_custo', Number(p.preco_custo).toFixed(2));
      setVal('prod_preco_venda', Number(p.preco_venda).toFixed(2));
      setVal('prod_estoque', p.estoque);
      setVal('prod_estoque_minimo', p.estoque_minimo);
      setVal('prod_localizacao', p.localizacao);
      setVal('prod_fornecedor', p.fornecedor);
      setVal('prod_marca', p.marca);
      el('prod_fracionado').checked = !!p.fracionado;
      el('prod_ativo').checked = !!p.ativo;
      el('prod_estoque').readOnly = true;
      el('prodAvisoEstoque').innerHTML = `<div class="aviso info"><span>ℹ️</span><div>
        O saldo do estoque só muda por <strong>venda</strong> ou pela tela de <strong>Estoque</strong>
        (entrada, saída ou ajuste), para o histórico não se perder.</div></div>`;
      el('produtoTitulo').textContent = 'Editar produto';
    } catch (e) { erro(e.message); return; }
  }
  calcMargem();
  abrirModal('modalProduto');
  setTimeout(() => el('prod_descricao').focus(), 100);
}

function calcMargem() {
  const custo = valor(el('prod_preco_custo').value);
  const venda = valor(el('prod_preco_venda').value);
  setVal('prod_lucro', R$(venda - custo));
  // nao reescreve a margem enquanto o usuario estiver digitando nela
  if (custo > 0 && document.activeElement !== el('prod_margem')) {
    setVal('prod_margem', (((venda - custo) / custo) * 100).toFixed(1));
  }
}

function aplicarMargem() {
  const custo = valor(el('prod_preco_custo').value);
  const margem = valor(el('prod_margem').value);
  if (custo > 0) {
    setVal('prod_preco_venda', (custo * (1 + margem / 100)).toFixed(2));
    setVal('prod_lucro', R$(custo * (margem / 100)));
  }
}

async function salvarProduto() {
  if (!val('prod_descricao')) { alerta('Informe a descrição.'); return; }
  if (valor(el('prod_preco_venda').value) <= 0 && !confirm('O preço de venda está zerado. Salvar assim?')) return;

  try {
    await api('/api/produtos', {
      method: 'POST',
      body: {
        id: val('prod_id') || null,
        codigo: val('prod_codigo'),
        codigo_barras: val('prod_codigo_barras'),
        descricao: val('prod_descricao'),
        categoria_id: val('prod_categoria_id') || null,
        unidade: val('prod_unidade'),
        ncm: val('prod_ncm'),
        cest: val('prod_cest'),
        cfop: val('prod_cfop'),
        origem: val('prod_origem'),
        csosn: val('prod_csosn'),
        preco_custo: valor(el('prod_preco_custo').value),
        preco_venda: valor(el('prod_preco_venda').value),
        estoque: valor(el('prod_estoque').value),
        estoque_minimo: valor(el('prod_estoque_minimo').value),
        fracionado: el('prod_fracionado').checked ? 1 : 0,
        localizacao: val('prod_localizacao'),
        fornecedor: val('prod_fornecedor'),
        marca: val('prod_marca'),
        ativo: el('prod_ativo').checked ? 1 : 0
      }
    });
    fecharModal('modalProduto');
    carregarProdutos();
    ok('Produto salvo.');
  } catch (e) { erro(e.message); }
}

async function excluirProduto(id, nome) {
  if (!confirm(`Excluir o produto "${nome}"?\n\nSe ele já tiver vendas, será apenas inativado.`)) return;
  try {
    const r = await api('/api/produtos/' + id, { method: 'DELETE' });
    carregarProdutos();
    if (r.aviso) alerta(r.aviso); else ok('Produto excluído.');
  } catch (e) { erro(e.message); }
}

/* ---------------- categorias ---------------- */
function abrirCategorias() { renderCategorias(); abrirModal('modalCategorias'); }

function renderCategorias() {
  el('catLista').innerHTML = `<table><tbody>
    ${CATEGORIAS.map((c) => `<tr>
      <td>${esc(c.nome)}</td>
      <td class="centro" style="width:44px"><button class="btn-ic" onclick="excluirCategoria(${c.id})">🗑️</button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function salvarCategoria() {
  if (!val('catNova')) return;
  try {
    await api('/api/categorias', { method: 'POST', body: { nome: val('catNova') } });
    setVal('catNova', '');
    CATEGORIAS = await api('/api/categorias');
    preencherCategorias();
    renderCategorias();
    ok('Categoria adicionada.');
  } catch (e) { erro(e.message); }
}

async function excluirCategoria(id) {
  if (!confirm('Excluir esta categoria?')) return;
  try {
    await api('/api/categorias/' + id, { method: 'DELETE' });
    CATEGORIAS = await api('/api/categorias');
    preencherCategorias();
    renderCategorias();
  } catch (e) { erro(e.message); }
}

/* ---------------- reajuste ---------------- */
function abrirReajuste() { setVal('rjPercentual', ''); abrirModal('modalReajuste'); }

async function salvarReajuste() {
  const p = valor(el('rjPercentual').value);
  if (!p) { alerta('Informe o percentual.'); return; }
  if (!confirm(`Aplicar ${p}% no preço de ${val('rjCampo') === 'custo' ? 'custo' : 'venda'}?\nNão tem como desfazer.`)) return;
  try {
    const r = await api('/api/produtos/reajuste', {
      method: 'POST',
      body: { percentual: p, campo: val('rjCampo'), categoria_id: val('rjCategoria') || null }
    });
    fecharModal('modalReajuste');
    carregarProdutos();
    ok(`${r.alterados} produto(s) reajustado(s).`);
  } catch (e) { erro(e.message); }
}

/* ============================ ESTOQUE ============================ */

async function carregarEstoque() {
  try {
    const r = await api('/api/estoque/resumo');
    el('estoqueTiles').innerHTML = `
      ${tile('Produtos ativos', r.produtos, 'itens no cadastro', '')}
      ${tile('Estoque a preço de custo', R$(r.valor_custo), 'quanto está parado na loja', '')}
      ${tile('Estoque a preço de venda', R$(r.valor_venda), 'quanto vale se vender tudo', 'verde')}
      ${tile('No estoque mínimo', r.criticos.length, 'precisam de reposição', r.criticos.length ? 'vermelho' : 'verde')}`;

    el('estoqueCriticos').innerHTML = r.criticos.length ? `
      <table><thead><tr><th>Código</th><th>Produto</th><th class="num">Saldo</th>
        <th class="num">Mínimo</th><th class="num">Sugestão de compra</th><th></th></tr></thead><tbody>
      ${r.criticos.map((p) => `<tr>
        <td>${esc(p.codigo)}</td><td>${esc(p.descricao)}</td>
        <td class="num" style="color:var(--vermelho);font-weight:700">${Q(p.estoque)} ${esc(p.unidade)}</td>
        <td class="num">${Q(p.estoque_minimo)}</td>
        <td class="num">${Q(Math.max(0, Number(p.estoque_minimo) * 2 - Number(p.estoque)))} ${esc(p.unidade)}</td>
        <td class="centro"><button class="btn pequeno verde" onclick="abrirMovEstoque('entrada', ${p.id})">⬆️ Entrada</button></td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="vazio"><span class="ic">✅</span>Nenhum produto abaixo do mínimo.</div>';

    carregarMovimentos();
  } catch (e) { erro(e.message); }
}

async function carregarMovimentos() {
  try {
    const p = new URLSearchParams();
    if (val('movTipo')) p.set('tipo', val('movTipo'));
    const lista = await api('/api/estoque/movimentos?' + p.toString());

    const cor = { entrada: 'verde', saida: 'vermelha', ajuste: 'amarela' };
    el('estoqueMovimentos').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Data</th><th class="centro">Tipo</th><th>Produto</th><th class="num">Qtd.</th>
        <th class="num">Antes</th><th class="num">Depois</th><th>Documento</th><th>Observação</th><th>Usuário</th>
      </tr></thead><tbody>
      ${lista.map((m) => `<tr>
        <td style="white-space:nowrap">${dataHoraBr(m.data)}</td>
        <td class="centro"><span class="pill ${cor[m.tipo] || 'cinza'}">${esc(m.tipo)}</span></td>
        <td>${esc(m.descricao || '(produto excluído)')}</td>
        <td class="num">${Q(m.quantidade)} ${esc(m.unidade || '')}</td>
        <td class="num">${Q(m.saldo_anterior)}</td>
        <td class="num"><strong>${Q(m.saldo_novo)}</strong></td>
        <td>${esc(m.documento || '-')}</td>
        <td>${esc(m.observacao || '-')}</td>
        <td>${esc(m.usuario || '-')}</td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="vazio"><span class="ic">📜</span>Nenhuma movimentação registrada.</div>';
  } catch (e) { erro(e.message); }
}

function abrirMovEstoque(tipo, produtoId) {
  setVal('est_tipo', tipo);
  setVal('est_produto_id', '');
  setVal('est_produto_busca', '');
  setVal('est_quantidade', '');
  setVal('est_custo', '0');
  setVal('est_documento', '');
  setVal('est_observacao', '');
  el('est_produto_sel').textContent = '';
  el('est_resultado').style.display = 'none';

  const titulos = {
    entrada: '⬆️ Entrada de mercadoria',
    saida: '⬇️ Saída / baixa de estoque',
    ajuste: '🔧 Ajuste de saldo (inventário)'
  };
  el('estoqueTitulo').textContent = titulos[tipo];
  el('est_lbl_qtd').textContent = tipo === 'ajuste' ? 'Saldo correto (contado) *' : 'Quantidade *';
  el('est_aviso').innerHTML = tipo === 'ajuste'
    ? '<div class="aviso alerta"><span>⚠️</span><div>No ajuste, informe o <strong>saldo real contado</strong>. O sistema grava a diferença no histórico.</div></div>'
    : '';

  abrirModal('modalEstoque');
  if (produtoId) selecionarProdutoEstoquePorId(produtoId);
  else setTimeout(() => el('est_produto_busca').focus(), 100);
}

async function selecionarProdutoEstoquePorId(id) {
  try {
    const p = await api('/api/produtos/' + id);
    aplicarProdutoEstoque(p);
  } catch (e) { erro(e.message); }
}

let timerEst = null;
function buscarProdutoEstoque() {
  clearTimeout(timerEst);
  timerEst = setTimeout(async () => {
    const t = val('est_produto_busca');
    const c = el('est_resultado');
    if (t.length < 2) { c.style.display = 'none'; return; }
    try {
      const lista = await api('/api/produtos/busca?q=' + encodeURIComponent(t));
      c.style.display = 'block';
      c.innerHTML = lista.length ? lista.map((p) => `
        <div class="item" onclick='aplicarProdutoEstoque(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
          <div class="d"><div class="nome">${esc(p.descricao)}</div>
            <div class="sub">Cód. ${esc(p.codigo)} • saldo ${Q(p.estoque)} ${esc(p.unidade)}</div></div>
          <div class="preco">${R$(p.preco_venda)}</div>
        </div>`).join('')
        : '<div class="vazio" style="padding:16px">Nada encontrado.</div>';
    } catch (e) { erro(e.message); }
  }, 200);
}

function aplicarProdutoEstoque(p) {
  setVal('est_produto_id', p.id);
  setVal('est_produto_busca', p.descricao);
  el('est_resultado').style.display = 'none';
  el('est_produto_sel').innerHTML =
    `Saldo atual: <strong>${Q(p.estoque)} ${esc(p.unidade)}</strong> • custo ${R$(p.preco_custo)}`;
  if (Number(p.preco_custo) > 0) setVal('est_custo', Number(p.preco_custo).toFixed(2));
  setTimeout(() => el('est_quantidade').focus(), 60);
}

async function salvarMovEstoque() {
  if (!val('est_produto_id')) { alerta('Escolha o produto.'); return; }
  const q = valor(el('est_quantidade').value);
  if (val('est_tipo') !== 'ajuste' && q <= 0) { alerta('Informe a quantidade.'); return; }

  try {
    const r = await api('/api/estoque/movimento', {
      method: 'POST',
      body: {
        produto_id: Number(val('est_produto_id')),
        tipo: val('est_tipo'),
        quantidade: q,
        custo: valor(el('est_custo').value),
        documento: val('est_documento'),
        observacao: val('est_observacao')
      }
    });
    fecharModal('modalEstoque');
    carregarEstoque();
    ok('Movimento lançado. Novo saldo: ' + Q(r.saldo));
  } catch (e) { erro(e.message); }
}

/* ============================ CLIENTES ============================ */

async function carregarClientes() {
  try {
    const p = new URLSearchParams();
    if (val('cliBusca')) p.set('q', val('cliBusca'));
    p.set('status', val('cliStatus'));
    const lista = await api('/api/clientes?' + p.toString());

    el('cliLista').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Nome</th><th>CPF/CNPJ</th><th>Telefone</th><th>Cidade</th>
        <th class="num">Limite</th><th class="num">Devendo</th><th class="num">Disponível</th>
        <th class="num">Compras</th><th>Última compra</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${lista.map((c) => {
        const dias = c.ultima_compra
          ? Math.floor((new Date() - new Date(c.ultima_compra)) / 86400000) : null;
        return `<tr class="${c.status === 'ativo' ? '' : 'inativa'}">
          <td><strong>${esc(c.nome)}</strong></td>
          <td>${docFmt(c.cpf_cnpj) || '-'}</td>
          <td>${esc(c.telefone || '-')}</td>
          <td>${esc(c.cidade || '-')}${c.uf ? '/' + esc(c.uf) : ''}</td>
          <td class="num">${N(c.limite_credito)}</td>
          <td class="num" style="${Number(c.saldo_devedor) > 0 ? 'color:var(--vermelho);font-weight:700' : ''}">${N(c.saldo_devedor)}</td>
          <td class="num" style="color:var(--verde)">${N(c.credito_disponivel)}</td>
          <td class="num">${c.compras}</td>
          <td style="${dias !== null && dias > 60 ? 'color:var(--laranja-esc);font-weight:600' : ''}">
            ${c.ultima_compra ? dataBr(c.ultima_compra) + (dias !== null ? ` (${dias}d)` : '') : '—'}</td>
          <td class="centro"><span class="pill ${c.status === 'ativo' ? 'verde' : 'cinza'}">${esc(c.status)}</span></td>
          <td class="centro" style="white-space:nowrap">
            <button class="btn-ic" onclick="abrirCliente(${c.id})" title="Editar">✏️</button>
            <button class="btn-ic" onclick="verTitulosCliente(${c.id})" title="Contas a receber">📆</button>
            ${podeVer('excluir') ? `<button class="btn-ic" onclick="excluirCliente(${c.id}, '${esc(c.nome).replace(/'/g, '')}')" title="Excluir">🗑️</button>` : ''}
          </td></tr>`;
      }).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="4">${lista.length} cliente(s)</td>
        <td class="num">${N(lista.reduce((s, c) => s + Number(c.limite_credito), 0))}</td>
        <td class="num">${N(lista.reduce((s, c) => s + Number(c.saldo_devedor), 0))}</td>
        <td colspan="5"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">👥</span>Nenhum cliente encontrado.</div>';
  } catch (e) { erro(e.message); }
}

let CLIENTE_VOLTA_PDV = false;

async function abrirCliente(id, voltarPdv = false) {
  CLIENTE_VOLTA_PDV = voltarPdv;
  ['cli_nome', 'cli_cpf_cnpj', 'cli_rg_ie', 'cli_telefone', 'cli_email', 'cli_cep',
   'cli_logradouro', 'cli_numero', 'cli_complemento', 'cli_bairro', 'cli_cidade',
   'cli_uf', 'cli_observacao'].forEach((c) => setVal(c, ''));
  setVal('cli_id', '');
  setVal('cli_tipo', 'F');
  setVal('cli_limite_credito', '0');
  setVal('cli_status', 'ativo');
  setVal('cli_uf', CONFIG.loja_uf || 'BA');
  setVal('cli_cidade', CONFIG.loja_cidade || '');
  el('cliInfoCredito').innerHTML = '';
  el('clienteTitulo').textContent = 'Novo cliente';

  if (voltarPdv) {
    fecharModal('modalBuscaCliente');
    setVal('cli_nome', val('buscaCliTermo'));
  }

  if (id) {
    try {
      const c = await api('/api/clientes/' + id);
      Object.keys(c).forEach((k) => { if (el('cli_' + k)) setVal('cli_' + k, c[k]); });
      setVal('cli_limite_credito', Number(c.limite_credito).toFixed(2));
      el('clienteTitulo').textContent = 'Editar cliente';
      el('cliInfoCredito').innerHTML = `<div class="aviso ${Number(c.saldo_devedor) > 0 ? 'alerta' : 'ok'}">
        <span>💳</span><div>Saldo devedor <strong>${R$(c.saldo_devedor)}</strong> •
        crédito disponível <strong>${R$(c.credito_disponivel)}</strong></div></div>`;
    } catch (e) { erro(e.message); return; }
  }
  abrirModal('modalCliente');
  setTimeout(() => el('cli_nome').focus(), 100);
}

async function buscarCep() {
  const cep = val('cli_cep').replace(/\D/g, '');
  if (cep.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const d = await r.json();
    if (d.erro) return;
    setVal('cli_logradouro', d.logradouro || '');
    setVal('cli_bairro', d.bairro || '');
    setVal('cli_cidade', d.localidade || '');
    setVal('cli_uf', d.uf || '');
    el('cli_numero').focus();
  } catch (e) { /* sem internet: segue manual */ }
}

async function salvarCliente() {
  if (!val('cli_nome')) { alerta('Informe o nome.'); return; }
  try {
    const r = await api('/api/clientes', {
      method: 'POST',
      body: {
        id: val('cli_id') || null, nome: val('cli_nome'), tipo: val('cli_tipo'),
        cpf_cnpj: val('cli_cpf_cnpj'), rg_ie: val('cli_rg_ie'), telefone: val('cli_telefone'),
        email: val('cli_email'), cep: val('cli_cep'), logradouro: val('cli_logradouro'),
        numero: val('cli_numero'), complemento: val('cli_complemento'), bairro: val('cli_bairro'),
        cidade: val('cli_cidade'), uf: val('cli_uf'),
        limite_credito: valor(el('cli_limite_credito').value),
        observacao: val('cli_observacao'), status: val('cli_status')
      }
    });
    fecharModal('modalCliente');
    ok('Cliente salvo.');

    if (CLIENTE_VOLTA_PDV) {
      CLIENTE_VOLTA_PDV = false;
      const c = await api('/api/clientes/' + r.id);
      escolherCliente(c);
    } else if (SECAO_ATUAL === 'clientes') {
      carregarClientes();
    }
  } catch (e) { erro(e.message); }
}

async function excluirCliente(id, nome) {
  if (!confirm(`Excluir o cliente "${nome}"?\n\nSe ele já tiver compras, será apenas inativado.`)) return;
  try {
    const r = await api('/api/clientes/' + id, { method: 'DELETE' });
    carregarClientes();
    if (r.aviso) alerta(r.aviso); else ok('Cliente excluído.');
  } catch (e) { erro(e.message); }
}

function verTitulosCliente(id) {
  irPara('receber');
  setTimeout(() => {
    setVal('recSituacao', 'todas');
    setVal('recDe', '2000-01-01');
    setVal('recAte', somaDias(hojeIso(), 3650));
    el('recLista').dataset.cliente = id;
    carregarReceber(id);
  }, 120);
}
