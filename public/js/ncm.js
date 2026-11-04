/* ==========================================================================
   ncm.js — tela "NCM dos produtos" e busca na tabela NCM

   O NCM vai em cada item da NFC-e. Aqui a loja vê quem está sem código,
   recebe sugestão (nota de compra › produto parecido › palavra-chave),
   confere a descrição e aplica em lote. A busca na tabela serve também
   ao cadastro do produto.
   ========================================================================== */

let NCM_DADOS = null;          // resposta de /api/produtos/ncm/analise
let NCM_PAGINA = 0;
const NCM_POR_PAGINA = 150;
const NCM_MARCADOS = new Map(); // id -> ncm a aplicar
const NCM_DIGITADOS = new Map(); // id -> ncm digitado na linha (sobrepõe a sugestão)

const FONTE_NCM = {
  nota: { rotulo: 'nota de compra', pill: 'verde', dica: 'NCM que o fornecedor declarou na NF-e de compra deste produto — a fonte mais segura' },
  parecido: { rotulo: 'produto parecido', pill: 'azul', dica: 'Outro produto seu, com a mesma palavra-chave, já tem este NCM' },
  palavra: { rotulo: 'palavra-chave', pill: 'amarela', dica: 'Sugestão pela descrição do produto: confira a descrição do código' }
};

