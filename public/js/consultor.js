/* --------------------------------------------------------------------------
   CONSULTOR DE REFORMA

   O balconista mede a sala com o cliente e sai daqui com a obra inteira
   orçada: piso, argamassa, rejunte, espaçador e rodapé, com os produtos e
   os preços da própria loja.

   Todo cálculo é feito no servidor (obra.js). Aqui só se monta a tela e se
   guarda o que o usuário escolheu.
   -------------------------------------------------------------------------- */

let OBRA_OPCOES = null;      // ambientes, paginações e padrões da loja
let OBRA_AMBIENTE = 'sala';
let OBRA_PISOS = [];         // pisos escolhidos para comparar (até 3)
let OBRA_CALCULO = null;     // resposta do /obra/calcular
let OBRA_COMPLEMENTOS = [];  // itens do "complete sua obra"
let OBRA_PROJETO_ID = null;  // projeto salvo que está aberto
let PISOS_BUSCA = [];

async function carregarConsultor() {
  if (!OBRA_OPCOES) {
    try {
      OBRA_OPCOES = await api('/api/obra/opcoes');
    } catch (e) { return erro(e.message); }

    el('obraAmbientes').innerHTML = OBRA_OPCOES.ambientes.map((a) => `
      <button data-amb="${a.chave}" onclick="escolherAmbiente('${a.chave}')">
        <span class="ic">${a.icone}</span>${esc(a.nome)}
      </button>`).join('');

    el('obraPaginacao').innerHTML = OBRA_OPCOES.paginacoes.map((p) =>
      `<option value="${p.chave}">${esc(p.nome)} — ${p.perda}% de perda</option>`).join('');

    setVal('obraJunta', OBRA_OPCOES.junta_padrao);
  }
  escolherAmbiente(OBRA_AMBIENTE);
  await buscarPisosObra();
}

function escolherAmbiente(chave) {
  OBRA_AMBIENTE = chave;
  document.querySelectorAll('#obraAmbientes button').forEach((b) => {
    b.classList.toggle('sel', b.dataset.amb === chave);
  });
  const a = (OBRA_OPCOES.ambientes || []).find((x) => x.chave === chave);
  // banheiro e área externa normalmente não levam rodapé
  if (a) setVal('obraComRodape', a.rodape ? '1' : '0');
  recalcularObra();
}

function trocarFormatoObra() {
  const porArea = val('obraFormato') === 'area';
  document.querySelectorAll('.obra-ret').forEach((e) => { e.style.display = porArea ? 'none' : ''; });
  document.querySelectorAll('.obra-area').forEach((e) => { e.style.display = porArea ? '' : 'none'; });
  recalcularObra();
}

/* ---------------- catálogo ---------------- */

let timerPisos = null;
function buscarPisosObra() {
  clearTimeout(timerPisos);
  timerPisos = setTimeout(async () => {
    const p = new URLSearchParams();
    if (val('obraBuscaPiso')) p.set('q', val('obraBuscaPiso'));
    if (valor(el('obraPrecoMax').value)) p.set('preco_max', valor(el('obraPrecoMax').value));
    try {
      PISOS_BUSCA = await api('/api/obra/pisos?' + p.toString());
      desenharPisos();
    } catch (e) { erro(e.message); }
  }, 200);
}

function desenharPisos() {
  const c = el('obraListaPisos');
  if (!PISOS_BUSCA.length) {
    c.innerHTML = `<div class="vazio"><span class="ic">🔍</span>
      Nenhum piso encontrado.<br><small>Os produtos precisam estar marcados como
      <strong>família “piso”</strong> no cadastro para aparecerem aqui.</small></div>`;
    return;
  }
  c.innerHTML = PISOS_BUSCA.map((p) => {
    const escolhido = OBRA_PISOS.some((x) => x.id === p.id);
    const tam = p.peca_comprimento && p.peca_largura
      ? `${Q(p.peca_comprimento)}×${Q(p.peca_largura)} cm` : '';
    return `<div class="piso-card ${escolhido ? 'sel' : ''}" onclick="alternarPiso(${p.id})">
      <div class="nome">${esc(p.descricao)}</div>
      <div class="sub">${[esc(p.marca), tam, esc(p.acabamento)].filter(Boolean).join(' • ')}</div>
      <div class="sub">${p.m2_caixa ? Q(p.m2_caixa) + ' m²/caixa' : ''}
        ${p.estoque > 0 ? '• ' + Q(p.estoque) + ' em estoque' : '• <strong>sem estoque</strong>'}</div>
      <div class="preco">${R$(p.preco_venda)} <span style="font-size:11px;font-weight:400">/${esc(p.unidade || 'm²')}</span></div>
      ${p.completo ? '' : `<div class="aviso-ficha">⚠️ falta m²/caixa ou tamanho da peça no cadastro</div>`}
    </div>`;
  }).join('');
}

