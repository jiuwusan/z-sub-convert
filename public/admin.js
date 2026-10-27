'use strict';

const $ = selector => document.querySelector(selector);
const state = { tab: 'subscriptions', data: { sources: [], templates: [], subscriptions: [] }, csrf: '', mode: 'login', initialized: false, editing: null, refreshing: new Set(), allBusy: false };
const labels = {
  subscriptions: { title: '系统订阅', list: '全部订阅', add: '新增订阅', description: '将多个来源与模板组合，生成专属订阅链接。', heads: ['订阅名称', '第三方来源 / 模板', '缓存状态', '最近刷新成功', '最近刷新结果', '操作'] },
  sources: { title: '第三方订阅源', list: '全部来源', add: '新增来源', description: '统一维护第三方链接和 User-Agent，供系统订阅组合使用。', heads: ['来源名称', '订阅链接摘要', 'User-Agent', '关联订阅', '操作'] },
  templates: { title: '订阅模板', list: '全部模板', add: '新增模板', description: '维护转换模板，为每份系统订阅选择合适的配置。', heads: ['模板名称', '关联订阅', '操作'] }
};
const cacheLabels = { empty: '无缓存', valid: '缓存有效', expired: '已过期', invalidated: '待刷新' };
let toastTimer;

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); } catch { throw Error('服务返回异常，请稍后重试'); }
  if (!response.ok) {
    if (response.status === 401 && !['/login', '/setup', '/reset'].includes(path)) { $('#editor').close(); showAuth('login'); }
    throw Error(data.error || '操作失败');
  }
  return data;
}

function showAuth(mode) {
  state.mode = mode;
  state.csrf = '';
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  const setup = mode === 'setup';
  const reset = mode === 'reset';
  $('#auth-title').textContent = setup ? '创建管理员账号' : reset ? '重置管理员账号' : '欢迎回来';
  $('#auth-description').textContent = setup ? '首次使用，设置用户名和密码即可开始。' : reset ? '使用当前容器启动日志中的 key 重置账号。' : '登录以管理你的订阅。';
  $('#auth-submit').textContent = setup ? '创建账号并登录' : reset ? '重置账号' : '登录';
  $('#auth-switch').hidden = setup;
  $('#auth-switch').textContent = reset ? '返回登录' : '忘记账号或密码？';
  $('#reset-field').hidden = !reset;
  $('#reset-key').required = reset;
  $('#reset-help').hidden = !reset;
  $('#password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#password').value = '';
  $('#reset-key').value = '';
  $('#auth-error').hidden = true;
}

async function showApp(session) {
  state.csrf = session.csrf;
  $('#account-name').textContent = session.username;
  await load();
  $('#auth-view').hidden = true;
  $('#loading').hidden = true;
  $('#app').hidden = false;
}

async function load() {
  state.data = await api('/state');
  $('#page-error').hidden = true;
  render();
}

function cell(row, child, className) {
  const td = node('td', className);
  td.append(typeof child === 'string' ? document.createTextNode(child) : child);
  row.append(td);
  return td;
}

