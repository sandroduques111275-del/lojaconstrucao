/* ==========================================================================
   obras.js — [1.16] Obras do dono: material que sai a preço de custo e o
   saldo que ele acerta com a loja. Tela separada, fora do caixa.
   ========================================================================== */

let OBRAS = [];
let OBRA_ABERTA = null;        // id da obra aberta no detalhe
let SAIDA_ITENS = [];          // itens sendo montados em "Saída pra obra"

async function carregarObras() {
  try {
    const st = el('obraStatus') ? val('obraStatus') : '';
    const r = await api('/api/obras' + (st ? '?status=' + st : ''));
    OBRAS = r.obras || [];

    el('obrasTotais').innerHTML = `
      ${tile('Retirado (custo)', R$(r.totais.retirado), 'material que saiu para as obras', '')}
      ${tile('Pago', R$(r.totais.pago), 'o dono já acertou', 'verde')}
      ${tile('Saldo a pagar', R$(r.totais.saldo), 'falta o dono pagar à loja', r.totais.saldo > 0 ? 'vermelho' : 'verde')}
      ${tile('Obras', String(r.totais.qtd), 'cadastradas', 'cinza')}`;

    el('obrasLista').innerHTML = OBRAS.length ? `
      <table><thead><tr>
        <th>Obra</th><th>Responsável</th><th class="centro">Situação</th>
        <th class="num">Retirado</th><th class="num">Pago</th><th class="num">Saldo</th><th></th>
      </tr></thead><tbody>
      ${OBRAS.map((o) => `<tr style="cursor:pointer" onclick="abrirObra(${o.id})">
        <td><strong>${esc(o.nome)}</strong>${o.endereco ? `<div style="font-size:11px;color:var(--texto-fraco)">${esc(o.endereco)}</div>` : ''}</td>
        <td>${esc(o.responsavel || '—')}</td>
        <td class="centro"><span class="pill ${o.status === 'concluida' ? 'cinza' : 'azul'}">${o.status === 'concluida' ? 'concluída' : 'em andamento'}</span></td>
        <td class="num">${N(o.retirado)}</td>
        <td class="num">${N(o.pago)}</td>
        <td class="num"><strong style="${o.saldo > 0 ? 'color:var(--vermelho)' : 'color:var(--verde)'}">${N(o.saldo)}</strong></td>
        <td class="centro"><button class="btn pequeno" onclick="event.stopPropagation();abrirObra(${o.id})">Abrir</button></td>
      </tr>`).join('')}
      </tbody></table>`
      : '<div class="vazio"><span class="ic">🏗️</span>Nenhuma obra cadastrada. Clique em “Nova obra”.</div>';
  } catch (e) { erro(e.message); }
}

/* ---------------- cadastro da obra ---------------- */
function abrirCadObra(o) {
  ['obra_nome', 'obra_responsavel', 'obra_endereco', 'obra_telefone', 'obra_observacao'].forEach((c) => setVal(c, ''));
  setVal('obra_id', o ? o.id : '');
  setVal('obra_status', o ? o.status : 'andamento');
  if (o) {
    setVal('obra_nome', o.nome); setVal('obra_responsavel', o.responsavel);
    setVal('obra_endereco', o.endereco); setVal('obra_telefone', o.telefone);
    setVal('obra_observacao', o.observacao);
  }
  el('obraCadTitulo').textContent = o ? 'Editar obra' : 'Nova obra';
  abrirModal('modalObraCad');
  setTimeout(() => el('obra_nome').focus(), 100);
}

async function salvarObra() {
  if (!val('obra_nome')) { alerta('Informe o nome da obra.'); return; }
  try {
    await api('/api/obras', {
      method: 'POST',
      body: {
        id: val('obra_id') || null, nome: val('obra_nome'), responsavel: val('obra_responsavel'),
        endereco: val('obra_endereco'), telefone: val('obra_telefone'),
        observacao: val('obra_observacao'), status: val('obra_status')
      }
    });
    fecharModal('modalObraCad');
    const abrirDepois = val('obra_id');
    await carregarObras();
    if (abrirDepois) abrirObra(Number(abrirDepois));
    ok('Obra salva.');
  } catch (e) { erro(e.message); }
}

