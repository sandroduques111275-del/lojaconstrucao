/* ==========================================================================
   entrada.js — entrada de nota fiscal de compra (XML) e importação de planilha
   ========================================================================== */

let NOTA = null;
let NOTA_XML = null;   // [1.11] o arquivo original, que vai guardado para a contabilidade

/* ============================ ENTRADA DE NOTA ============================ */

function carregarEntradaNota() {
  if (!val('nfDe')) {
    setVal('nfDe', somaDias(hojeIso(), -90));
    setVal('nfAte', hojeIso());
  }
  carregarHistoricoNotas();
  prepararPacoteContabil();
}

function lerArquivoTexto(input) {
  return new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) { reject(new Error('Escolha o arquivo.')); return; }
    const r = new FileReader();
    r.onload = () => resolve({ nome: f.name, conteudo: r.result });
    r.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    r.readAsText(f, 'UTF-8');
  });
}

function lerArquivoBase64(input) {
  return new Promise((resolve, reject) => {
    const f = input.files && input.files[0];
    if (!f) { reject(new Error('Escolha o arquivo.')); return; }
    const r = new FileReader();
    r.onload = () => resolve({ nome: f.name, base64: String(r.result).split(',')[1] });
    r.onerror = () => reject(new Error('Não consegui ler o arquivo.'));
    r.readAsDataURL(f);
  });
}

async function analisarNota() {
  el('nfPreview').innerHTML = '<div class="card"><div class="vazio">Lendo o XML…</div></div>';
  try {
    const arq = await lerArquivoTexto(el('nfArquivo'));
    const r = await api('/api/entrada-nota/analisar', { method: 'POST', body: { xml: arq.conteudo } });
    NOTA = r;
    NOTA_XML = arq.conteudo;
    renderPreviaNota(r);
  } catch (e) {
    NOTA = null;
    NOTA_XML = null;
    el('nfPreview').innerHTML = `<div class="card"><div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div></div>`;
  }
}

