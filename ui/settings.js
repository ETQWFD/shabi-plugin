/**
 * ui/settings.js — 沙币设置页前端。
 * 零依赖、离线可用；所有配置通过 /shabi/api 读写。
 */
if (window.self !== window.top) document.documentElement.classList.add('embedded');

const API_BASE = window.__SHABI_API_BASE__ || '/shabi/api';

const state = {
  schema: null,
  config: {},
  status: null,
  personalities: [],
  accounts: [],
  dirty: false,
  loading: false,
  memoryQuery: '',
  memoryArchive: false,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const contentEl = $('#content');
const navEl = $('#nav');
const dirtyEl = $('#dirty');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const versionText = $('#versionText');
const modalMask = $('#modalMask');
const modalTitle = $('#modalTitle');
const modalBody = $('#modalBody');
const modalFoot = $('#modalFoot');

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function api(path, { method = 'GET', body, allowFail = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const type = res.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) data = await res.json();
  else {
    const text = await res.text();
    throw new ApiError(text.slice(0, 200) || `HTTP ${res.status}`, res.status, null);
  }
  if (!res.ok || (data?.ok === false && !allowFail)) {
    const message = data?.error || (data?.errors ? data.errors.join('；') : `请求失败（HTTP ${res.status}）`);
    throw new ApiError(message, res.status, data);
  }
  return data;
}

async function load() {
  setLoading(true);
  try {
    const data = await api('/settings');
    state.schema = data.schema;
    state.config = data.config || {};
    state.status = data.status || null;
    state.personalities = data.personality || [];
    state.accounts = state.status?.accounts || state.config.accounts?.platforms || [];
    if (!state.schema) throw new Error('宿主未返回设置 schema（config/settings.schema.json）');
    renderAll();
    updateStatus();
    setDirty(false);
  } catch (err) {
    contentEl.innerHTML = `
      <div class="empty-state" style="text-align:left;line-height:1.9">
        <strong>无法加载设置</strong><br />
        ${escapeHtml(err.message)}<br /><br />
        请确认：<br />
        1. 插件已在 DSH 中启用（<code>dsh plugin --profile &lt;name&gt; add github:ETQWFD/shabi-plugin</code>）；<br />
        2. 宿主提供 HTTP 路由；或运行 <code>npm start</code> 后打开 <code>http://127.0.0.1:3579/shabi/settings</code>；<br />
        3. 浏览器与 DSH 同源，且 <code>/shabi/api</code> 未被拦截。
      </div>`;
    updateStatus(true);
  } finally {
    setLoading(false);
  }
}

function setLoading(v) {
  state.loading = v;
  for (const id of ['#save', '#saveBottom', '#reload']) {
    const el = $(id);
    if (el) el.disabled = v;
  }
}

function renderAll() {
  const scroll = contentEl.scrollTop;
  renderNav();
  renderContent();
  contentEl.scrollTop = scroll;
}

function renderNav() {
  navEl.innerHTML = '';
  const groups = [...(state.schema?.groups || []), { id: 'logs', title: '运行日志', description: '最近日志与错误。' }];
  groups.forEach((g, index) => {
    const a = document.createElement('a');
    a.href = `#group-${g.id}`;
    a.dataset.target = `group-${g.id}`;
    if (index === 0) a.classList.add('active');
    a.innerHTML = `<span class="nav-dot"></span><span>${escapeHtml(g.title)}</span>`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = $(`#group-${g.id}`);
      if (target && contentEl) contentEl.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: 'smooth' });
      $$('.nav a').forEach((x) => x.classList.remove('active'));
      a.classList.add('active');
    });
    navEl.appendChild(a);
  });
}

function renderContent() {
  contentEl.innerHTML = '';
  const groups = state.schema?.groups || [];
  for (const group of groups) contentEl.appendChild(renderGroup(group));
  contentEl.appendChild(renderLogsPanel());
  hydrateSpecialPanels();
}

function renderGroup(group) {
  const section = document.createElement('section');
  section.className = 'group';
  section.id = `group-${group.id}`;

  const head = document.createElement('div');
  head.className = 'group-head';
  head.innerHTML = `<div><h2>${escapeHtml(group.title)}</h2>${group.description ? `<p>${escapeHtml(group.description)}</p>` : ''}</div>`;
  section.appendChild(head);

  const body = document.createElement('div');
  body.className = 'group-body';
  for (const field of group.fields || []) {
    if (field.type === 'customList') body.appendChild(specialContainer(field, 'personality-list'));
    else if (field.type === 'memoryList') body.appendChild(specialContainer(field, 'memory-panel'));
    else if (field.type === 'actionList') body.appendChild(specialContainer(field, 'action-panel'));
    else if (field.type === 'platformStatus') body.appendChild(specialContainer(field, 'platform-panel'));
    else if (field.type === 'readonly') body.appendChild(renderReadonly(field));
    else body.appendChild(renderField(field));
  }
  section.appendChild(body);
  return section;
}

function specialContainer(field, cls) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.special = field.type;
  const label = document.createElement('div');
  label.className = 'field-label';
  label.innerHTML = `<label>${escapeHtml(field.label)}</label>${field.hint ? `<span class="hint">${escapeHtml(field.hint)}</span>` : ''}`;
  const control = document.createElement('div');
  control.className = 'field-control';
  const inner = document.createElement('div');
  inner.className = cls;
  inner.dataset.specialTarget = field.type;
  control.appendChild(inner);
  wrap.append(label, control);
  return wrap;
}