function alternarPiso(id) {
  const jaTem = OBRA_PISOS.findIndex((x) => x.id === id);
  if (jaTem >= 0) OBRA_PISOS.splice(jaTem, 1);
  else {
    if (OBRA_PISOS.length >= 3) return alerta('Dá para comparar até 3 pisos por vez.');
    const p = PISOS_BUSCA.find((x) => x.id === id);
    if (p) OBRA_PISOS.push(p);
  }
  desenharPisos();
  recalcularObra();
}

/* ---------------- cálculo ---------------- */

let timerCalculo = null;
function recalcularObra() {
  clearTimeout(timerCalculo);
  timerCalculo = setTimeout(calcularObraAgora, 260);
}

function medidasAtuais() {
  return {
    ambiente: OBRA_AMBIENTE,
    formato: val('obraFormato'),
    comprimento: valor(el('obraComprimento').value),
    largura: valor(el('obraLargura').value),
    area_informada: valor(el('obraArea').value),
    perimetro_informado: valor(el('obraPerimetro').value),
    paginacao: val('obraPaginacao'),
    junta_mm: valor(el('obraJunta').value),
    portas: parseInt(val('obraPortas'), 10) || 0,
    com_rodape: val('obraComRodape') === '1'
  };
}

async function calcularObraAgora() {
  const base = medidasAtuais();
  const p = (OBRA_OPCOES.paginacoes || []).find((x) => x.chave === base.paginacao);
  el('obraDicaPerda').textContent = p ? `Perda considerada: ${p.perda}%.` : '';

  if (!OBRA_PISOS.length) {
    OBRA_CALCULO = null;
    el('obraComparador').innerHTML = '';
    el('obraComplementos').innerHTML = '';
    el('obraFechamento').innerHTML = '';
    return mostrarAreaSemPiso(base);
  }

  try {
    OBRA_CALCULO = await api('/api/obra/calcular', {
      method: 'POST',
      body: { ...base, pisos: OBRA_PISOS.map((x) => ({ produto_id: x.id })) }
    });
  } catch (e) {
    el('obraResumoArea').innerHTML = `<div class="aviso alerta"><span>⚠️</span>
      <div>${esc(e.message)}</div></div>`;
    return;
  }

  desenharResumoArea();
  desenharComparador();
  await montarComplementos();
  desenharFechamento();
}

/** Área calculada mesmo antes de escolher piso — é a primeira pergunta do cliente. */
function mostrarAreaSemPiso(base) {
  const area = base.formato === 'area'
    ? base.area_informada : base.comprimento * base.largura;
  const p = (OBRA_OPCOES.paginacoes || []).find((x) => x.chave === base.paginacao);
  const perda = area * ((p ? p.perda : 10) / 100);

  el('obraResumoArea').innerHTML = area > 0 ? `
    <div class="grid g4" style="margin-top:12px">
      ${tile('Área útil', Q(area) + ' m²', 'do ambiente', 'azul')}
      ${tile('Perda', Q(perda) + ' m²', (p ? p.perda : 10) + '% de recorte', 'laranja')}
      ${tile('Você precisa de', Q(area + perda) + ' m²', 'de piso', 'verde')}
      ${tile('Perímetro', Q(base.formato === 'area' ? base.perimetro_informado
        : 2 * (base.comprimento + base.largura)) + ' m', 'para o rodapé', 'cinza')}
    </div>
    <div class="aviso info" style="margin-top:10px"><span>👇</span>
      <div>Agora escolha o piso abaixo para o sistema calcular caixas, argamassa e rejunte.</div>
    </div>` : '';
}

function desenharResumoArea() {
  const o = OBRA_CALCULO.opcoes[0].calculo;
  el('obraResumoArea').innerHTML = `
    <div class="grid g4" style="margin-top:12px">
      ${tile('Área útil', Q(OBRA_CALCULO.area_util) + ' m²', 'do ambiente', 'azul')}
      ${tile('Perda', Q(o.perda) + ' m²', o.perda_pct + '% de recorte', 'laranja')}
      ${tile('Você precisa de', Q(o.area_total) + ' m²', 'de piso', 'verde')}
      ${tile('Perímetro', Q(OBRA_CALCULO.perimetro) + ' m', 'para o rodapé', 'cinza')}
    </div>`;
}

