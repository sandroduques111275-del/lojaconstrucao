/* ==========================================================================
   pdv.js — frente de caixa
   ========================================================================== */

let CARRINHO = [];
let PDV_CLIENTE = null;
let PDV_DESCONTO = 0;
let PDV_OBS = '';
let PAGAMENTOS = [];
let BUSCA_SEL = -1;
let BUSCA_RESULTADO = [];
let PDV_ORCAMENTO = null;   // orcamento que esta sendo fechado nesta venda

/* ---------------- preparo da tela ---------------- */
async function prepararPdv() {
  try {
    const c = await api('/api/caixa/atual');
    marcarTopoCaixa(c.aberto);
    el('pdvAvisoCaixa').innerHTML = c.aberto
      ? ''
      : `<div class="aviso alerta"><span>💵</span><div><strong>O caixa está fechado.</strong>
          ${CONFIG.venda_exige_caixa_aberto === '1'
            ? 'Abra o caixa para conseguir vender.'
            : 'As vendas não vão entrar em nenhum caixa.'}
          <button class="btn pequeno" style="margin-left:8px" onclick="irPara('caixa')">Abrir caixa</button></div></div>`;
  } catch (e) { /* silencioso */ }
  if (PDV_ORCAMENTO) {
    el('pdvAvisoCaixa').innerHTML += `<div class="aviso info"><span>📝</span><div>
      Esta venda vem de um <strong>orçamento</strong> — os preços são os que foram
      prometidos ao cliente. Ao finalizar, o orçamento é marcado como fechado.</div></div>`;
  }

  const btnDesc = document.querySelector('.pdv-acoes button[onclick="pdvDesconto()"]');
  if (btnDesc) btnDesc.style.display = podeVer('venda_desconto') ? '' : 'none';

  /* O campo de CPF na nota so faz sentido com a NFC-e ligada — sem ela,
     seria mais um campo para o caixa ignorar. */
  const cpf = el('pdvCpfNota');
  if (cpf) cpf.style.display = CONFIG.nfce_ativo === '1' ? '' : 'none';

  renderCarrinho();
  setTimeout(() => el('pdvCodigo').focus(), 120);
}

/* ---------------- teclas de atalho ---------------- */
document.addEventListener('keydown', (e) => {
  if (!USUARIO) return;
  const emModal = document.querySelector('.modal.aberto');

  if (e.key === 'F2') { e.preventDefault(); if (SECAO_ATUAL === 'pdv') pdvBuscar(); }
  if (e.key === 'F3') { e.preventDefault(); if (SECAO_ATUAL === 'pdv') abrirBuscaCliente(); }
  if (e.key === 'F4') { e.preventDefault(); if (SECAO_ATUAL === 'pdv' && !emModal) pdvDesconto(); }
  if (e.key === 'F8') { e.preventDefault(); if (SECAO_ATUAL === 'pdv' && !emModal) pdvRemoverUltimo(); }
  if (e.key === 'F7') {
    e.preventDefault();
    if (SECAO_ATUAL === 'pdv' && !emModal && el('pdv_cpf_nota')) el('pdv_cpf_nota').focus();
  }
  if (e.key === 'F9') {
    e.preventDefault();
    if (SECAO_ATUAL === 'pdv' && !emModal) abrirPagamento();
    else if (el('modalPagamento').classList.contains('aberto')) confirmarVenda();
  }
});

/* ---------------- busca de produto ---------------- */
async function pdvBuscar() {
  let termo = val('pdvCodigo');
  let qtd = valor(el('pdvQtd').value) || 1;

  // formato "3*7891..." ou "3*"
  const m = termo.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.*)$/);
  if (m) { qtd = valor(m[1]); termo = m[2].trim(); }

  if (!termo) { abrirBuscaProduto(); return; }

  try {
    const r = await api('/api/produtos/busca?q=' + encodeURIComponent(termo));
    if (!r.length) { alerta('Produto não encontrado: ' + termo); el('pdvCodigo').select(); return; }
    if (r.length === 1) { addItem(r[0], qtd); return; }
    abrirBuscaProduto(termo, qtd);
  } catch (e) { erro(e.message); }
}

function abrirBuscaProduto(termo = '', qtd = 1) {
  el('modalBuscaProduto').dataset.qtd = qtd;
  setVal('buscaProdTermo', termo);
  abrirModal('modalBuscaProduto');
  setTimeout(() => el('buscaProdTermo').focus(), 100);
  buscarProdutoModal();
}