function renderField(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.fieldWrap = '1';
  wrap.dataset.key = field.key;
  wrap.dataset.type = field.type;

  const label = document.createElement('div');
  label.className = 'field-label';
  const id = `f-${field.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  label.innerHTML = `<label for="${id}">${escapeHtml(field.label)}</label>${field.hint ? `<span class="hint">${escapeHtml(field.hint)}</span>` : ''}`;

  const control = document.createElement('div');
  control.className = 'field-control';
  const value = getPath(state.config, field.key) ?? field.default;

  if (field.type === 'boolean') {
    control.appendChild(booleanControl(field, value, id));
  } else if (field.type === 'number' || field.type === 'range') {
    control.appendChild(numberControl(field, value, id));
  } else if (field.type === 'select') {
    control.appendChild(selectControl(field, value, id));
  } else if (field.type === 'textarea') {
    control.appendChild(textareaControl(field, value, id));
  } else if (field.type === 'list' || field.type === 'paths') {
    control.appendChild(listControl(field, value, id));
  } else if (field.type === 'timeRange') {
    control.appendChild(timeRangeControl(field, value));
  } else if (field.type === 'imageList') {
    control.appendChild(imageListControl(field, value));
  } else if (field.type === 'action') {
    control.appendChild(actionControl(field));
  } else {
    control.appendChild(inputControl(field, value, id, field.type === 'password' ? 'password' : 'text'));
  }

  wrap.append(label, control);
  return wrap;
}

function booleanControl(field, value, id) {
  const label = document.createElement('label');
  label.className = 'switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = value === true;
  input.dataset.fieldInput = '1';
  const track = document.createElement('span');
  track.className = 'track';
  const text = document.createElement('span');
  text.className = 'switch-text';
  text.textContent = value === true ? '已开启' : '已关闭';
  input.addEventListener('change', () => {
    text.textContent = input.checked ? '已开启' : '已关闭';
    setDirty(true);
  });
  label.append(input, track, text);
  return label;
}

function numberControl(field, value, id) {
  if (field.type === 'range') {
    const row = document.createElement('div');
    row.className = 'range-row';
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = field.min ?? 0;
    input.max = field.max ?? 1;
    input.step = field.step ?? 0.01;
    input.value = Number(value ?? field.default ?? field.min ?? 0);
    input.dataset.fieldInput = '1';
    const out = document.createElement('span');
    out.className = 'range-val';
    out.textContent = input.value;
    input.addEventListener('input', () => { out.textContent = input.value; setDirty(true); });
    row.append(input, out);
    return row;
  }
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.className = 'input';
  if (field.min !== undefined) input.min = field.min;
  if (field.max !== undefined) input.max = field.max;
  if (field.step !== undefined) input.step = field.step;
  input.value = value ?? field.default ?? '';
  input.dataset.fieldInput = '1';
  input.addEventListener('input', () => setDirty(true));
  return input;
}

function selectControl(field, value, id) {
  const select = document.createElement('select');
  select.id = id;
  select.className = 'select';
  select.dataset.fieldInput = '1';
  const options = [...(field.options || [])];
  const current = String(value ?? field.default ?? '');
  if (current && !options.some((o) => String(o.value) === current)) options.push({ value: current, label: current });
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = String(opt.value);
    o.textContent = opt.label ?? String(opt.value);
    select.appendChild(o);
  }
  select.value = current;
  select.addEventListener('change', () => setDirty(true));
  return select;
}

function inputControl(field, value, id, type = 'text') {
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.className = 'input';
  input.value = value ?? '';
  input.placeholder = field.placeholder || '';
  if (type === 'password') input.autocomplete = 'new-password';
  input.dataset.fieldInput = '1';
  input.addEventListener('input', () => setDirty(true));
  return input;
}

function textareaControl(field, value, id) {
  const ta = document.createElement('textarea');
  ta.id = id;
  ta.className = 'textarea';
  ta.rows = field.rows || 4;
  ta.placeholder = field.placeholder || '';
  ta.value = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  ta.dataset.fieldInput = '1';
  ta.addEventListener('input', () => setDirty(true));
  return ta;
}

function listControl(field, value, id) {
  const ta = document.createElement('textarea');
  ta.id = id;
  ta.className = 'textarea';
  ta.rows = field.rows || 4;
  ta.placeholder = field.placeholder || '每行一个';
  const arr = Array.isArray(value) ? value : String(value || '').split('\n').filter(Boolean);
  ta.value = arr.join('\n');
  ta.dataset.fieldInput = '1';
  ta.addEventListener('input', () => setDirty(true));
  return ta;
}

function timeRangeControl(field, value) {
  const wrap = document.createElement('div');
  wrap.className = 'time-range';
  const arr = Array.isArray(value) ? value : field.default || ['23:00', '07:00'];
  for (let i = 0; i < 2; i += 1) {
    if (i === 1) {
      const sep = document.createElement('span');
      sep.className = 'action-note';
      sep.textContent = '至';
      wrap.appendChild(sep);
    }
    const input = document.createElement('input');
    input.type = 'time';
    input.className = 'input';
    input.value = arr[i] || (i === 0 ? '23:00' : '07:00');
    input.dataset.timeIndex = String(i);
    input.addEventListener('input', () => setDirty(true));
    wrap.appendChild(input);
  }
  return wrap;
}

function imageListControl(field, value) {
  const grid = document.createElement('div');
  grid.className = 'image-grid';
  grid.dataset.imageList = '1';
  const list = Array.isArray(value) ? value.slice(0, field.max || 4) : [];
  const max = field.max || 4;
  for (let i = 0; i < max; i += 1) {
    const slot = document.createElement('div');
    slot.className = 'image-slot';
    slot.dataset.imageSlot = String(i);
    const head = document.createElement('div');
    head.className = 'slot-head';
    head.innerHTML = `<span>参考图 ${i + 1}</span><span>${i === 0 ? '主参考' : '可选'}</span>`;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.placeholder = 'https://… 或 /绝对/路径.png';
    input.value = list[i] || '';
    input.dataset.imageInput = '1';
    const preview = document.createElement('div');
    preview.className = 'empty';
    preview.textContent = '未设置';
    const img = document.createElement('img');
    img.alt = '';
    img.style.display = 'none';
    img.addEventListener('error', () => { img.style.display = 'none'; preview.style.display = 'grid'; });
    img.addEventListener('load', () => { img.style.display = 'block'; preview.style.display = 'none'; });
    const update = () => {
      const url = input.value.trim();
      if (!url) {
        img.style.display = 'none';
        preview.style.display = 'grid';
        preview.textContent = '未设置';
        return;
      }
      img.src = /^https?:/i.test(url) ? url : fileUrl(url);
      preview.textContent = '预览加载中…';
      preview.style.display = 'grid';
    };
    input.addEventListener('input', () => { update(); setDirty(true); });
    slot.append(head, input, preview, img);
    grid.appendChild(slot);
    if (list[i]) update();
  }
  return grid;
}

function actionControl(field) {
  const row = document.createElement('div');
  row.className = 'action-row';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn small';
  btn.dataset.action = field.action;
  btn.textContent = field.button || field.label || '执行';
  btn.addEventListener('click', () => runAction(field.action, btn));
  row.appendChild(btn);
  if (field.hint) {
    const note = document.createElement('span');
    note.className = 'action-note';
    note.textContent = field.hint;
    row.appendChild(note);
  }
  return row;
}

function renderReadonly(field) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.dataset.readonly = field.source || field.key;
  const label = document.createElement('div');
  label.className = 'field-label';
  label.innerHTML = `<label>${escapeHtml(field.label)}</label>${field.hint ? `<span class="hint">${escapeHtml(field.hint)}</span>` : ''}`;
  const control = document.createElement('div');
  control.className = 'field-control';
  const box = document.createElement('div');
  box.className = 'readonly';
  box.dataset.readonlyBox = field.source || field.key;
  box.textContent = '—';
  control.appendChild(box);
  wrap.append(label, control);
  return wrap;
}

// ───────────────── 特殊面板 ─────────────────

function hydrateSpecialPanels() {
  for (const el of $$('[data-special-target="personality-list"]')) renderPersonalityCards(el);
  for (const el of $$('[data-special-target="memory-panel"]')) renderMemoryPanel(el);
  for (const el of $$('[data-special-target="action-panel"]')) renderActionsPanel(el);
  for (const el of $$('[data-special-target="platform-panel"]')) renderPlatforms(el);
  for (const el of $$('[data-readonly-box]')) renderReadonlyValue(el);
}

function renderPersonalityCards(container) {
  container.innerHTML = '';
  const active = state.config?.personality?.active || state.status?.config?.personality?.id;
  if (!state.personalities.length) {
    container.innerHTML = '<div class="empty-state">没有可用人格</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const p of state.personalities) {
    const card = document.createElement('div');
    card.className = 'mini-card';
    const isActive = p.id === active || p.active;
    card.innerHTML = `
      <h3>${escapeHtml(p.name)} ${isActive ? '<span class="badge ok">当前</span>' : ''} ${p.builtin ? '<span class="badge">内置</span>' : '<span class="badge warn">自定义</span>'}</h3>
      <p>${escapeHtml(p.description || '')}</p>
      <div class="meta"><span>主动 ${Math.round(Number(p.proactivity ?? 0) * 100)}%</span><span>${escapeHtml(p.id)}</span></div>`;
    const ops = document.createElement('div');
    ops.className = 'ops';
    if (!isActive) {
      const sw = document.createElement('button');
      sw.className = 'btn small';
      sw.textContent = '切换';
      sw.addEventListener('click', () => switchPersonality(p.id));
      ops.appendChild(sw);
    }
    if (!p.builtin) {
      const edit = document.createElement('button');
      edit.className = 'btn small';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => editPersonality(p.id));
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '删除';
      del.addEventListener('click', () => deletePersonality(p.id));
      ops.append(edit, del);
    }
    card.appendChild(ops);
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

async function switchPersonality(id) {
  try {
    const data = await api('/personalities', { method: 'POST', body: { action: 'active', id } });
    state.config.personality = state.config.personality || {};
    state.config.personality.active = data.personality.id;
    toast(`已切换到 ${data.personality.name}`, 'ok');
    await refreshPersonalities();
    renderPersonalityCards($('[data-special-target="personality-list"]'));
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function refreshPersonalities() {
  const data = await api('/personalities');
  state.personalities = data.items || [];
  state.config.personality = state.config.personality || {};
  if (data.active) state.config.personality.active = data.active;
}

async function deletePersonality(id) {
  const ok = await confirmDialog('删除人格', `确定删除自定义人格“${id}”吗？此操作可重新创建，但不会恢复原来的对话示例。`);
  if (!ok) return;
  try {
    await api('/personalities', { method: 'POST', body: { action: 'remove', id } });
    toast('已删除', 'ok');
    await refreshPersonalities();
    renderPersonalityCards($('[data-special-target="personality-list"]'));
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function editPersonality(id) {
  let def = state.personalities.find((p) => p.id === id);
  try {
    const data = await api('/personalities');
    const full = (data.definitions || []).find((d) => d.id === id);
    if (full) def = { ...def, ...full };
  } catch { /* ignore */ }
  openPersonalityEditor({ ...(def || {}), id }, false);
}

function openPersonalityEditor(def = {}, isNew = true) {
  const examplesText = (def.examples || []).map((e) => JSON.stringify(e)).join('\n');
  const body = `
    <div class="two-col">
      <div class="form-row"><label>名称</label><input class="input" id="pe-name" value="${escapeAttr(def.name || '')}" maxlength="40" placeholder="例如：外表冷淡内心话多" /></div>
      <div class="form-row"><label>ID（可选）</label><input class="input" id="pe-id" value="${escapeAttr(def.id || '')}" placeholder="留空按名称生成" ${isNew ? '' : 'readonly'} /></div>
    </div>
    <div class="form-row"><label>一句话定位</label><input class="input" id="pe-desc" value="${escapeAttr(def.description || '')}" maxlength="200" placeholder="例如：说话简短、先吐槽后帮忙" /></div>
    <div class="form-row"><label>语气规则（每行一条）</label><textarea class="textarea" id="pe-tone" rows="3" placeholder="简短\n不人身攻击">${escapeHtml((def.tone || []).join('\n'))}</textarea></div>
    <div class="form-row"><label>行为规则（每行一条）</label><textarea class="textarea" id="pe-rules" rows="4" placeholder="先给结论再解释">${escapeHtml((def.rules || []).join('\n'))}</textarea></div>
    <div class="form-row"><label>口癖（每行一条）</label><textarea class="textarea" id="pe-catch" rows="3" placeholder="行吧。">${escapeHtml((def.catchphrases || []).join('\n'))}</textarea></div>
    <div class="form-row"><label>禁忌（每行一条）</label><textarea class="textarea" id="pe-taboos" rows="3" placeholder="人身攻击">${escapeHtml((def.taboos || []).join('\n'))}</textarea></div>
    <div class="form-row"><label>示例对话（每行一个 JSON：{"user":"…","assistant":"…"}）</label><textarea class="textarea" id="pe-examples" rows="4">${escapeHtml(examplesText)}</textarea></div>
    <div class="two-col">
      <div class="form-row"><label>主动程度（0–1）</label><input class="input" id="pe-proactivity" type="number" min="0" max="1" step="0.05" value="${Number(def.proactivity ?? 0.3)}" /></div>
      <div class="form-row"><label>回复长度</label><select class="select" id="pe-length"><option value="short">简短</option><option value="medium">适中</option><option value="long">可展开</option></select></div>
    </div>`;
  openModal('新增人格', body, [
    { label: '取消', onClick: closeModal },
    {
      label: '保存人格',
      primary: true,
      onClick: async (btn) => {
        btn.disabled = true;
        try {
          const payload = {
            id: $('#pe-id').value.trim() || undefined,
            name: $('#pe-name').value.trim(),
            description: $('#pe-desc').value.trim(),
            tone: splitLines($('#pe-tone').value),
            rules: splitLines($('#pe-rules').value),
            catchphrases: splitLines($('#pe-catch').value),
            taboos: splitLines($('#pe-taboos').value),
            examples: parseExamples($('#pe-examples').value),
            proactivity: Number($('#pe-proactivity').value || 0.3),
            replyLength: $('#pe-length').value,
          };
          if (!payload.name) throw new Error('名称不能为空');
          await api('/personalities', { method: 'POST', body: { action: isNew ? 'add' : 'update', id: def.id, definition: payload } });
          toast(isNew ? '已新增人格' : '已保存人格', 'ok');
          closeModal();
          await refreshPersonalities();
          renderPersonalityCards($('[data-special-target="personality-list"]'));
          state.config.personality = state.config.personality || {};
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          btn.disabled = false;
        }
      },
    },
  ]);
  $('#pe-length').value = def.replyLength || 'short';
}

function parseExamples(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const obj = JSON.parse(s);
      if (obj.user && obj.assistant) out.push({ user: String(obj.user), assistant: String(obj.assistant) });
    } catch {
      throw new Error(`示例对话不是合法 JSON：${s.slice(0, 60)}`);
    }
  }
  return out.slice(0, 5);
}

function renderMemoryPanel(container) {
  container.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'search-row';
  const input = document.createElement('input');
  input.className = 'input';
  input.placeholder = '搜索记忆：关键词、实体、场景…';
  input.value = state.memoryQuery;
  const search = document.createElement('button');
  search.className = 'btn small primary';
  search.textContent = '搜索';
  const all = document.createElement('button');
  all.className = 'btn small';
  all.textContent = '全部';
  const archived = document.createElement('button');
  archived.className = 'btn small';
  archived.textContent = state.memoryArchive ? '看主库' : '看归档';
  bar.append(input, search, all, archived);

  const results = document.createElement('div');
  results.className = 'memory-results';
  results.dataset.memoryResults = '1';

  const doSearch = () => {
    state.memoryQuery = input.value.trim();
    loadMemoryList(results, { q: state.memoryQuery, archive: state.memoryArchive });
  };
  search.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  all.addEventListener('click', () => { input.value = ''; state.memoryQuery = ''; state.memoryArchive = false; archived.textContent = '看归档'; loadMemoryList(results, {}); });
  archived.addEventListener('click', () => {
    state.memoryArchive = !state.memoryArchive;
    archived.textContent = state.memoryArchive ? '看主库' : '看归档';
    loadMemoryList(results, { q: state.memoryQuery, archive: state.memoryArchive });
  });

  container.append(bar, results);
  loadMemoryList(results, { q: state.memoryQuery, archive: state.memoryArchive });
}

async function loadMemoryList(container, { q = '', archive = false } = {}) {
  container.innerHTML = '<div class="empty-state">读取记忆中…</div>';
  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    else params.set('limit', '20');
    if (archive) params.set('archive', '1');
    const data = await api(`/memory?${params.toString()}`);
    const items = data.items || [];
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">${archive ? '归档为空' : '暂无记忆。和沙币聊几句，或让它看一段视频。'}</div>`;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    for (const m of items) {
      const card = document.createElement('div');
      card.className = 'mini-card';
      card.innerHTML = `
        <h3>${escapeHtml(m.summary || m.content?.slice(0, 40) || m.id)}</h3>
        <p>${escapeHtml((m.content || '').slice(0, 140))}</p>
        <div class="meta">
          <span>${escapeHtml(m.type || 'unknown')}</span>
          <span>重要度 ${Math.round(Number(m.importance || 0) * 100)}%</span>
          <span>${escapeHtml(formatTime(m.time))}</span>
        </div>
        <div class="meta">${(m.tags || []).slice(0, 5).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')}</div>`;
      const ops = document.createElement('div');
      ops.className = 'ops';
      const detail = document.createElement('button');
      detail.className = 'btn small';
      detail.textContent = '详情';
      detail.addEventListener('click', () => showMemoryDetail(m));
      ops.appendChild(detail);
      if (archive) {
        const un = document.createElement('button');
        un.className = 'btn small';
        un.textContent = '放回主库';
        un.addEventListener('click', () => memoryAction({ action: 'unarchive', id: m.id }, '已放回主库'));
        ops.appendChild(un);
      } else {
        const arc = document.createElement('button');
        arc.className = 'btn small';
        arc.textContent = '归档';
        arc.addEventListener('click', () => memoryAction({ action: 'archive', id: m.id }, '已归档'));
        ops.appendChild(arc);
      }
      const del = document.createElement('button');
      del.className = 'btn small danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        const ok = await confirmDialog('删除记忆', '删除后不可恢复。确定删除这条记忆吗？');
        if (ok) memoryAction({ action: 'delete', id: m.id }, '已删除');
      });
      ops.appendChild(del);
      card.appendChild(ops);
      grid.appendChild(card);
    }
    container.innerHTML = '';
    container.appendChild(grid);
  } catch (err) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function showMemoryDetail(m) {
  const evidence = (m.evidence || []).map((e) => `${e.videoId || e.source || '?'} ${e.start ?? ''}–${e.end ?? ''}`).join('\n');
  openModal('记忆详情', `
    <div class="form-row"><label>摘要</label><div class="readonly">${escapeHtml(m.summary || '')}</div></div>
    <div class="form-row"><label>内容</label><div class="readonly" style="max-height:260px;overflow:auto">${escapeHtml(m.content || '')}</div></div>
    <div class="two-col">
      <div class="form-row"><label>类型</label><div class="readonly">${escapeHtml(m.type || '')}</div></div>
      <div class="form-row"><label>重要度 / 强度</label><div class="readonly">${Math.round(Number(m.importance || 0) * 100)}% / ${Number(m.strength ?? 1).toFixed(2)}</div></div>
    </div>
    <div class="form-row"><label>标签</label><div class="readonly">${escapeHtml((m.tags || []).join('、') || '无')}</div></div>
    <div class="form-row"><label>证据</label><div class="readonly">${escapeHtml(evidence || '无')}</div></div>
    <div class="form-row"><label>元信息</label><div class="readonly">${escapeHtml(JSON.stringify({ id: m.id, time: m.time, lastAccess: m.lastAccess, accessCount: m.accessCount, source: m.source, version: m.version, checksum: m.checksum }, null, 2))}</div></div>
  `, [{ label: '关闭', onClick: closeModal }]);
}

