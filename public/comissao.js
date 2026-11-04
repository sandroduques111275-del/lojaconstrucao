/* --------------------------------------------------------------------------
   COMISSAO DE VENDEDORES

   A venda pertence a quem estava logado quando ela foi feita. Aqui se ve
   quanto cada um vendeu, com quanto de comissao, e se ajusta o percentual
   de cada vendedor.
   -------------------------------------------------------------------------- */

let COMISSAO = null;

async function carregarComissoes() {
  const alvo = el('comissoesSaida');
  try {
    COMISSAO = await api(`/api/comissoes?de=${val('comDe')}&ate=${val('comAte')}`);
  } catch (e) {
    alvo.innerHTML = `<div class="card"><div class="aviso erro"><span>❌</span>
      <div>${esc(e.message)}</div></div></div>`;
    return;
  }
  setVal('cfg_comissao_base', COMISSAO.base);
  desenharComissoes();
}

/** Só quem mexe em usuários pode alterar percentual e base de cálculo. */
const podeMexerNaComissao = () => podeVer('usuarios') || podeVer('config');

function desenharComissoes() {
  const r = COMISSAO;
  const alvo = el('comissoesSaida');
  const sobreLucro = r.base === 'lucro';

  if (!r.vendedores.length) {
    alvo.innerHTML = `<div class="card"><div class="vazio"><span class="ic">🤑</span>
      Nenhuma venda no período.</div></div>`;
    return;
  }

  const semPercentual = r.vendedores.filter((v) => !v.percentual && !v.sem_cadastro);
  const semCadastro = r.vendedores.filter((v) => v.sem_cadastro);

  alvo.innerHTML = `
    <div class="grid g4" style="margin-bottom:16px">
      ${tile('Vendido no período', R$(r.total_vendido), `${r.vendedores.length} vendedor(es)`, 'azul')}
      ${tile('Lucro das vendas', R$(r.total_lucro), 'venda menos custo', 'verde')}
      ${tile('Comissão a pagar', R$(r.total_comissao),
        sobreLucro ? 'calculada sobre o lucro' : 'calculada sobre o valor vendido', 'laranja')}
      ${tile('Peso da comissão', r.total_vendido
        ? ((r.total_comissao / r.total_vendido) * 100).toFixed(2) + '%' : '—',
        'sobre o faturamento', 'cinza')}
    </div>

    ${semPercentual.length ? `<div class="aviso alerta"><span>⚠️</span>
      <div><strong>${semPercentual.length} vendedor(es) com 0% de comissão:</strong>
      ${semPercentual.map((v) => esc(v.nome)).join(', ')}.
      ${podeMexerNaComissao()
        ? 'Ajuste o percentual na coluna “%” da tabela abaixo.'
        : 'Peça ao administrador para ajustar.'}</div></div>` : ''}

    ${semCadastro.length ? `<div class="aviso info"><span>ℹ️</span>
      <div>Há vendas sem vendedor identificado — são vendas antigas, feitas antes
      da comissão existir, ou de um login que foi apagado. Elas aparecem como
      <strong>SEM VENDEDOR</strong> e não geram comissão.</div></div>` : ''}

    <div class="card">
      <h3>🤑 Comissão por vendedor
        <span class="acoes" style="font-weight:400;font-size:13px;color:var(--texto-fraco)">
          ${sobreLucro ? 'sobre o lucro' : 'sobre o valor vendido'}
        </span>
      </h3>
      <div class="tabela-wrap"><table>
        <thead><tr>
          <th>Vendedor</th><th>Login</th>
          <th class="centro">Vendas</th>
          <th class="num">Valor vendido</th>
          <th class="num">Ticket médio</th>
          <th class="num">Lucro</th>
          <th class="centro" style="width:105px">%</th>
          <th class="num">Comissão</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${r.vendedores.map((v) => linhaVendedor(v, sobreLucro)).join('')}
        </tbody>
        <tfoot><tr>
          <th colspan="3">TOTAL</th>
          <th class="num">${N(r.total_vendido)}</th>
          <th></th>
          <th class="num">${N(r.total_lucro)}</th>
          <th></th>
          <th class="num">${N(r.total_comissao)}</th>
          <th></th>
        </tr></tfoot>
      </table></div>
    </div>

    <div id="comissaoDetalhe"></div>`;
}