let timerBusca = null;
function buscarProdutoModal() {
  clearTimeout(timerBusca);
  timerBusca = setTimeout(async () => {
    const t = val('buscaProdTermo');
    if (t.length < 1) { el('buscaProdResultado').innerHTML = ''; BUSCA_RESULTADO = []; return; }
    try {
      BUSCA_RESULTADO = await api('/api/produtos/busca?q=' + encodeURIComponent(t));
      BUSCA_SEL = BUSCA_RESULTADO.length ? 0 : -1;
      renderBuscaProduto();
    } catch (e) { erro(e.message); }
  }, 180);
}

function renderBuscaProduto() {
  const c = el('buscaProdResultado');
  if (!BUSCA_RESULTADO.length) {
    c.innerHTML = '<div class="vazio"><span class="ic">🔍</span>Nenhum produto encontrado.</div>';
    return;
  }
  c.innerHTML = BUSCA_RESULTADO.map((p, i) => `
    <div class="item ${i === BUSCA_SEL ? 'sel' : ''}" onclick="escolherProdutoBusca(${i})">
      <div class="d">
        <div class="nome">${esc(p.descricao)}</div>
        <div class="sub">Cód. ${esc(p.codigo)} ${p.codigo_barras ? '• ' + esc(p.codigo_barras) : ''}
          • Estoque: ${Q(p.estoque)} ${esc(p.unidade)} ${Number(p.estoque) <= 0 ? '⚠️' : ''}</div>
      </div>
      <div class="preco">${R$(p.preco_venda)}<div class="sub" style="text-align:right">${esc(p.unidade)}</div></div>
    </div>`).join('');
  const sel = c.querySelector('.item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function navegarBusca(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); BUSCA_SEL = Math.min(BUSCA_SEL + 1, BUSCA_RESULTADO.length - 1); renderBuscaProduto(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); BUSCA_SEL = Math.max(BUSCA_SEL - 1, 0); renderBuscaProduto(); }
  if (e.key === 'Enter') { e.preventDefault(); if (BUSCA_SEL >= 0) escolherProdutoBusca(BUSCA_SEL); }
}

function escolherProdutoBusca(i) {
  const p = BUSCA_RESULTADO[i];
  if (!p) return;
  const caixa = el('modalBuscaProduto');
  const qtd = valor(caixa.dataset.qtd) || 1;
  const destino = caixa.dataset.destino;
  caixa.dataset.destino = '';
  fecharModal('modalBuscaProduto');
  if (destino === 'orcamento') orcAddItem(p, qtd);
  else addItem(p, qtd);
}

/* ---------------- carrinho ---------------- */
function addItem(produto, quantidade) {
  const qtd = Number(quantidade) || 1;

  if (!produto.fracionado && Math.abs(qtd - Math.round(qtd)) > 0.0001) {
    alerta(`${produto.descricao} não é vendido fracionado. Ajuste a quantidade.`);
    return;
  }
  if (Number(produto.estoque) < qtd) {
    if (CONFIG.venda_permite_estoque_negativo !== '1') {
      erro(`Estoque insuficiente de ${produto.descricao}. Disponível: ${Q(produto.estoque)} ${produto.unidade}.`);
      return;
    }
    alerta(`Atenção: ${produto.descricao} vai ficar com estoque negativo.`);
  }

  const existente = CARRINHO.find((i) => i.produto_id === produto.id && !i.desconto);
  if (existente) existente.quantidade = Number((existente.quantidade + qtd).toFixed(3));
  else {
    CARRINHO.push({
      produto_id: produto.id, codigo: produto.codigo, descricao: produto.descricao,
      unidade: produto.unidade, quantidade: qtd, preco_unit: Number(produto.preco_venda),
      desconto: 0, estoque: Number(produto.estoque), fracionado: !!produto.fracionado,
      novo: true
    });
  }

  setVal('pdvQtd', '1');
  setVal('pdvCodigo', '');
  el('pdvCodigo').focus();
  renderCarrinho();
  el('pdvUltimo').textContent = produto.descricao.slice(0, 22);
}

function renderCarrinho() {
  const tb = el('pdvItens');
  if (!CARRINHO.length) {
    tb.innerHTML = `<tr><td colspan="7"><div class="vazio">
      <span class="ic">🛒</span>Nenhum item lançado.<br>
      <small>Bipe o código de barras ou tecle <strong>F2</strong> para buscar.</small></div></td></tr>`;
  } else {
    tb.innerHTML = CARRINHO.map((i, idx) => {
      const total = i.quantidade * i.preco_unit - i.desconto;
      const linha = `<tr class="${i.novo ? 'novo' : ''}">
        <td class="centro">${idx + 1}</td>
        <td><strong>${esc(i.descricao)}</strong>
            <div style="font-size:11px;color:var(--texto-fraco)">Cód. ${esc(i.codigo)} • ${esc(i.unidade)}</div></td>
        <td class="num"><input value="${i.quantidade}" style="width:78px;text-align:right;padding:4px 6px;border:1px solid var(--cinza-linha);border-radius:4px"
             onchange="mudarQtd(${idx}, this.value)" inputmode="decimal"></td>
        <td class="num"><input value="${i.preco_unit.toFixed(2)}" style="width:88px;text-align:right;padding:4px 6px;border:1px solid var(--cinza-linha);border-radius:4px"
             onchange="mudarPreco(${idx}, this.value)" inputmode="decimal"
             ${podeVer('venda_preco') ? '' : 'readonly title="Seu perfil não pode alterar o preço"'}></td>
        <td class="num">${i.desconto > 0 ? R$(i.desconto) : '—'}</td>
        <td class="num"><strong>${R$(total)}</strong></td>
        <td class="centro" style="white-space:nowrap">
          ${podeVer('venda_desconto') ? `<button class="btn-ic" onclick="descontoItem(${idx})" title="Desconto no item">🏷️</button>` : ''}
          <button class="btn-ic" onclick="removerItem(${idx})" title="Remover">🗑️</button>
        </td></tr>`;
      i.novo = false;
      return linha;
    }).join('');
  }
  atualizarTotais();
}

function atualizarTotais() {
  const subtotal = CARRINHO.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  const total = Math.max(0, subtotal - PDV_DESCONTO);
  el('pdvSubtotal').textContent = R$(subtotal);
  el('pdvDescontoLbl').textContent = R$(PDV_DESCONTO);
  el('pdvTotal').textContent = R$(total);
  el('pdvQtdItens').textContent = CARRINHO.length;
}

function mudarQtd(idx, v) {
  const q = valor(v);
  const item = CARRINHO[idx];
  if (q <= 0) { removerItem(idx); return; }
  if (!item.fracionado && Math.abs(q - Math.round(q)) > 0.0001) {
    alerta('Esse produto não é vendido fracionado.');
    renderCarrinho(); return;
  }
  item.quantidade = q;
  renderCarrinho();
}

function mudarPreco(idx, v) {
  if (!podeVer('venda_preco')) { alerta('Seu perfil não pode alterar o preço.'); renderCarrinho(); return; }
  const p = valor(v);
  if (p < 0) { renderCarrinho(); return; }
  CARRINHO[idx].preco_unit = p;
  renderCarrinho();
}

function descontoItem(idx) {
  if (!podeVer('venda_desconto')) { alerta('Seu perfil não pode dar desconto.'); return; }
  const i = CARRINHO[idx];
  const bruto = i.quantidade * i.preco_unit;
  const r = prompt(`Desconto em ${i.descricao}\nValor do item: ${R$(bruto)}\n\nDigite o desconto em R$ (ou 10% para percentual):`,
    i.desconto ? String(i.desconto).replace('.', ',') : '');
  if (r === null) return;
  let d = 0;
  if (r.includes('%')) d = bruto * (valor(r.replace('%', '')) / 100);
  else d = valor(r);
  if (d < 0 || d > bruto) { erro('Desconto inválido.'); return; }
  i.desconto = Math.round(d * 100) / 100;
  renderCarrinho();
}

function removerItem(idx) {
  CARRINHO.splice(idx, 1);
  renderCarrinho();
  el('pdvCodigo').focus();
}

function pdvRemoverUltimo() {
  if (!CARRINHO.length) return;
  CARRINHO.pop();
  renderCarrinho();
}

function pdvDesconto() {
  if (!podeVer('venda_desconto')) { alerta('Seu perfil não pode dar desconto.'); return; }
  const subtotal = CARRINHO.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  if (!subtotal) { alerta('Lance os itens primeiro.'); return; }
  const r = prompt(`Desconto na venda\nSubtotal: ${R$(subtotal)}\n\nDigite o desconto em R$ (ou 5% para percentual):`,
    PDV_DESCONTO ? String(PDV_DESCONTO).replace('.', ',') : '');
  if (r === null) return;
  let d = r.includes('%') ? subtotal * (valor(r.replace('%', '')) / 100) : valor(r);
  if (d < 0 || d > subtotal) { erro('Desconto inválido.'); return; }
  PDV_DESCONTO = Math.round(d * 100) / 100;
  atualizarTotais();
}

function pdvObservacao() {
  const r = prompt('Observação do cupom (aparece impressa):', PDV_OBS);
  if (r === null) return;
  PDV_OBS = r.trim();
  if (PDV_OBS) ok('Observação registrada.');
}

function pdvCancelar() {
  if (!CARRINHO.length && !PDV_CLIENTE) { el('pdvCodigo').focus(); return; }
  if (!confirm('Cancelar a venda em andamento e limpar a tela?')) return;
  limparVenda();
  ok('Venda cancelada.');
}

function limparVenda() {
  CARRINHO = [];
  PDV_CLIENTE = null;
  PDV_DESCONTO = 0;
  PDV_OBS = '';
  PDV_ORCAMENTO = null;
  PAGAMENTOS = [];
  pdvMostrarCliente();
  renderCarrinho();
  el('pdvUltimo').textContent = '—';
  setVal('pdvQtd', '1');
  setVal('pdvCodigo', '');
  el('pdvCodigo').focus();
}

/* ---------------- cliente ---------------- */
function abrirBuscaCliente() {
  setVal('buscaCliTermo', '');
  el('buscaCliResultado').innerHTML = '';
  abrirModal('modalBuscaCliente');
  setTimeout(() => el('buscaCliTermo').focus(), 100);
  buscarClienteModal();
}

let timerCli = null;
function buscarClienteModal() {
  clearTimeout(timerCli);
  timerCli = setTimeout(async () => {
    try {
      const lista = await api('/api/clientes?status=ativo&q=' + encodeURIComponent(val('buscaCliTermo')));
      el('buscaCliResultado').innerHTML = lista.length ? lista.slice(0, 40).map((c) => `
        <div class="item" onclick='escolherCliente(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
          <div class="d">
            <div class="nome">${esc(c.nome)}</div>
            <div class="sub">${c.cpf_cnpj ? docFmt(c.cpf_cnpj) + ' • ' : ''}${esc(c.telefone || 'sem telefone')}
              ${Number(c.saldo_devedor) > 0 ? ` • <span style="color:var(--vermelho)">deve ${R$(c.saldo_devedor)}</span>` : ''}</div>
          </div>
          <div class="preco" style="color:var(--azul);font-size:12px">
            limite<br>${R$(c.limite_credito)}</div>
        </div>`).join('')
        : '<div class="vazio"><span class="ic">👥</span>Nenhum cliente encontrado.</div>';
    } catch (e) { erro(e.message); }
  }, 200);
}

function escolherCliente(c) {
  PDV_CLIENTE = c;
  fecharModal('modalBuscaCliente');
  pdvMostrarCliente();
  el('pdvCodigo').focus();
}

function pdvLimparCliente() {
  PDV_CLIENTE = null;
  pdvMostrarCliente();
}

function pdvMostrarCliente() {
  if (!PDV_CLIENTE) {
    el('pdvClienteNome').textContent = 'CONSUMIDOR';
    el('pdvClienteDet').textContent = 'Venda sem identificação de cliente';
    return;
  }
  const c = PDV_CLIENTE;
  el('pdvClienteNome').textContent = c.nome;
  const partes = [];
  if (c.cpf_cnpj) partes.push(docFmt(c.cpf_cnpj));
  if (Number(c.limite_credito) > 0) {
    partes.push(`limite ${R$(c.limite_credito)} • disponível ${R$(c.credito_disponivel)}`);
  }
  if (Number(c.saldo_devedor) > 0) partes.push(`deve ${R$(c.saldo_devedor)}`);
  el('pdvClienteDet').textContent = partes.join(' • ') || 'Cliente sem crediário';
}

/* ---------------- pagamento ---------------- */
function abrirPagamento() {
  if (!CARRINHO.length) { alerta('Lance pelo menos um item.'); el('pdvCodigo').focus(); return; }
  PAGAMENTOS = [];
  setVal('pagPrimeiroVenc', somaDias(hojeIso(), 30));
  setVal('pagIntervalo', '30');
  el('pagCrediario').style.display = 'none';
  el('pagCartao').style.display = 'none';
  el('modalPagamento').dataset.formaCartao = '';
  // [1.13] entrega: padrao da configuracao; endereco vem do cliente escolhido
  if (el('pagEntrega')) {
    setVal('pagEntrega', CONFIG.venda_entrega_padrao === 'agora' ? 'agora' : 'depois');
    setVal('pagPrevisao', '');
    const c = PDV_CLIENTE || {};
    setVal('pagEndereco', [c.logradouro, c.numero, c.complemento, c.bairro, c.cidade ? c.cidade + (c.uf ? '/' + c.uf : '') : '']
      .map((x) => String(x || '').trim()).filter(Boolean).join(', '));
    aplicarEntregaNoPag();
  }
  renderPagamentos();
  abrirModal('modalPagamento');
  setTimeout(() => el('pagValor').focus(), 120);
}

/** Mostra previsao e endereco so quando a entrega fica para depois. */
function aplicarEntregaNoPag() {
  const depois = val('pagEntrega') !== 'agora';
  if (el('pagPrevisaoCampo')) el('pagPrevisaoCampo').style.display = depois ? '' : 'none';
  if (el('pagEnderecoCampo')) el('pagEnderecoCampo').style.display = depois ? '' : 'none';
}

function totalVenda() {
  const subtotal = CARRINHO.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  return Math.round(Math.max(0, subtotal - PDV_DESCONTO) * 100) / 100;
}

function addPagamento(forma) {
  const total = totalVenda();
  const jaPago = PAGAMENTOS.reduce((s, p) => s + p.valor, 0);
  const falta = Math.round((total - jaPago) * 100) / 100;

  let v = valor(el('pagValor').value);
  if (!v) v = Math.max(0, falta);
  if (v <= 0) { alerta('Informe o valor.'); return; }

  if (forma !== 'DINHEIRO' && v > falta + 0.001) {
    erro(`Em ${forma} só pode lançar até ${R$(falta)}. Troco só existe em dinheiro.`);
    return;
  }
  if (forma === 'CREDIARIO' && !PDV_CLIENTE) {
    alerta('Escolha o cliente antes de vender no crediário.');
    fecharModal('modalPagamento');
    abrirBuscaCliente();
    return;
  }

  const parcelas = Math.max(1, parseInt(el('pagParcelas').value) || 1);

  /* cartão: primeiro mostra a maquininha e a taxa, depois confirma */
  if (forma.startsWith('CARTAO') && OPERADORAS.length) {
    const painel = el('modalPagamento');
    if (painel.dataset.formaCartao !== forma) {
      painel.dataset.formaCartao = forma;
      painel.dataset.valorCartao = v;
      el('pagCartao').style.display = 'block';
      previewTaxaCartao();
      toast('💳 Confira a maquininha e clique de novo em ' +
        (forma === 'CARTAO DEBITO' ? 'Débito' : 'Crédito') + ' para lançar.', 'alerta', 5000);
      return;
    }
  }

  PAGAMENTOS.push({
    forma,
    valor: Math.round(v * 100) / 100,
    parcelas,
    operadora_id: forma.startsWith('CARTAO') ? (val('pagOperadora') || null) : null,
    detalhe: forma.startsWith('CARTAO') ? val('pagBandeira') : ''
  });

  el('modalPagamento').dataset.formaCartao = '';
  el('pagCartao').style.display = 'none';
  setVal('pagValor', '');
  setVal('pagParcelas', '1');
  renderPagamentos();
}

function removerPagamento(i) {
  PAGAMENTOS.splice(i, 1);
  renderPagamentos();
}

function renderPagamentos() {
  const total = totalVenda();
  const pago = PAGAMENTOS.reduce((s, p) => s + p.valor, 0);
  const falta = Math.round((total - pago) * 100) / 100;
  const troco = Math.max(0, Math.round((pago - total) * 100) / 100);

  const subtotal = CARRINHO.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  el('pagSubtotal').textContent = R$(subtotal);
  el('pagDesconto').textContent = R$(PDV_DESCONTO);
  el('pagTotal').textContent = R$(total);
  el('pagFalta').textContent = R$(Math.max(0, falta));
  el('pagFaltaLinha').style.display = falta > 0.001 ? 'flex' : 'none';
  el('pagTrocoLinha').style.display = troco > 0.001 ? 'flex' : 'none';
  el('pagTroco').textContent = R$(troco);

  const lista = el('pagLista');
  lista.style.display = PAGAMENTOS.length ? 'block' : 'none';
  lista.innerHTML = PAGAMENTOS.map((p, i) => {
    const op = p.operadora_id && OPERADORAS.find((o) => String(o.id) === String(p.operadora_id));
    return `
    <div class="l">
      <span class="f">${esc(p.forma)}${p.parcelas > 1 ? ` <span class="pill azul">${p.parcelas}x</span>` : ''}
        ${op ? `<div style="font-size:11px;color:var(--texto-fraco)">${esc(op.nome)}${p.detalhe ? ' • ' + esc(p.detalhe) : ''}</div>` : ''}</span>
      <span class="v">${R$(p.valor)}</span>
      <button class="btn-ic" onclick="removerPagamento(${i})" title="Tirar">🗑️</button>
    </div>`;
  }).join('');

  el('pagCrediario').style.display = PAGAMENTOS.some((p) => p.forma === 'CREDIARIO') ? 'block' : 'none';
  el('btnConfirmarVenda').disabled = falta > 0.001;
  if (!el('pagValor').value && falta > 0) setVal('pagValor', falta.toFixed(2));
}

async function confirmarVenda() {
  const total = totalVenda();
  const pago = PAGAMENTOS.reduce((s, p) => s + p.valor, 0);
  if (pago < total - 0.001) { erro(`Faltam ${R$(total - pago)}.`); return; }

  const btn = el('btnConfirmarVenda');
  btn.disabled = true;
  btn.textContent = '⏳ Gravando...';

  // [1.12] venda no cartao = NFC-e obrigatoria; o PDV decide pelas formas desta venda
  const formasDaVenda = PAGAMENTOS.map((p) => p.forma);

  try {
    const r = await api('/api/vendas', {
      method: 'POST',
      body: {
        cliente_id: PDV_CLIENTE ? PDV_CLIENTE.id : null,
        cliente_doc: PDV_CLIENTE ? '' : val('pdv_cpf_nota'),
        vendedor: USUARIO.nome,
        desconto: PDV_DESCONTO,
        observacao: PDV_OBS,
        itens: CARRINHO.map((i) => ({
          produto_id: i.produto_id, quantidade: i.quantidade,
          preco_unit: i.preco_unit, desconto: i.desconto
        })),
        pagamentos: PAGAMENTOS.map((p) => ({
          forma: p.forma, valor: p.valor, parcelas: p.parcelas,
          operadora_id: p.operadora_id || null, detalhe: p.detalhe || ''
        })),
        primeiro_vencimento: val('pagPrimeiroVenc'),
        intervalo_dias: parseInt(val('pagIntervalo')) || 30,
        orcamento_id: PDV_ORCAMENTO,
        // [1.13] a venda nao baixa o estoque; a entrega baixa
        entrega: val('pagEntrega') || 'depois',
        previsao_entrega: val('pagPrevisao'),
        endereco_entrega: val('pagEndereco')
      }
    });

    fecharModal('modalPagamento');
    limparVenda();

    if (r.troco > 0) {
      toast(`✅ Cupom ${String(r.numero).padStart(6, '0')} gravado.<br>
             <strong style="font-size:17px;color:var(--verde)">TROCO ${R$(r.troco)}</strong>`, 'ok', 8000);
    } else {
      ok(`Cupom ${String(r.numero).padStart(6, '0')} gravado — ${R$(r.total)}`);
    }
    if (r.orcamento) {
      toast(`📝 Orçamento nº ${String(r.orcamento).padStart(5, '0')} fechado em venda.`, 'ok', 6000);
    }
    if (r.entrega && r.entrega.situacao === 'pendente') {
      toast('🚚 Entrega pendente: o estoque só baixa quando a expedição confirmar, em Expedição / Entregas.', 'ok', 6000);
    }

    /* A NFC-e vem ANTES da impressão: o cupom precisa sair já com a chave
       de acesso e o QR Code. Se a nota falhar, o cupom sai do mesmo jeito
       — a venda nunca fica presa esperando a SEFAZ. */
    await emitirNfceDaVenda(r.id, formasDaVenda);

    imprimirCupom(r.id);
    if (SECAO_ATUAL === 'dashboard') carregarDashboard();
  } catch (e) {
    erro(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Confirmar venda';
  }
}

/**
 * Emite a NFC-e da venda, se estiver ligada.
 *
 * Nunca joga erro para cima: se a SEFAZ recusar ou a internet cair, o
 * caixa recebe o aviso e a venda segue. A nota pendente fica na tela de
 * NFC-e para reenviar depois.
 */
async function emitirNfceDaVenda(vendaId, formas) {
  if (CONFIG.nfce_ativo !== '1') return;

  /* [1.12] Cartao (debito ou credito) passa pela operadora, que informa tudo
     a SEFAZ: a nota e obrigatoria e sai sem perguntar. Dinheiro e PIX seguem
     a regra da configuracao (perguntar ou emitir sozinho). */
  const temCartao = (formas || []).some((f) => String(f).toUpperCase().startsWith('CARTAO'));
  const modo = String(CONFIG.nfce_emitir_automatico || '0');   // 0 pergunta, 1 emite sozinho, 2 pergunta ate no cartao
  const obrigatoria = temCartao && modo !== '2';

  if (modo !== '1' && !obrigatoria) {
    if (!confirm('Emitir a NFC-e desta venda agora?')) return;
  }

  toast(obrigatoria ? '💳 Venda no cartão: NFC-e obrigatória. Enviando para a SEFAZ…' : '🏛️ Enviando a NFC-e para a SEFAZ…', 'ok', 4000);
  try {
    const r = await api('/api/nfce/emitir', { method: 'POST', body: { venda_id: vendaId } });
    ok(`NFC-e ${String(r.numero).padStart(6, '0')} autorizada.`);
  } catch (e) {
    toast(`⚠️ <strong>${obrigatoria ? 'VENDA NO CARTÃO SEM NOTA: a NFC-e não saiu.' : 'A venda foi gravada, mas a NFC-e não saiu.'}</strong><br>${esc(e.message)}<br>
           <span style="font-size:12px">O cupom vai sair sem valor fiscal. ${obrigatoria ? 'Essa nota precisa ser reenviada hoje: ' : 'Reenvie em '}
           Sistema → NFC-e → Reenviar.</span>`, 'alerta', obrigatoria ? 20000 : 12000);
  }
}

function imprimirCupom(vendaId, via) {
  const url = `/api/vendas/${vendaId}/cupom?token=${encodeURIComponent(TOKEN)}${via ? '&via=' + encodeURIComponent(via) : ''}`;
  const j = window.open(url, 'cupom' + vendaId, 'width=420,height=680');
  if (!j) alerta('O navegador bloqueou a janela do cupom. Libere os pop-ups deste site.');
}

/* --------------------------------------------------------------------------
   CPF na nota (NFC-e)

   O consumidor pode pedir o CPF na nota sem ser cliente cadastrado. Aqui
   validamos o documento na hora, porque a SEFAZ rejeita a nota inteira por
   um CPF errado — e ai a fila do caixa para.
   -------------------------------------------------------------------------- */

function pdvConferirCpf() {
  const campo = el('pdv_cpf_nota');
  const aviso = el('pdvCpfAviso');
  if (!campo || !aviso) return;

  const d = campo.value.replace(/\D/g, '');
  if (!d) {
    aviso.textContent = 'Deixe em branco para "consumidor não identificado".';
    aviso.style.color = '';
    return;
  }
  if (d.length === 11) {
    const bom = cpfValido(d);
    aviso.textContent = bom ? '✅ CPF válido' : '❌ CPF inválido — a SEFAZ vai recusar a nota';
    aviso.style.color = bom ? 'var(--verde)' : 'var(--vermelho)';
    return;
  }
  if (d.length === 14) {
    const bom = cnpjValido(d);
    aviso.textContent = bom ? '✅ CNPJ válido' : '❌ CNPJ inválido — a SEFAZ vai recusar a nota';
    aviso.style.color = bom ? 'var(--verde)' : 'var(--vermelho)';
    return;
  }
  aviso.textContent = `Faltam dígitos (${d.length} de 11 ou 14).`;
  aviso.style.color = 'var(--laranja)';
}

function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  for (let t = 9; t < 11; t++) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(d[i]) * ((t + 1) - i);
    let dig = (soma * 10) % 11;
    if (dig === 10) dig = 0;
    if (dig !== Number(d[t])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const conta = (base) => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return conta(d.slice(0, 12)) === Number(d[12]) && conta(d.slice(0, 13)) === Number(d[13]);
}
