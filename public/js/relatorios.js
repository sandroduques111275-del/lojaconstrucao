/* ==========================================================================
   relatorios.js — vendas, produtos (curva ABC) e clientes
   ========================================================================== */

function barra(percentual, cor = 'var(--laranja)') {
  const p = Math.max(0, Math.min(100, Number(percentual) || 0));
  return `<div style="background:#eef1f5;border-radius:3px;height:8px;width:100%;overflow:hidden">
    <div style="width:${p}%;background:${cor};height:100%"></div></div>`;
}

/* ---------------- vendas ---------------- */
async function carregarRelVendas() {
  try {
    const r = await api(`/api/relatorios/vendas?de=${val('relVDe')}&ate=${val('relVAte')}`);
    const t = r.totais;

    el('relVendasSaida').innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        ${tile('Cupons', t.qtd, 'vendas no período', '')}
        ${tile('Faturamento', R$(t.total), 'total vendido', 'verde')}
        ${tile('Ticket médio', R$(t.ticket_medio), 'por cupom', '')}
        ${tile('Descontos', R$(t.desconto), 'concedidos', 'laranja')}
        ${tile('Custo das mercadorias', R$(t.custo), 'preço de custo', '')}
        ${tile('Lucro bruto', R$(t.lucro), 'venda menos custo', 'verde')}
        ${tile('Margem', t.margem.toFixed(1) + '%', 'sobre o faturamento', t.margem >= 20 ? 'verde' : 'laranja')}
        ${tile('Média por dia', R$(r.por_dia.length ? t.total / r.por_dia.length : 0), r.por_dia.length + ' dia(s) com venda', '')}
      </div>

      <div class="grid g2">
        <div class="card"><h3>💳 Por forma de pagamento</h3>
          <div class="tabela-wrap"><table>
            <thead><tr><th>Forma</th><th class="centro">Vendas</th><th class="num">Valor</th><th style="width:110px">%</th></tr></thead>
            <tbody>${r.por_forma.map((f) => {
              const p = t.total ? (Number(f.total) / t.total) * 100 : 0;
              return `<tr><td>${esc(f.forma)}</td><td class="centro">${f.vendas}</td>
                <td class="num"><strong>${N(f.total)}</strong></td>
                <td>${barra(p)}<small>${p.toFixed(1)}%</small></td></tr>`;
            }).join('') || '<tr><td colspan="4" class="centro" style="padding:20px">Sem dados.</td></tr>'}
            </tbody></table></div>
        </div>

        <div class="card"><h3>👤 Por vendedor</h3>
          <div class="tabela-wrap"><table>
            <thead><tr><th>Vendedor</th><th class="centro">Cupons</th><th class="num">Total</th><th class="num">Ticket</th></tr></thead>
            <tbody>${r.por_operador.map((o) => `<tr><td>${esc(o.vendedor)}</td>
              <td class="centro">${o.qtd}</td><td class="num"><strong>${N(o.total)}</strong></td>
              <td class="num">${N(o.qtd ? o.total / o.qtd : 0)}</td></tr>`).join('')
              || '<tr><td colspan="4" class="centro" style="padding:20px">Sem dados.</td></tr>'}
            </tbody></table></div>
        </div>
      </div>

      <div class="card"><h3>📅 Dia a dia</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Data</th><th class="centro">Cupons</th><th class="num">Subtotal</th>
            <th class="num">Desconto</th><th class="num">Total</th><th class="num">Ticket médio</th></tr></thead>
          <tbody>${r.por_dia.map((d) => `<tr>
            <td>${dataBr(d.dia)}</td><td class="centro">${d.qtd}</td>
            <td class="num">${N(d.subtotal)}</td><td class="num">${N(d.desconto)}</td>
            <td class="num"><strong>${N(d.total)}</strong></td>
            <td class="num">${N(d.qtd ? d.total / d.qtd : 0)}</td></tr>`).join('')
            || '<tr><td colspan="6" class="centro" style="padding:20px">Nenhuma venda no período.</td></tr>'}
          </tbody>
          <tfoot><tr><td>TOTAL</td><td class="centro">${t.qtd}</td><td class="num"></td>
            <td class="num">${N(t.desconto)}</td><td class="num">${N(t.total)}</td>
            <td class="num">${N(t.ticket_medio)}</td></tr></tfoot>
        </table></div>
      </div>`;
  } catch (e) { erro(e.message); }
}

/* ---------------- produtos / curva ABC ---------------- */
async function carregarRelProdutos() {
  try {
    const r = await api(`/api/relatorios/produtos?de=${val('relPDe')}&ate=${val('relPAte')}`);
    const corCurva = { A: 'verde', B: 'amarela', C: 'cinza' };

    const contaA = r.produtos.filter((p) => p.curva === 'A').length;
    const contaB = r.produtos.filter((p) => p.curva === 'B').length;
    const contaC = r.produtos.filter((p) => p.curva === 'C').length;

    el('relProdutosSaida').innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        ${tile('Faturamento', R$(r.total_geral), 'no período', 'verde')}
        ${tile('Produtos vendidos', r.produtos.length, 'itens diferentes', '')}
        ${tile('Curva A', contaA, 'geram até 80% da receita', 'verde')}
        ${tile('Curva B / C', contaB + ' / ' + contaC, 'giro médio e baixo', 'laranja')}
      </div>

      <div class="card"><h3>🗂️ Por categoria</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Categoria</th><th class="num">Total</th><th style="width:180px">Participação</th></tr></thead>
          <tbody>${r.por_categoria.map((c) => `<tr>
            <td>${esc(c.nome)}</td><td class="num"><strong>${N(c.total)}</strong></td>
            <td>${barra(c.participacao)}<small>${c.participacao.toFixed(1)}%</small></td></tr>`).join('')
            || '<tr><td colspan="3" class="centro" style="padding:20px">Sem dados.</td></tr>'}
          </tbody></table></div>
      </div>

      <div class="card"><h3>🏆 Ranking de produtos (curva ABC)</h3>
        <div class="aviso info"><span>ℹ️</span><div>
          <strong>A</strong> = produtos que somam até 80% do faturamento (o que sustenta a loja) •
          <strong>B</strong> = os 15% seguintes • <strong>C</strong> = os últimos 5%, giro baixo.</div></div>
        <div class="tabela-wrap"><table>
          <thead><tr><th>#</th><th class="centro">Curva</th><th>Código</th><th>Produto</th><th>Categoria</th>
            <th class="num">Qtd.</th><th class="num">Faturamento</th><th class="num">Custo</th>
            <th class="num">Lucro</th><th class="num">Margem</th><th class="num">% acum.</th></tr></thead>
          <tbody>${r.produtos.map((p, i) => `<tr>
            <td>${i + 1}</td>
            <td class="centro"><span class="pill ${corCurva[p.curva]}">${p.curva}</span></td>
            <td>${esc(p.codigo)}</td><td>${esc(p.descricao)}</td><td>${esc(p.categoria || '-')}</td>
            <td class="num">${Q(p.qtd)} ${esc(p.unidade || '')}</td>
            <td class="num"><strong>${N(p.total)}</strong></td>
            <td class="num">${N(p.custo)}</td>
            <td class="num" style="color:${p.lucro >= 0 ? 'var(--verde)' : 'var(--vermelho)'}">${N(p.lucro)}</td>
            <td class="num">${p.total ? ((p.lucro / p.total) * 100).toFixed(0) : 0}%</td>
            <td class="num">${p.acumulado.toFixed(1)}%</td></tr>`).join('')
            || '<tr><td colspan="11" class="centro" style="padding:20px">Nenhuma venda no período.</td></tr>'}
          </tbody></table></div>
      </div>`;
  } catch (e) { erro(e.message); }
}