async function memoryAction(body, okText) {
  try {
    const data = await api('/memory', { method: 'POST', body });
    toast(okText || '完成', 'ok');
    if (data.result?.summary) toast(data.result.summary, 'ok');
    const results = $('[data-memory-results]');
    if (results) loadMemoryList(results, { q: state.memoryQuery, archive: state.memoryArchive });
  } catch (err) {
    toast(err.message, 'err');
  }
}

function renderActionsPanel(container) {
  container.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'search-row';
  const refresh = document.createElement('button');
  refresh.className = 'btn small';
  refresh.textContent = '刷新动作日志';
  bar.appendChild(refresh);
  const tableWrap = document.createElement('div');
  tableWrap.className = 'table-wrap';
  tableWrap.innerHTML = '<div class="empty-state">读取中…</div>';
  refresh.addEventListener('click', () => loadActions(tableWrap));
  container.append(bar, tableWrap);
  loadActions(tableWrap);
}

async function loadActions(container) {
  try {
    const data = await api('/safety');
    const actions = data.actions || [];
    if (!actions.length) {
      container.innerHTML = '<div class="empty-state">还没有动作记录。</div>';
      return;
    }
    container.innerHTML = `<table><thead><tr><th>时间</th><th>动作</th><th>风险</th><th>结果</th><th>操作</th></tr></thead><tbody>${actions.map((a) => `
      <tr>
        <td class="mono">${escapeHtml(formatTime(a.ts))}</td>
        <td>${escapeHtml(a.action || '')}<div class="action-note">${escapeHtml(JSON.stringify(a.detail || {}).slice(0, 80))}</div></td>
        <td><span class="badge ${a.risk === 'high' ? 'err' : a.risk === 'medium' ? 'warn' : ''}">${escapeHtml(a.risk || '')}</span></td>
        <td>${escapeHtml(typeof a.result === 'object' ? JSON.stringify(a.result).slice(0, 60) : String(a.result ?? ''))}</td>
        <td>${a.rollback?.type === 'file-restore' ? `<button class="btn small danger" data-rollback="${escapeAttr(a.logId)}">回滚</button>` : '<span class="action-note">—</span>'}</td>
      </tr>`).join('')}</tbody></table>`;
    for (const btn of $$('[data-rollback]', container)) {
      btn.addEventListener('click', async () => {
        const ok = await confirmDialog('回滚动作', '将用备份恢复目标文件。确定继续吗？');
        if (!ok) return;
        try {
          const res = await api('/safety', { method: 'POST', body: { action: 'rollback', logId: btn.dataset.rollback } });
          toast(`已回滚：${res.result.restored || res.result.removed || ''}`, 'ok');
          loadActions(container);
        } catch (err) {
          toast(err.message, 'err');
        }
      });
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderPlatforms(container) {
  container.innerHTML = '';
  const list = state.accounts?.length ? state.accounts : (state.config.accounts?.platforms || []);
  if (!list.length) {
    container.innerHTML = '<div class="empty-state">没有配置平台。</div>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'platform-list';
  for (const p of list) {
    const row = document.createElement('div');
    row.className = 'platform-row';
    const left = document.createElement('div');
    left.innerHTML = `<div class="p-name">${escapeHtml(p.label || p.platform)} <span class="badge ${p.authorized ? 'ok' : 'warn'}">${p.authorized ? '已授权' : '未授权'}</span></div><div class="p-note">${escapeHtml(p.note || p.sessionMode || '')}</div>`;
    const actions = document.createElement('div');
    actions.className = 'p-actions';
    const check = document.createElement('button');
    check.className = 'btn small';
    check.textContent = '检查会话';
    check.addEventListener('click', () => checkPlatform(p.platform, check));
    actions.appendChild(check);
    row.append(left, actions);
    wrap.appendChild(row);
  }
  const bar = document.createElement('div');
  bar.className = 'action-row';
  bar.style.marginTop = '10px';
  const all = document.createElement('button');
  all.className = 'btn small';
  all.textContent = '检查全部';
  all.addEventListener('click', async () => {
    all.disabled = true;
    try {
      for (const p of list) await checkPlatform(p.platform);
      toast('已更新授权状态', 'ok');
    } finally {
      all.disabled = false;
    }
  });
  bar.appendChild(all);
  container.append(wrap, bar);
}

async function checkPlatform(platform, btn = null) {
  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  try {
    const data = await api('/accounts', { method: 'POST', body: { platform }, allowFail: true });
    state.accounts = data.platforms || state.accounts;
    toast(`${platform}：${data.result?.ok ? '会话有效' : data.result?.reason || '不可用'}`, data.result?.ok ? 'ok' : 'err');
    renderPlatforms($('[data-special-target="platform-panel"]'));
    if (state.status?.accounts) state.status.accounts = state.accounts;
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '检查会话'; }
  }
}

function renderReadonlyValue(box) {
  const source = box.dataset.readonlyBox;
  if (source === 'qqWebhook') {
    const path = state.config.qqBot?.webhookPath || '/shabi/qq/webhook';
    const base = state.config.qqBot?.publicBaseUrl || location.origin;
    box.textContent = `${String(base).replace(/\/$/, '')}${path}`;
    return;
  }
  if (source === 'status') {
    const status = state.status || {};
    box.textContent = JSON.stringify({
      capabilities: status.capabilities,
      memory: status.memory && { entries: status.memory.entries, files: status.memory.files, archived: status.memory.archived },
      eye: status.eye && { paused: status.eye.paused, lastAt: status.eye.lastAt, error: status.eye.lastError },
      qq: status.qq && { enabled: status.qq.enabled, running: status.qq.running, mode: status.qq.mode },
      autonomy: status.autonomy && { running: status.autonomy.running, ticks: status.autonomy.stats?.ticks },
      routes: status.routes,
    }, null, 2);
    return;
  }
  box.textContent = '—';
}

// ───────────────── 动作 ─────────────────

async function runAction(action, btn) {
  if (!action) return;
  const original = btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
  try {
    if (action === 'personalityAdd') {
      openPersonalityEditor({}, true);
    } else if (action === 'imageTest') {
      const cfg = collectAll().imageApi;
      const data = await api('/image', { method: 'POST', body: { action: 'test', config: cfg }, allowFail: true });
      showResultModal('图片 API 测试', data.result || data, data.ok);
    } else if (action === 'imagePreview') {
      const cfg = collectAll().imageApi;
      const data = await api('/image', { method: 'POST', body: { action: 'generate', config: cfg, scene: '室内，自然光，随手自拍' }, allowFail: true });
      const result = data.result || {};
      if (!result.ok) {
        toast(result.message || data.error || '生成失败', 'err');
      } else {
        showImages(result);
      }
    } else if (action === 'memorySearch') {
      const q = await askText('搜索记忆', '输入关键词、实体或场景描述');
      if (q === null) return;
      state.memoryQuery = q;
      const results = $('[data-memory-results]');
      if (results) loadMemoryList(results, { q });
      const input = $('.memory-panel .search-row input');
      if (input) input.value = q;
    } else if (action === 'memoryForget') {
      const data = await api('/memory', { method: 'POST', body: { action: 'forget' } });
      toast(`遗忘结算完成：扫描 ${data.result?.scanned ?? 0} 条，归档 ${data.result?.archived ?? 0} 条`, 'ok');
      const results = $('[data-memory-results]');
      if (results) loadMemoryList(results, {});
    } else if (action === 'memoryCompress') {
      const data = await api('/memory', { method: 'POST', body: { action: 'compress' } });
      toast(`压缩完成：合并 ${data.result?.merged ?? 0} 组`, 'ok');
    } else if (action === 'memoryExport') {
      const data = await api('/memory', { method: 'POST', body: { action: 'export', format: 'ini' } });
      toast(`已导出：${data.result?.path || data.result?.files?.join(', ') || '完成'}`, 'ok');
    } else if (action === 'memoryResurface') {
      const q = await askText('突然记起来', '输入一个线索（可留空，随机从归档里找）', { optional: true });
      if (q === null) return;
      const data = await api('/memory', { method: 'POST', body: { action: 'resurface', query: q } });
      toast(data.message || (data.result ? `想起来了：${data.result.summary}` : '没有匹配的归档记忆'), data.result ? 'ok' : '');
    } else if (action === 'safetyCheck') {
      const target = await askText('检查路径', '输入要检查的文件或目录绝对路径');
      if (target === null) return;
      const data = await api('/safety', { method: 'POST', body: { action: 'checkPath', path: target, write: true } });
      showResultModal('路径检查', data.result, data.result?.ok);
    } else if (action === 'qqToggle') {
      const running = Boolean(state.status?.qq?.running);
      const data = await api('/qq', { method: 'POST', body: { action: running ? 'stop' : 'start' }, allowFail: true });
      if (data.ok === false) throw new Error(data.error || 'QQ 操作失败');
      state.status.qq = data.status;
      toast(running ? 'QQ 机器人已停止' : 'QQ 机器人已启动', 'ok');
      renderAll();
    } else if (action === 'qqTest') {
      const data = await api('/qq', { method: 'POST', body: { action: 'test' }, allowFail: true });
      showResultModal('QQ 机器人连接测试', data.result || data, data.result?.ok);
    } else if (action === 'accountsCheck') {
      for (const p of state.accounts) await checkPlatform(p.platform);
      toast('授权状态已刷新', 'ok');
    } else if (action === 'eyeTest') {
      const data = await api('/eye', { method: 'POST', body: { action: 'test' }, allowFail: true });
      if (!data.ok || !data.result) throw new Error(data.error || '没有拿到屏幕内容');
      showResultModal('眼睛测试', data.result, true);
    } else if (action === 'eyeToggle') {
      const paused = Boolean(state.status?.eye?.paused);
      await api('/eye', { method: 'POST', body: { action: paused ? 'resume' : 'pause' } });
      const data = await api('/status');
      state.status = data.status || state.status;
      updateStatus();
      toast(paused ? '屏幕识别已恢复' : '屏幕识别已暂停', 'ok');
    } else if (action === 'contentFeed') {
      const data = await api('/content', { method: 'POST', body: { action: 'next' }, allowFail: true });
      if (!data.ok) throw new Error(data.error || '没有刷到 B 站内容');
      showResultModal('B 站推荐', data.pick || data, true);
      if (data.pick?.url) {
        const open = document.createElement('button');
        open.className = 'btn small primary';
        open.textContent = '在浏览器打开';
        open.onclick = () => window.open(data.pick.url, '_blank', 'noopener');
        $('#modalFoot')?.appendChild(open);
      }
    } else if (action === 'contentNovel') {
      let url = state.config?.content?.novel?.defaultUrl || '';
      if (!url) {
        url = await askText('打开小说', '输入小说页面地址（https://…）');
        if (url === null) return;
      }
      const data = await api('/content', { method: 'POST', body: { action: 'novelOpen', url }, allowFail: true });
      if (!data.ok) throw new Error(data.error || '打开失败');
      showResultModal('小说阅读', { title: data.title, chars: data.chars, paragraphs: data.paragraphs?.slice(0, 6), chapterLinks: data.chapterLinks?.slice(0, 12) }, true);
    } else if (action === 'contentLearn') {
      const target = await askText('学习 B 站视频', '输入 BV 号或视频链接');
      if (target === null) return;
      const data = await api('/content', { method: 'POST', body: { action: 'bilibiliLearn', bvid: target }, allowFail: true });
      if (!data.ok) throw new Error(data.error || '学习失败');
      showResultModal('学习完成', { title: data.title, mode: data.mode, summary: data.summary, notes: data.notes, memoryIds: data.memoryIds }, true);
    } else if (action === 'selfcheck') {
      const data = await api('/selfcheck', { method: 'POST', allowFail: true });
      showSelfcheck(data.report || data);
    } else {
      toast(`未知动作：${action}`, 'err');
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

function showResultModal(title, result, ok) {
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  openModal(title, `
    <div class="form-row"><label>结果</label><div class="readonly" style="max-height:420px;overflow:auto">${escapeHtml(text)}</div></div>
  `, [{ label: '关闭', onClick: closeModal }]);
  if (ok === false) toast('测试未通过，请检查配置', 'err');
}

function showImages(result) {
  const imgs = (result.images || []).map((p) => `<img src="${escapeAttr(imageSrc(p))}" alt="AI 生成自拍" style="width:100%;border-radius:12px;margin-top:8px;border:1px solid var(--line)" />`).join('');
  openModal('AI 自拍', `
    <div class="form-row"><label>${escapeHtml(result.caption || '（AI 生成）')}</label></div>
    ${imgs || '<div class="empty-state">没有返回图片</div>'}
    <div class="action-note">图片由 AI 生成，不代表真实人物。保存路径：${escapeHtml((result.images || []).join('、'))}</div>
  `, [{ label: '关闭', onClick: closeModal }]);
}

function imageSrc(p) {
  if (/^https?:/i.test(p)) return p;
  return fileUrl(p);
}

function fileUrl(p) {
  return `${API_BASE}/file?path=${encodeURIComponent(p)}`;
}

function showSelfcheck(report) {
  if (!report) {
    toast('自检没有返回结果', 'err');
    return;
  }
  const checks = report.checks || [];
  openModal('自检报告', `
    <div class="form-row"><label>总体</label><div class="readonly">${report.ok ? '通过' : '存在失败项'}（${checks.filter((c) => c.ok).length}/${checks.length}）</div></div>
    <div class="table-wrap"><table><thead><tr><th>项目</th><th>状态</th><th>详情</th></tr></thead><tbody>${checks.map((c) => `<tr><td>${escapeHtml(c.name || '')}</td><td><span class="badge ${c.ok ? 'ok' : 'err'}">${c.ok ? '通过' : '失败'}</span></td><td>${escapeHtml(c.detail || c.error || '')}</td></tr>`).join('')}</tbody></table></div>
  `, [{ label: '关闭', onClick: closeModal }]);
}

// ───────────────── 收集与保存 ─────────────────

function collectAll() {
  const out = JSON.parse(JSON.stringify(state.config || {}));
  for (const wrap of $$('[data-field-wrap]')) {
    const key = wrap.dataset.key;
    const type = wrap.dataset.type;
    if (!key || key.startsWith('__')) continue;
    const value = readWrap(wrap, type);
    if (value !== undefined) setPath(out, key, value);
  }
  return out;
}

function readWrap(wrap, type) {
  if (type === 'imageList') {
    const vals = $$('[data-image-input]', wrap).map((i) => i.value.trim()).filter(Boolean);
    return vals;
  }
  if (type === 'timeRange') {
    return $$('[data-time-index]', wrap).map((i) => i.value);
  }
  const input = $('[data-field-input]', wrap);
  if (!input) return undefined;
  if (type === 'boolean') return Boolean(input.checked);
  if (type === 'number' || type === 'range') {
    if (input.value === '') return undefined;
    const n = Number(input.value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'list' || type === 'paths') return splitLines(input.value);
  return input.value;
}

async function save() {
  if (state.loading) return;
  setLoading(true);
  try {
    const next = collectAll();
    const data = await api('/settings', { method: 'POST', body: { config: next } });
    state.config = data.config || state.config;
    state.status = data.status || state.status;
    state.accounts = state.status?.accounts || state.accounts;
    setDirty(false);
    if (data.warnings?.length) toast(`已保存，但有以下提醒：${data.warnings.join('；')}`, 'warn');
    else toast('设置已保存', 'ok');
    renderAll();
    updateStatus();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    setLoading(false);
  }
}

function setDirty(v) {
  state.dirty = Boolean(v);
  dirtyEl.classList.toggle('show', state.dirty);
}

function updateStatus(failed = false) {
  if (failed || !state.status) {
    statusDot.className = 'dot err';
    statusText.textContent = '未连接';
    return;
  }
  const s = state.status;
  const ok = Boolean(s.capabilities?.screen || s.capabilities?.llm || s.capabilities?.ffmpeg);
  statusDot.className = `dot ${ok ? 'ok' : 'warn'}`;
  const bits = [];
  bits.push(s.memory ? `记忆 ${s.memory.entries ?? 0} 条` : '记忆未加载');
  if (s.eye?.paused) bits.push('眼睛暂停');
  if (s.qq?.running) bits.push('QQ 运行中');
  if (s.autonomy?.running) bits.push('自主循环开');
  statusText.textContent = bits.join(' · ');
  versionText.textContent = `v${s.version || '1.0.0'}`;
  const subtitle = $('#subtitle');
  if (subtitle && state.schema?.description) subtitle.textContent = state.schema.description;
}

// ───────────────── 日志面板 ─────────────────

function renderLogsPanel() {
  const section = document.createElement('section');
  section.className = 'group';
  section.id = 'group-logs';
  section.innerHTML = '<div class="group-head"><div><h2>运行日志</h2><p>最近 80 行，敏感字段已脱敏。</p></div></div>';
  const body = document.createElement('div');
  body.className = 'group-body';
  const bar = document.createElement('div');
  bar.className = 'search-row';
  const refresh = document.createElement('button');
  refresh.className = 'btn small';
  refresh.textContent = '刷新日志';
  bar.appendChild(refresh);
  const pre = document.createElement('div');
  pre.className = 'readonly';
  pre.style.maxHeight = '320px';
  pre.style.overflow = 'auto';
  pre.style.fontFamily = '"SF Mono", ui-monospace, monospace';
  pre.textContent = '读取中…';
  bar.addEventListener('click', () => loadLogs(pre));
  body.append(bar, pre);
  section.appendChild(body);
  loadLogs(pre);
  return section;
}

async function loadLogs(pre) {
  try {
    const data = await api('/logs?lines=80');
    pre.textContent = (data.lines || []).join('\n') || '暂无日志';
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    pre.textContent = err.message;
  }
}

// ───────────────── 通用 UI ─────────────────

function openModal(title, bodyHtml, buttons = []) {
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHtml;
  modalFoot.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`;
    btn.textContent = b.label;
    btn.addEventListener('click', () => b.onClick?.(btn));
    modalFoot.appendChild(btn);
  }
  modalMask.classList.add('show');
}

function closeModal() {
  modalMask.classList.remove('show');
  modalBody.innerHTML = '';
  modalFoot.innerHTML = '';
}

function confirmDialog(title, message, confirmLabel = '确认') {
  return new Promise((resolve) => {
    openModal(title, `<div class="readonly">${escapeHtml(message)}</div>`, [
      { label: '取消', onClick: () => { closeModal(); resolve(false); } },
      { label: confirmLabel, danger: true, onClick: () => { closeModal(); resolve(true); } },
    ]);
  });
}

function askText(title, hint, { optional = false } = {}) {
  return new Promise((resolve) => {
    openModal(title, `
      <div class="form-row"><label>${escapeHtml(hint)}</label><input class="input" id="ask-text" autocomplete="off" /></div>
      ${optional ? '<div class="action-note">留空表示不限定线索。</div>' : ''}
    `, [
      { label: '取消', onClick: () => { closeModal(); resolve(null); } },
      {
        label: '确定', primary: true,
        onClick: () => {
          const v = $('#ask-text').value.trim();
          closeModal();
          resolve(v);
        },
      },
    ]);
    setTimeout(() => $('#ask-text')?.focus(), 30);
  });
}

function toast(text, kind = '') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 6000 : 3800);
}

function splitLines(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function getPath(obj, key) {
  return String(key).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj, key, value) {
  const parts = String(key).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

function formatTime(t) {
  if (!t) return '—';
  try {
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return String(t);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(t);
  }
}

// ───────────────── 事件绑定 ─────────────────

$('#save').addEventListener('click', save);
$('#saveBottom').addEventListener('click', save);
$('#reload').addEventListener('click', async () => {
  if (state.dirty) {
    const ok = await confirmDialog('放弃未保存修改？', '重新加载会丢掉当前未保存的修改。');
    if (!ok) return;
  }
  await load();
});
$('#modalClose').addEventListener('click', closeModal);
modalMask.addEventListener('click', (e) => { if (e.target === modalMask) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalMask.classList.contains('show')) closeModal();
});

$('#exportConfig').addEventListener('click', () => {
  const data = JSON.stringify(state.config, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'shabi-config.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/// 滚动时高亮导航
contentEl.addEventListener('scroll', () => {
  const sections = $$('.group', contentEl);
  let current = sections[0];
  for (const s of sections) {
    if (s.getBoundingClientRect().top <= 120) current = s;
  }
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.target === current?.id));
}, { passive: true });

load();