/* ---------------- comparador ---------------- */

function desenharComparador() {
  const ops = OBRA_CALCULO.opcoes;
  const c = el('obraComparador');

  const coluna = (o) => {
    const cx = o.calculo.caixas;
    return `<td>
      <div style="font-weight:600">${esc(o.piso.descricao)}</div>
      <div class="dica">${[esc(o.piso.marca), esc(o.piso.acabamento)].filter(Boolean).join(' • ')}</div>
    </td>`;
  };

  const linha = (rot, fn, forte) => `<tr${forte ? ' style="font-weight:700"' : ''}>
    <th>${rot}</th>${ops.map((o) => `<td class="num">${fn(o)}</td>`).join('')}</tr>`;

  c.innerHTML = `<div class="card">
    <h3>4️⃣ Comparação${ops.length > 1 ? ` — ${ops.length} opções` : ''}</h3>
    <div class="tabela-wrap"><table>
      <thead><tr><th style="width:190px">Piso</th>${ops.map(coluna).join('')}</tr></thead>
      <tbody>
        ${linha('Preço', (o) => R$(o.piso.preco_venda) + '/' + (o.piso.unidade || 'm²'))}
        ${linha('m² por caixa', (o) => o.piso.m2_caixa ? Q(o.piso.m2_caixa) : '—')}
        ${linha('Caixas necessárias', (o) => o.calculo.caixas.sem_caixa
          ? '<span class="dica">sem m²/caixa</span>' : '<strong>' + o.calculo.caixas.caixas + '</strong>')}
        ${linha('m² comprados', (o) => Q(o.calculo.caixas.m2_comprado) + ' m²')}
        ${linha('Sobra', (o) => Q(o.calculo.caixas.sobra) + ' m²')}
        ${linha('Argamassa', (o) => Q(o.calculo.argamassa.kg) + ' kg' +
          (o.calculo.argamassa.dupla_colagem ? ' <span class="dica">dupla colagem</span>' : ''))}
        ${linha('Rejunte', (o) => o.calculo.rejunte.sem_dados
          ? '<span class="dica">falta a ficha</span>' : Q(o.calculo.rejunte.kg) + ' kg')}
        ${linha('Estoque', (o) => o.estoque_suficiente === null ? '—'
          : (o.estoque_suficiente ? '<span class="pill verde">tem</span>'
            : '<span class="pill vermelha">não tem</span>'))}
        ${linha('Total do piso', (o) => R$(o.total_piso), true)}
      </tbody>
    </table></div>
    ${ops.length > 1 ? `<div class="aviso info" style="margin-top:11px"><span>👉</span>
      <div>Os complementos abaixo são calculados para a <strong>primeira opção</strong>
      (${esc(ops[0].piso.descricao)}). Clique nela na lista para trocar a ordem.</div></div>` : ''}
  </div>`;
}

/* ---------------- complete sua obra ---------------- */

async function montarComplementos() {
  const principal = OBRA_CALCULO.opcoes[0];
  const amb = (OBRA_OPCOES.ambientes || []).find((a) => a.chave === OBRA_AMBIENTE);
  try {
    const r = await api('/api/obra/complementos', {
      method: 'POST',
      body: { calculo: principal.calculo, area_molhada: amb ? amb.area_molhada : false }
    });
    OBRA_COMPLEMENTOS = r.itens;
    desenharComplementos(r);
  } catch (e) {
    OBRA_COMPLEMENTOS = [];
    el('obraComplementos').innerHTML = `<div class="card"><div class="aviso alerta">
      <span>⚠️</span><div>${esc(e.message)}</div></div></div>`;
  }
}