/* ---------------- clientes ---------------- */
async function carregarRelClientes() {
  try {
    const r = await api(`/api/relatorios/clientes?de=${val('relCDe')}&ate=${val('relCAte')}`);
    const comCadastro = r.clientes.filter((c) => c.cliente_id);
    const semCadastro = r.clientes.filter((c) => !c.cliente_id);
    const totalSem = semCadastro.reduce((s, c) => s + Number(c.total), 0);

    el('relClientesSaida').innerHTML = `
      <div class="grid g4" style="margin-bottom:16px">
        ${tile('Faturamento', R$(r.total_geral), 'no período', 'verde')}
        ${tile('Clientes que compraram', comCadastro.length, 'com cadastro', '')}
        ${tile('Venda ao balcão', R$(totalSem), 'sem identificação', 'laranja')}
        ${tile('Ticket médio geral', R$(r.clientes.length
          ? r.total_geral / r.clientes.reduce((s, c) => s + c.compras, 0) : 0), 'por cupom', '')}
      </div>

      <div class="card"><h3>🤝 Ranking de clientes</h3>
        <div class="tabela-wrap"><table>
          <thead><tr><th>#</th><th>Cliente</th><th class="centro">Compras</th>
            <th class="num">Total</th><th class="num">Ticket médio</th><th style="width:170px">Participação</th></tr></thead>
          <tbody>${r.clientes.map((c, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(c.cliente)}${!c.cliente_id ? ' <span class="pill cinza">balcão</span>' : ''}</td>
            <td class="centro">${c.compras}</td>
            <td class="num"><strong>${N(c.total)}</strong></td>
            <td class="num">${N(c.ticket)}</td>
            <td>${barra(c.participacao)}<small>${c.participacao.toFixed(1)}%</small></td></tr>`).join('')
            || '<tr><td colspan="6" class="centro" style="padding:20px">Nenhuma venda no período.</td></tr>'}
          </tbody>
          <tfoot><tr><td colspan="3">TOTAL</td><td class="num">${N(r.total_geral)}</td><td colspan="2"></td></tr></tfoot>
        </table></div>
      </div>`;
  } catch (e) { erro(e.message); }
}

/* ---------------- [1.11] sugestão de compra ---------------- */

let SC_FORNECEDORES_OK = false;

function paramsSugestao() {
  const p = new URLSearchParams();
  p.set('dias', val('scDias') || '90');
  p.set('cobertura', val('scCobertura') || '30');
  p.set('prazo', val('scPrazo') || '7');
  p.set('agrupar', val('scAgrupar') || 'categoria');
  if (val('scFornecedor')) p.set('fornecedor', val('scFornecedor'));
  return p.toString();
}

const SITUACAO_SC = {
  falta:   { rotulo: 'FALTA',    pill: 'vermelha', dica: 'estoque zerado e vendendo' },
  urgente: { rotulo: 'URGENTE',  pill: 'vermelha', dica: 'acaba antes de a entrega chegar' },
  comprar: { rotulo: 'comprar',  pill: 'amarela',  dica: 'não cobre o prazo + cobertura' },
  ok:      { rotulo: 'ok',       pill: 'verde',    dica: 'estoque suficiente' },
  excesso: { rotulo: 'excesso',  pill: 'cinza',    dica: 'muito acima do necessário: dinheiro parado' },
  parado:  { rotulo: 'parado',   pill: 'cinza',    dica: 'sem nenhuma venda no período' }
};
const pillSc = (s) => { const x = SITUACAO_SC[s] || { rotulo: s, pill: 'cinza', dica: '' };
  return `<span class="pill ${x.pill}" title="${esc(x.dica)}">${x.rotulo}</span>`; };
const diasTxt = (d) => (d === null ? '∞' : d > 999 ? '999+' : String(d));

async function carregarSugestaoCompra() {
  const alvo = el('relComprasSaida');
  alvo.innerHTML = '<div class="card"><div class="vazio">Calculando pela velocidade de venda…</div></div>';
  try {
    const r = await api('/api/relatorios/sugestao-compra?' + paramsSugestao());
    const p = r.parametros;
    const s = r.resumo;
    const soComprar = el('scSoComprar').checked;

    if (!SC_FORNECEDORES_OK && r.lista_fornecedores) {
      const sel = el('scFornecedor');
      const atual = sel.value;
      sel.innerHTML = '<option value="">Todos</option>' + r.lista_fornecedores.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
      sel.value = atual;
      SC_FORNECEDORES_OK = true;
    }

    const rotuloGrupo = p.agrupar === 'marca' ? 'Marca/modelo' : 'Categoria';
    const tabelaProdutos = (produtos) => `
      <table><thead><tr>
        <th>Produto</th><th class="num" title="Quantidade vendida no período">Vendido</th>
        <th class="num">Vendas R$</th><th class="num" title="Média por semana">Média/sem</th>
        <th class="num">Estoque</th><th class="centro" title="Quantos dias o estoque atual aguenta, no ritmo atual">Dias de estoque</th>
        <th class="num" title="Quanto comprar para cobrir entrega + cobertura">Comprar</th><th class="num">Custo</th><th class="centro">Situação</th>
      </tr></thead><tbody>
      ${produtos.map((l) => `<tr class="${l.comprar > 0 ? '' : 'inativa'}">
        <td><strong>${esc(l.descricao)}</strong><div style="font-size:11px;color:var(--texto-fraco)">cód. ${esc(l.codigo)} · ${esc(l.unidade)}${l.ultima_venda ? ' · última venda ' + dataBr(l.ultima_venda) : ''}</div></td>
        <td class="num">${Q(l.vendido_qtd)}</td>
        <td class="num"><strong>${N(l.vendido_valor)}</strong></td>
        <td class="num">${Q(l.media_semana)}${l.dias_efetivos < p.dias ? `<div style="font-size:10.5px;color:var(--texto-fraco)" title="produto cadastrado há ${l.dias_efetivos} dias: a média é sobre esse tempo">em ${l.dias_efetivos} dias</div>` : ''}</td>
        <td class="num">${Q(l.estoque)}</td>
        <td class="centro">${diasTxt(l.dias_estoque)}</td>
        <td class="num">${l.comprar > 0 ? `<strong style="color:var(--laranja-esc)">${Q(l.comprar)}</strong>` : '—'}</td>
        <td class="num">${l.comprar > 0 ? N(l.custo_compra) : '—'}</td>
        <td class="centro">${pillSc(l.situacao)}</td>
      </tr>`).join('')}
      </tbody></table>`;

    const blocosFornecedor = r.fornecedores.map((f) => {
      const grupos = f.grupos.map((g) => {
        const produtos = soComprar ? g.produtos.filter((l) => l.comprar > 0) : g.produtos;
        if (!produtos.length) return '';
        return `<div style="margin-top:10px">
          <div style="font-size:12.5px;font-weight:700;color:var(--texto-fraco);text-transform:uppercase;letter-spacing:.3px;margin-bottom:4px">
            ${esc(rotuloGrupo)}: ${esc(g.nome)} — vendas ${R$(g.vendido_valor)}${g.custo_compra ? ' · comprar ' + R$(g.custo_compra) : ''}</div>
          <div class="tabela-wrap">${tabelaProdutos(produtos)}</div></div>`;
      }).join('');
      if (!grupos) return '';
      return `<details class="card" ${f.a_comprar || !soComprar ? 'open' : ''} style="padding:0">
        <summary style="cursor:pointer;padding:14px 16px;display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;list-style:none">
          <span style="font-size:15px;font-weight:700">🚚 ${esc(f.nome)}</span>
          <span style="font-size:12.5px;color:var(--texto-fraco)">${f.produtos} produto(s) vendido(s) · vendas <strong>${R$(f.vendido_valor)}</strong></span>
          ${f.a_comprar ? `<span class="pill amarela">${f.a_comprar} a comprar · ${R$(f.custo_compra)}</span>` : '<span class="pill verde">nada a comprar</span>'}
          ${f.urgentes ? `<span class="pill vermelha">${f.urgentes} urgente(s)</span>` : ''}
          ${f.dinheiro_parado ? `<span class="pill cinza" title="estoque acima do necessário, a preço de custo">${R$(f.dinheiro_parado)} parado</span>` : ''}
        </summary>
        <div style="padding:0 16px 16px">${grupos}</div>
      </details>`;
    }).join('');

    alvo.innerHTML = `
      <div class="aviso info" style="margin-bottom:12px"><span>📐</span><div>
        Vendas de <strong>${dataBr(p.de)}</strong> a <strong>${dataBr(p.ate)}</strong> (${p.dias} dias).
        Para cada produto: <em>velocidade</em> = vendido ÷ ${p.dias} dias; <em>comprar</em> = velocidade × (${p.prazo} dias de entrega + ${p.cobertura} de cobertura) − estoque atual
        (nunca abaixo do estoque mínimo do cadastro). O que não vendeu no período não entra na compra.</div></div>

      <div class="grid g4" style="margin-bottom:14px">
        ${tile('Vendido no período', R$(s.vendido), `${s.produtos_vendidos} produto(s) · lucro bruto ${R$(s.lucro)}`, 'verde')}
        ${tile('Compra sugerida', R$(s.custo_compra), `${s.a_comprar} produto(s) em ${s.fornecedores} fornecedor(es)`, 'laranja')}
        ${tile('Urgentes / em falta', s.urgentes, 'acabam antes da entrega chegar', s.urgentes ? 'vermelho' : '')}
        ${tile('Dinheiro parado', R$(s.dinheiro_parado), `${s.em_excesso} em excesso · ${s.parados} sem venda`, s.dinheiro_parado > 0 ? 'cinza' : '')}
      </div>

      ${r.top.length ? `<div class="card"><h3>🏆 Os ${r.top.length} mais vendidos (todos os fornecedores)</h3>
        <div class="tabela-wrap">${tabelaProdutos(r.top)}</div></div>` : ''}

      <h3 style="margin:18px 0 8px;font-size:15px">🚚 Por fornecedor › ${esc(rotuloGrupo).toLowerCase()} › produto</h3>
      ${blocosFornecedor || '<div class="card"><div class="vazio"><span class="ic">🛒</span>Nenhuma venda no período. Amplie o período.</div></div>'}

      ${r.parados.length ? `<details class="card" style="padding:0">
        <summary style="cursor:pointer;padding:14px 16px;font-weight:700;list-style:none">💤 Estoque parado — ${r.parados.length} produto(s) sem nenhuma venda no período
          <span class="pill cinza" style="margin-left:8px">${R$(r.parados.reduce((t, l) => t + l.dinheiro_parado, 0))} a preço de custo</span></summary>
        <div style="padding:0 16px 16px"><div class="tabela-wrap"><table>
          <thead><tr><th>Produto</th><th>Fornecedor</th><th class="num">Estoque</th><th class="num">Custo unit.</th><th class="num">Parado R$</th></tr></thead>
          <tbody>${r.parados.map((l) => `<tr><td><strong>${esc(l.descricao)}</strong><div style="font-size:11px;color:var(--texto-fraco)">cód. ${esc(l.codigo)}</div></td>
            <td>${esc(l.fornecedor)}</td><td class="num">${Q(l.estoque)} ${esc(l.unidade)}</td><td class="num">${N(l.custo_unit)}</td>
            <td class="num"><strong>${N(l.dinheiro_parado)}</strong></td></tr>`).join('')}</tbody></table></div>
          <div class="dica" style="margin-top:6px">Não compre disto. Vale promoção, devolução ao fornecedor ou tirar do catálogo.</div></div>
      </details>` : ''}`;
  } catch (e) {
    alvo.innerHTML = `<div class="card"><div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div></div>`;
  }
}

function exportarSugestaoCompra() {
  const a = document.createElement('a');
  a.href = '/api/relatorios/sugestao-compra.xlsx?' + paramsSugestao() + '&token=' + encodeURIComponent(TOKEN);
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  ok('Planilha gerada: uma aba por fornecedor com o pedido sugerido.');
}