async function excluirObra(id) {
  if (!confirm('Excluir esta obra? (só dá para excluir obra sem saídas e sem pagamentos)')) return;
  try {
    await api('/api/obras/' + id, { method: 'DELETE' });
    fecharModal('modalObra');
    carregarObras();
    ok('Obra excluída.');
  } catch (e) { erro(e.message); }
}

/* ---------------- detalhe da obra ---------------- */
async function abrirObra(id) {
  try {
    const d = await api('/api/obras/' + id);
    OBRA_ABERTA = d.obra.id;
    el('obraTitulo').textContent = d.obra.nome;
    el('obraCorpo').innerHTML = htmlDetalheObra(d);
    abrirModal('modalObra');
  } catch (e) { erro(e.message); }
}

function htmlDetalheObra(d) {
  const o = d.obra, r = d.resumo;
  const cab = `
    <div style="font-size:12.5px;color:var(--texto-fraco);margin-bottom:10px">
      ${o.responsavel ? '👷 ' + esc(o.responsavel) + ' · ' : ''}
      ${o.endereco ? '📍 ' + esc(o.endereco) + ' · ' : ''}
      ${o.telefone ? '📞 ' + esc(o.telefone) : ''}
      <span class="pill ${o.status === 'concluida' ? 'cinza' : 'azul'}" style="margin-left:6px">${o.status === 'concluida' ? 'concluída' : 'em andamento'}</span>
    </div>
    <div class="grid g3" style="margin-bottom:12px">
      ${tile('Retirado (custo)', R$(r.retirado), 'total de material', '')}
      ${tile('Pago', R$(r.pago), 'já acertado', 'verde')}
      ${tile('Saldo a pagar', R$(r.saldo), r.saldo > 0 ? 'o dono deve à loja' : 'quitado', r.saldo > 0 ? 'vermelho' : 'verde')}
    </div>
    <div class="acoes" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <button class="btn laranja" onclick="abrirSaidaObra(${o.id})">📦 Registrar saída de material</button>
      <button class="btn verde" onclick="abrirPagtoObra(${o.id})">💵 Registrar pagamento</button>
      <button class="btn" onclick="imprimirExtratoObra(${o.id})">🖨️ Extrato</button>
      <button class="btn" onclick='abrirCadObra(${JSON.stringify(o).replace(/'/g, "&#39;")})'>✏️ Editar</button>
      <button class="btn-ic" title="Excluir obra" onclick="excluirObra(${o.id})" style="margin-left:auto">🗑️</button>
    </div>`;

  const saidas = d.saidas.length ? d.saidas.map((s) => `
    <div class="card" style="margin:0 0 10px;padding:10px 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <strong>Saída de ${dataBr(s.data)}</strong>
        <span>R$ ${N(s.total)}
          <button class="btn-ic" title="Estornar esta saída (devolve ao estoque)" onclick="estornarSaidaObra(${s.id})">↺</button></span>
      </div>
      ${s.observacao ? `<div style="font-size:12px;color:var(--texto-fraco)">${esc(s.observacao)}</div>` : ''}
      <div class="tabela-wrap" style="margin-top:6px"><table>
        <thead><tr><th>Material</th><th class="centro">Un.</th><th class="num">Qtd.</th><th class="num">Custo</th><th class="num">Total</th></tr></thead>
        <tbody>${s.itens.map((i) => `<tr><td>${esc(i.descricao)}</td><td class="centro">${esc(i.unidade)}</td>
          <td class="num">${Q(i.quantidade)}</td><td class="num">${N(i.custo_unit)}</td><td class="num">${N(i.total)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('') : '<div class="vazio" style="padding:18px"><span class="ic">📦</span>Nenhuma saída ainda.</div>';

  const pagamentos = d.pagamentos.length ? `
    <div class="tabela-wrap"><table>
      <thead><tr><th>Data</th><th>Forma</th><th>Observação</th><th class="num">Valor</th><th></th></tr></thead>
      <tbody>${d.pagamentos.map((p) => `<tr>
        <td>${dataBr(p.data)}</td><td>${esc(p.forma)}</td><td>${esc(p.observacao || '—')}</td>
        <td class="num"><strong>${N(p.valor)}</strong></td>
        <td class="centro"><button class="btn-ic" title="Estornar" onclick="estornarPagtoObra(${p.id})">↺</button></td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="vazio" style="padding:18px"><span class="ic">💵</span>Nenhum pagamento ainda.</div>';

  const porProd = d.por_produto.length ? `
    <div class="tabela-wrap"><table>
      <thead><tr><th>Material</th><th class="centro">Un.</th><th class="num">Qtd. total</th><th class="num">Valor (custo)</th></tr></thead>
      <tbody>${d.por_produto.map((p) => `<tr><td>${esc(p.descricao)}</td><td class="centro">${esc(p.unidade)}</td>
        <td class="num">${Q(p.quantidade)}</td><td class="num">${N(p.total)}</td></tr>`).join('')}</tbody></table></div>` : '';

  return cab +
    `<h3 style="margin:4px 0 8px">📦 Saídas de material</h3>${saidas}` +
    `<h3 style="margin:16px 0 8px">💵 Pagamentos</h3>${pagamentos}` +
    (porProd ? `<h3 style="margin:16px 0 8px">📊 Resumo por material</h3>${porProd}` : '');
}

function imprimirExtratoObra(id) {
  const j = window.open('/api/obras/' + id + '/extrato?token=' + encodeURIComponent(TOKEN), '_blank');
  if (!j) alerta('O navegador bloqueou a janela. Libere os pop-ups deste site.');
}

async function estornarSaidaObra(id) {
  if (!confirm('Estornar esta saída? O material volta para o estoque.')) return;
  try {
    const r = await api('/api/obras/saida/' + id, { method: 'DELETE' });
    ok(`Saída estornada (${r.itens} item devolvido ao estoque).`);
    abrirObra(OBRA_ABERTA); carregarObras();
  } catch (e) { erro(e.message); }
}

async function estornarPagtoObra(id) {
  if (!confirm('Estornar este pagamento?')) return;
  try {
    await api('/api/obras/pagamento/' + id, { method: 'DELETE' });
    ok('Pagamento estornado.');
    abrirObra(OBRA_ABERTA); carregarObras();
  } catch (e) { erro(e.message); }
}

/* ---------------- saída de material ---------------- */
function abrirSaidaObra(obraId) {
  OBRA_ABERTA = obraId;
  SAIDA_ITENS = [];
  setVal('saidaData', hojeIso());
  setVal('saidaObs', '');
  setVal('saidaBusca', '');
  el('saidaResultado').style.display = 'none';
  el('saidaResultado').innerHTML = '';
  renderItensSaida();
  abrirModal('modalObraSaida');
  setTimeout(() => el('saidaBusca').focus(), 100);
}

let timerSaida = null;
function buscarProdutoSaida() {
  clearTimeout(timerSaida);
  timerSaida = setTimeout(async () => {
    const t = val('saidaBusca');
    const c = el('saidaResultado');
    if (t.length < 2) { c.style.display = 'none'; return; }
    try {
      const lista = await api('/api/produtos/busca?q=' + encodeURIComponent(t));
      c.style.display = 'block';
      c.innerHTML = lista.length
        ? lista.slice(0, 20).map((p) => `
            <div class="item" onclick='addItemSaida(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
              <div class="d"><div class="nome">${esc(p.descricao)}</div>
                <div class="sub">${esc(p.codigo || '')} · custo ${R$(p.preco_custo)} · estoque ${Q(p.estoque)} ${esc(p.unidade)}</div></div>
            </div>`).join('')
        : '<div style="padding:12px;font-size:13px;color:var(--texto-fraco)">Nenhum produto com esse nome.</div>';
    } catch (e) { erro(e.message); }
  }, 220);
}

function addItemSaida(p) {
  const existe = SAIDA_ITENS.find((i) => i.produto_id === p.id);
  if (existe) { existe.quantidade = round2v(existe.quantidade + 1); }
  else {
    SAIDA_ITENS.push({
      produto_id: p.id, codigo: p.codigo, descricao: p.descricao, unidade: p.unidade,
      quantidade: 1, custo_unit: Number(p.preco_custo) || 0, estoque: Number(p.estoque) || 0
    });
  }
  setVal('saidaBusca', '');
  el('saidaResultado').style.display = 'none';
  renderItensSaida();
  el('saidaBusca').focus();
}

function round2v(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function atualizarItemSaida(i, campo, valorTxt) {
  if (!SAIDA_ITENS[i]) return;
  SAIDA_ITENS[i][campo] = valor(valorTxt);
  // atualiza só os totais, sem redesenhar (não perder o foco do campo)
  const it = SAIDA_ITENS[i];
  const tot = el('saidaTot' + i);
  if (tot) tot.textContent = N(round2v(it.quantidade * it.custo_unit));
  const geral = el('saidaTotalGeral');
  if (geral) geral.textContent = R$(SAIDA_ITENS.reduce((s, x) => s + round2v(x.quantidade * x.custo_unit), 0));
}

function removerItemSaida(i) { SAIDA_ITENS.splice(i, 1); renderItensSaida(); }

function renderItensSaida() {
  const total = SAIDA_ITENS.reduce((s, x) => s + round2v(x.quantidade * x.custo_unit), 0);
  el('saidaItens').innerHTML = SAIDA_ITENS.length ? `
    <table><thead><tr>
      <th>Material</th><th class="centro" style="width:90px">Qtd.</th>
      <th class="num" style="width:110px">Custo un.</th><th class="num" style="width:90px">Total</th><th style="width:36px"></th>
    </tr></thead><tbody>
    ${SAIDA_ITENS.map((it, i) => `<tr>
      <td><strong>${esc(it.descricao)}</strong>
        <div style="font-size:11px;color:var(--texto-fraco)">${esc(it.unidade)} · estoque ${Q(it.estoque)}</div></td>
      <td class="centro"><input type="number" step="0.001" min="0" value="${it.quantidade}"
        style="width:80px;text-align:center" oninput="atualizarItemSaida(${i},'quantidade',this.value)"></td>
      <td class="num"><input type="number" step="0.01" min="0" value="${it.custo_unit.toFixed(2)}"
        style="width:100px;text-align:right" oninput="atualizarItemSaida(${i},'custo_unit',this.value)"></td>
      <td class="num"><strong id="saidaTot${i}">${N(round2v(it.quantidade * it.custo_unit))}</strong></td>
      <td class="centro"><button class="btn-ic" onclick="removerItemSaida(${i})" title="Tirar">🗑️</button></td>
    </tr>`).join('')}
    </tbody><tfoot><tr><td colspan="3" class="num">Total (custo)</td>
      <td class="num"><strong id="saidaTotalGeral">${R$(total)}</strong></td><td></td></tr></tfoot></table>`
    : '<div class="vazio" style="padding:16px"><span class="ic">📦</span>Busque e adicione os materiais que vão para a obra.</div>';
}

async function salvarSaidaObra() {
  if (!SAIDA_ITENS.length) { alerta('Adicione ao menos um material.'); return; }
  if (SAIDA_ITENS.some((i) => valor(i.quantidade) <= 0)) { alerta('Há item com quantidade zerada.'); return; }
  try {
    const r = await api('/api/obras/' + OBRA_ABERTA + '/saida', {
      method: 'POST',
      body: {
        data: val('saidaData'), observacao: val('saidaObs'),
        itens: SAIDA_ITENS.map((i) => ({ produto_id: i.produto_id, quantidade: valor(i.quantidade), custo_unit: valor(i.custo_unit) }))
      }
    });
    fecharModal('modalObraSaida');
    ok('Saída registrada: ' + R$(r.total) + ' em material.');
    abrirObra(OBRA_ABERTA); carregarObras();
  } catch (e) { erro(e.message); }
}

/* ---------------- pagamento ---------------- */
function abrirPagtoObra(obraId) {
  OBRA_ABERTA = obraId;
  setVal('pagtoData', hojeIso());
  setVal('pagtoValor', '');
  setVal('pagtoForma', 'PIX');
  setVal('pagtoObs', '');
  abrirModal('modalObraPagto');
  setTimeout(() => el('pagtoValor').focus(), 100);
}

async function salvarPagtoObra() {
  if (valor(el('pagtoValor').value) <= 0) { alerta('Informe o valor pago.'); return; }
  try {
    await api('/api/obras/' + OBRA_ABERTA + '/pagamento', {
      method: 'POST',
      body: { data: val('pagtoData'), valor: valor(el('pagtoValor').value), forma: val('pagtoForma'), observacao: val('pagtoObs') }
    });
    fecharModal('modalObraPagto');
    ok('Pagamento registrado.');
    abrirObra(OBRA_ABERTA); carregarObras();
  } catch (e) { erro(e.message); }
}