function action(container, label, callback, className = '') {
  const button = node('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await callback(); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
  container.append(button);
  return button;
}

function formatTime(value) {
  return value === null || value === undefined ? '尚未刷新' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function render() {
  const tab = state.tab;
  const config = labels[tab];
  const data = state.data;
  $('#breadcrumb').textContent = config.title;
  $('#page-title').textContent = config.title;
  $('#page-description').textContent = config.description;
  $('#add-record').textContent = `＋ ${config.add}`;
  $('#refresh-all').hidden = tab !== 'subscriptions';
  $('#refresh-all').disabled = state.allBusy || !data.subscriptions.length;
  $('#refresh-all').textContent = state.allBusy ? '正在全部刷新…' : '全部刷新';
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
    button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
  }
  $('#stat-subscriptions').textContent = data.subscriptions.length;
  $('#nav-count').textContent = data.subscriptions.length;
  $('#stat-cached').textContent = data.subscriptions.filter(row => row.cacheStatus === 'valid').length;
  $('#stat-sources').textContent = data.sources.length;
  $('#stat-templates').textContent = data.templates.length;
  const heading = node('tr');
  for (const title of config.heads) heading.append(node('th', '', title));
  $('#table-head').replaceChildren(heading);
  $('#list-title').replaceChildren(document.createTextNode(config.list + ' '), node('span', 'count', data[tab].length));
  $('#table-body').replaceChildren();
  $('#empty').hidden = data[tab].length > 0;
  $('#total-label').textContent = `共 ${data[tab].length} 条记录`;
  $('#cache-hint').textContent = tab === 'subscriptions' ? '访问时按需拉取 · 支持手动刷新' : '修改配置后，关联订阅将在下次访问时刷新';
  $('#list-hint').textContent = tab === 'templates' ? '模板在保存时校验，修改后自动应用到关联订阅' : '保存配置不会立即拉取第三方订阅';
  const needsSource = tab === 'subscriptions' && !data.sources.length;
  $('#empty-title').textContent = tab === 'subscriptions' ? '创建你的第一份订阅' : tab === 'sources' ? '添加第一个第三方来源' : '创建你的订阅模板';
  $('#empty-description').textContent = tab === 'subscriptions' ? '选择一个或多个第三方来源，再搭配模板生成订阅。' : tab === 'sources' ? '保存来源名称、订阅链接和 User-Agent，供系统订阅使用。' : '粘贴 YAML 或上传模板文件，保存后即可关联到订阅。';
  $('#empty-action').textContent = needsSource ? '添加第三方订阅源' : config.add;
  for (const record of data[tab]) {
    const row = node('tr');
    const title = node('div');
    title.append(node('strong', 'record-name', record.name));
    if (tab === 'subscriptions') title.append(node('small', 'subline', 'Clash.Meta / Mihomo'));
    cell(row, title);
    if (tab === 'subscriptions') {
      const sources = node('div');
      for (const name of record.sourceNames) sources.append(node('span', 'tag', name));
      sources.append(node('small', 'subline', record.templateName));
      cell(row, sources);
      const refreshing = state.refreshing.has(record.id) || record.refreshing || state.allBusy;
      cell(row, node('span', `badge ${refreshing ? 'refreshing' : record.cacheStatus}`, refreshing ? '刷新中…' : cacheLabels[record.cacheStatus]));
      cell(row, formatTime(record.lastSuccessAt));
      const result = record.lastResult;
      const resultEl = node('span', result ? result.ok ? 'result-ok' : 'result-error' : 'muted', result ? result.message : '—');
      if (result) resultEl.title = formatTime(result.at);
      cell(row, resultEl);
    } else if (tab === 'sources') {
      cell(row, record.urlSummary);
      cell(row, record.userAgent);
      cell(row, `${data.subscriptions.filter(sub => sub.sourceIds.includes(record.id)).length} 份订阅`);
    } else cell(row, `${data.subscriptions.filter(sub => sub.templateId === record.id).length} 份订阅`);
    const actions = node('div', 'row-actions');
    if (tab === 'subscriptions') {
      action(actions, '复制', () => copyLink(record));
      const refresh = action(actions, '刷新', () => refreshOne(record));
      refresh.disabled = state.refreshing.has(record.id) || state.allBusy || record.refreshing;
    }
    action(actions, '编辑', () => edit(tab, record.id));
    action(actions, '删除', async () => {
      if (!window.confirm(`确定删除“${record.name}”？${tab === 'subscriptions' ? '对应订阅链接将立即失效。' : '已被引用的记录不能删除。'}`)) return;
      await api(`/${tab}/${record.id}`, 'DELETE');
      await load();
      toast('已删除');
    }, 'danger');
    cell(row, actions);
    $('#table-body').append(row);
  }
}

function field(labelText, name, value = '', options = {}) {
  const label = node('label', '', labelText);
  const input = node(options.tag || 'input');
  input.name = name;
  if (options.tag !== 'textarea') input.type = options.type || 'text';
  input.required = true;
  input.value = value;
  if (options.maxLength) input.maxLength = options.maxLength;
  if (options.placeholder) input.placeholder = options.placeholder;
  label.append(input);
  return { label, input };
}

async function edit(resource, id) {
  const record = id ? await api(`/${resource}/${id}`) : {};
  state.editing = { resource, id };
  $('#editor-title').textContent = id ? `编辑${labels[resource].title === '系统订阅' ? '订阅' : resource === 'sources' ? '来源' : '模板'}` : labels[resource].add;
  const fields = $('#editor-fields');
  fields.replaceChildren(field('名称', 'name', record.name, { maxLength: 120, placeholder: resource === 'subscriptions' ? '例如：日常使用' : resource === 'sources' ? '例如：主力机场' : '例如：日常分流模板' }).label);
  if (resource === 'sources') {
    fields.append(field('第三方订阅链接', 'url', record.url, { type: 'url', maxLength: 8192, placeholder: 'https://example.com/subscribe?token=…' }).label);
    fields.append(field('User-Agent', 'userAgent', record.userAgent ?? 'clash-verge/v2.4.5', { maxLength: 512 }).label);
    fields.append(node('p', 'field-help', '列表将隐藏链接中的令牌；保存仅维护配置，不拉取第三方内容。'));
  } else if (resource === 'templates') {
    const upload = field('从文件读取（可选）', 'file', '', { type: 'file' });
    upload.input.required = false;
    upload.input.accept = '.yaml,.yml,.txt,text/yaml,text/plain';
    upload.input.className = 'file-input';
    const content = field('模板内容', 'content', record.content || '', { tag: 'textarea' });
    content.input.spellcheck = false;
    upload.input.addEventListener('change', async () => {
      const file = upload.input.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) { showEditorError('模板文件不能超过 1 MiB'); upload.input.value = ''; return; }
      try { content.input.value = await file.text(); $('#editor-error').hidden = true; }
      catch { showEditorError('文件读取失败，请重新选择'); }
    });
    fields.append(upload.label, content.label, node('p', 'field-help', '须包含 proxies、proxy-groups，以及“🚀 节点选择”“🔰 故障转移”分组。保存时将检查模板。'));
  } else {
    const group = node('div');
    const groupTitle = node('span', 'field-title', '第三方订阅源（可多选）');
    groupTitle.id = 'source-group-label';
    const list = node('div', 'source-options');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-labelledby', 'source-group-label');
    if (!state.data.sources.length) list.append(node('p', 'field-help', '还没有来源，请先到“第三方订阅源”添加。'));
    const selectedIds = record.sourceIds || [];
    const orderedSources = [
      ...selectedIds.map(id => state.data.sources.find(source => source.id === id)).filter(Boolean),
      ...state.data.sources.filter(source => !selectedIds.includes(source.id))
    ];
    for (const source of orderedSources) {
      const label = node('label', 'source-option');
      const check = node('input');
      check.type = 'checkbox'; check.name = 'sourceIds'; check.value = source.id;
      check.checked = record.sourceIds?.includes(source.id) || false;
      const caption = node('span', '', source.name);
      caption.append(node('small', '', source.urlSummary));
      label.append(check, caption); list.append(label);
    }
    group.append(groupTitle, list);
    const template = node('label', '', '订阅模板');
    const select = node('select');
    select.name = 'templateId'; select.required = true;
    for (const record of state.data.templates) { const option = node('option', '', record.name); option.value = record.id; select.append(option); }
    if (record.templateId) select.value = record.templateId;
    template.append(select);
    fields.append(group, template, node('p', 'field-help', '按所选来源的列表顺序合并。保存不拉取，首次访问或点击刷新时获取内容。订阅链接保持不变。'));
  }
  $('#editor-error').hidden = true;
  $('#editor').showModal();
}

