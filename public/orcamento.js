/* ==========================================================================
   orcamento.js — proposta de preço para o cliente
   Não mexe em estoque nem em caixa: só vira movimento quando fecha em venda.
   ========================================================================== */

let ORC_ITENS = [];
let ORC_CLIENTE = null;

/* ============================ LISTA ============================ */

async function carregarOrcamentos() {
  try {
    const p = new URLSearchParams();
    if (val('orcDe')) p.set('de', val('orcDe'));
    if (val('orcAte')) p.set('ate', val('orcAte'));
    if (val('orcSituacao')) p.set('situacao', val('orcSituacao'));
    if (val('orcBusca')) p.set('q', val('orcBusca'));

    const r = await api('/api/orcamentos?' + p.toString());

    el('orcTotais').innerHTML = `
      ${tile('Em aberto', r.totais.abertos, R$(r.totais.valor_aberto) + ' aguardando resposta', 'laranja')}
      ${tile('Viraram venda', r.totais.fechados, R$(r.totais.valor_fechado) + ' fechados', 'verde')}
      ${tile('Vencidos', r.totais.expirados, 'passaram da validade', r.totais.expirados ? 'vermelho' : '')}
      ${tile('Taxa de conversão', r.totais.conversao.toFixed(0) + '%', 'orçamentos que viraram venda',
        r.totais.conversao >= 50 ? 'verde' : '')}`;

    const pill = { aberto: 'azul', fechado: 'verde', expirado: 'vermelha', cancelado: 'cinza' };
    const rot = { aberto: 'em aberto', fechado: 'virou venda', expirado: 'vencido', cancelado: 'cancelado' };

    el('orcLista').innerHTML = r.orcamentos.length ? `
      <table><thead><tr>
        <th>Nº</th><th>Data</th><th>Cliente</th><th>Vendedor</th>
        <th class="centro">Itens</th><th class="num">Total</th>
        <th>Validade</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${r.orcamentos.map((o) => `<tr class="${o.status === 'cancelado' ? 'inativa' : ''}">
        <td><strong>${String(o.numero).padStart(5, '0')}</strong></td>
        <td style="white-space:nowrap">${dataBr(o.data)}</td>
        <td>${esc(o.cliente_nome || 'CONSUMIDOR')}
          ${o.cliente_telefone ? `<div style="font-size:11px;color:var(--texto-fraco)">${esc(o.cliente_telefone)}</div>` : ''}</td>
        <td>${esc(o.vendedor || '-')}</td>
        <td class="centro">${o.itens_qtd}</td>
        <td class="num"><strong>${R$(o.total)}</strong></td>
        <td style="white-space:nowrap;${o.status === 'expirado' ? 'color:var(--vermelho);font-weight:700' : ''}">
          ${dataBr(o.validade)}
          ${o.status === 'aberto' && o.dias_restantes !== null
            ? `<div style="font-size:11px;color:var(--texto-fraco)">${o.dias_restantes === 0 ? 'vence hoje' : 'faltam ' + o.dias_restantes + ' d'}</div>`
            : ''}</td>
        <td class="centro"><span class="pill ${pill[o.status]}">${rot[o.status]}</span>
          ${o.status === 'fechado' ? `<div style="font-size:11px;color:var(--texto-fraco)">cupom ${String(o.venda_numero).padStart(6, '0')}</div>` : ''}</td>
        <td class="centro" style="white-space:nowrap">
          <button class="btn-ic" onclick="imprimirOrcamento(${o.id})" title="Imprimir">🖨️</button>
          ${o.status !== 'fechado' ? `<button class="btn-ic" onclick="abrirOrcamento(${o.id})" title="Editar">✏️</button>` : ''}
          ${(o.status === 'aberto' || o.status === 'expirado') && podeVer('pdv')
            ? `<button class="btn pequeno verde" onclick="fecharVendaOrcamento(${o.id})">✅ Fechar venda</button>` : ''}
          ${o.status === 'expirado' || o.status === 'cancelado'
            ? `<button class="btn-ic" onclick="reabrirOrcamento(${o.id})" title="Reabrir">↺</button>` : ''}
          ${o.status === 'aberto'
            ? `<button class="btn-ic" onclick="cancelarOrcamento(${o.id}, ${o.numero})" title="Cancelar">🚫</button>` : ''}
          ${o.status === 'fechado' ? `<button class="btn-ic" onclick="verVenda(${o.venda_id})" title="Ver a venda">🧾</button>` : ''}
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="5">${r.orcamentos.length} orçamento(s)</td>
        <td class="num">${N(r.orcamentos.reduce((s, o) => s + Number(o.total), 0))}</td>
        <td colspan="3"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">📝</span>Nenhum orçamento no filtro.</div>';
  } catch (e) { erro(e.message); }
}