function desenharComplementos(r) {
  const total = OBRA_COMPLEMENTOS.reduce((s, i) => s + i.total, 0);
  el('obraComplementos').innerHTML = `<div class="card">
    <h3>5️⃣ Complete a obra
      <span class="acoes" style="font-weight:400;font-size:13px;color:var(--texto-fraco)">
        além do piso, o cliente vai precisar de:
      </span>
    </h3>
    ${!OBRA_COMPLEMENTOS.length ? `<div class="vazio">
      Nenhum complemento pôde ser sugerido.</div>` : `
    <div class="tabela-wrap"><table>
      <thead><tr><th>Material</th><th style="width:230px">Como foi calculado</th>
        <th class="centro" style="width:110px">Qtd.</th><th class="num">Unitário</th>
        <th class="num">Total</th><th></th></tr></thead>
      <tbody>${OBRA_COMPLEMENTOS.map((i, idx) => `<tr data-idx="${idx}">
        <td><strong>${esc(i.descricao)}</strong>
          ${i.opcional ? ' <span class="pill azul">opcional</span>' : ''}</td>
        <td class="dica">${esc(i.detalhe)}</td>
        <td class="centro">
          <input type="number" min="0" step="1" value="${i.quantidade}"
                 style="width:70px;text-align:center;padding:4px"
                 onchange="mudarQtdComplemento(${idx}, this.value)"> ${esc(i.unidade)}</td>
        <td class="num">${R$(i.preco_unit)}</td>
        <td class="num"><strong class="comp-total">${N(i.total)}</strong></td>
        <td><button class="btn pequeno" onclick="tirarComplemento(${idx})" title="Tirar da obra">✖</button></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><th colspan="4">TOTAL DOS COMPLEMENTOS</th>
        <th class="num" id="compTotalGeral">${N(total)}</th><th></th></tr></tfoot>
    </table></div>`}
    ${r.faltando_no_cadastro && r.faltando_no_cadastro.length ? `
      <div class="aviso alerta" style="margin-top:11px"><span>⚠️</span>
        <div>Não achei no catálogo nenhum produto da família
        <strong>${r.faltando_no_cadastro.map(esc).join(', ')}</strong>.
        Cadastre em Produtos (com a família preenchida) para o sistema orçar sozinho.</div></div>` : ''}
  </div>`;
}

/**
 * Muda a quantidade de um complemento.
 *
 * Aqui NAO se redesenha a tabela inteira: o evento vem de um input que
 * ainda está em foco, e trocar o innerHTML no meio do blur faz o navegador
 * reclamar ("node to be removed is no longer a child"). Além do erro, o
 * cursor pulava do campo a cada digitação. Então só os números mudam.
 */
function mudarQtdComplemento(idx, valorNovo) {
  const i = OBRA_COMPLEMENTOS[idx];
  if (!i) return;
  i.quantidade = Math.max(0, Number(valorNovo) || 0);
  i.total = Math.round(i.quantidade * i.preco_unit * 100) / 100;

  const linha = document.querySelector(`#obraComplementos tr[data-idx="${idx}"] .comp-total`);
  if (linha) linha.textContent = N(i.total);
  const geral = el('compTotalGeral');
  if (geral) geral.textContent = N(OBRA_COMPLEMENTOS.reduce((s, x) => s + x.total, 0));

  desenharLinhasFechamento();   // só os valores; os campos ficam intactos
}

function tirarComplemento(idx) {
  OBRA_COMPLEMENTOS.splice(idx, 1);
  /* Sai da pilha do evento antes de refazer a tabela, pelo mesmo motivo
     do comentário acima. */
  setTimeout(() => {
    desenharComplementos({ faltando_no_cadastro: [] });
    desenharLinhasFechamento();
  }, 0);
}

/* ---------------- fechamento ---------------- */

function totaisObra() {
  const piso = OBRA_CALCULO ? OBRA_CALCULO.opcoes[0].total_piso : 0;
  const comp = OBRA_COMPLEMENTOS.reduce((s, i) => s + i.total, 0);
  return { piso, comp, total: Math.round((piso + comp) * 100) / 100 };
}

/**
 * Bloco de fechamento.
 *
 * Os CAMPOS (nome, cliente, telefone) sao montados uma vez so e nunca mais
 * tocados; so os NUMEROS sao redesenhados. Antes o bloco inteiro era
 * refeito a cada mexida na quantidade — e como clicar num campo faz o campo
 * anterior disparar o onchange, o que a pessoa estava digitando ia embora
 * junto com o elemento antigo.
 */
function desenharFechamento() {
  if (!OBRA_CALCULO) return;

  if (!el('obraResumoLinhas')) {
    el('obraFechamento').innerHTML = `<div class="card">
      <h3>6️⃣ Orçamento da obra</h3>

      <div class="linha">
        <div class="campo"><label>Nome do projeto</label>
          <input id="obraNome" placeholder="ex: SALA DO SEU JOÃO" value="${esc(nomeSugerido())}"></div>
        <div class="campo m"><label>Cliente</label>
          <input id="obraCliente" placeholder="nome do cliente"></div>
        <div class="campo m"><label>WhatsApp do cliente</label>
          <input id="obraTelefone" inputmode="numeric" placeholder="75 90000-0000"></div>
      </div>

      <div id="obraResumoLinhas"></div>

      <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primario" onclick="salvarProjeto()">💾 Salvar projeto</button>
        <button class="btn verde" onclick="projetoParaOrcamento()">📝 Gerar orçamento</button>
        <button class="btn" onclick="projetoNoWhatsApp()">💬 Mandar no WhatsApp</button>
        <span class="dica" id="obraProjetoAtual" style="align-self:center"></span>
      </div>
    </div>`;
  }
  desenharLinhasFechamento();
}

/** Só os valores — pode ser chamado a qualquer momento sem estragar a digitação. */
function desenharLinhasFechamento() {
  const alvo = el('obraResumoLinhas');
  if (!alvo || !OBRA_CALCULO) return;
  const t = totaisObra();
  const p = OBRA_CALCULO.opcoes[0];

  alvo.innerHTML = `
    <div class="obra-linha"><span>${esc(p.piso.descricao)} — ${
      p.calculo.caixas.sem_caixa ? Q(p.calculo.area_total) + ' m²'
        : p.calculo.caixas.caixas + ' caixa(s)'}</span><span>${R$(t.piso)}</span></div>
    ${OBRA_COMPLEMENTOS.filter((i) => i.quantidade > 0).map((i) => `<div class="obra-linha">
      <span>${esc(i.descricao)} — ${i.quantidade} ${esc(i.unidade)}</span>
      <span>${R$(i.total)}</span></div>`).join('')}
    <div class="obra-linha forte"><span>TOTAL DA OBRA</span><span>${R$(t.total)}</span></div>`;

  const marca = el('obraProjetoAtual');
  if (marca) marca.textContent = OBRA_PROJETO_ID ? `Projeto salvo nº ${OBRA_PROJETO_ID}` : '';
}

function nomeSugerido() {
  const a = (OBRA_OPCOES.ambientes || []).find((x) => x.chave === OBRA_AMBIENTE);
  return a ? a.nome.toUpperCase() : 'PROJETO';
}

/* ---------------- projeto ---------------- */

function novoProjeto() {
  OBRA_PROJETO_ID = null;
  OBRA_PISOS = [];
  OBRA_CALCULO = null;
  OBRA_COMPLEMENTOS = [];
  setVal('obraComprimento', '5,00');
  setVal('obraLargura', '4,00');
  setVal('obraArea', '');
  setVal('obraPerimetro', '');
  setVal('obraPortas', '1');
  el('obraFechamento').innerHTML = '';   // campos voltam em branco de propósito
  desenharPisos();
  recalcularObra();
  ok('Projeto novo.');
}

async function salvarProjeto() {
  if (!OBRA_CALCULO) return alerta('Calcule a obra antes de salvar.');
  const t = totaisObra();
  const p = OBRA_CALCULO.opcoes[0];
  const base = medidasAtuais();

  try {
    const r = await api('/api/projetos', {
      method: 'POST',
      body: {
        id: OBRA_PROJETO_ID,
        ...base,
        nome: val('obraNome'),
        cliente_nome: val('obraCliente'),
        cliente_telefone: val('obraTelefone'),
        calculo: p.calculo,
        complementos: OBRA_COMPLEMENTOS,
        comparacao: OBRA_CALCULO.opcoes.map((o) => ({
          descricao: o.piso.descricao, preco: o.piso.preco_venda,
          caixas: o.calculo.caixas.caixas, total: o.total_piso
        })),
        piso_id: p.piso.id,
        piso_descricao: p.piso.descricao,
        piso_preco: p.piso.preco_venda,
        total_piso: t.piso,
        total_complementos: t.comp,
        total: t.total
      }
    });
    OBRA_PROJETO_ID = r.id;
    ok(`Projeto nº ${r.numero} salvo.`);
    desenharFechamento();
    return r;
  } catch (e) { erro(e.message); return null; }
}

async function projetoParaOrcamento() {
  if (!OBRA_PROJETO_ID && !(await salvarProjeto())) return;
  try {
    const r = await api(`/api/projetos/${OBRA_PROJETO_ID}/orcamento`, { method: 'POST', body: {} });
    ok(`Orçamento nº ${r.numero} gerado a partir do projeto.`);
    if (confirm(`Orçamento nº ${r.numero} criado.\n\nAbrir a tela de orçamentos?`)) {
      irPara('orcamentos');
    }
  } catch (e) { erro(e.message); }
}

async function projetoNoWhatsApp() {
  if (!OBRA_PROJETO_ID && !(await salvarProjeto())) return;
  try {
    const r = await api(`/api/projetos/${OBRA_PROJETO_ID}/whatsapp`);
    const link = r.link_cliente || r.link_loja;
    if (link) { window.open(link, '_blank'); return; }
    // sem telefone: copia o texto para o vendedor colar onde quiser
    await navigator.clipboard.writeText(r.texto).catch(() => {});
    alerta('Sem WhatsApp do cliente. O resumo foi copiado — é só colar na conversa.');
  } catch (e) { erro(e.message); }
}

async function carregarProjetos() {
  const alvo = el('projetosLista');
  let lista = [];
  try {
    const p = new URLSearchParams();
    if (val('projBusca')) p.set('q', val('projBusca'));
    lista = await api('/api/projetos?' + p.toString());
  } catch (e) { return erro(e.message); }

  if (!lista.length) {
    alvo.innerHTML = '<div class="vazio"><span class="ic">📂</span>Nenhum projeto salvo ainda.</div>';
    return;
  }
  const cores = { aberto: 'azul', orcado: 'verde', fechado: 'verde', cancelado: 'cinza' };
  alvo.innerHTML = `<table>
    <thead><tr><th>Nº</th><th>Projeto</th><th>Cliente</th><th class="num">Área</th>
      <th>Piso</th><th class="num">Total</th><th>Situação</th><th></th></tr></thead>
    <tbody>${lista.map((p) => `<tr>
      <td>${String(p.numero).padStart(4, '0')}</td>
      <td><strong>${esc(p.nome)}</strong><div class="dica">${
        p.criado_em ? new Date(p.criado_em).toLocaleDateString('pt-BR') : ''}</div></td>
      <td>${esc(p.cliente_nome || '—')}</td>
      <td class="num">${Q(p.area_total)} m²</td>
      <td>${esc(p.piso_descricao || '—')}</td>
      <td class="num"><strong>${N(p.total)}</strong></td>
      <td><span class="pill ${cores[p.situacao] || 'cinza'}">${esc(p.situacao)}</span></td>
      <td><button class="btn pequeno" onclick="abrirProjeto(${p.id})">📂 Abrir</button></td>
    </tr>`).join('')}</tbody></table>`;
}

async function abrirProjeto(id) {
  let p;
  try { p = await api('/api/projetos/' + id); } catch (e) { return erro(e.message); }

  OBRA_PROJETO_ID = p.id;
  OBRA_AMBIENTE = p.ambiente || 'sala';
  setVal('obraFormato', p.formato || 'retangular');
  trocarFormatoObra();
  setVal('obraComprimento', p.comprimento || '');
  setVal('obraLargura', p.largura || '');
  setVal('obraArea', p.area_informada || '');
  setVal('obraPerimetro', p.perimetro_informado || '');
  setVal('obraPaginacao', p.paginacao || 'reta');
  setVal('obraJunta', p.junta_mm || 3);
  setVal('obraPortas', p.portas || 0);
  setVal('obraComRodape', p.com_rodape ? '1' : '0');

  OBRA_PISOS = [];
  if (p.piso_id) {
    try {
      const prod = await api('/api/produtos/' + p.piso_id);
      OBRA_PISOS = [{
        id: prod.id, descricao: prod.descricao, marca: prod.marca,
        preco_venda: prod.preco_venda, unidade: prod.unidade,
        m2_caixa: prod.m2_caixa, acabamento: prod.acabamento,
        peca_comprimento: prod.peca_comprimento, peca_largura: prod.peca_largura,
        estoque: prod.estoque, completo: true
      }];
    } catch (e) { /* produto sumiu do catálogo */ }
  }

  fecharModal('modalProjetos');
  el('obraFechamento').innerHTML = '';   // força o bloco a nascer de novo
  escolherAmbiente(OBRA_AMBIENTE);
  await calcularObraAgora();
  if (el('obraNome')) {
    setVal('obraNome', p.nome);
    setVal('obraCliente', p.cliente_nome || '');
    setVal('obraTelefone', p.cliente_telefone || '');
  }
  ok(`Projeto nº ${p.numero} aberto.`);
}
