/* ==========================================================================
   perfis.js — perfis de acesso e vínculo com os usuários
   ========================================================================== */

let CATALOGO = { modulos: [], acoes: [] };
let PERFIS = [];

async function carregarPerfis() {
  try {
    if (!CATALOGO.modulos.length) CATALOGO = await api('/api/permissoes');
    PERFIS = await api('/api/perfis');

    const nomes = (p) => {
      if (p.permissoes.todos) return '<span class="pill verde">acesso total</span>';
      const mods = CATALOGO.modulos.filter((m) => p.permissoes[m.chave]).map((m) => m.nome);
      if (!mods.length) return '<span class="pill cinza">nenhum módulo</span>';
      const mostra = mods.slice(0, 5).map((n) => `<span class="pill azul">${esc(n)}</span>`).join(' ');
      return mostra + (mods.length > 5 ? ` <span class="pill cinza">+${mods.length - 5}</span>` : '');
    };

    el('perfisLista').innerHTML = `
      <table><thead><tr>
        <th>Perfil</th><th>Módulos liberados</th>
        <th class="centro">Usuários</th><th></th>
      </tr></thead><tbody>
      ${PERFIS.map((p) => `<tr>
        <td><strong>${esc(p.nome)}</strong>
          ${p.sistema ? ' <span class="pill cinza">do sistema</span>' : ''}
          ${p.descricao ? `<div style="font-size:11.5px;color:var(--texto-fraco)">${esc(p.descricao)}</div>` : ''}</td>
        <td style="line-height:2">${nomes(p)}</td>
        <td class="centro">${p.usuarios}</td>
        <td class="centro" style="white-space:nowrap">
          <button class="btn-ic" onclick="abrirPerfil(${p.id})" title="Editar">✏️</button>
          ${p.sistema ? '' : `<button class="btn-ic" onclick="excluirPerfil(${p.id}, '${esc(p.nome).replace(/'/g, '')}')" title="Excluir">🗑️</button>`}
        </td></tr>`).join('')}
      </tbody></table>`;

    // alimenta o select do cadastro de usuário
    if (el('usr_perfil_id')) {
      el('usr_perfil_id').innerHTML = '<option value="">— escolha —</option>' +
        PERFIS.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
    }
  } catch (e) { erro(e.message); }
}

async function abrirPerfil(id) {
  if (!CATALOGO.modulos.length) CATALOGO = await api('/api/permissoes');

  setVal('prf_id', '');
  setVal('prf_nome', '');
  setVal('prf_descricao', '');
  el('prf_todos').checked = false;
  el('perfilTitulo').textContent = 'Novo perfil de acesso';

  const p = id ? PERFIS.find((x) => x.id === id) : null;
  if (p) {
    setVal('prf_id', p.id);
    setVal('prf_nome', p.nome);
    setVal('prf_descricao', p.descricao);
    el('prf_todos').checked = !!p.permissoes.todos;
    el('perfilTitulo').textContent = 'Editar perfil: ' + p.nome;
  }

  montarQuadroPermissoes(p ? p.permissoes : {});
  alternarTudoPerfil();
  abrirModal('modalPerfil');
  setTimeout(() => el('prf_nome').focus(), 100);
}

function montarQuadroPermissoes(perms) {
  const grupos = {};
  CATALOGO.modulos.forEach((m) => {
    (grupos[m.grupo] = grupos[m.grupo] || []).push(m);
  });

  const caixa = (chave, nome, dica) => `
    <label class="check" style="padding:6px 4px;border-bottom:1px solid #eef1f5">
      <input type="checkbox" class="perm" data-chave="${chave}" ${perms[chave] ? 'checked' : ''}>
      <span>${esc(nome)}${dica ? `<div style="font-size:11px;color:var(--texto-fraco);margin-left:0">${esc(dica)}</div>` : ''}</span>
    </label>`;

  el('prf_permissoes').innerHTML = `
    <div class="grid g2">
      ${Object.entries(grupos).map(([grupo, mods]) => `
        <div class="card" style="margin-bottom:0;box-shadow:none">
          <h3 style="font-size:12.5px">${esc(grupo)}</h3>
          ${mods.map((m) => caixa(m.chave, m.nome, '')).join('')}
        </div>`).join('')}

      <div class="card" style="margin-bottom:0;box-shadow:none;border-color:var(--laranja)">
        <h3 style="font-size:12.5px;color:var(--laranja-esc)">⚡ O que pode fazer</h3>
        ${CATALOGO.acoes.map((a) => caixa(a.chave, a.nome, a.dica)).join('')}
      </div>
    </div>`;
}

function alternarTudoPerfil() {
  const todos = el('prf_todos').checked;
  el('prf_permissoes').style.opacity = todos ? '.4' : '1';
  el('prf_permissoes').style.pointerEvents = todos ? 'none' : '';
  el('prf_marcadores').style.display = todos ? 'none' : 'flex';
}

function marcarPerfil(marcar) {
  document.querySelectorAll('#prf_permissoes .perm').forEach((c) => { c.checked = marcar; });
}

async function salvarPerfil() {
  if (!val('prf_nome')) { alerta('Informe o nome do perfil.'); return; }

  const permissoes = {};
  if (el('prf_todos').checked) permissoes.todos = true;
  else {
    document.querySelectorAll('#prf_permissoes .perm').forEach((c) => {
      if (c.checked) permissoes[c.dataset.chave] = true;
    });
    if (!Object.keys(permissoes).length) {
      alerta('Marque pelo menos um módulo, senão quem usar esse perfil não vê nada.');
      return;
    }
  }

  try {
    await api('/api/perfis', {
      method: 'POST',
      body: {
        id: val('prf_id') || null,
        nome: val('prf_nome'),
        descricao: val('prf_descricao'),
        permissoes
      }
    });
    fecharModal('modalPerfil');
    await carregarPerfis();
    carregarUsuarios();
    ok('Perfil salvo. Quem já estiver logado precisa sair e entrar de novo.');
  } catch (e) { erro(e.message); }
}

async function excluirPerfil(id, nome) {
  if (!confirm(`Excluir o perfil "${nome}"?`)) return;
  try {
    await api('/api/perfis/' + id, { method: 'DELETE' });
    await carregarPerfis();
    ok('Perfil excluído.');
  } catch (e) { erro(e.message); }
}

/** Mostra, no cadastro do usuário, o que o perfil escolhido libera. */
function mostrarResumoPerfil() {
  const p = PERFIS.find((x) => String(x.id) === val('usr_perfil_id'));
  const box = el('usr_resumo_perfil');
  if (!p) { box.innerHTML = ''; return; }

  if (p.permissoes.todos) {
    box.innerHTML = `<div class="aviso alerta"><span>🔑</span><div>
      <strong>${esc(p.nome)}</strong> tem <strong>acesso total</strong> ao sistema,
      inclusive usuários, configurações e backup.</div></div>`;
    return;
  }
  const mods = CATALOGO.modulos.filter((m) => p.permissoes[m.chave]).map((m) => m.nome);
  const acoes = CATALOGO.acoes.filter((a) => p.permissoes[a.chave]).map((a) => a.nome);
  box.innerHTML = `<div class="aviso info"><span>🔑</span><div>
    <strong>${esc(p.nome)}</strong> vê: ${mods.length ? esc(mods.join(', ')) : '<em>nenhum módulo</em>'}.
    ${acoes.length ? `<br>Pode: ${esc(acoes.join(', '))}.` : ''}</div></div>`;
}