/* ============================ MONTAR ============================ */

async function abrirOrcamento(id) {
  ORC_ITENS = [];
  ORC_CLIENTE = null;
  ['orc_cliente_busca', 'orc_cliente_telefone', 'orc_condicao', 'orc_entrega', 'orc_observacao']
    .forEach((c) => setVal(c, ''));
  setVal('orc_id', '');
  setVal('orc_cliente_id', '');
  setVal('orc_validade_dias', '15');
  setVal('orc_desconto', '0');
  setVal('orc_vendedor', USUARIO ? USUARIO.nome : '');
  setVal('orc_qtd', '1');
  setVal('orc_codigo', '');
  el('orc_cli_resultado').style.display = 'none';
  el('orcTitulo').textContent = 'Novo orçamento';

  if (id) {
    try {
      const o = await api('/api/orcamentos/' + id);
      setVal('orc_id', o.id);
      setVal('orc_cliente_id', o.cliente_id || '');
      setVal('orc_cliente_busca', o.cliente_nome === 'CONSUMIDOR' ? '' : o.cliente_nome);
      setVal('orc_cliente_telefone', o.cliente_telefone);
      setVal('orc_validade_dias', o.validade_dias);
      setVal('orc_desconto', Number(o.desconto).toFixed(2));
      setVal('orc_condicao', o.condicao_pagamento);
      setVal('orc_entrega', o.prazo_entrega);
      setVal('orc_vendedor', o.vendedor);
      setVal('orc_observacao', o.observacao);
      ORC_ITENS = o.itens.map((i) => ({
        produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao,
        unidade: i.unidade, quantidade: Number(i.quantidade),
        preco_unit: Number(i.preco_unit), desconto: Number(i.desconto)
      }));
      el('orcTitulo').textContent = `Orçamento nº ${String(o.numero).padStart(5, '0')}`;
    } catch (e) { erro(e.message); return; }
  }

  orcRender();
  abrirModal('modalOrcamento');
  setTimeout(() => el(id ? 'orc_codigo' : 'orc_cliente_busca').focus(), 120);
}

let timerCliOrc = null;
function buscarClienteOrcamento() {
  setVal('orc_cliente_id', '');
  clearTimeout(timerCliOrc);
  timerCliOrc = setTimeout(async () => {
    const t = val('orc_cliente_busca');
    const c = el('orc_cli_resultado');
    if (t.length < 2) { c.style.display = 'none'; return; }
    try {
      const lista = await api('/api/clientes?status=ativo&q=' + encodeURIComponent(t));
      c.style.display = 'block';
      c.innerHTML = lista.length ? lista.slice(0, 15).map((x) => `
        <div class="item" onclick='escolherClienteOrcamento(${JSON.stringify(x).replace(/'/g, "&#39;")})'>
          <div class="d"><div class="nome">${esc(x.nome)}</div>
            <div class="sub">${x.cpf_cnpj ? docFmt(x.cpf_cnpj) + ' • ' : ''}${esc(x.telefone || 'sem telefone')}</div></div>
        </div>`).join('')
        : `<div style="padding:11px;font-size:13px;color:var(--texto-fraco)">
             Cliente não cadastrado — pode deixar assim mesmo, o nome digitado sai no orçamento.</div>`;
    } catch (e) { /* silencioso */ }
  }, 220);
}

function escolherClienteOrcamento(c) {
  setVal('orc_cliente_id', c.id);
  setVal('orc_cliente_busca', c.nome);
  if (c.telefone) setVal('orc_cliente_telefone', c.telefone);
  el('orc_cli_resultado').style.display = 'none';
  el('orc_codigo').focus();
}

async function orcBuscarProduto() {
  let termo = val('orc_codigo');
  let qtd = valor(el('orc_qtd').value) || 1;

  const m = termo.match(/^(\d+(?:[.,]\d+)?)\s*[*xX]\s*(.*)$/);
  if (m) { qtd = valor(m[1]); termo = m[2].trim(); }
  if (!termo) return;

  try {
    const r = await api('/api/produtos/busca?q=' + encodeURIComponent(termo));
    if (!r.length) { alerta('Produto não encontrado: ' + termo); el('orc_codigo').select(); return; }
    if (r.length === 1) { orcAddItem(r[0], qtd); return; }

    // mais de um: reaproveita o modal de busca do PDV
    BUSCA_RESULTADO = r;
    BUSCA_SEL = 0;
    el('modalBuscaProduto').dataset.qtd = qtd;
    el('modalBuscaProduto').dataset.destino = 'orcamento';
    setVal('buscaProdTermo', termo);
    abrirModal('modalBuscaProduto');
    renderBuscaProduto();
    setTimeout(() => el('buscaProdTermo').focus(), 100);
  } catch (e) { erro(e.message); }
}

