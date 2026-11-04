/* ==========================================================================
   expedicao.js — Expedição / Entregas

   A venda não baixa o estoque. Ela entra aqui como "a entregar"; quando a
   expedição confirma que a mercadoria saiu (toda ou parte), o estoque
   baixa naquela hora, com quem recebeu. Romaneio para o motorista levar.
   ========================================================================== */

let EXP_DADOS = null;
let EXP_ATUAL = null;    // entrega aberta no modal de confirmação

const PILL_ENTREGA = {
  pendente: ['cinza', 'a entregar'], parcial: ['amarela', 'parcial'],
  entregue: ['verde', 'entregue'], cancelada: ['vermelha', 'cancelada']
};
const pillEntrega = (s) => { const p = PILL_ENTREGA[s] || ['cinza', s]; return `<span class="pill ${p[0]}">${esc(p[1])}</span>`; };

async function carregarExpedicao() {
  const alvo = el('expLista');
  if (!alvo) return;
  alvo.innerHTML = '<div class="vazio">Carregando…</div>';
  try {
    const p = new URLSearchParams();
    p.set('situacao', val('expSituacao') || 'abertas');
    if (val('expDe')) p.set('de', val('expDe'));
    if (val('expAte')) p.set('ate', val('expAte'));
    if (val('expBusca')) p.set('q', val('expBusca'));
    if (el('expAtrasadas') && el('expAtrasadas').checked) p.set('atrasadas', '1');
    EXP_DADOS = await api('/api/entregas?' + p.toString());
  } catch (e) { alvo.innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`; return; }

  const r = EXP_DADOS.resumo;
  el('expResumo').innerHTML = `
    <div class="grid g4" style="margin-bottom:14px">
      ${tile('A entregar', r.abertas, `${R$(r.abertas_valor)} em mercadoria vendida`, r.abertas ? 'laranja' : 'verde')}
      ${tile('Entregas parciais', r.parciais, 'saiu uma parte, falta o resto', r.parciais ? 'laranja' : '')}
      ${tile('Atrasadas', r.atrasadas, 'previsão já passou', r.atrasadas ? 'vermelho' : '')}
      ${tile('Entregues hoje', r.entregues_hoje, 'confirmações de hoje', 'verde')}
    </div>`;
  const bd = el('badgeEntregas');
  if (bd) { bd.textContent = r.abertas; bd.style.display = r.abertas ? '' : 'none'; }

  const lista = EXP_DADOS.entregas;
  alvo.innerHTML = lista.length ? `
    <table><thead><tr>
      <th>Cupom</th><th>Venda</th><th>Cliente / endereço</th><th>Itens</th><th>Previsão</th><th class="num">Valor</th><th class="centro">Situação</th><th></th>
    </tr></thead><tbody>
    ${lista.map((e) => {
      const aberta = e.situacao === 'pendente' || e.situacao === 'parcial';
      const itensTxt = e.itens.map((i) => {
        const falta = Math.max(0, Number(i.quantidade) - Number(i.entregue));
        return `<div style="${falta > 0 ? '' : 'color:var(--texto-fraco);text-decoration:line-through'}">${Q(i.quantidade)} ${esc(i.unidade)} ${esc(i.descricao)}${
          Number(i.entregue) > 0 && falta > 0 ? ` <span style="color:var(--laranja-esc)">(faltam ${Q(falta)})</span>` : ''}</div>`;
      }).join('');
      return `<tr class="${e.situacao === 'cancelada' ? 'cancelada' : ''}">
        <td><strong>${String(e.venda_numero).padStart(6, '0')}</strong></td>
        <td style="white-space:nowrap;font-size:12px">${dataHoraBr(e.data_venda)}</td>
        <td><strong>${esc(e.cliente_nome)}</strong>${e.telefone ? ` · ${esc(e.telefone)}` : ''}
          <div style="font-size:11.5px;color:var(--texto-fraco)">${esc(e.endereco || 'sem endereço — retirada / a combinar')}</div>
          ${e.observacao ? `<div style="font-size:11px;color:var(--laranja-esc)">${esc(e.observacao)}</div>` : ''}</td>
        <td style="font-size:12px;max-width:380px">${itensTxt}</td>
        <td style="white-space:nowrap;${e.atrasada ? 'color:var(--vermelho);font-weight:700' : ''}">${e.previsao ? dataBr(e.previsao) : '—'}${e.atrasada ? '<br><span style="font-size:10.5px">atrasada</span>' : ''}</td>
        <td class="num"><strong>${R$(e.venda_total)}</strong></td>
        <td class="centro">${pillEntrega(e.situacao)}</td>
        <td class="centro" style="white-space:nowrap">
          ${aberta ? `<button class="btn pequeno verde" onclick="abrirEntrega(${e.id})">✅ Entregar</button>` : ''}
          <button class="btn-ic" title="Romaneio para imprimir" onclick="imprimirRomaneio(${e.id})">🖨️</button>
          ${aberta ? `<button class="btn-ic" title="Endereço, telefone, previsão" onclick="abrirDadosEntrega(${e.id})">📍</button>` : ''}
        </td>
      </tr>`;
    }).join('')}
    </tbody><tfoot><tr><td colspan="8">${lista.length} entrega(s)</td></tr></tfoot></table>`
    : '<div class="vazio"><span class="ic">🚚</span>Nada por aqui neste filtro.</div>';
}

/* ---------------- confirmar ---------------- */

async function abrirEntrega(id) {
  try { EXP_ATUAL = await api('/api/entregas/' + id); } catch (e) { return erro(e.message); }
  const e = EXP_ATUAL;
  el('entregaTitulo').textContent = `🚚 Entrega do cupom ${String(e.venda_numero).padStart(6, '0')} — ${e.cliente_nome}`;
  el('entregaCabecalho').innerHTML = `${esc(e.endereco || 'sem endereço')}${e.telefone ? ' · ' + esc(e.telefone) : ''}
    ${e.movimentos.length ? `<div style="font-size:12px;color:var(--texto-fraco);margin-top:4px">Já saiu: ${e.movimentos.map((m) =>
      `${dataHoraBr(m.data)} — ${m.itens.map((i) => `${Q(i.quantidade)} ${esc(i.unidade)} ${esc(i.descricao)}`).join(', ')}${m.recebido_por ? ' (' + esc(m.recebido_por) + ')' : ''}`).join(' · ')}</div>` : ''}`;
  el('entregaItens').innerHTML = `<table><thead><tr><th>Produto</th><th class="num">Vendido</th><th class="num">Já entregue</th><th class="num">Falta</th><th style="width:150px">Entregar agora</th></tr></thead>
    <tbody>${e.itens.map((i) => {
      const falta = Math.max(0, Number(i.quantidade) - Number(i.entregue));
      return `<tr class="${falta > 0 ? '' : 'inativa'}">
        <td><strong>${esc(i.descricao)}</strong><div style="font-size:11px;color:var(--texto-fraco)">cód. ${esc(i.codigo)} · ${esc(i.unidade)}</div></td>
        <td class="num">${Q(i.quantidade)}</td><td class="num">${Q(i.entregue)}</td>
        <td class="num"><strong>${Q(falta)}</strong></td>
        <td><input id="entQ${i.id}" inputmode="decimal" value="${falta > 0 ? String(falta).replace('.', ',') : ''}" ${falta > 0 ? '' : 'disabled'} style="width:120px;text-align:right"></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  setVal('entregaRecebidoPor', '');
  setVal('entregaObs', '');
  abrirModal('modalEntrega');
}

function entregaTudo() {
  if (!EXP_ATUAL) return;
  EXP_ATUAL.itens.forEach((i) => {
    const falta = Math.max(0, Number(i.quantidade) - Number(i.entregue));
    if (el('entQ' + i.id) && falta > 0) el('entQ' + i.id).value = String(falta).replace('.', ',');
  });
}

async function confirmarEntregaModal() {
  if (!EXP_ATUAL) return;
  const itens = [];
  let parcial = false;
  EXP_ATUAL.itens.forEach((i) => {
    const campo = el('entQ' + i.id);
    if (!campo || campo.disabled) return;
    const q = valor(campo.value);
    const falta = Math.max(0, Number(i.quantidade) - Number(i.entregue));
    if (q > 0) itens.push({ id: i.id, quantidade: q });
    if (q < falta - 0.0001) parcial = true;
  });
  if (!itens.length) return alerta('Informe a quantidade entregue de pelo menos um item.');
  if (parcial && !confirm('Entrega PARCIAL: o que não foi informado continua pendente para outra viagem.\n\nConfirmar?')) return;
  const btn = el('btnConfirmarEntrega');
  btn.disabled = true;
  try {
    const r = await api(`/api/entregas/${EXP_ATUAL.id}/confirmar`, { method: 'POST',
      body: { itens, recebido_por: val('entregaRecebidoPor'), observacao: val('entregaObs') } });
    fecharModal('modalEntrega');
    ok(r.completa ? 'Entrega concluída — estoque baixado.' : 'Entrega parcial registrada — estoque baixado na quantidade entregue.');
    carregarExpedicao();
    if (SECAO_ATUAL === 'dashboard') carregarDashboard();
  } catch (e) { erro(e.message); }
  finally { btn.disabled = false; }
}

/* ---------------- dados e romaneio ---------------- */

async function abrirDadosEntrega(id) {
  let e;
  try { e = await api('/api/entregas/' + id); } catch (x) { return erro(x.message); }
  setVal('entDados_id', e.id);
  setVal('entDados_endereco', e.endereco || '');
  setVal('entDados_telefone', e.telefone || '');
  setVal('entDados_previsao', e.previsao || '');
  setVal('entDados_obs', e.observacao || '');
  abrirModal('modalEntregaDados');
}

async function salvarDadosEntrega() {
  try {
    await api(`/api/entregas/${val('entDados_id')}/dados`, { method: 'POST', body: {
      endereco: val('entDados_endereco'), telefone: val('entDados_telefone'),
      previsao: val('entDados_previsao'), observacao: val('entDados_obs') } });
    fecharModal('modalEntregaDados');
    ok('Dados da entrega salvos.');
    carregarExpedicao();
  } catch (e) { erro(e.message); }
}

function imprimirRomaneio(id) {
  const j = window.open(`/api/entregas/${id}/romaneio?token=${encodeURIComponent(TOKEN)}`, 'romaneio' + id, 'width=900,height=800');
  if (!j) alerta('O navegador bloqueou a janela. Libere os pop-ups deste site.');
}
