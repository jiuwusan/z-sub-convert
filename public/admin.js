'use strict';

const $ = selector => document.querySelector(selector);
const state = { tab: 'subscriptions', data: { sources: [], bases: [], nameservers: [], templates: [], subscriptions: [] }, csrf: '', mode: 'login', initialized: false, authenticated: false, ready: false, route: '', returnTo: 'subscriptions', navigation: 0, editing: null, calls: null, previewContent: '', previewSourceId: null, refreshing: new Set(), allBusy: false };
const labels = {
  subscriptions: { title: '系统订阅', list: '全部订阅', add: '新增订阅', description: '组合来源、基础模板、DNS 和规则模板，生成专属订阅链接。', heads: ['订阅名称', '第三方来源', '模板配置', 'DNS 配置', '操作'] },
  sources: { title: '第三方订阅源', list: '全部来源', add: '新增来源', description: '维护并更新第三方来源，缓存结果供所有关联订阅复用。', heads: ['来源名称', '订阅链接摘要 / User-Agent', '关联订阅', '套餐信息', '缓存状态', '最近更新成功', '最近更新结果', '操作'] },
  bases: { title: '基础模板', list: '全部基础模板', add: '新增基础模板', description: '维护端口、运行模式与 DNS 基础设置，为系统订阅选择一份基础配置。', heads: ['模板名称', '关联订阅', '操作'] },
  nameservers: { title: 'Nameserver', list: '全部 nameserver', add: '新增 nameserver', description: '每条维护一个完整 DNS 地址，可组合使用或作为订阅源 DNS 的备用。', heads: ['名称', 'DNS 地址', '关联订阅', '操作'] },
  templates: { title: '规则模板', list: '全部规则模板', add: '新增规则模板', description: '维护 proxies、proxy-groups 和 rules，保存时检查必要分组。', heads: ['模板名称', '关联订阅', '操作'] }
};
const cacheLabels = { empty: '无缓存', valid: '缓存有效', expired: '已过期', invalidated: '待更新' };
const historyViews = {
  subscriptions: { title: '调用记录', kind: '系统订阅', endpoint: 'calls', heads: ['调用时间', '方法', '来源 IP', 'User-Agent', '状态', '耗时', '错误信息'], empty: '最近 3 天暂无调用记录', note: '仅记录公开链接的 GET / HEAD；后台下载不计入。超过 72 小时自动清理。' },
  sources: { title: '缓存更新记录', kind: '第三方订阅源', endpoint: 'updates', heads: ['更新时间', '更新方式', 'User-Agent', '结果', '耗时', '错误信息'], empty: '最近 3 天暂无缓存更新记录', note: '记录实际更新；命中缓存、预览和来源下载不计入。超过 72 小时自动清理。' }
};
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

async function requestApi(path, method = 'GET', body) {
  const session = state.csrf;
  const navigation = state.navigation;
  const response = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { throw Error('服务返回异常，请稍后重试'); }
    if (response.status === 401 && session === state.csrf && navigation === state.navigation && !['/login', '/setup', '/reset'].includes(path)) { $('#editor').close(); showAuth('login'); }
    throw Error(data.error || '操作失败');
  }
  return response;
}

async function api(path, method = 'GET', body) {
  const response = await requestApi(path, method, body);
  try { return await response.json(); } catch { throw Error('服务返回异常，请稍后重试'); }
}

function showAuth(mode) {
  state.authenticated = false;
  state.csrf = '';
  state.ready = true;
  navigate(mode, true);
}

function navigate(name, replace = false) {
  const hash = SubConvertRoutes.hashFor(name, state.returnTo);
  if (replace) history.replaceState(null, '', hash);
  else if (location.hash !== hash) location.hash = hash;
  applyRoute();
}