async function carregarNcm() {
  const alvo = el('ncmTabela');
  if (alvo) alvo.innerHTML = '<div class="vazio">Analisando os produtos…</div>';
  try {
    NCM_DADOS = await api('/api/produtos/ncm/analise');
  } catch (e) {
    if (alvo) alvo.innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`;
    return;
  }
  NCM_MARCADOS.clear();
  NCM_DIGITADOS.clear();
  const r = NCM_DADOS.resumo;
  const pend = r.sem + r.invalido;
  el('ncmResumo').innerHTML = `
    <div class="grid g4" style="margin-bottom:14px">
      ${tile('Produtos ativos', r.ativos, `${r.ok} com NCM válido`, 'verde')}
      ${tile('Sem NCM', pend, r.invalido ? `${r.sem} vazios · ${r.invalido} inválidos` : 'saem com o NCM padrão da loja', pend ? 'vermelho' : 'verde')}
      ${tile('Vendidos sem NCM', r.vendidos_sem_ncm, 'nos últimos 180 dias — os urgentes', r.vendidos_sem_ncm ? 'laranja' : '')}
      ${tile('Com sugestão', r.sugestao_nota + r.sugestao_parecido + r.sugestao_palavra,
        `${r.sugestao_nota} pela nota · ${r.sugestao_parecido} parecidos · ${r.sugestao_palavra} por palavra`, '')}
    </div>
    ${r.divergente_nota ? `<div class="aviso alerta"><span>⚠️</span><div><strong>${r.divergente_nota} produto(s)</strong> têm NCM no cadastro
      diferente do que veio na nota de compra do fornecedor. Veja no filtro "NCM diferente do que veio na nota".</div></div>` : ''}
    ${r.sem_sugestao ? `<div class="dica" style="margin-bottom:8px">${r.sem_sugestao} produto(s) sem NCM ficaram sem sugestão: use o 🔍 na linha para procurar na tabela,
      ou mande a planilha para o contador.</div>` : ''}`;
  NCM_PAGINA = 0;
  renderNcm();
}

function filtrarNcm() {
  if (!NCM_DADOS) return [];
  const f = val('ncmFiltro') || 'pendentes';
  const q = val('ncmBusca').toUpperCase();
  return NCM_DADOS.produtos.filter((p) => {
    if (q && !(String(p.descricao).toUpperCase().includes(q) || String(p.codigo).toUpperCase().includes(q))) return false;
    if (f === 'pendentes') return p.situacao !== 'ok';
    if (f === 'vendidos') return p.situacao !== 'ok' && p.vendido_qtd > 0;
    if (f === 'sugestao') return p.situacao !== 'ok' && !!p.sugestao;
    if (f === 'sem_sugestao') return p.situacao !== 'ok' && !p.sugestao;
    if (f === 'divergente') return p.situacao === 'ok' && !!p.nota_ncm;
    if (f === 'ok') return p.situacao === 'ok';
    return true;
  });
}

function renderNcm(acrescentar) {
  const alvo = el('ncmTabela');
  if (!alvo || !NCM_DADOS) return;
  if (!acrescentar) NCM_PAGINA = 0;
  const lista = filtrarNcm();
  const fim = (NCM_PAGINA + 1) * NCM_POR_PAGINA;
  const parte = lista.slice(0, fim);

  const linha = (p) => {
    const digitado = NCM_DIGITADOS.get(p.id) || '';
    const marcado = NCM_MARCADOS.has(p.id);
    const sug = p.sugestao;
    const fonte = sug ? FONTE_NCM[sug.fonte] : null;
    const atual = p.situacao === 'ok'
      ? `<strong>${fmtNcm(p.ncm)}</strong><div style="font-size:11px;color:var(--texto-fraco)">${esc(p.ncm_descricao)}</div>`
      : (p.situacao === 'invalido'
        ? `<span class="pill vermelha" title="não existe na tabela">${esc(p.ncm)} inválido</span>`
        : '<span class="pill cinza">sem NCM</span>');
    return `<tr class="${marcado ? '' : ''}">
      <td class="centro"><input type="checkbox" ${marcado ? 'checked' : ''} ${(sug || digitado) ? '' : 'disabled title="sem código para aplicar: digite um ou use o 🔍"'}
        onchange="marcarNcm(${p.id}, this.checked)"></td>
      <td><strong>${esc(p.descricao)}</strong>
        <div style="font-size:11px;color:var(--texto-fraco)">cód. ${esc(p.codigo)} · ${esc(p.unidade)}${p.fornecedor ? ' · ' + esc(p.fornecedor) : ''}${p.vendido_qtd ? ` · vendeu ${Q(p.vendido_qtd)} em 180 dias` : ''}</div></td>
      <td>${atual}${p.nota_ncm ? `<div style="font-size:11px;color:var(--laranja-esc)" title="NCM que veio na NF-e de compra">nota de compra: ${fmtNcm(p.nota_ncm)}</div>` : ''}</td>
      <td>${sug ? `<strong>${fmtNcm(sug.ncm)}</strong> <span class="pill ${fonte.pill}" title="${esc(fonte.dica)}">${fonte.rotulo}</span>
        <div style="font-size:11px;color:var(--texto-fraco)">${esc(sug.descricao)}</div>
        <div style="font-size:10.5px;color:var(--texto-fraco)">${esc(sug.detalhe)}</div>` : '<span style="color:var(--texto-fraco)">—</span>'}</td>
      <td style="white-space:nowrap">
        <input id="ncmDig${p.id}" value="${esc(digitado)}" placeholder="${sug ? fmtNcm(sug.ncm) : '8 dígitos'}" inputmode="numeric" style="width:120px"
          onchange="digitarNcm(${p.id}, this.value)">
        <button class="btn-ic" title="Procurar na tabela NCM" onclick="abrirBuscaNcm('ncmDig${p.id}', null, ${p.id})">🔍</button>
      </td>
    </tr>`;
  };

  alvo.innerHTML = parte.length ? `
    <table><thead><tr>
      <th style="width:34px" class="centro">✓</th><th>Produto</th><th>NCM no cadastro</th><th>Sugestão</th><th>Aplicar este NCM</th>
    </tr></thead><tbody>${parte.map(linha).join('')}</tbody>
    <tfoot><tr><td colspan="5">${parte.length} de ${lista.length} produto(s)</td></tr></tfoot></table>`
    : '<div class="vazio"><span class="ic">🏷️</span>Nenhum produto neste filtro.</div>';
  el('btnNcmMais').style.display = lista.length > fim ? '' : 'none';
  atualizarBotaoAplicar();
}

const fmtNcm = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}` : esc(c); };

function ncmParaAplicar(p) {
  const d = (NCM_DIGITADOS.get(p.id) || '').replace(/\D/g, '');
  if (d) return d;
  return p.sugestao ? p.sugestao.ncm : '';
}

function marcarNcm(id, marcado) {
  const p = NCM_DADOS.produtos.find((x) => x.id === id);
  if (!p) return;
  const c = ncmParaAplicar(p);
  if (marcado && c) NCM_MARCADOS.set(id, c); else NCM_MARCADOS.delete(id);
  atualizarBotaoAplicar();
}

function digitarNcm(id, valorDigitado) {
  const d = String(valorDigitado || '').replace(/\D/g, '');
  if (d) NCM_DIGITADOS.set(id, d); else NCM_DIGITADOS.delete(id);
  if (d) NCM_MARCADOS.set(id, d);
  const p = NCM_DADOS.produtos.find((x) => x.id === id);
  if (!d && p && !p.sugestao) NCM_MARCADOS.delete(id);
  renderNcm(true);
}

/** Marca de uma vez tudo que tem sugestão de uma fonte (no filtro atual). '' desmarca tudo. */
function marcarSugestoes(fonte) {
  if (!fonte) { NCM_MARCADOS.clear(); renderNcm(true); return; }
  filtrarNcm().forEach((p) => {
    if (p.situacao !== 'ok' && p.sugestao && p.sugestao.fonte === fonte) NCM_MARCADOS.set(p.id, ncmParaAplicar(p));
  });
  renderNcm(true);
}

function atualizarBotaoAplicar() {
  const b = el('btnAplicarNcm');
  if (!b) return;
  b.textContent = `✅ Aplicar marcados (${NCM_MARCADOS.size})`;
  b.disabled = !NCM_MARCADOS.size;
}

async function aplicarNcmMarcados() {
  if (!NCM_MARCADOS.size) return;
  const itens = [...NCM_MARCADOS.entries()].map(([id, c]) => ({ id, ncm: c }));
  if (!confirm(`Aplicar o NCM em ${itens.length} produto(s)?\n\nO NCM vai nas próximas notas. Produto com NCM errado é problema na fiscalização — confira a descrição dos códigos antes.`)) return;
  try {
    const r = await api('/api/produtos/ncm/aplicar', { method: 'POST', body: { itens } });
    ok(`${r.aplicados} produto(s) com NCM aplicado.`);
    if (r.recusados && r.recusados.length) alerta(`${r.recusados.length} recusado(s): ${r.recusados.slice(0, 3).map((x) => x.ncm + ' ' + x.motivo).join(' · ')}`);
    await carregarNcm();
  } catch (e) { erro(e.message); }
}

function baixarPlanilhaNcm() {
  const a = document.createElement('a');
  a.href = '/api/produtos/ncm/planilha.xlsx?token=' + encodeURIComponent(TOKEN);
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  ok('Planilha gerada. O contador corrige a coluna NCM e você importa de volta em Produtos → Importar planilha.');
}

/* ---------------- busca na tabela NCM (modal) ---------------- */

let NCM_BUSCA_ALVO = null;   // { campo, dica, produtoId }
let NCM_BUSCA_TIMER = null;

function abrirBuscaNcm(idCampo, idDica, produtoId) {
  NCM_BUSCA_ALVO = { campo: idCampo, dica: idDica || null, produtoId: produtoId || null };
  const campo = el(idCampo);
  const semente = campo && campo.value ? campo.value : '';
  // na tela de NCM, comeca pela descricao do produto; no cadastro, pelo que ja esta no campo
  let inicial = semente;
  if (produtoId && NCM_DADOS) {
    const p = NCM_DADOS.produtos.find((x) => x.id === produtoId);
    if (p) inicial = String(p.descricao).split(/[\s/]+/).filter((w) => w.length >= 4).slice(0, 2).join(' ');
  } else if (!inicial && el('prod_descricao')) {
    inicial = String(el('prod_descricao').value).split(/[\s/]+/).filter((w) => w.length >= 4).slice(0, 2).join(' ');
  }
  setVal('ncmBuscaTexto', inicial);
  el('ncmBuscaLista').innerHTML = '';
  abrirModal('modalBuscaNcm');
  setTimeout(() => { el('ncmBuscaTexto').focus(); buscarNcmAgora(); }, 50);
}

function buscarNcmDigitando() {
  clearTimeout(NCM_BUSCA_TIMER);
  NCM_BUSCA_TIMER = setTimeout(buscarNcmAgora, 250);
}

async function buscarNcmAgora() {
  const q = val('ncmBuscaTexto');
  const alvo = el('ncmBuscaLista');
  if (q.length < 2) { alvo.innerHTML = '<div class="vazio">Digite pelo menos 2 letras ou 2 dígitos.</div>'; return; }
  try {
    const lista = await api('/api/ncm/busca?q=' + encodeURIComponent(q) + '&limite=40');
    alvo.innerHTML = lista.length ? `<table><tbody>${lista.map((it) => `
      <tr style="cursor:pointer" onclick="escolherNcm('${it.ncm}')">
        <td style="white-space:nowrap"><strong>${fmtNcm(it.ncm)}</strong></td>
        <td style="font-size:12.5px">${esc(it.resumo)}</td>
        <td class="centro"><button class="btn pequeno primario">Usar</button></td>
      </tr>`).join('')}</tbody></table>`
      : '<div class="vazio">Nada com essas palavras. Tente outra palavra (ex.: só "tinta", ou o começo do código).</div>';
  } catch (e) { alvo.innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`; }
}

function escolherNcm(codigo) {
  if (!NCM_BUSCA_ALVO) return;
  const campo = el(NCM_BUSCA_ALVO.campo);
  if (campo) campo.value = codigo;
  fecharModal('modalBuscaNcm');
  if (NCM_BUSCA_ALVO.produtoId) digitarNcm(NCM_BUSCA_ALVO.produtoId, codigo);
  if (NCM_BUSCA_ALVO.dica) mostrarDescricaoNcm(NCM_BUSCA_ALVO.campo, NCM_BUSCA_ALVO.dica);
}

/** Embaixo do campo NCM do cadastro: diz o que o código significa (ou que não existe). */
async function mostrarDescricaoNcm(idCampo, idDica) {
  const campo = el(idCampo); const dica = el(idDica);
  if (!campo || !dica) return;
  const c = campo.value.replace(/\D/g, '');
  if (!c) { dica.textContent = 'Em branco, a nota sai com o NCM padrão da loja.'; dica.classList.remove('alerta'); return; }
  try {
    const r = await api('/api/ncm/' + c);
    dica.textContent = r.valido ? r.resumo : (c.length === 8 ? 'Este código NÃO existe na tabela da Receita.' : 'O NCM tem 8 dígitos.');
    dica.classList.toggle('alerta', !r.valido);
  } catch (e) { dica.textContent = ''; }
}