function linhaVendedor(v, sobreLucro) {
  const campoPct = podeMexerNaComissao() && !v.sem_cadastro
    ? `<input type="number" step="0.5" min="0" max="100" value="${v.percentual}"
             style="width:72px;text-align:right;padding:4px 6px"
             onchange="salvarPercentual(${v.id}, this)">`
    : `${v.percentual}%`;

  return `<tr class="${v.sem_cadastro ? 'cancelada' : ''}">
    <td><strong>${esc(v.nome)}</strong>
      ${!v.ativo && !v.sem_cadastro ? ' <span class="pill cinza">inativo</span>' : ''}</td>
    <td>${esc(v.login)}</td>
    <td class="centro">${v.vendas}</td>
    <td class="num"><strong>${N(v.total)}</strong></td>
    <td class="num">${N(v.ticket)}</td>
    <td class="num" style="color:${v.lucro >= 0 ? 'var(--verde)' : 'var(--vermelho)'}">${N(v.lucro)}</td>
    <td class="centro">${campoPct}</td>
    <td class="num"><strong>${N(v.comissao)}</strong></td>
    <td><button class="btn pequeno" onclick="verVendasDoVendedor(${v.id === null ? 'null' : v.id})">
      📋 Ver vendas</button></td>
  </tr>`;
}

async function salvarPercentual(usuarioId, campo) {
  const pct = Number(String(campo.value).replace(',', '.'));
  if (!(pct >= 0 && pct <= 100)) {
    alerta('O percentual precisa ficar entre 0 e 100.');
    campo.value = '0';
    return;
  }
  try {
    await api('/api/comissoes/percentual', {
      method: 'POST', body: { usuario_id: usuarioId, percentual: pct }
    });
    ok('Percentual salvo.');
    carregarComissoes();   // recalcula tudo com o novo percentual
  } catch (e) {
    erro(e.message);
  }
}

async function salvarBaseComissao() {
  if (!podeMexerNaComissao()) {
    alerta('Seu perfil não pode alterar a base de cálculo.');
    return;
  }
  try {
    await api('/api/config', { method: 'POST', body: { comissao_base: val('cfg_comissao_base') } });
    await carregarConfig();
    carregarComissoes();
  } catch (e) {
    erro(e.message);
  }
}

async function verVendasDoVendedor(id) {
  const alvo = el('comissaoDetalhe');
  alvo.innerHTML = '<div class="card"><div class="vazio">Carregando…</div></div>';

  let r;
  try {
    r = await api(`/api/comissoes/${id === null ? 'null' : id}/vendas` +
      `?de=${val('comDe')}&ate=${val('comAte')}`);
  } catch (e) {
    alvo.innerHTML = `<div class="card"><div class="aviso erro"><span>❌</span>
      <div>${esc(e.message)}</div></div></div>`;
    return;
  }

  const sobreLucro = r.base === 'lucro';
  alvo.innerHTML = `
    <div class="card">
      <h3>📋 Vendas de ${esc(r.vendedor.nome)}
        <span class="acoes">
          <span style="font-weight:400;font-size:13px;color:var(--texto-fraco);margin-right:10px">
            ${r.vendedor.percentual}% sobre ${sobreLucro ? 'o lucro' : 'o valor vendido'}
          </span>
          <button class="btn pequeno" onclick="el('comissaoDetalhe').innerHTML=''">✖ Fechar</button>
        </span>
      </h3>
      ${!r.vendas.length ? '<div class="vazio">Nenhuma venda no período.</div>' : `
      <div class="tabela-wrap"><table>
        <thead><tr>
          <th>Cupom</th><th>Data</th><th>Cliente</th>
          <th class="num">Total</th><th class="num">Lucro</th><th class="num">Comissão</th>
        </tr></thead>
        <tbody>${r.vendas.map((v) => `<tr>
          <td>${String(v.numero).padStart(6, '0')}</td>
          <td>${new Date(v.data).toLocaleString('pt-BR')}</td>
          <td>${esc(v.cliente_nome || 'CONSUMIDOR')}</td>
          <td class="num">${N(v.total)}</td>
          <td class="num">${N(v.lucro)}</td>
          <td class="num"><strong>${N(v.comissao)}</strong></td>
        </tr>`).join('')}</tbody>
        <tfoot><tr>
          <th colspan="3">TOTAL — ${r.vendas.length} venda(s)</th>
          <th class="num">${N(r.total)}</th>
          <th></th>
          <th class="num">${N(r.total_comissao)}</th>
        </tr></tfoot>
      </table></div>`}
    </div>`;

  alvo.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
