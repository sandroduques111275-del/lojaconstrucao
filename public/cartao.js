/* ==========================================================================
   cartao.js — maquininhas (operadoras) e recebíveis de cartão
   ========================================================================== */

let OPERADORAS = [];

async function carregarOperadorasLista() {
  OPERADORAS = await api('/api/operadoras');

  const opts = OPERADORAS.map((o) =>
    `<option value="${o.id}">${esc(o.nome)}${o.apelido ? ' — ' + esc(o.apelido) : ''}</option>`).join('');

  if (el('pagOperadora')) {
    el('pagOperadora').innerHTML = OPERADORAS.length
      ? opts : '<option value="">— nenhuma maquininha cadastrada —</option>';
    const padrao = OPERADORAS.find((o) => o.padrao);
    if (padrao) setVal('pagOperadora', padrao.id);
  }
  if (el('crOperadora')) {
    el('crOperadora').innerHTML = '<option value="">Todas as maquininhas</option>' + opts;
  }
}

/* ============================ CADASTRO ============================ */

async function carregarOperadoras() {
  try {
    await carregarOperadorasLista();
    const lista = await api('/api/operadoras?status=todos');

    el('opLista').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Maquininha</th><th class="num">Débito</th><th class="num">Créd. à vista</th>
        <th class="num">Créd. parcelado</th><th class="centro">Prazos (dias)</th>
        <th class="num">A receber</th><th class="num">Taxas pagas</th>
        <th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${lista.map((o) => `<tr class="${o.status === 'ativo' ? '' : 'inativa'}">
        <td><strong>${esc(o.nome)}</strong>
          ${o.padrao ? ' <span class="pill azul">padrão</span>' : ''}
          ${o.apelido ? `<div style="font-size:11px;color:var(--texto-fraco)">${esc(o.apelido)}</div>` : ''}</td>
        <td class="num">${N(o.taxa_debito)}%</td>
        <td class="num">${N(o.taxa_credito)}%</td>
        <td class="num">${Number(o.taxa_parcelado) > 0 ? N(o.taxa_parcelado) + '%' : '—'}</td>
        <td class="centro" style="font-size:12px">
          déb. ${o.prazo_debito} • créd. ${o.prazo_credito} • parc. +${o.prazo_parcela}</td>
        <td class="num" style="${Number(o.a_receber) > 0 ? 'color:var(--verde);font-weight:700' : ''}">${N(o.a_receber)}
          ${o.parcelas_abertas ? `<div style="font-size:11px;color:var(--texto-fraco)">${o.parcelas_abertas} parcela(s)</div>` : ''}</td>
        <td class="num" style="color:var(--vermelho)">${N(o.taxas_pagas)}</td>
        <td class="centro"><span class="pill ${o.status === 'ativo' ? 'verde' : 'cinza'}">${o.status === 'ativo' ? 'ativa' : 'inativa'}</span></td>
        <td class="centro" style="white-space:nowrap">
          <button class="btn-ic" onclick='abrirOperadora(${JSON.stringify(o).replace(/'/g, "&#39;")})' title="Editar">✏️</button>
          <button class="btn-ic" onclick="excluirOperadora(${o.id}, '${esc(o.nome).replace(/'/g, '')}')" title="Excluir">🗑️</button>
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="5">${lista.length} maquininha(s)</td>
        <td class="num">${N(lista.reduce((s, o) => s + Number(o.a_receber), 0))}</td>
        <td class="num">${N(lista.reduce((s, o) => s + Number(o.taxas_pagas), 0))}</td>
        <td colspan="2"></td></tr></tfoot></table>`
      : `<div class="vazio"><span class="ic">🏧</span>Nenhuma maquininha cadastrada.<br>
         <small>Sem cadastro, a venda no cartão entra como paga na hora e não gera recebível.</small></div>`;
  } catch (e) { erro(e.message); }
}

function abrirOperadora(o) {
  ['op_nome', 'op_apelido', 'op_observacao'].forEach((c) => setVal(c, ''));
  setVal('op_id', '');
  setVal('op_taxa_debito', '1,99');
  setVal('op_taxa_credito', '3,49');
  setVal('op_taxa_parcelado', '4,99');
  setVal('op_prazo_debito', '1');
  setVal('op_prazo_credito', '30');
  setVal('op_prazo_parcela', '30');
  setVal('op_status', 'ativo');
  el('op_padrao').checked = !OPERADORAS.length;   // a primeira já nasce padrão
  el('operadoraTitulo').textContent = 'Nova maquininha';

  if (o && o.id) {
    setVal('op_id', o.id);
    setVal('op_nome', o.nome);
    setVal('op_apelido', o.apelido);
    setVal('op_taxa_debito', N(o.taxa_debito));
    setVal('op_taxa_credito', N(o.taxa_credito));
    setVal('op_taxa_parcelado', N(o.taxa_parcelado));
    setVal('op_prazo_debito', o.prazo_debito);
    setVal('op_prazo_credito', o.prazo_credito);
    setVal('op_prazo_parcela', o.prazo_parcela);
    setVal('op_status', o.status);
    setVal('op_observacao', o.observacao);
    el('op_padrao').checked = !!o.padrao;
    el('operadoraTitulo').textContent = 'Editar maquininha';
  }

  simularOperadora();
  ['op_taxa_debito', 'op_taxa_credito', 'op_taxa_parcelado',
   'op_prazo_credito', 'op_prazo_parcela'].forEach((c) => {
    el(c).oninput = simularOperadora;
  });

  abrirModal('modalOperadora');
  setTimeout(() => el('op_nome').focus(), 100);
}

/** Mostra, em dinheiro, o que a taxa significa numa venda de R$ 1.000. */
function simularOperadora() {
  const base = 1000;
  const tDeb = valor(el('op_taxa_debito').value);
  const tCre = valor(el('op_taxa_credito').value);
  const tPar = valor(el('op_taxa_parcelado').value) || tCre;
  const pCre = parseInt(el('op_prazo_credito').value) || 30;
  const pPar = parseInt(el('op_prazo_parcela').value) || 30;

  el('op_simulacao').innerHTML = `
    <div class="aviso info"><span>🧮</span><div>
      <strong>Numa venda de ${R$(base)}:</strong><br>
      Débito → você recebe <strong>${R$(base - base * tDeb / 100)}</strong>
        (taxa de ${R$(base * tDeb / 100)})<br>
      Crédito à vista → <strong>${R$(base - base * tCre / 100)}</strong>
        (taxa de ${R$(base * tCre / 100)}) em ${pCre} dias<br>
      Crédito em 3x → <strong>${R$(base - base * tPar / 100)}</strong>
        (taxa de ${R$(base * tPar / 100)}), caindo em ${pCre}, ${pCre + pPar} e ${pCre + pPar * 2} dias
    </div></div>`;
}

async function salvarOperadora() {
  if (!val('op_nome')) { alerta('Informe o nome da maquininha.'); return; }
  try {
    await api('/api/operadoras', {
      method: 'POST',
      body: {
        id: val('op_id') || null,
        nome: val('op_nome'), apelido: val('op_apelido'),
        taxa_debito: valor(el('op_taxa_debito').value),
        taxa_credito: valor(el('op_taxa_credito').value),
        taxa_parcelado: valor(el('op_taxa_parcelado').value),
        prazo_debito: parseInt(val('op_prazo_debito')) || 0,
        prazo_credito: parseInt(val('op_prazo_credito')) || 30,
        prazo_parcela: parseInt(val('op_prazo_parcela')) || 30,
        padrao: el('op_padrao').checked ? 1 : 0,
        status: val('op_status'),
        observacao: val('op_observacao')
      }
    });
    fecharModal('modalOperadora');
    await carregarOperadoras();
    ok('Maquininha salva.');
  } catch (e) { erro(e.message); }
}

async function excluirOperadora(id, nome) {
  if (!confirm(`Excluir a maquininha "${nome}"?\n\nSe já tiver vendas, será apenas inativada.`)) return;
  try {
    const r = await api('/api/operadoras/' + id, { method: 'DELETE' });
    carregarOperadoras();
    if (r.aviso) alerta(r.aviso); else ok('Maquininha excluída.');
  } catch (e) { erro(e.message); }
}

/* ============================ RECEBÍVEIS ============================ */

async function carregarCartao() {
  try {
    if (!OPERADORAS.length) await carregarOperadorasLista();

    el('cartaoAviso').innerHTML = OPERADORAS.length ? '' : `
      <div class="aviso alerta"><span>🏧</span><div>
        <strong>Nenhuma maquininha cadastrada.</strong> Enquanto não houver, as vendas no cartão
        não geram recebível — cadastre a sua com taxa e prazo.
        <button class="btn pequeno" style="margin-left:8px" onclick="irPara('operadoras')">Cadastrar</button>
      </div></div>`;

    const p = new URLSearchParams();
    if (val('crDe')) p.set('de', val('crDe'));
    if (val('crAte')) p.set('ate', val('crAte'));
    if (val('crSituacao')) p.set('situacao', val('crSituacao'));
    if (val('crOperadora')) p.set('operadora_id', val('crOperadora'));
    if (val('crForma')) p.set('forma', val('crForma'));

    const r = await api('/api/cartao/recebiveis?' + p.toString());

    el('crTotais').innerHTML = `
      ${tile('A receber das maquininhas', R$(r.totais.a_receber), 'líquido, já sem a taxa', 'verde')}
      ${tile('Atrasados', R$(r.totais.atrasados), r.totais.qtd_atrasados + ' parcela(s) não depositada(s)',
        r.totais.atrasados > 0 ? 'vermelho' : 'verde')}
      ${tile('Cai hoje', R$(r.totais.cai_hoje), 'confira o extrato', 'laranja')}
      ${tile('Taxas no filtro', R$(r.totais.taxas), 'quanto a maquininha ficou', 'vermelho')}`;

    const pill = { recebido: 'verde', atrasado: 'vermelha', cai_hoje: 'amarela', aberto: 'azul' };
    const rot = { recebido: 'recebido', atrasado: 'atrasado', cai_hoje: 'cai hoje', aberto: 'a receber' };

    el('crLista').innerHTML = r.recebiveis.length ? `
      <table><thead><tr>
        <th style="width:34px" class="centro"><input type="checkbox" onchange="marcarTodosCartao(this.checked)"></th>
        <th>Previsão</th><th class="centro">Falta</th><th>Maquininha</th><th>Modalidade</th>
        <th class="centro">Cupom</th><th class="num">Bruto</th><th class="num">Taxa</th>
        <th class="num">Líquido</th><th class="centro">Situação</th><th></th>
      </tr></thead><tbody>
      ${r.recebiveis.map((t) => `<tr>
        <td class="centro">${t.status !== 'recebido'
          ? `<input type="checkbox" class="chk-cartao" value="${t.id}">` : ''}</td>
        <td style="white-space:nowrap;${t.status === 'atrasado' ? 'color:var(--vermelho);font-weight:700' : ''}">${dataBr(t.previsao)}</td>
        <td class="centro" style="font-size:12px">${t.status === 'recebido' ? '—'
          : (t.dias > 0 ? 'em ' + t.dias + ' d' : (t.dias === 0 ? 'hoje' : Math.abs(t.dias) + ' d atrás'))}</td>
        <td><strong>${esc(t.operadora)}</strong>${t.bandeira ? `<div style="font-size:11px;color:var(--texto-fraco)">${esc(t.bandeira)}</div>` : ''}</td>
        <td style="font-size:12px">${t.forma === 'CARTAO DEBITO' ? 'Débito' : 'Crédito'}
          ${t.total_parcelas > 1 ? `<span class="pill cinza">${t.parcela}/${t.total_parcelas}</span>` : ''}</td>
        <td class="centro">${String(t.venda_numero).padStart(6, '0')}</td>
        <td class="num">${N(t.valor_bruto)}</td>
        <td class="num" style="color:var(--vermelho)">${N(t.valor_taxa)}
          <div style="font-size:10.5px;color:var(--texto-fraco)">${N(t.taxa_percentual)}%</div></td>
        <td class="num"><strong>${N(t.valor_liquido)}</strong></td>
        <td class="centro"><span class="pill ${pill[t.status]}">${rot[t.status]}</span></td>
        <td class="centro" style="white-space:nowrap">
          ${t.status !== 'recebido'
            ? `<button class="btn pequeno verde" onclick='abrirReceberCartao(${JSON.stringify(t).replace(/'/g, "&#39;")})'>✅ Caiu</button>`
            : `<button class="btn-ic" onclick="estornarCartao(${t.id})" title="Estornar">↺</button>`}
          <button class="btn-ic" onclick="verVenda(${t.venda_id})" title="Ver a venda">🧾</button>
        </td></tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="6">${r.recebiveis.length} parcela(s)</td>
        <td class="num">${N(r.totais.bruto)}</td>
        <td class="num">${N(r.totais.taxas)}</td>
        <td class="num">${N(r.totais.bruto - r.totais.taxas)}</td>
        <td colspan="2"></td>
      </tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">💳</span>Nenhuma parcela de cartão no filtro.</div>';
  } catch (e) { erro(e.message); }
}

function marcarTodosCartao(marcar) {
  document.querySelectorAll('.chk-cartao').forEach((c) => { c.checked = marcar; });
}

async function baixarLoteCartao() {
  const ids = [...document.querySelectorAll('.chk-cartao:checked')].map((c) => Number(c.value));
  if (!ids.length) { alerta('Marque as parcelas que a operadora depositou.'); return; }
  if (!confirm(`Confirmar o depósito de ${ids.length} parcela(s)?`)) return;
  try {
    const r = await api('/api/cartao/recebiveis/baixar-lote', { method: 'POST', body: { ids } });
    carregarCartao();
    ok(`${r.baixadas} parcela(s) baixada(s) — ${R$(r.total)}`);
  } catch (e) { erro(e.message); }
}

function abrirReceberCartao(t) {
  setVal('rcId', t.id);
  setVal('rcValor', Number(t.saldo).toFixed(2));
  setVal('rcObs', '');
  el('rcInfo').innerHTML = `
    <div style="background:#f5f7fa;border-radius:6px;padding:11px;font-size:13.5px;line-height:1.8">
      <div><strong>${esc(t.operadora)}</strong> — ${t.forma === 'CARTAO DEBITO' ? 'débito' : 'crédito'}
        ${t.total_parcelas > 1 ? `parcela ${t.parcela} de ${t.total_parcelas}` : 'à vista'}</div>
      <div>Cupom ${String(t.venda_numero).padStart(6, '0')} de ${dataBr(t.data_venda)}</div>
      <div>Previsto para ${dataBr(t.previsao)}
        ${t.status === 'atrasado' ? `<span class="pill vermelha">${Math.abs(t.dias)} dias de atraso</span>` : ''}</div>
      <div style="margin-top:6px">Bruto ${R$(t.valor_bruto)} − taxa ${R$(t.valor_taxa)} (${N(t.taxa_percentual)}%)</div>
      <div style="font-size:16px"><strong>Líquido: ${R$(t.saldo)}</strong></div>
    </div>`;
  abrirModal('modalReceberCartao');
  setTimeout(() => el('rcValor').select(), 100);
}

async function salvarReceberCartao() {
  try {
    const r = await api(`/api/cartao/recebiveis/${val('rcId')}/receber`, {
      method: 'POST',
      body: { valor: valor(el('rcValor').value), observacao: val('rcObs') }
    });
    fecharModal('modalReceberCartao');
    carregarCartao();
    ok(r.quitado ? 'Depósito confirmado.' : 'Depósito parcial registrado.');
  } catch (e) { erro(e.message); }
}

async function estornarCartao(id) {
  if (!confirm('Estornar esta baixa? A parcela volta para a lista de a receber.')) return;
  try {
    await api(`/api/cartao/recebiveis/${id}/estornar`, { method: 'POST' });
    carregarCartao();
    ok('Baixa estornada.');
  } catch (e) { erro(e.message); }
}

/* ============================ PDV ============================ */

/** Mostra quanto a maquininha vai descontar antes de o operador confirmar. */
function previewTaxaCartao() {
  const box = el('pagTaxaPreview');
  if (!box) return;

  const forma = el('modalPagamento').dataset.formaCartao || '';
  const op = OPERADORAS.find((o) => String(o.id) === val('pagOperadora'));
  const v = valor(el('pagValor').value);
  const parcelas = Math.max(1, parseInt(el('pagParcelas').value) || 1);

  if (!op || !v || !forma) { box.innerHTML = ''; return; }

  const debito = forma === 'CARTAO DEBITO';
  const taxa = debito ? Number(op.taxa_debito)
    : (parcelas > 1 && Number(op.taxa_parcelado) > 0 ? Number(op.taxa_parcelado) : Number(op.taxa_credito));
  const desconto = v * (taxa / 100);
  const prazo = debito ? Number(op.prazo_debito) : Number(op.prazo_credito);
  const entre = Number(op.prazo_parcela) || 30;

  const ultima = debito ? prazo : prazo + entre * (parcelas - 1);

  box.innerHTML = `
    <div class="aviso info" style="margin-bottom:0"><span>💳</span><div>
      Taxa de <strong>${N(taxa)}%</strong> → a loja recebe <strong>${R$(v - desconto)}</strong>
      (${R$(desconto)} fica com a maquininha).<br>
      ${parcelas > 1
        ? `Em ${parcelas} parcelas, a última cai em ${ultima} dias.`
        : `Cai em ${prazo} ${prazo === 1 ? 'dia' : 'dias'}.`}
    </div></div>`;
}
