/* ==========================================================================
   operacao.js — vendas, caixa e contas a receber
   ========================================================================== */

/* ============================ VENDAS ============================ */

async function carregarVendas() {
  try {
    const p = new URLSearchParams();
    if (val('vendasDe')) p.set('de', val('vendasDe'));
    if (val('vendasAte')) p.set('ate', val('vendasAte'));
    if (val('vendasSituacao')) p.set('situacao', val('vendasSituacao'));
    if (val('vendasBusca')) p.set('q', val('vendasBusca'));

    const lista = await api('/api/vendas?' + p.toString());
    const fin = lista.filter((v) => v.situacao === 'finalizada');
    const total = fin.reduce((s, v) => s + Number(v.total), 0);

    el('vendasTotais').innerHTML = `
      ${tile('Cupons', fin.length, 'vendas finalizadas', '')}
      ${tile('Faturamento', R$(total), 'no período filtrado', 'verde')}
      ${tile('Ticket médio', R$(fin.length ? total / fin.length : 0), 'por cupom', '')}
      ${tile('Canceladas', lista.filter((v) => v.situacao === 'cancelada').length, 'no período', 'vermelho')}`;

    el('vendasLista').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Cupom</th><th>Data</th><th>Cliente</th><th>Vendedor</th>
        <th class="centro">Itens</th><th>Pagamento</th>
        <th class="num">Desconto</th><th class="num">Total</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${lista.map((v) => `<tr class="${v.situacao === 'cancelada' ? 'cancelada' : ''}">
        <td><strong>${String(v.numero).padStart(6, '0')}</strong></td>
        <td style="white-space:nowrap">${dataHoraBr(v.data)}</td>
        <td>${esc(v.cliente_nome || 'CONSUMIDOR')}</td>
        <td>${esc(v.vendedor || '-')}</td>
        <td class="centro">${v.itens_qtd}</td>
        <td style="font-size:11.5px">${esc(v.formas || '-')}</td>
        <td class="num">${Number(v.desconto) > 0 ? N(v.desconto) : '—'}</td>
        <td class="num"><strong>${R$(v.total)}</strong></td>
        <td class="centro"><span class="pill ${v.situacao === 'finalizada' ? 'verde' : 'vermelha'}">${esc(v.situacao)}</span>
          ${v.situacao === 'finalizada' && v.entrega_situacao && v.entrega_situacao !== 'entregue'
            ? `<br><span class="pill ${v.entrega_situacao === 'parcial' ? 'amarela' : 'cinza'}" title="estoque só baixa na entrega">🚚 ${v.entrega_situacao === 'parcial' ? 'entrega parcial' : 'a entregar'}</span>` : ''}</td>
        <td class="centro" style="white-space:nowrap">
          <button class="btn-ic" onclick="verVenda(${v.id})" title="Detalhes">👁️</button>
          <button class="btn-ic" onclick="imprimirCupom(${v.id}, '2a VIA')" title="Imprimir 2ª via">🖨️</button>
        </td></tr>`).join('')}
      </tbody></table>`
      : '<div class="vazio"><span class="ic">🧾</span>Nenhuma venda no período.</div>';
  } catch (e) { erro(e.message); }
}

async function verVenda(id) {
  try {
    const v = await api('/api/vendas/' + id);
    el('vendaTitulo').textContent = `Cupom ${String(v.numero).padStart(6, '0')} — ${dataHoraBr(v.data)}`;

    el('vendaCorpo').innerHTML = `
      ${v.situacao === 'cancelada' ? `<div class="aviso erro"><span>🚫</span><div>
        <strong>Venda cancelada</strong> por ${esc(v.cancelado_por)} em ${dataHoraBr(v.cancelado_em)}.<br>
        Motivo: ${esc(v.cancelado_motivo)}</div></div>` : ''}

      <div class="linha">
        <div class="campo"><label>Cliente</label><div><strong>${esc(v.cliente_nome || 'CONSUMIDOR')}</strong>
          ${v.cliente_doc ? '<br><small>' + docFmt(v.cliente_doc) + '</small>' : ''}</div></div>
        <div class="campo"><label>Vendedor</label><div>${esc(v.vendedor || '-')}</div></div>
        <div class="campo"><label>Operador</label><div>${esc(v.usuario || '-')}</div></div>
      </div>

      <div class="tabela-wrap" style="margin:12px 0">
        <table><thead><tr><th>Cód.</th><th>Produto</th><th class="num">Qtd.</th>
          <th class="num">V. Unit.</th><th class="num">Desc.</th><th class="num">Total</th></tr></thead>
        <tbody>${v.itens.map((i) => `<tr>
          <td>${esc(i.codigo)}</td><td>${esc(i.descricao)}</td>
          <td class="num">${Q(i.quantidade)} ${esc(i.unidade)}</td>
          <td class="num">${N(i.preco_unit)}</td>
          <td class="num">${Number(i.desconto) > 0 ? N(i.desconto) : '—'}</td>
          <td class="num"><strong>${N(i.total)}</strong></td></tr>`).join('')}</tbody>
        <tfoot>
          <tr><td colspan="5" class="num">Subtotal</td><td class="num">${N(v.subtotal)}</td></tr>
          ${Number(v.desconto) > 0 ? `<tr><td colspan="5" class="num">Desconto</td><td class="num">-${N(v.desconto)}</td></tr>` : ''}
          <tr><td colspan="5" class="num">TOTAL</td><td class="num">${R$(v.total)}</td></tr>
        </tfoot></table>
      </div>

      <div class="grid g2">
        <div><h3 style="font-size:13px;color:var(--azul);margin-bottom:7px">Pagamento</h3>
          <div class="tabela-wrap"><table><tbody>
            ${v.pagamentos.map((p) => `<tr><td>${esc(p.forma)}${p.parcelas > 1 ? ` (${p.parcelas}x)` : ''}</td>
              <td class="num"><strong>${N(p.valor)}</strong></td></tr>`).join('')}
            ${Number(v.troco) > 0 ? `<tr><td>Troco</td><td class="num" style="color:var(--verde)"><strong>${N(v.troco)}</strong></td></tr>` : ''}
          </tbody></table></div>
        </div>
        ${v.parcelas.length ? `<div><h3 style="font-size:13px;color:var(--azul);margin-bottom:7px">Parcelas do crediário</h3>
          <div class="tabela-wrap"><table><thead><tr><th>Doc.</th><th>Vencimento</th>
            <th class="num">Valor</th><th class="centro">Situação</th></tr></thead><tbody>
            ${v.parcelas.map((p) => `<tr><td>${esc(p.documento)}</td><td>${dataBr(p.vencimento)}</td>
              <td class="num">${N(p.valor)}</td>
              <td class="centro"><span class="pill ${p.situacao === 'pago' ? 'verde' : 'amarela'}">${esc(p.situacao)}</span></td>
            </tr>`).join('')}</tbody></table></div></div>` : ''}
      </div>

      ${v.observacao ? `<div class="aviso info" style="margin-top:12px"><span>📝</span><div>${esc(v.observacao)}</div></div>` : ''}`;

    el('vendaAcoes').innerHTML = `
      <button class="btn" onclick="fecharModal('modalVenda')">Fechar</button>
      <button class="btn primario" onclick="imprimirCupom(${v.id}, '2a VIA')">🖨️ Imprimir 2ª via</button>
      ${v.situacao === 'finalizada' && podeVer('venda_cancelar')
        ? `<button class="btn perigo" onclick="cancelarVenda(${v.id}, ${v.numero})">🚫 Cancelar venda</button>` : ''}`;

    abrirModal('modalVenda');
  } catch (e) { erro(e.message); }
}

async function cancelarVenda(id, numero) {
  const motivo = prompt(`Cancelar o cupom ${String(numero).padStart(6, '0')}.\n\nO estoque volta e as parcelas do crediário são apagadas.\nDescreva o motivo (mínimo 5 letras):`);
  if (motivo === null) return;
  if (motivo.trim().length < 5) { alerta('Descreva melhor o motivo.'); return; }
  try {
    await api(`/api/vendas/${id}/cancelar`, { method: 'POST', body: { motivo: motivo.trim() } });
    fecharModal('modalVenda');
    carregarVendas();
    ok('Venda cancelada e estoque devolvido.');
  } catch (e) { erro(e.message); }
}

/* ============================ CAIXA ============================ */

let CAIXA_ATUAL = null;

async function carregarCaixa() {
  try {
    const c = await api('/api/caixa/atual');
    CAIXA_ATUAL = c.aberto ? c : null;
    marcarTopoCaixa(c.aberto);

    el('caixaBotoes').innerHTML = c.aberto ? `
      <button class="btn" onclick="abrirCaixaMov('suprimento')">⬆️ Suprimento</button>
      <button class="btn" onclick="abrirCaixaMov('sangria')">⬇️ Sangria</button>
      <button class="btn perigo" onclick="abrirFecharCaixa()">🔒 Fechar caixa</button>`
      : `<button class="btn verde" onclick="abrirModal('modalCaixaAbrir')">💵 Abrir caixa</button>`;

    el('caixaAtual').innerHTML = c.aberto ? renderCaixaAberto(c) : `
      <div class="card"><div class="vazio">
        <span class="ic">🔒</span><strong>Nenhum caixa aberto.</strong><br>
        Abra o caixa informando o fundo de troco para começar as vendas do dia.
      </div></div>`;

    const hist = await api('/api/caixa/historico');
    el('caixaHistorico').innerHTML = hist.length ? `
      <table><thead><tr>
        <th>#</th><th>Abertura</th><th>Fechamento</th><th>Operador</th>
        <th class="num">Fundo</th><th class="num">Sistema</th><th class="num">Contado</th>
        <th class="num">Diferença</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${hist.map((x) => {
        const dif = Number(x.diferenca || 0);
        return `<tr>
          <td>${x.id}</td>
          <td style="white-space:nowrap">${dataHoraBr(x.abertura)}</td>
          <td style="white-space:nowrap">${x.fechamento ? dataHoraBr(x.fechamento) : '—'}</td>
          <td>${esc(x.usuario_abertura)}</td>
          <td class="num">${N(x.fundo)}</td>
          <td class="num">${x.valor_sistema !== null ? N(x.valor_sistema) : '—'}</td>
          <td class="num">${x.valor_informado !== null ? N(x.valor_informado) : '—'}</td>
          <td class="num" style="color:${Math.abs(dif) < 0.01 ? 'var(--verde)' : (dif < 0 ? 'var(--vermelho)' : 'var(--laranja-esc)')};font-weight:700">
            ${x.fechamento ? (dif > 0 ? '+' : '') + N(dif) : '—'}</td>
          <td class="centro"><span class="pill ${x.situacao === 'aberto' ? 'verde' : 'cinza'}">${esc(x.situacao)}</span></td>
          <td class="centro"><button class="btn-ic" onclick="verResumoCaixa(${x.id})" title="Ver resumo">👁️</button></td>
        </tr>`;
      }).join('')}</tbody></table>`
      : '<div class="vazio"><span class="ic">📚</span>Nenhum caixa registrado ainda.</div>';
  } catch (e) { erro(e.message); }
}

function renderCaixaAberto(c) {
  return `
    <div class="grid g4" style="margin-bottom:16px">
      ${tile('Aberto em', dataHoraBr(c.caixa.abertura), 'por ' + esc(c.caixa.usuario_abertura), 'verde')}
      ${tile('Vendas', c.vendas_qtd, 'cupons emitidos', '')}
      ${tile('Faturamento', R$(c.vendas_total), 'total vendido', 'verde')}
      ${tile('Dinheiro em caixa', R$(c.dinheiro_esperado), 'o que deve ter na gaveta', 'laranja')}
    </div>

    <div class="grid g2">
      <div class="card">
        <h3>💳 Por forma de pagamento</h3>
        <div class="tabela-wrap">
          <table><thead><tr><th>Forma</th><th class="centro">Vendas</th><th class="num">Valor</th></tr></thead>
          <tbody>${c.formas.length ? c.formas.map((f) => `<tr>
            <td>${esc(f.forma)}</td><td class="centro">${f.vendas}</td>
            <td class="num"><strong>${N(f.valor)}</strong></td></tr>`).join('')
            : '<tr><td colspan="3" class="centro" style="padding:20px;color:var(--texto-fraco)">Sem vendas ainda.</td></tr>'}
          </tbody></table>
        </div>
        <div style="margin-top:12px;font-size:13px;line-height:1.9;background:#f5f7fa;padding:11px;border-radius:6px">
          <div style="display:flex;justify-content:space-between"><span>Fundo de troco</span><strong>${R$(c.caixa.fundo)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>+ Suprimentos</span><strong>${R$(c.suprimentos)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>− Sangrias</span><strong>${R$(c.sangrias)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>− Troco entregue</span><strong>${R$(c.troco_total)}</strong></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid var(--cinza-linha);margin-top:6px;padding-top:6px;font-size:15px">
            <span><strong>Dinheiro esperado</strong></span><strong style="color:var(--laranja-esc)">${R$(c.dinheiro_esperado)}</strong></div>
        </div>
      </div>

      <div class="card">
        <h3>🔄 Sangrias e suprimentos</h3>
        <div class="tabela-wrap">
          <table><thead><tr><th>Hora</th><th class="centro">Tipo</th><th>Motivo</th>
            <th class="num">Valor</th><th>Usuário</th></tr></thead>
          <tbody>${c.movimentos.length ? c.movimentos.map((m) => `<tr>
            <td>${dataHoraBr(m.data)}</td>
            <td class="centro"><span class="pill ${m.tipo === 'sangria' ? 'vermelha' : 'verde'}">${esc(m.tipo)}</span></td>
            <td>${esc(m.motivo)}</td><td class="num">${N(m.valor)}</td><td>${esc(m.usuario)}</td></tr>`).join('')
            : '<tr><td colspan="5" class="centro" style="padding:20px;color:var(--texto-fraco)">Nenhum lançamento.</td></tr>'}
          </tbody></table>
        </div>
        ${c.recebimentos.length ? `<div style="margin-top:12px">
          <h3 style="font-size:13px">📆 Crediário recebido no período</h3>
          <div class="tabela-wrap"><table><tbody>
            ${c.recebimentos.map((r) => `<tr><td>${esc(r.forma || 'DINHEIRO')}</td>
              <td class="num"><strong>${N(r.valor)}</strong></td></tr>`).join('')}
          </tbody></table></div></div>` : ''}
      </div>
    </div>`;
}

async function abrirCaixa() {
  try {
    await api('/api/caixa/abrir', { method: 'POST', body: { fundo: valor(el('cxFundo').value) } });
    fecharModal('modalCaixaAbrir');
    carregarCaixa();
    ok('Caixa aberto. Bom trabalho!');
  } catch (e) { erro(e.message); }
}

function abrirCaixaMov(tipo) {
  setVal('cxMovTipo', tipo);
  setVal('cxMovValor', '');
  setVal('cxMovMotivo', '');
  el('cxMovTitulo').textContent = tipo === 'sangria' ? '⬇️ Sangria (retirada)' : '⬆️ Suprimento (entrada)';
  abrirModal('modalCaixaMov');
  setTimeout(() => el('cxMovValor').focus(), 100);
}

async function salvarCaixaMov() {
  try {
    await api('/api/caixa/movimento', {
      method: 'POST',
      body: { tipo: val('cxMovTipo'), valor: valor(el('cxMovValor').value), motivo: val('cxMovMotivo') }
    });
    fecharModal('modalCaixaMov');
    carregarCaixa();
    ok('Lançamento registrado.');
  } catch (e) { erro(e.message); }
}

function abrirFecharCaixa() {
  if (!CAIXA_ATUAL) return;
  const c = CAIXA_ATUAL;
  el('cxFecharCorpo').innerHTML = `
    <div class="aviso info"><span>ℹ️</span><div>Conte o dinheiro da gaveta e informe abaixo.
      O sistema compara com o esperado e registra a diferença.</div></div>

    <div class="tabela-wrap" style="margin-bottom:14px">
      <table><tbody>
        <tr><td>Fundo de troco</td><td class="num">${R$(c.caixa.fundo)}</td></tr>
        ${c.formas.map((f) => `<tr><td>Vendas em ${esc(f.forma)}</td><td class="num">${R$(f.valor)}</td></tr>`).join('')}
        ${c.recebimentos.map((r) => `<tr><td>Crediário recebido (${esc(r.forma || 'DINHEIRO')})</td><td class="num">${R$(r.valor)}</td></tr>`).join('')}
        <tr><td>Suprimentos</td><td class="num">+ ${R$(c.suprimentos)}</td></tr>
        <tr><td>Sangrias</td><td class="num">− ${R$(c.sangrias)}</td></tr>
        <tr><td>Troco entregue</td><td class="num">− ${R$(c.troco_total)}</td></tr>
      </tbody><tfoot>
        <tr><td><strong>Dinheiro esperado na gaveta</strong></td>
            <td class="num" style="font-size:17px;color:var(--laranja-esc)"><strong>${R$(c.dinheiro_esperado)}</strong></td></tr>
      </tfoot></table>
    </div>

    <div class="linha">
      <div class="campo"><label>Dinheiro contado na gaveta (R$)</label>
        <input id="cxFecharValor" inputmode="decimal" value="${Number(c.dinheiro_esperado).toFixed(2)}"
               oninput="calcDiferencaCaixa(${c.dinheiro_esperado})"></div>
      <div class="campo"><label>Diferença</label><input id="cxFecharDif" readonly value="R$ 0,00"></div>
    </div>
    <div class="campo"><label>Observação do fechamento</label><input id="cxFecharObs"></div>`;
  abrirModal('modalCaixaFechar');
}

function calcDiferencaCaixa(esperado) {
  const dif = valor(el('cxFecharValor').value) - Number(esperado);
  const campo = el('cxFecharDif');
  campo.value = (dif > 0 ? '+ ' : dif < 0 ? '− ' : '') + R$(Math.abs(dif));
  campo.style.color = Math.abs(dif) < 0.01 ? 'var(--verde)' : 'var(--vermelho)';
  campo.style.fontWeight = '700';
}

async function fecharCaixa() {
  try {
    const r = await api('/api/caixa/fechar', {
      method: 'POST',
      body: { valor_informado: valor(el('cxFecharValor').value), observacao: val('cxFecharObs') }
    });
    fecharModal('modalCaixaFechar');
    carregarCaixa();
    if (Math.abs(r.diferenca) < 0.01) ok('Caixa fechado certinho, sem diferença.');
    else alerta(`Caixa fechado com diferença de ${R$(r.diferenca)} (${r.diferenca < 0 ? 'faltou' : 'sobrou'}).`);
  } catch (e) { erro(e.message); }
}

async function verResumoCaixa(id) {
  try {
    const c = await api('/api/caixa/' + id + '/resumo');
    el('vendaTitulo').textContent = `Caixa #${id} — ${dataHoraBr(c.caixa.abertura)}`;
    el('vendaCorpo').innerHTML = `
      <div class="grid g3" style="margin-bottom:14px">
        ${tile('Vendas', c.vendas_qtd, 'cupons', '')}
        ${tile('Faturamento', R$(c.vendas_total), '', 'verde')}
        ${tile('Diferença no fechamento', c.caixa.fechamento ? R$(c.caixa.diferenca) : '—',
          c.caixa.fechamento ? 'contado ' + R$(c.caixa.valor_informado) : 'ainda aberto',
          Math.abs(Number(c.caixa.diferenca || 0)) < 0.01 ? 'verde' : 'vermelho')}
      </div>
      <div class="tabela-wrap"><table><thead><tr><th>Forma de pagamento</th>
        <th class="centro">Vendas</th><th class="num">Valor</th></tr></thead>
        <tbody>${c.formas.map((f) => `<tr><td>${esc(f.forma)}</td>
          <td class="centro">${f.vendas}</td><td class="num"><strong>${N(f.valor)}</strong></td></tr>`).join('')}
        </tbody></table></div>
      ${c.caixa.observacao ? `<div class="aviso info" style="margin-top:12px"><span>📝</span><div>${esc(c.caixa.observacao)}</div></div>` : ''}`;
    el('vendaAcoes').innerHTML = `<button class="btn" onclick="fecharModal('modalVenda')">Fechar</button>`;
    abrirModal('modalVenda');
  } catch (e) { erro(e.message); }
}

/* ============================ CONTAS A RECEBER ============================ */

async function carregarReceber(clienteId) {
  try {
    const p = new URLSearchParams();
    if (val('recDe')) p.set('de', val('recDe'));
    if (val('recAte')) p.set('ate', val('recAte'));
    if (val('recSituacao')) p.set('situacao', val('recSituacao'));
    if (val('recBusca')) p.set('q', val('recBusca'));
    if (clienteId) p.set('cliente_id', clienteId);

    const r = await api('/api/receber?' + p.toString());

    el('recTotais').innerHTML = `
      ${tile('Em aberto', R$(r.totais.em_aberto), 'total a receber', '')}
      ${tile('Vencidos', R$(r.totais.vencidos), 'em atraso', r.totais.vencidos > 0 ? 'vermelho' : 'verde')}
      ${tile('Vencem hoje', R$(r.totais.vence_hoje), 'cobrar hoje', 'laranja')}
      ${tile('Já recebido', R$(r.totais.recebido), 'no filtro atual', 'verde')}`;

    const pill = { pago: 'verde', vencido: 'vermelha', vence_hoje: 'amarela', aberto: 'azul' };
    const rot = { pago: 'recebido', vencido: 'vencido', vence_hoje: 'vence hoje', aberto: 'em aberto' };

    el('recLista').innerHTML = r.titulos.length ? `
      <table><thead><tr>
        <th>Documento</th><th>Cliente</th><th>Emissão</th><th>Vencimento</th>
        <th class="centro">Atraso</th><th class="num">Valor</th><th class="num">Pago</th>
        <th class="num">Saldo</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${r.titulos.map((t) => `<tr>
        <td><strong>${esc(t.documento)}</strong>
          <div style="font-size:11px;color:var(--texto-fraco)">parcela ${t.parcela}/${t.total_parcelas}</div></td>
        <td>${esc(t.cliente_nome)}</td>
        <td>${dataBr(t.emissao)}</td>
        <td style="${t.status === 'vencido' ? 'color:var(--vermelho);font-weight:700' : ''}">${dataBr(t.vencimento)}</td>
        <td class="centro">${t.status === 'vencido' ? t.dias + ' dias' : '—'}</td>
        <td class="num">${N(t.valor)}</td>
        <td class="num">${Number(t.valor_pago) > 0 ? N(t.valor_pago) : '—'}</td>
        <td class="num"><strong>${t.status === 'pago' ? '—' : N(t.saldo)}</strong></td>
        <td class="centro"><span class="pill ${pill[t.status]}">${rot[t.status]}</span></td>
        <td class="centro" style="white-space:nowrap">
          ${t.status !== 'pago'
            ? `<button class="btn pequeno verde" onclick='abrirBaixa(${JSON.stringify(t).replace(/'/g, "&#39;")})'>💰 Receber</button>`
            : `<button class="btn-ic" onclick="estornarTitulo(${t.id})" title="Estornar">↺</button>`}
          <button class="btn-ic" onclick="verVenda(${t.venda_id})" title="Ver a venda">🧾</button>
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="5">${r.titulos.length} parcela(s)</td>
        <td class="num">${N(r.titulos.reduce((s, t) => s + Number(t.valor), 0))}</td>
        <td class="num">${N(r.titulos.reduce((s, t) => s + Number(t.valor_pago), 0))}</td>
        <td class="num">${N(r.totais.em_aberto)}</td>
        <td colspan="2"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">📆</span>Nenhuma parcela no filtro.</div>';
  } catch (e) { erro(e.message); }
}

function abrirBaixa(t) {
  setVal('bxId', t.id);
  setVal('bxValor', Number(t.saldo).toFixed(2));
  setVal('bxForma', 'DINHEIRO');
  setVal('bxObs', '');
  el('bxInfo').innerHTML = `
    <div style="background:#f5f7fa;border-radius:6px;padding:11px;font-size:13.5px;line-height:1.8">
      <div><strong>${esc(t.cliente_nome)}</strong></div>
      <div>Documento ${esc(t.documento)} — parcela ${t.parcela} de ${t.total_parcelas}</div>
      <div>Vencimento ${dataBr(t.vencimento)}
        ${t.status === 'vencido' ? `<span class="pill vermelha">${t.dias} dias em atraso</span>` : ''}</div>
      <div style="margin-top:5px;font-size:16px"><strong>Saldo: ${R$(t.saldo)}</strong></div>
    </div>`;
  abrirModal('modalBaixa');
  setTimeout(() => el('bxValor').select(), 100);
}

async function salvarBaixa() {
  try {
    const r = await api(`/api/receber/${val('bxId')}/baixar`, {
      method: 'POST',
      body: { valor: valor(el('bxValor').value), forma: val('bxForma'), observacao: val('bxObs') }
    });
    fecharModal('modalBaixa');
    carregarReceber();
    ok(r.quitado ? 'Parcela quitada.' : 'Pagamento parcial registrado.');
  } catch (e) { erro(e.message); }
}

async function estornarTitulo(id) {
  if (!confirm('Estornar o recebimento desta parcela? Ela volta para em aberto.')) return;
  try {
    await api(`/api/receber/${id}/estornar`, { method: 'POST' });
    carregarReceber();
    ok('Recebimento estornado.');
  } catch (e) { erro(e.message); }
}