function orcAddItem(produto, quantidade) {
  const qtd = Number(quantidade) || 1;
  if (!produto.fracionado && Math.abs(qtd - Math.round(qtd)) > 0.0001) {
    alerta(`${produto.descricao} não é vendido fracionado.`);
    return;
  }
  const existente = ORC_ITENS.find((i) => i.produto_id === produto.id);
  if (existente) existente.quantidade = Number((existente.quantidade + qtd).toFixed(3));
  else {
    ORC_ITENS.push({
      produto_id: produto.id, codigo: produto.codigo, descricao: produto.descricao,
      unidade: produto.unidade, quantidade: qtd,
      preco_unit: Number(produto.preco_venda), desconto: 0,
      fracionado: !!produto.fracionado
    });
  }
  setVal('orc_qtd', '1');
  setVal('orc_codigo', '');
  el('orc_codigo').focus();
  orcRender();
}

function orcRender() {
  const tb = el('orc_itens');
  if (!ORC_ITENS.length) {
    tb.innerHTML = `<tr><td colspan="6"><div class="vazio" style="padding:22px">
      <span class="ic">📝</span>Nenhum item ainda.<br>
      <small>Bipe o código ou digite o nome do produto acima.</small></div></td></tr>`;
  } else {
    tb.innerHTML = ORC_ITENS.map((i, idx) => `<tr>
      <td class="centro">${idx + 1}</td>
      <td><strong>${esc(i.descricao)}</strong>
        <div style="font-size:11px;color:var(--texto-fraco)">Cód. ${esc(i.codigo)} • ${esc(i.unidade)}</div></td>
      <td class="num"><input value="${i.quantidade}" inputmode="decimal"
           style="width:78px;text-align:right;padding:4px 6px;border:1px solid var(--cinza-linha);border-radius:4px"
           onchange="orcMudarQtd(${idx}, this.value)"></td>
      <td class="num"><input value="${i.preco_unit.toFixed(2)}" inputmode="decimal"
           style="width:86px;text-align:right;padding:4px 6px;border:1px solid var(--cinza-linha);border-radius:4px"
           onchange="orcMudarPreco(${idx}, this.value)"></td>
      <td class="num"><strong>${R$(i.quantidade * i.preco_unit - i.desconto)}</strong></td>
      <td class="centro"><button class="btn-ic" onclick="orcRemover(${idx})" title="Tirar">🗑️</button></td>
    </tr>`).join('');
  }
  orcTotais();
}

function orcMudarQtd(idx, v) {
  const q = valor(v);
  if (q <= 0) { orcRemover(idx); return; }
  const i = ORC_ITENS[idx];
  if (i.fracionado === false && Math.abs(q - Math.round(q)) > 0.0001) {
    alerta('Esse produto não é vendido fracionado.');
    orcRender(); return;
  }
  i.quantidade = q;
  orcRender();
}

function orcMudarPreco(idx, v) {
  const p = valor(v);
  if (p < 0) { orcRender(); return; }
  ORC_ITENS[idx].preco_unit = p;
  orcRender();
}

function orcRemover(idx) { ORC_ITENS.splice(idx, 1); orcRender(); }

function orcTotais() {
  const subtotal = ORC_ITENS.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  const desconto = valor(el('orc_desconto').value);
  el('orc_subtotal').textContent = R$(subtotal);
  el('orc_desc_lbl').textContent = R$(desconto);
  el('orc_total').textContent = R$(Math.max(0, subtotal - desconto));
}

async function salvarOrcamento(imprimir) {
  if (!ORC_ITENS.length) { alerta('Adicione pelo menos um item.'); return; }
  const subtotal = ORC_ITENS.reduce((s, i) => s + i.quantidade * i.preco_unit - i.desconto, 0);
  if (valor(el('orc_desconto').value) > subtotal) { erro('O desconto passou do subtotal.'); return; }

  try {
    const r = await api('/api/orcamentos', {
      method: 'POST',
      body: {
        id: val('orc_id') || null,
        cliente_id: val('orc_cliente_id') || null,
        cliente_nome: val('orc_cliente_busca'),
        cliente_telefone: val('orc_cliente_telefone'),
        vendedor: val('orc_vendedor'),
        condicao_pagamento: val('orc_condicao'),
        prazo_entrega: val('orc_entrega'),
        validade_dias: parseInt(val('orc_validade_dias')) || 15,
        desconto: valor(el('orc_desconto').value),
        observacao: val('orc_observacao'),
        itens: ORC_ITENS.map((i) => ({
          produto_id: i.produto_id, quantidade: i.quantidade,
          preco_unit: i.preco_unit, desconto: i.desconto
        }))
      }
    });
    fecharModal('modalOrcamento');
    carregarOrcamentos();
    ok(`Orçamento nº ${String(r.numero).padStart(5, '0')} salvo — ${R$(r.total)}`);
    if (imprimir) imprimirOrcamento(r.id);
  } catch (e) { erro(e.message); }
}