function showEditorError(message) { $('#editor-error').textContent = message; $('#editor-error').hidden = false; }

async function copyLink(record) {
  const url = new URL('/sub', location.origin);
  url.searchParams.set('key', record.key);
  try { await navigator.clipboard.writeText(url.href); toast('订阅链接已复制'); }
  catch { $('#copy-url').value = url.href; $('#copy-dialog').showModal(); $('#copy-url').select(); }
}

async function refreshOne(record) {
  state.refreshing.add(record.id);
  render();
  try { await api(`/subscriptions/${record.id}/refresh`, 'POST', {}); toast(`“${record.name}”刷新成功`); }
  catch (error) { toast(error.message); }
  finally { state.refreshing.delete(record.id); await load(); }
}

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#auth-submit').disabled = true;
  $('#auth-error').hidden = true;
  try {
    const data = { username: $('#username').value.trim(), password: $('#password').value };
    if (state.mode === 'setup') {
      await api('/setup', 'POST', data);
      state.initialized = true;
      showAuth('login'); // Login remains available if the automatic login request fails.
    }
    if (state.mode === 'reset') {
      await api('/reset', 'POST', { ...data, key: $('#reset-key').value.trim() });
      showAuth('login'); toast('账号已重置，请使用新账号登录'); return;
    }
    const session = await api('/login', 'POST', data);
    $('#password').value = '';
    await showApp(session);
  } catch (error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; }
  finally { $('#auth-submit').disabled = false; }
});
$('#auth-switch').addEventListener('click', () => showAuth(state.mode === 'reset' ? 'login' : 'reset'));
$('#logout').addEventListener('click', async () => {
  try { await api('/logout', 'POST', {}); showAuth('login'); }
  catch (error) { toast(error.message); }
});
for (const button of document.querySelectorAll('[data-tab]')) button.addEventListener('click', () => { state.tab = button.dataset.tab; render(); });
$('#add-record').addEventListener('click', () => edit(state.tab).catch(error => toast(error.message)));
$('#empty-action').addEventListener('click', () => {
  if (state.tab === 'subscriptions' && !state.data.sources.length) { state.tab = 'sources'; render(); }
  edit(state.tab).catch(error => toast(error.message));
});
$('#reload').addEventListener('click', async () => {
  $('#reload').disabled = true;
  try { await load(); toast('列表已更新'); } catch (error) { toast(error.message); }
  finally { $('#reload').disabled = false; }
});
$('#refresh-all').addEventListener('click', async () => {
  state.allBusy = true; render();
  try {
    const { results } = await api('/refresh-all', 'POST', {});
    const succeeded = results.filter(row => row.ok).length;
    $('#results-summary').textContent = `共 ${results.length} 条，成功 ${succeeded} 条，失败 ${results.length - succeeded} 条。`;
    $('#results-list').replaceChildren(...results.map(result => {
      const item = node('li', result.ok ? '' : 'failed');
      item.append(node('strong', '', result.name), node('span', '', result.message)); return item;
    }));
    $('#results-dialog').showModal();
  } catch (error) { toast(error.message); }
  finally { state.allBusy = false; try { await load(); } catch (error) { toast(error.message); } }
});
$('#editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#save-record').disabled = true;
  try {
    const { resource, id } = state.editing;
    const form = new FormData(event.target);
    const body = { name: form.get('name') };
    if (resource === 'sources') Object.assign(body, { url: form.get('url'), userAgent: form.get('userAgent') });
    else if (resource === 'templates') body.content = form.get('content');
    else {
      body.sourceIds = form.getAll('sourceIds'); body.templateId = form.get('templateId');
      if (!body.sourceIds.length) throw Error('请至少选择一个第三方订阅源');
    }
    await api(`/${resource}${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', body);
    $('#editor').close(); await load(); toast('已保存');
  } catch (error) { showEditorError(error.message); }
  finally { $('#save-record').disabled = false; }
});
for (const id of ['close-editor', 'cancel-editor']) $(`#${id}`).addEventListener('click', () => $('#editor').close());
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());
$('#close-results').addEventListener('click', () => $('#results-dialog').close());

async function initialize() {
  try {
    const status = await api('/status');
    state.initialized = status.initialized;
    if (status.authenticated) await showApp(status);
    else showAuth(status.initialized ? 'login' : 'setup');
  } catch (error) { $('#loading').textContent = `连接失败：${error.message}。请刷新页面重试。`; }
}
initialize();