function renderPreviaNota(r) {
  const n = r.nota;
  const totalItens = n.itens.reduce((s, i) => s + Number(i.total), 0);

  const avisos = [];
  if (r.ja_entrou) {
    avisos.push(`<div class="aviso erro"><span>⚠️</span><div>
      <strong>Esta nota já teve entrada</strong> em ${dataHoraBr(r.ja_entrou.data)} por ${esc(r.ja_entrou.usuario)}.
      Se lançar de novo, o estoque entra duas vezes.</div></div>`);
  }
  if (r.para_outra_empresa) {
    avisos.push(`<div class="aviso alerta"><span>🏢</span><div>
      O destinatário desta nota (<strong>${esc(n.destinatario.nome)}</strong>) não é o CNPJ
      cadastrado na sua loja. Confira se é a nota certa.</div></div>`);
  }
  if (!r.fornecedor_cadastrado) {
    avisos.push(`<div class="aviso info"><span>🚚</span><div>
      O fornecedor <strong>${esc(n.fornecedor.nome)}</strong> ainda não está cadastrado —
      será criado automaticamente.</div></div>`);
  }

  el('nfPreview').innerHTML = `
    ${avisos.join('')}

    <div class="grid g4" style="margin-bottom:14px">
      ${tile('Nota', 'nº ' + esc(n.numero), 'série ' + esc(n.serie) + ' • ' + dataBr(n.emissao), '')}
      ${tile('Fornecedor', esc((n.fornecedor.fantasia || n.fornecedor.nome).slice(0, 22)),
        docFmt(n.fornecedor.cnpj), '')}
      ${tile('Valor da nota', R$(n.valor_total),
        n.valor_desconto > 0 ? 'desconto de ' + R$(n.valor_desconto) : 'sem desconto', 'verde')}
      ${tile('Itens', n.itens.length, `${r.resumo.novos} novo(s) • ${r.resumo.vinculados} já cadastrado(s)`,
        r.resumo.novos ? 'laranja' : '')}
    </div>

    <div class="card">
      <h3>📦 Itens da nota</h3>
      <div class="tabela-wrap">
        <table><thead><tr>
          <th style="width:34px" class="centro" title="Desmarque para não dar entrada neste item">✓</th>
          <th>Produto na nota</th><th>No seu cadastro</th>
          <th class="num">Qtd.</th><th class="num">Custo</th><th class="num">Total</th>
          <th class="num">Preço de venda</th>
        </tr></thead><tbody>
        ${n.itens.map((i, idx) => `<tr>
          <td class="centro"><input type="checkbox" class="nf-item" data-idx="${idx}" checked></td>
          <td><strong>${esc(i.descricao)}</strong>
            <div style="font-size:11px;color:var(--texto-fraco)">
              cód. ${esc(i.codigo_fornecedor)}${i.codigo_barras ? ' • ' + esc(i.codigo_barras) : ''}
              • NCM ${esc(i.ncm)} • ${esc(i.unidade)}</div></td>
          <td>${i.acao === 'novo'
            ? '<span class="pill laranja" style="background:#fdf1d8;color:var(--laranja-esc)">produto novo</span>'
            : `<span class="pill verde">achei por ${esc(i.encontrado_por)}</span>
               <div style="font-size:11px;color:var(--texto-fraco)">${esc(i.produto_atual.descricao)}<br>
               estoque ${Q(i.produto_atual.estoque)} → <strong>${Q(i.produto_atual.estoque + Number(i.quantidade))}</strong></div>`}</td>
          <td class="num">${Q(i.quantidade)}</td>
          <td class="num">${N(i.custo_unitario)}
            ${i.acao === 'vincular' && Math.abs(i.produto_atual.preco_custo - i.custo_unitario) > 0.009
              ? `<div style="font-size:10.5px;color:var(--laranja-esc)">era ${N(i.produto_atual.preco_custo)}</div>` : ''}</td>
          <td class="num"><strong>${N(i.total)}</strong></td>
          <td class="num" id="nfPreco${idx}" style="font-size:12px;color:var(--texto-fraco)">—</td>
        </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="5">${n.itens.length} item(ns)</td>
          <td class="num">${N(totalItens)}</td><td></td>
        </tr></tfoot></table>
      </div>
    </div>

    ${n.duplicatas.length ? `
    <div class="card">
      <h3>📆 Parcelas da nota</h3>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th></tr></thead>
        <tbody>${n.duplicatas.map((d) => `<tr>
          <td>${esc(d.numero)}</td><td>${dataBr(d.vencimento)}</td>
          <td class="num"><strong>${N(d.valor)}</strong></td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="2">${n.duplicatas.length} parcela(s)</td>
          <td class="num">${N(n.duplicatas.reduce((s, d) => s + Number(d.valor), 0))}</td></tr></tfoot>
      </table></div>
    </div>` : ''}

    <div class="card">
      <h3>⚙️ Como dar a entrada</h3>
      <div class="linha">
        <div class="campo m"><label>Categoria dos produtos novos</label>
          <select id="nfCategoria">${'<option value="">— sem categoria —</option>' +
            CATEGORIAS.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('')}</select>
        </div>
        <div class="campo p"><label>Margem de venda (%)</label>
          <input id="nfMargem" inputmode="decimal" value="45" oninput="calcularPrecosNota()">
          <div class="dica">Usada no preço dos produtos novos.</div>
        </div>
        <div class="campo" style="padding-top:18px">
          <label class="check"><input type="checkbox" id="nfAtualizarPreco" onchange="calcularPrecosNota()">
            Recalcular também o preço dos produtos <strong>já cadastrados</strong></label>
          <label class="check" style="margin-top:6px">
            <input type="checkbox" id="nfGerarContas" ${n.duplicatas.length ? 'checked' : ''}>
            Lançar as parcelas no <strong>Contas a Pagar</strong>
            ${n.duplicatas.length ? `(${n.duplicatas.length}x)` : '(sem parcelas na nota: cria uma só)'}</label>
        </div>
      </div>
      <div class="campo"><label>Observação</label><input id="nfObservacao" placeholder="ex: conferido por João"></div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="btn" onclick="cancelarEntradaNota()">Cancelar</button>
        <button class="btn verde" onclick="confirmarEntradaNota()" style="padding:11px 22px;font-size:15px">
          ✅ Confirmar entrada</button>
      </div>
    </div>`;

  calcularPrecosNota();
  window.scrollTo(0, 0);
}

/** Mostra o preço de venda que cada item vai receber, antes de confirmar. */
function calcularPrecosNota() {
  if (!NOTA) return;
  const margem = valor(el('nfMargem').value);
  const atualizar = el('nfAtualizarPreco').checked;

  NOTA.nota.itens.forEach((i, idx) => {
    const campo = el('nfPreco' + idx);
    if (!campo) return;
    if (i.acao === 'novo') {
      const p = margem > 0 ? i.custo_unitario * (1 + margem / 100) : 0;
      campo.innerHTML = p > 0
        ? `<strong style="color:var(--verde)">${N(p)}</strong>`
        : '<span style="color:var(--vermelho)">sem preço</span>';
    } else if (atualizar && margem > 0) {
      const p = i.custo_unitario * (1 + margem / 100);
      campo.innerHTML = `<strong style="color:var(--verde)">${N(p)}</strong>
        <div style="font-size:10.5px;color:var(--texto-fraco)">era ${N(i.produto_atual.preco_venda)}</div>`;
    } else {
      campo.innerHTML = `<span style="color:var(--texto-fraco)">${N(i.produto_atual.preco_venda)}</span>`;
    }
  });
}

function cancelarEntradaNota() {
  NOTA = null;
  NOTA_XML = null;
  el('nfPreview').innerHTML = '';
  el('nfArquivo').value = '';
}

async function confirmarEntradaNota() {
  if (!NOTA) return;

  const marcados = new Set([...document.querySelectorAll('.nf-item:checked')]
    .map((c) => Number(c.dataset.idx)));
  const itens = NOTA.nota.itens.map((i, idx) => ({ ...i, ignorar: !marcados.has(idx) }));
  const validos = itens.filter((i) => !i.ignorar);
  if (!validos.length) { alerta('Marque pelo menos um item.'); return; }

  const margem = valor(el('nfMargem').value);
  const novosSemPreco = validos.filter((i) => i.acao === 'novo').length && margem <= 0;
  if (novosSemPreco && !confirm(
    'A margem está zerada: os produtos novos vão entrar SEM preço de venda e não poderão ser vendidos até você definir o preço.\n\nContinuar assim?')) return;

  if (NOTA.ja_entrou && !confirm(
    'Esta nota já teve entrada antes. Lançar de novo vai somar o estoque outra vez.\n\nTem certeza?')) return;

  try {
    const r = await api('/api/entrada-nota/confirmar', {
      method: 'POST',
      body: {
        nota: { ...NOTA.nota, itens },
        fornecedor_id: NOTA.fornecedor_cadastrado ? NOTA.fornecedor_cadastrado.id : null,
        categoria_id: val('nfCategoria') || null,
        margem,
        atualizar_preco: el('nfAtualizarPreco').checked,
        gerar_contas: el('nfGerarContas').checked,
        observacao: val('nfObservacao'),
        forcar: !!NOTA.ja_entrou,
        xml: NOTA_XML
      }
    });
    cancelarEntradaNota();
    carregarHistoricoNotas();
    CATEGORIAS = await api('/api/categorias');
    preencherCategorias();
    ok(`Entrada feita: ${r.criados} produto(s) novo(s), ${r.atualizados} atualizado(s)` +
       (r.contas ? `, ${r.contas} conta(s) a pagar` : ''));
    if (r.aviso) alerta(r.aviso);
  } catch (e) { erro(e.message); }
}

async function carregarHistoricoNotas() {
  try {
    const p = new URLSearchParams();
    if (val('nfDe')) p.set('de', val('nfDe'));
    if (val('nfAte')) p.set('ate', val('nfAte'));
    if (val('nfBusca')) p.set('q', val('nfBusca'));
    const lista = await api('/api/entrada-nota/historico?' + p.toString());

    el('nfHistorico').innerHTML = lista.length ? `
      <table><thead><tr>
        <th>Entrada</th><th>Nota</th><th>Fornecedor</th><th>Emissão</th>
        <th class="centro">Itens</th><th class="num">Valor</th>
        <th class="centro">Contas</th><th>Usuário</th><th class="centro" title="XML guardado para a contabilidade">XML</th>
      </tr></thead><tbody>
      ${lista.map((e) => `<tr>
        <td style="white-space:nowrap">${dataHoraBr(e.data_entrada)}</td>
        <td><strong>nº ${esc(e.numero)}</strong>${e.serie ? '/' + esc(e.serie) : ''}</td>
        <td>${esc(e.fornecedor || '-')}</td>
        <td>${dataBr(e.emissao)}</td>
        <td class="centro">${e.itens_qtd}</td>
        <td class="num"><strong>${N(e.valor_total)}</strong></td>
        <td class="centro">${e.gerou_contas ? `<span class="pill verde">${e.parcelas_qtd}x</span>` : '<span class="pill cinza">não</span>'}</td>
        <td>${esc(e.usuario)}</td>
        <td class="centro">${e.tem_xml
          ? `<button class="btn-ic" title="Baixar o XML desta nota" onclick="baixarXmlEntrada(${e.id})">📄</button>`
          : '<span class="pill cinza" title="Lançada antes da versão 1.11: o XML não foi guardado">sem</span>'}</td>
      </tr>`).join('')}
      </tbody>
      <tfoot><tr><td colspan="5">${lista.length} nota(s)</td>
        <td class="num">${N(lista.reduce((s, e) => s + Number(e.valor_total), 0))}</td>
        <td colspan="3"></td></tr></tfoot></table>`
      : '<div class="vazio"><span class="ic">📥</span>Nenhuma nota de compra lançada no período.</div>';
  } catch (e) { erro(e.message); }
}

function baixarXmlEntrada(id) {
  const a = document.createElement('a');
  a.href = `/api/entrada-nota/${id}/xml?token=${encodeURIComponent(TOKEN)}`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

/* ======================= PACOTE PARA A CONTABILIDADE ======================= */

/** Últimos 12 meses no seletor; o mês passado já vem escolhido. */
function prepararPacoteContabil() {
  const card = el('cardPacoteContabil');
  if (!card) return;
  if (!podeVer('fiscal')) { card.style.display = 'none'; return; }
  card.style.display = '';
  const sel = el('pacMes');
  if (!sel.options.length) {
    const h = new Date();
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    for (let i = 0; i < 12; i++) {
      const d = new Date(h.getFullYear(), h.getMonth() - i, 1);
      const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const o = document.createElement('option');
      o.value = v; o.textContent = `${nomes[d.getMonth()]} de ${d.getFullYear()}` + (i === 0 ? ' (em andamento)' : '');
      sel.appendChild(o);
    }
    sel.selectedIndex = 1;   // mês passado
  }
  conferirPacoteContabil();
}

function escolherMesDoPacote(mes) {
  const sel = el('pacMes');
  if (!sel) return;
  if (![...sel.options].some((o) => o.value === mes)) return;
  sel.value = mes;
  conferirPacoteContabil();
}

async function conferirPacoteContabil() {
  const alvo = el('pacPrevia');
  if (!alvo) return;
  alvo.innerHTML = '<div class="vazio">Conferindo…</div>';
  try {
    const p = await api('/api/contabilidade/pacote/previa?mes=' + encodeURIComponent(val('pacMes')));
    const nada = !p.compras.qtd && !p.vendas.autorizadas_qtd && !p.vendas.canceladas_qtd;
    alvo.innerHTML = `
      <div class="grid g4" style="margin-bottom:10px">
        ${tile('Compras com nota', R$(p.compras.total), `${p.compras.qtd} NF-e de entrada`, '')}
        ${tile('XML de compra no pacote', p.compras.com_xml + ' de ' + p.compras.qtd,
          p.compras.sem_xml.length ? p.compras.sem_xml.length + ' sem XML (antes da 1.11)' : 'todas com XML', p.compras.sem_xml.length ? 'laranja' : 'verde')}
        ${tile('NFC-e autorizadas', R$(p.vendas.autorizadas), `${p.vendas.autorizadas_qtd} nota(s) de venda`, 'verde')}
        ${tile('NFC-e canceladas', R$(p.vendas.canceladas), `${p.vendas.canceladas_qtd} nota(s) — não somam`, '')}
      </div>
      ${p.compras.sem_xml.length ? `<div class="aviso alerta"><span>⚠️</span><div>
        <strong>${p.compras.sem_xml.length} nota(s) de compra sem o XML</strong> (foram lançadas antes da versão 1.11).
        Elas vão na planilha com a chave de acesso, e o LEIA-ME do pacote explica ao contador como baixar o XML no portal da SEFAZ.
        ${p.compras.sem_xml.slice(0, 5).map((c) => `<br>• NF ${esc(c.numero)} — ${esc(c.fornecedor)} — ${R$(c.valor)}`).join('')}
        ${p.compras.sem_xml.length > 5 ? '<br>• …' : ''}</div></div>` : ''}
      ${p.vendas.sem_xml ? `<div class="aviso alerta"><span>⚠️</span><div>${p.vendas.sem_xml} NFC-e sem o XML autorizado guardado
        (a nota vale, mas o arquivo ficou na Focus/SEFAZ). Elas constam na planilha pela chave.</div></div>` : ''}
      ${p.baixado_em ? `<div class="aviso ok"><span>✅</span><div>Este pacote já foi baixado em ${dataHoraBr(p.baixado_em)}.
        Pode baixar de novo — se entrou nota depois, o novo vem completo.</div></div>` : ''}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn verde" onclick="baixarPacoteContabil()" ${nada ? 'disabled' : ''} style="padding:11px 20px;font-size:15px">
          ⬇️ Baixar pacote de ${esc(p.nome_mes)} (ZIP)</button>
        <span style="font-size:12.5px;color:var(--texto-fraco)">Dentro: LEIA-ME, planilha-resumo, <code>compras/</code> com os XML das NF-e,
          <code>vendas/</code> com os XML das NFC-e (e <code>canceladas/</code> com o evento). É só mandar o arquivo para o contador.</span>
      </div>`;
  } catch (e) {
    alvo.innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`;
  }
}

function baixarPacoteContabil() {
  const a = document.createElement('a');
  a.href = `/api/contabilidade/pacote?mes=${encodeURIComponent(val('pacMes'))}&token=${encodeURIComponent(TOKEN)}`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
  ok('Pacote gerado. Encaminhe o arquivo ZIP para a contabilidade.');
  setTimeout(conferirPacoteContabil, 1500);
}

/* ============================ IMPORTAR PLANILHA ============================ */

let IMPORT_ARQUIVO = null;

function abrirImportacao(tipo) {
  setVal('imp_tipo', tipo);
  el('imp_arquivo').value = '';
  el('imp_preview').innerHTML = '';
  el('imp_linha_novos').style.display = 'none';
  el('imp_somente_novos').checked = false;
  el('imp_btn').disabled = true;
  IMPORT_ARQUIVO = null;

  const titulos = {
    produtos: '📦 Importar produtos',
    clientes: '👥 Importar clientes',
    fornecedores: '🚚 Importar fornecedores'
  };
  el('impTitulo').textContent = titulos[tipo];
  abrirModal('modalImportar');
}

function baixarModelo() {
  const a = document.createElement('a');
  a.href = `/api/importar/${val('imp_tipo')}/modelo?token=${encodeURIComponent(TOKEN)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function analisarImportacao() {
  el('imp_preview').innerHTML = '<div class="vazio">Lendo a planilha…</div>';
  el('imp_btn').disabled = true;
  try {
    IMPORT_ARQUIVO = await lerArquivoBase64(el('imp_arquivo'));
    const r = await api(`/api/importar/${val('imp_tipo')}/analisar`, {
      method: 'POST',
      body: { arquivo: IMPORT_ARQUIVO.base64, nome: IMPORT_ARQUIVO.nome }
    });

    const pill = { novo: 'verde', atualizar: 'azul' };
    const primeiraColuna = val('imp_tipo') === 'produtos' ? 'descricao' : 'nome';

    el('imp_preview').innerHTML = `
      <div class="grid g4" style="margin-bottom:12px">
        ${tile('Linhas lidas', r.total, 'na planilha', '')}
        ${tile('Vão entrar', r.resumo.novos, 'cadastros novos', 'verde')}
        ${tile('Vão ser atualizados', r.resumo.atualizar, 'já existem no sistema', 'laranja')}
        ${tile('Com problema', r.resumo.erros, 'serão puladas', r.resumo.erros ? 'vermelho' : '')}
      </div>

      ${r.colunas_ignoradas.length ? `<div class="aviso alerta"><span>⚠️</span><div>
        Estas colunas não foram reconhecidas e serão ignoradas:
        <strong>${esc(r.colunas_ignoradas.join(', '))}</strong>.</div></div>` : ''}

      <div class="aviso ok"><span>✅</span><div>
        Colunas reconhecidas: <strong>${esc(r.colunas_lidas.join(', '))}</strong></div></div>

      <div class="tabela-wrap" style="max-height:320px;overflow-y:auto">
        <table><thead><tr>
          <th>Linha</th><th class="centro">O que vai acontecer</th>
          ${r.colunas_lidas.map((c) => `<th>${esc(c)}</th>`).join('')}
        </tr></thead><tbody>
        ${r.registros.slice(0, 100).map((x) => `<tr>
          <td>${x._linha}</td>
          <td class="centro">${x._erro
            ? `<span class="pill vermelha">${esc(x._erro)}</span>`
            : `<span class="pill ${pill[x._acao]}">${x._acao === 'novo' ? 'cadastrar' : 'atualizar'}</span>`}</td>
          ${r.colunas_lidas.map((c) => `<td>${esc(String(x[c] || '').slice(0, 40))}</td>`).join('')}
        </tr>`).join('')}
        </tbody></table>
      </div>
      ${r.total > 100 ? `<div style="font-size:12px;color:var(--texto-fraco);margin-top:8px">
        Mostrando as 100 primeiras linhas — a importação vai processar todas as ${r.total}.</div>` : ''}`;

    el('imp_linha_novos').style.display = r.resumo.atualizar > 0 ? 'flex' : 'none';
    el('imp_btn').disabled = r.resumo.novos + r.resumo.atualizar === 0;
  } catch (e) {
    IMPORT_ARQUIVO = null;
    el('imp_preview').innerHTML = `<div class="aviso erro"><span>❌</span><div>${esc(e.message)}</div></div>`;
  }
}

async function confirmarImportacao() {
  if (!IMPORT_ARQUIVO) { alerta('Escolha a planilha.'); return; }
  const btn = el('imp_btn');
  btn.disabled = true;
  btn.textContent = '⏳ Importando…';

  try {
    const tipo = val('imp_tipo');
    const r = await api(`/api/importar/${tipo}/confirmar`, {
      method: 'POST',
      body: {
        arquivo: IMPORT_ARQUIVO.base64,
        nome: IMPORT_ARQUIVO.nome,
        somente_novos: el('imp_somente_novos').checked
      }
    });
    fecharModal('modalImportar');
    ok(`${r.criados} cadastrado(s), ${r.atualizados} atualizado(s)` +
       (r.pulados ? `, ${r.pulados} pulado(s)` : ''));
    if (r.problemas && r.problemas.length) alerta('Alguns problemas: ' + r.problemas.join(' | '));

    if (tipo === 'produtos') {
      CATEGORIAS = await api('/api/categorias');
      preencherCategorias();
      carregarProdutos();
    } else if (tipo === 'clientes') carregarClientes();
    else carregarFornecedores();
  } catch (e) {
    erro(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📥 Importar';
  }
}