function imprimirOrcamento(id) {
  const j = window.open(`/api/orcamentos/${id}/impressao?token=${encodeURIComponent(TOKEN)}`,
    'orcamento' + id, 'width=880,height=760');
  if (!j) alerta('O navegador bloqueou a janela. Libere os pop-ups deste site.');
}

async function cancelarOrcamento(id, numero) {
  const motivo = prompt(`Cancelar o orçamento nº ${String(numero).padStart(5, '0')}.\n\nQual o motivo?`);
  if (motivo === null) return;
  if (motivo.trim().length < 3) { alerta('Diga o motivo.'); return; }
  try {
    await api(`/api/orcamentos/${id}/cancelar`, { method: 'POST', body: { motivo: motivo.trim() } });
    carregarOrcamentos();
    ok('Orçamento cancelado.');
  } catch (e) { erro(e.message); }
}

async function reabrirOrcamento(id) {
  const dias = prompt('Reabrir o orçamento por quantos dias?', '15');
  if (dias === null) return;
  try {
    const r = await api(`/api/orcamentos/${id}/reabrir`, {
      method: 'POST', body: { validade_dias: parseInt(dias) || 15 }
    });
    carregarOrcamentos();
    ok('Orçamento reaberto até ' + dataBr(r.validade));
  } catch (e) { erro(e.message); }
}

/* ============================ FECHAR EM VENDA ============================ */

/**
 * Leva o orçamento para a Frente de Caixa mantendo os preços prometidos ao
 * cliente. Se algum preço mudou desde a proposta, avisa antes.
 */
async function fecharVendaOrcamento(id) {
  try {
    const o = await api('/api/orcamentos/' + id);

    const mudaram = o.itens.filter((i) => i.preco_mudou);
    const semEstoque = o.itens.filter((i) => i.estoque_atual !== null && i.estoque_atual < Number(i.quantidade));

    let aviso = `Levar o orçamento nº ${String(o.numero).padStart(5, '0')} para a Frente de Caixa?\n\n`;
    if (mudaram.length) {
      aviso += `⚠ ${mudaram.length} produto(s) mudaram de preço desde o orçamento.\n` +
        mudaram.slice(0, 5).map((i) =>
          `   ${i.descricao}: prometido ${R$(i.preco_unit)} • hoje ${R$(i.preco_atual)}`).join('\n') +
        '\n\nO sistema vai usar o PREÇO DO ORÇAMENTO, que é o que o cliente viu.\n\n';
    }
    if (semEstoque.length) {
      aviso += `⚠ ${semEstoque.length} produto(s) com estoque menor que o orçado:\n` +
        semEstoque.slice(0, 5).map((i) =>
          `   ${i.descricao}: precisa ${Q(i.quantidade)}, tem ${Q(i.estoque_atual)}`).join('\n') + '\n\n';
    }
    if (o.status === 'expirado') aviso += '⚠ Este orçamento está vencido.\n\n';

    if (!confirm(aviso + 'Continuar?')) return;

    // monta o carrinho do PDV com os preços do orçamento
    CARRINHO = o.itens.map((i) => ({
      produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao,
      unidade: i.unidade, quantidade: Number(i.quantidade),
      preco_unit: Number(i.preco_unit), desconto: Number(i.desconto),
      estoque: i.estoque_atual === null ? 0 : i.estoque_atual,
      fracionado: true, novo: true
    }));
    PDV_DESCONTO = Number(o.desconto) || 0;
    PDV_OBS = `Orçamento nº ${String(o.numero).padStart(5, '0')}`;
    PDV_ORCAMENTO = o.id;

    if (o.cliente_id) {
      try { PDV_CLIENTE = await api('/api/clientes/' + o.cliente_id); } catch (e) { PDV_CLIENTE = null; }
    } else PDV_CLIENTE = null;

    irPara('pdv');
    setTimeout(() => {
      pdvMostrarCliente();
      renderCarrinho();
      toast(`📝 Orçamento nº ${String(o.numero).padStart(5, '0')} carregado. ` +
            'Finalize a venda normalmente (F9).', 'ok', 7000);
    }, 400);
  } catch (e) { erro(e.message); }
}