function applyRoute() {
  if (!state.ready) return;
  const route = SubConvertRoutes.resolveRoute(location.hash, state);
  if (location.hash !== route.hash) history.replaceState(null, '', route.hash);
  state.returnTo = route.returnTo;
  if (state.route === route.name) return;
  state.route = route.name;
  state.navigation += 1;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  if (Object.hasOwn(labels, route.name)) {
    state.tab = route.name;
    $('#auth-view').hidden = true;
    $('#loading').hidden = true;
    $('#app').hidden = false;
    document.title = `${labels[route.name].title} · Sub Convert`;
    render();
  } else renderAuth(route.name);
}

function renderAuth(mode) {
  state.mode = mode;
  state.csrf = '';
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#auth-view').hidden = false;
  const setup = mode === 'setup';
  const reset = mode === 'reset';
  document.title = `${setup ? '初始化账号' : reset ? '重置账号' : '登录'} · Sub Convert`;
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
  state.ready = false;
  state.csrf = session.csrf;
  $('#account-name').textContent = session.username;
  try { await load(); }
  finally { state.ready = true; }
  state.authenticated = true;
  applyRoute();
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
  return value === null || value === undefined ? '尚未更新' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function cacheMessage(message) {
  return message.replace(/^刷新(?=成功|失败)/, '更新');
}

function formatBytes(value) {
  if (value === undefined) return '—';
  const bytes = Number(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
  const index = bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${Number((bytes / 1024 ** index).toFixed(index ? 2 : 0))} ${units[index]}`;
}

function packageCell(info) {
  if (!info) return node('span', 'muted', '未提供');
  const details = node('div', 'package-info');
  let remaining;
  if (info.total !== undefined && info.upload !== undefined && info.download !== undefined) {
    remaining = BigInt(info.total) - BigInt(info.upload) - BigInt(info.download);
    remaining = (remaining > 0n ? remaining : 0n).toString();
  }
  const unlimited = info.total === '0';
  const expiry = info.expire === undefined ? '—' : info.expire === '0' ? '长期有效' : new Date(Number(info.expire) * 1000).toLocaleDateString('zh-CN');
  for (const [label, value] of [['总量', unlimited ? '无限' : formatBytes(info.total)], ['剩余', unlimited ? '无限' : formatBytes(remaining)], ['到期', expiry]]) {
    const line = node('div', 'package-line');
    line.append(node('span', 'muted', label), document.createTextNode(value));
    details.append(line);
  }
  return details;
}

function render() {
  const tab = state.tab;
  const config = labels[tab];
  const data = state.data;
  $('.table-panel').classList.toggle('subscription-list', tab === 'subscriptions');
  $('#breadcrumb').textContent = config.title;
  $('#page-title').textContent = config.title;
  $('#page-description').textContent = config.description;
  $('#add-record').textContent = `＋ ${config.add}`;
  $('#refresh-all').hidden = tab !== 'sources';
  $('#refresh-all').disabled = state.allBusy || !data.sources.length;
  $('#refresh-all').textContent = state.allBusy ? '正在全部更新…' : '全部更新';
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
    button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false');
  }
  $('#stat-subscriptions').textContent = data.subscriptions.length;
  $('#nav-count').textContent = data.subscriptions.length;
  $('#stat-cached').textContent = data.sources.filter(row => row.cacheStatus === 'valid').length;
  $('#stat-sources').textContent = data.sources.length;
  $('#stat-templates').textContent = data.bases.length + data.nameservers.length + data.templates.length;
  const heading = node('tr');
  for (const title of config.heads) heading.append(node('th', '', title));
  $('#table-head').replaceChildren(heading);
  $('#list-title').replaceChildren(document.createTextNode(config.list + ' '), node('span', 'count', data[tab].length));
  $('#table-body').replaceChildren();
  $('#empty').hidden = data[tab].length > 0;
  $('#total-label').textContent = `共 ${data[tab].length} 条记录`;
  $('#cache-hint').textContent = tab === 'sources' ? '正文与套餐共享 2 小时缓存 · 支持手动更新' : tab === 'subscriptions' ? '关联订阅共享来源缓存 · 按当前配置生成' : '配置修改后自动应用，无需更新来源';
  $('#list-hint').textContent = tab === 'templates' ? '仅规则模板校验业务结构，引用中的配置不能删除' : tab === 'sources' ? '来源独立缓存，更新成功后所有关联订阅使用新数据' : tab === 'subscriptions' ? '需要更新第三方数据时，请到来源列表更新' : '独立维护，多份订阅可复用';
  const needsSource = tab === 'subscriptions' && !data.sources.length;
  $('#empty-title').textContent = tab === 'subscriptions' ? '创建你的第一份订阅' : tab === 'sources' ? '添加第一个第三方来源' : `添加你的${config.title}`;
  $('#empty-description').textContent = tab === 'subscriptions' ? '选择来源、基础模板、nameserver 和规则模板生成订阅。' : tab === 'sources' ? '保存来源名称、订阅链接和 User-Agent，供系统订阅使用。' : tab === 'nameservers' ? '维护单个 DNS 地址，保留协议、参数及 # 后的内容。' : '粘贴 YAML 或上传模板文件，保存后即可关联到订阅。';
  $('#empty-action').textContent = needsSource ? '添加第三方订阅源' : config.add;
  for (const record of data[tab]) {
    const row = node('tr');
    const title = node('div');
    const recordName = node('strong', 'record-name', record.name);
    recordName.title = record.name;
    title.append(recordName);
    if (tab === 'sources') title.append(node('small', 'subline', record.updateMode === 'manual' ? '仅手动更新' : '自动更新'));
    cell(row, title);
    if (tab === 'subscriptions') {
      const sources = node('div');
      const sourceTags = node('div', 'subscription-source-tags');
      for (const name of record.sourceNames.slice(0, 2)) {
        const tag = node('span', 'tag', name); tag.title = name; sourceTags.append(tag);
      }
      if (record.sourceNames.length > 2) {
        const more = node('span', 'tag', `+${record.sourceNames.length - 2}`);
        more.title = record.sourceNames.slice(2).join('、');
        more.setAttribute('aria-label', `其他来源：${more.title}`);
        sourceTags.append(more);
      }
      sources.append(sourceTags);
      const coverage = record.packageCoverage;
      if (coverage) sources.append(node('small', 'subline package-coverage', `套餐信息覆盖 ${coverage.available}/${coverage.total} 个来源`));
      cell(row, sources);
      const templates = node('div', 'subscription-config');
      for (const [label, value] of [['基础', record.baseName], ['规则', record.templateName + (record.removeFailover ? ' · 无故障转移' : '')]]) {
        const line = node('div', 'config-line');
        const name = node('span', 'config-value', value); name.title = value;
        line.append(node('span', 'muted', label), name); templates.append(line);
      }
      cell(row, templates);
      const dns = node('div', 'subscription-config');
      dns.append(node('div', '', record.useSourceNameservers ? '订阅源优先' : '手动配置'));
      const dnsNames = node('div', 'config-value muted', `${record.useSourceNameservers ? '备用：' : ''}${record.nameserverNames.join('、') || '未选择'}`);
      dnsNames.title = dnsNames.textContent;
      dns.append(dnsNames);
      cell(row, dns);
    } else if (tab === 'sources') {
      const summary = node('div', '', record.urlSummary);
      summary.append(node('small', 'subline', record.userAgent));
      cell(row, summary);
      cell(row, `${data.subscriptions.filter(sub => sub.sourceIds.includes(record.id)).length} 份订阅`);
      cell(row, packageCell(record.userInfo));
      const refreshing = state.refreshing.has(record.id) || record.refreshing || state.allBusy;
      cell(row, node('span', `badge ${refreshing ? 'refreshing' : record.cacheStatus}`, refreshing ? '更新中…' : cacheLabels[record.cacheStatus]));
      cell(row, formatTime(record.lastSuccessAt));
      const result = record.lastResult;
      const resultEl = node('span', result ? result.ok ? 'result-ok' : 'result-error' : 'muted', result ? cacheMessage(result.message) : '—');
      if (result) resultEl.title = formatTime(result.at);
      cell(row, resultEl);
    } else {
      if (tab === 'nameservers') cell(row, record.address);
      const count = data.subscriptions.filter(sub => tab === 'bases' ? sub.baseId === record.id : tab === 'nameservers' ? sub.nameserverIds.includes(record.id) : sub.templateId === record.id).length;
      cell(row, `${count} 份订阅`);
    }
    const actions = node('div', 'row-actions');
    if (tab === 'subscriptions') {
      action(actions, '复制', () => copyLink(record));
      action(actions, '下载', () => downloadRecord(tab, record.id));
      const calls = action(actions, '记录', () => showCalls(record));
      calls.title = '查看调用记录'; calls.setAttribute('aria-label', '查看调用记录');
    } else if (tab === 'bases' || tab === 'templates') {
      action(actions, '下载', () => downloadRecord(tab, record.id));
    } else if (tab === 'sources') {
      action(actions, '预览', () => previewSource(record));
      action(actions, '下载', () => downloadRecord(tab, record.id));
      const refresh = action(actions, '更新', () => refreshOne(record));
      refresh.disabled = state.refreshing.has(record.id) || state.allBusy || record.refreshing;
      const updates = action(actions, '记录', () => showCalls(record, 'sources'));
      updates.title = '查看缓存更新记录'; updates.setAttribute('aria-label', '查看缓存更新记录');
    }
    action(actions, '编辑', () => edit(tab, record.id));
    action(actions, '删除', async () => {
      if (!window.confirm(`确定删除“${record.name}”？${tab === 'subscriptions' ? '对应订阅链接将立即失效。' : '已被引用的记录不能删除。'}`)) return;
      await api(`/${tab}/${record.id}`, 'DELETE');
      await load();
      toast('已删除');
    }, 'danger');
    cell(row, actions);
    if (tab === 'subscriptions') for (const [index, td] of [...row.children].entries()) td.dataset.label = config.heads[index];
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
  const navigation = state.navigation;
  const record = id ? await api(`/${resource}/${id}`) : {};
  if (navigation !== state.navigation || !state.authenticated) return;
  $('#editor').classList.toggle('template-editor', ['bases', 'templates'].includes(resource));
  state.editing = { resource, id };
  $('#editor-title').textContent = id ? `编辑${resource === 'subscriptions' ? '订阅' : resource === 'sources' ? '来源' : labels[resource].title}` : labels[resource].add;
  const fields = $('#editor-fields');
  fields.replaceChildren(field('名称', 'name', record.name, { maxLength: 120, placeholder: resource === 'subscriptions' ? '例如：日常使用' : resource === 'sources' ? '例如：主力机场' : '例如：日常分流模板' }).label);
  if (resource === 'sources') {
    fields.append(field('第三方订阅链接', 'url', record.url, { type: 'url', maxLength: 8192, placeholder: 'https://example.com/subscribe?token=…' }).label);
    fields.append(field('User-Agent', 'userAgent', record.userAgent ?? 'clash-verge/v2.4.5', { maxLength: 512 }).label);
    const mode = node('label', 'source-option');
    const manual = node('input'); manual.type = 'checkbox'; manual.name = 'manualUpdate'; manual.checked = record.updateMode === 'manual';
    mode.append(manual, node('span', '', '仅手动更新')); fields.append(mode);
    fields.append(node('p', 'field-help', '列表将隐藏链接中的令牌；保存仅维护配置，不拉取第三方内容。'));
    fields.append(node('p', 'field-help', '不勾选时自动更新：无缓存或缓存失效时，访问系统订阅按需拉取。勾选后仅使用已有缓存，过期也不自动拉取；无缓存时提示先手动更新。两种模式均可执行“更新”和“全部更新”。'));
  } else if (resource === 'nameservers') {
    fields.append(field('DNS 地址', 'address', record.address, { maxLength: 8192, placeholder: 'https://dns.google/dns-query#🚀 节点选择' }).label);
    fields.append(node('p', 'field-help', '每条一个地址，完整保留 # 后的内容。选择引用的分组时，请与规则模板保持一致。'));
  } else if (['bases', 'templates'].includes(resource)) {
    const upload = field('从文件读取（可选）', 'file', '', { type: 'file' });
    upload.input.required = false;
    upload.input.accept = '.yaml,.yml,.txt,text/yaml,text/plain';
    upload.input.className = 'file-input';
    const content = field('模板内容', 'content', record.content || '', { tag: 'textarea' });
    content.input.spellcheck = false;
    content.input.wrap = 'off';
    upload.input.addEventListener('change', async () => {
      const file = upload.input.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) { showEditorError('模板文件不能超过 1 MiB'); upload.input.value = ''; return; }
      try { content.input.value = await file.text(); $('#editor-error').hidden = true; }
      catch { showEditorError('文件读取失败，请重新选择'); }
    });
    fields.append(upload.label, content.label, node('p', 'field-help', resource === 'templates'
      ? '须包含 proxies、proxy-groups、rules 数组，以及“🚀 节点选择”“🔰 故障转移”分组。保存时校验规则结构。'
      : '仅检查 YAML 语法。维护基础配置与其他 DNS 设置；最终的 dns.nameserver 和规则字段由独立选择的配置替换。'));
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
    fields.append(group);
    for (const [title, name, options] of [['基础模板', 'baseId', state.data.bases], ['规则模板', 'templateId', state.data.templates]]) {
      const label = node('label', '', title);
      const select = node('select'); select.name = name; select.required = true;
      if (!options.length) { const option = node('option', '', `请先添加${title}`); option.value = ''; select.append(option); }
      for (const item of options) { const option = node('option', '', item.name); option.value = item.id; select.append(option); }
      if (record[name]) select.value = record[name];
      label.append(select); fields.append(label);
    }
    const failoverOption = node('label', 'source-option');
    const removeFailover = node('input'); removeFailover.type = 'checkbox'; removeFailover.name = 'removeFailover'; removeFailover.checked = record.removeFailover ?? false;
    failoverOption.append(removeFailover, node('span', '', '移除“🔰 故障转移”组'));
    fields.append(failoverOption, node('p', 'field-help', '勾选后移除顶层“🔰 故障转移”组，保留各国家和协议分组；只影响当前系统订阅，不修改规则模板。'));
    const sourceDns = node('label', 'source-option');
    const useSource = node('input'); useSource.type = 'checkbox'; useSource.name = 'useSourceNameservers'; useSource.checked = record.useSourceNameservers ?? false;
    sourceDns.append(useSource, node('span', '', '使用订阅源 nameserver'));
    const dnsTitle = node('span', 'field-title');
    dnsTitle.id = 'nameserver-group-label';
    const dnsList = node('div', 'nameserver-options'); dnsList.setAttribute('role', 'group'); dnsList.setAttribute('aria-labelledby', dnsTitle.id);
    const selectedDns = record.nameserverIds ?? state.data.nameservers.map(item => item.id);
    const dnsOptions = [...selectedDns.map(id => state.data.nameservers.find(item => item.id === id)).filter(Boolean), ...state.data.nameservers.filter(item => !selectedDns.includes(item.id))];
    if (!dnsOptions.length) dnsList.append(node('p', 'field-help', '还没有 nameserver，可到对应页面维护手动或备用地址。'));
    for (const item of dnsOptions) {
      const label = node('label', 'nameserver-tag');
      label.title = item.address;
      const check = node('input'); check.type = 'checkbox'; check.name = 'nameserverIds'; check.value = item.id; check.checked = selectedDns.includes(item.id);
      const caption = node('span', '', item.name);
      label.append(check, caption); dnsList.append(label);
    }
    const updateDnsTitle = () => { dnsTitle.textContent = useSource.checked ? '备用 nameserver（所有来源未提供时使用，可多选）' : 'Nameserver（可多选，至少一项）'; };
    useSource.addEventListener('change', updateDnsTitle); updateDnsTitle();
    fields.append(sourceDns, dnsTitle, dnsList, node('p', 'field-help', '勾选后优先合并来源缓存中的 dns.nameserver，全部来源均未提供时才使用备用项；手动选择始终可用。保存不拉取，访问时按需更新缓存。'));
  }
  $('#editor-error').hidden = true;
  $('#editor').showModal();
}

function showEditorError(message) { $('#editor-error').textContent = message; $('#editor-error').hidden = false; }

async function showCalls(record, resource = 'subscriptions') {
  const config = historyViews[resource];
  state.calls = { id: record.id, resource, page: 1, total: 0, pageSize: 50, request: 0 };
  $('#calls-title').textContent = config.title;
  $('#calls-kind').textContent = config.kind;
  $('#close-calls').setAttribute('aria-label', `关闭${config.title}`);
  $('#calls-empty').textContent = config.empty;
  $('#calls-note').textContent = config.note;
  $('#calls-columns').replaceChildren(...config.heads.map(title => node('th', '', title)));
  $('#calls-name').textContent = record.name;
  $('#calls-rows').replaceChildren();
  $('#calls-summary').textContent = '正在加载最近 3 天的记录…';
  $('#calls-empty').hidden = true;
  $('#calls-table').hidden = true;
  $('#calls-error').hidden = true;
  $('#calls-dialog').showModal();
  await loadCalls(1);
}

async function loadCalls(page) {
  const view = state.calls;
  if (!view) return;
  const request = ++view.request;
  const navigation = state.navigation;
  const session = state.csrf;
  const current = () => state.calls === view && view.request === request && state.navigation === navigation
    && state.authenticated && state.csrf === session && $('#calls-dialog').open;
  for (const id of ['calls-reload', 'calls-prev', 'calls-next']) $(`#${id}`).disabled = true;
  $('#calls-error').hidden = true;
  $('#calls-loading').hidden = false;
  try {
    const result = await api(`/${view.resource}/${view.id}/${historyViews[view.resource].endpoint}?page=${page}`);
    if (!current()) return;
    const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
    if (result.page > lastPage) { await loadCalls(lastPage); return; }
    Object.assign(view, { page: result.page, total: result.total, pageSize: result.pageSize });
    $('#calls-rows').replaceChildren();
    for (const record of result.records) {
      const row = node('tr');
      cell(row, formatTime(record.at));
      if (view.resource === 'sources') cell(row, ({ 'on-demand': '按需更新', manual: '手动更新', all: '全部更新' })[record.trigger] || '—');
      else { cell(row, record.method); cell(row, record.ip || '—'); }
      const agent = node('div', 'calls-detail', record.userAgent || '—'); agent.title = record.userAgent || '';
      cell(row, agent);
      const status = view.resource === 'sources' ? record.status < 400 ? '更新成功' : '更新失败'
        : `${record.status}${record.status === 499 ? ' · 中断' : record.status < 400 ? ' · 成功' : ' · 失败'}`;
      cell(row, node('span', record.status < 400 ? 'result-ok' : 'result-error', status));
      cell(row, `${record.durationMs} ms`);
      cell(row, node('div', 'calls-detail', record.error || '—'));
      $('#calls-rows').append(row);
    }
    $('#calls-table').hidden = result.records.length === 0;
    $('#calls-empty').hidden = result.records.length > 0;
    $('#calls-summary').textContent = `最近 3 天 · 共 ${result.total} 次 · 第 ${result.page}/${lastPage} 页`;
  } catch (error) {
    if (!current()) return;
    $('#calls-error').textContent = error.message; $('#calls-error').hidden = false;
  } finally {
    if (current()) {
      $('#calls-loading').hidden = true;
      $('#calls-reload').disabled = false;
      $('#calls-prev').disabled = view.page <= 1;
      $('#calls-next').disabled = view.page * view.pageSize >= view.total;
    }
  }
}

async function copyLink(record) {
  const navigation = state.navigation;
  const url = new URL('/sub', location.origin);
  url.searchParams.set('key', record.key);
  try { await navigator.clipboard.writeText(url.href); toast('订阅链接已复制'); }
  catch {
    if (navigation !== state.navigation || !state.authenticated) return;
    $('#copy-url').value = url.href; $('#copy-dialog').showModal(); $('#copy-url').select();
  }
}

async function refreshOne(record) {
  state.refreshing.add(record.id);
  render();
  try { await api(`/sources/${record.id}/refresh`, 'POST', {}); toast(`来源“${record.name}”更新成功`); }
  catch (error) { toast(error.message); }
  finally { state.refreshing.delete(record.id); await load(); }
}

async function downloadRecord(resource, id) {
  const session = state.csrf;
  const response = await requestApi(`/${resource}/${id}/download`);
  const blob = await response.blob();
  if (!state.authenticated || session !== state.csrf) return;
  const header = response.headers.get('content-disposition') || '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  const filename = encoded ? decodeURIComponent(encoded) : `subscription-${Date.now()}.yaml`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function previewSource(record) {
  const navigation = state.navigation;
  const result = await api(`/sources/${record.id}/preview`);
  if (navigation !== state.navigation || !state.authenticated) return;
  $('#preview-name').textContent = result.name;
  $('#preview-status').className = `badge ${result.cacheStatus}`;
  $('#preview-status').textContent = cacheLabels[result.cacheStatus];
  $('#preview-meta').textContent = `${result.proxyCount} 个节点 · 最近更新成功：${formatTime(result.lastSuccessAt)}`;
  const notes = {
    empty: '暂无可用缓存，请先在来源列表点击“更新”。',
    valid: '展示第三方返回的完整订阅原文，保留原有配置、分组、规则和注释，未套用本系统模板。',
    expired: '缓存已过期，以下为上次成功保留的结果；更新来源后可查看最新内容。',
    invalidated: '来源配置已变更，以下为变更前保留的缓存；更新来源后可查看最新内容。'
  };
  $('#preview-note').textContent = result.requiresUpdate
    ? '当前旧版缓存仅包含代理节点，请点击来源“更新”获取完整第三方订阅结果。'
    : notes[result.cacheStatus];
  state.previewContent = result.content || '';
  state.previewSourceId = record.id;
  $('#preview-content').value = state.previewContent;
  $('#preview-content').hidden = result.content === null;
  $('#copy-preview').disabled = result.content === null;
  $('#download-preview').disabled = result.content === null;
  $('#preview-dialog').showModal();
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
$('#auth-switch').addEventListener('click', () => navigate(state.mode === 'reset' ? 'login' : 'reset'));
$('#logout').addEventListener('click', async () => {
  try { await api('/logout', 'POST', {}); showAuth('login'); }
  catch (error) { toast(error.message); }
});
for (const link of document.querySelectorAll('[data-tab]')) link.addEventListener('click', event => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.dataset.tab);
});
$('#add-record').addEventListener('click', () => edit(state.tab).catch(error => toast(error.message)));
$('#empty-action').addEventListener('click', () => {
  if (state.tab === 'subscriptions' && !state.data.sources.length) navigate('sources');
  edit(state.tab).catch(error => toast(error.message));
});
$('#reload').addEventListener('click', async () => {
  $('#reload').disabled = true;
  try { await load(); toast('列表已刷新'); } catch (error) { toast(error.message); }
  finally { $('#reload').disabled = false; }
});
$('#refresh-all').addEventListener('click', async () => {
  const navigation = state.navigation;
  state.allBusy = true; render();
  try {
    const { results } = await api('/sources/refresh-all', 'POST', {});
    const succeeded = results.filter(row => row.ok).length;
    $('#results-summary').textContent = `共 ${results.length} 个来源，成功 ${succeeded} 个，失败 ${results.length - succeeded} 个。`;
    $('#results-list').replaceChildren(...results.map(result => {
      const item = node('li', result.ok ? '' : 'failed');
      item.append(node('strong', '', result.name), node('span', '', cacheMessage(result.message))); return item;
    }));
    if (navigation === state.navigation && state.authenticated) $('#results-dialog').showModal();
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
    if (resource === 'sources') Object.assign(body, { url: form.get('url'), userAgent: form.get('userAgent'), updateMode: form.has('manualUpdate') ? 'manual' : 'auto' });
    else if (['bases', 'templates'].includes(resource)) body.content = form.get('content');
    else if (resource === 'nameservers') body.address = form.get('address');
    else {
      body.sourceIds = form.getAll('sourceIds'); body.templateId = form.get('templateId');
      body.baseId = form.get('baseId'); body.nameserverIds = form.getAll('nameserverIds'); body.useSourceNameservers = form.has('useSourceNameservers');
      body.removeFailover = form.has('removeFailover');
      if (!body.sourceIds.length) throw Error('请至少选择一个第三方订阅源');
      if (!body.useSourceNameservers && !body.nameserverIds.length) throw Error('请至少选择一个 nameserver');
    }
    await api(`/${resource}${id ? `/${id}` : ''}`, id ? 'PATCH' : 'POST', body);
    $('#editor').close(); await load(); toast('已保存');
  } catch (error) { showEditorError(error.message); }
  finally { $('#save-record').disabled = false; }
});
for (const id of ['close-editor', 'cancel-editor']) $(`#${id}`).addEventListener('click', () => $('#editor').close());
$('#close-copy').addEventListener('click', () => $('#copy-dialog').close());
$('#close-results').addEventListener('click', () => $('#results-dialog').close());
$('#close-calls').addEventListener('click', () => $('#calls-dialog').close());
$('#calls-dialog').addEventListener('close', () => {
  if ($('#calls-dialog').open) return;
  state.calls = null; $('#calls-rows').replaceChildren();
});
$('#calls-reload').addEventListener('click', () => loadCalls(1));
$('#calls-prev').addEventListener('click', () => loadCalls(state.calls.page - 1));
$('#calls-next').addEventListener('click', () => loadCalls(state.calls.page + 1));
for (const id of ['close-preview', 'done-preview']) $(`#${id}`).addEventListener('click', () => $('#preview-dialog').close());
$('#preview-dialog').addEventListener('close', () => { state.previewContent = ''; state.previewSourceId = null; $('#preview-content').value = ''; });
$('#download-preview').addEventListener('click', async () => {
  $('#download-preview').disabled = true;
  try { await downloadRecord('sources', state.previewSourceId); }
  catch (error) { toast(error.message); }
  finally { $('#download-preview').disabled = !state.previewContent; }
});
$('#copy-preview').addEventListener('click', async () => {
  const navigation = state.navigation;
  const original = state.previewContent;
  const content = $('#preview-content');
  const current = () => navigation === state.navigation && state.authenticated && $('#preview-dialog').open && state.previewContent === original;
  try { await navigator.clipboard.writeText(original); if (current()) toast('预览内容已复制'); }
  catch { if (current()) { content.focus(); content.select(); toast('内容已选中，可手动复制'); } }
});

async function initialize() {
  try {
    const status = await api('/status');
    state.initialized = status.initialized;
    state.returnTo = SubConvertRoutes.resolveRoute(location.hash, status).returnTo;
    if (status.authenticated) await showApp(status);
    else { state.ready = true; applyRoute(); }
  } catch (error) { $('#loading').textContent = `连接失败：${error.message}。请刷新页面重试。`; }
}
window.addEventListener('hashchange', applyRoute);
initialize();
