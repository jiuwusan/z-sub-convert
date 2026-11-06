'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const routes = require('../public/router');

async function copyHarness() {
  const elements = new Map();
  let rejectClipboard;
  const location = { origin: 'https://admin.example', hash: '#/login' };
  const context = vm.createContext({
    URL, URLSearchParams, setTimeout, clearTimeout,
    SubConvertRoutes: routes,
    location,
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    window: { addEventListener() {} },
    navigator: { clipboard: { writeText: () => new Promise((_resolve, reject) => { rejectClipboard = reject; }) } },
    fetch: async () => ({ ok: true, json: async () => ({ initialized: true, authenticated: false }) }),
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          value: '', open: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; }, replaceChildren() {},
          close() { this.open = false; }, showModal() { this.open = true; }, select() { this.selected = true; }
        });
        return elements.get(selector);
      },
      querySelectorAll() { return []; }
    }
  });
  vm.runInContext(readFileSync(join(__dirname, '../public/admin.js'), 'utf8'), context);
  await context.initialize();
  vm.runInContext('state.authenticated = true; state.navigation = 1;', context);
  return { context, elements, denyClipboard: () => rejectClipboard(Error('denied')) };
}

class CountryElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.checked = false; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  change() { return this.listeners.change?.(); }
  all(name) { return this.children.flatMap(child => typeof child === 'object' ? [...(child.name === name ? [child] : []), ...child.all(name)] : []); }
}

async function countryHarness(record = {}) {
  const harness = await copyHarness();
  const {context} = harness;
  context.document.createElement = tag => new CountryElement(tag);
  context.document.querySelector('#editor').open = true;
  const sourceList = new CountryElement('div');
  let sourceIds = ['one'];
  sourceList.querySelectorAll = () => sourceIds.map(value => ({value}));
  context.sourceList = sourceList;
  context.record = record;
  const form = vm.runInContext('createCountryFilter(sourceList, record)', context);
  return {...harness, form, sources: sourceList, setSources(ids) {sourceIds = ids;} };
}

test('country filter defaults to all, shows selectable tags with counts and preserves selections when disabled or absent', async () => {
  const h = await countryHarness();
  let requests = 0;
  h.context.api = async (_path, _method, body) => {
    requests++;
    assert.deepEqual(JSON.parse(JSON.stringify(body)), {sourceIds:['one']});
    return {countries:[{code:'US',name:'美国',flag:'🇺🇸',count:2}], catalog:[{code:'US',name:'美国',flag:'🇺🇸'}],stale:false};
  };
  const toggle = h.form.all('customCountries')[0];
  assert.equal(toggle.checked,false);
  assert.equal(requests,0);
  toggle.checked = true;
  await toggle.change();
  let us = h.form.all('countryCodes')[0];
  assert.equal(us.value,'US');
  assert.equal(us.checked,false);
  us.checked = true; await us.change();
  toggle.checked = false; await toggle.change();
  assert.equal(h.form.all('countryCodes')[0].checked,true);
  assert.equal(requests,1);
  toggle.checked = true; await toggle.change();
  h.context.api = async () => ({countries:[],catalog:[{code:'US',name:'美国',flag:'🇺🇸'}]});
  h.setSources(['two']); await h.sources.change();
  us = h.form.all('countryCodes')[0];
  assert.equal(us.checked,true);
  assert.equal(us.value,'US');
  assert.match(JSON.stringify(h.form),/暂无节点/);
});

test('country filter ignores late choices after source changes, closing or changing the editor', async () => {
  for (const change of ['source','close','editor']) {
    const h = await countryHarness();
    const waiting = [];
    h.context.api = () => new Promise(resolve => waiting.push(resolve));
    const toggle = h.form.all('customCountries')[0]; toggle.checked = true;
    const first = toggle.change();
    if (change === 'source') {
      h.setSources(['two']);
      const second = h.sources.change();
      waiting[1]({countries:[{code:'JP',name:'日本',flag:'🇯🇵',count:1}],catalog:[]});
      await second;
    } else if (change === 'close') h.elements.get('#editor').open = false;
    else vm.runInContext('state.editing = {resource:"subscriptions",id:"new"}',h.context);
    waiting[0]({countries:[{code:'US',name:'美国',flag:'🇺🇸',count:1}],catalog:[]});
    await first;
    assert.ok(h.form.all('countryCodes').every(input => input.value !== 'US'));
  }
});

test('editing country filter restores the whitelist and exposes retryable source errors', async () => {
  const h = await countryHarness({customCountries:false,countryCodes:['OTHER']});
  h.context.api = async () => {throw Error('请先手动更新');};
  const toggle = h.form.all('customCountries')[0]; toggle.checked = true;
  await toggle.change();
  assert.match(JSON.stringify(h.form),/请先手动更新/);
  assert.equal(h.form.all('countryCodes')[0].checked,true);
});

test('clipboard fallback respects navigation/logout and still opens on the originating authenticated page', async () => {
  for (const change of ['state.navigation += 1;', 'state.authenticated = false;', '']) {
    const { context, elements, denyClipboard } = await copyHarness();
    const copying = context.copyLink({ key: 'test-key' });
    vm.runInContext(change, context);
    denyClipboard();
    await copying;
    const dialog = elements.get('#copy-dialog');
    if (change) assert.ok(!dialog?.open, 'A stale clipboard failure must not open a dialog');
    else {
      assert.equal(dialog.open, true);
      assert.equal(elements.get('#copy-url').value, 'https://admin.example/sub?key=test-key');
      assert.equal(elements.get('#copy-url').selected, true);
    }
  }
});

test('late unauthorized call-history responses cannot log out a newer session', async () => {
  const { context } = await copyHarness();
  let respond;
  context.fetch = () => new Promise(resolve => { respond = resolve; });
  vm.runInContext('state.csrf = "old-session"; state.authenticated = true;', context);
  const request = context.requestApi('/subscriptions/test/calls');
  vm.runInContext('state.csrf = "new-session"; state.authenticated = true; state.navigation += 1;', context);
  respond({ ok: false, status: 401, json: async () => ({ error: '请先登录' }) });
  await assert.rejects(request, /请先登录/);
  assert.equal(vm.runInContext('state.authenticated', context), true);
  assert.equal(vm.runInContext('state.csrf', context), 'new-session');
});

test('a delayed close event cannot clear a newly reopened call-history view', async () => {
  const { context, elements } = await copyHarness();
  const dialog = elements.get('#calls-dialog');
  vm.runInContext('state.calls = { id: "new-view" };', context);
  dialog.open = true;
  dialog.listeners.close();
  assert.equal(vm.runInContext('state.calls?.id', context), 'new-view');
});

test('notification settings populate saved channels and submit both optional URLs and signing secrets', async () => {
  const { context, elements } = await copyHarness();
  vm.runInContext('state.tab = "notifications";', context);
  const settings = { dingtalk: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: 'SEC-test', mention: '13800138000' }, feishu: { url: '', secret: '', mention: 'ou_member123' } };
  const requests = [];
  context.fetch = async (path, init) => {
    requests.push({ path, init });
    return { ok: true, json: async () => settings };
  };
  await context.loadNotificationSettings();
  assert.equal(elements.get('#dingtalk-url').value, settings.dingtalk.url);
  assert.equal(elements.get('#dingtalk-secret').value, 'SEC-test');
  assert.equal(elements.get('#feishu-url').value, '');
  assert.equal(elements.get('#dingtalk-mention').value, '13800138000');
  assert.equal(elements.get('#feishu-mention').value, 'ou_member123');
  assert.equal(elements.get('#notification-fields').disabled, false);
  elements.get('#dingtalk-url').value = '';
  elements.get('#dingtalk-secret').value = '';
  await elements.get('#notification-form').listeners.submit({ preventDefault() {} });
  assert.equal(requests[1].path, '/api/notifications');
  assert.equal(requests[1].init.method, 'PUT');
  assert.deepEqual(JSON.parse(requests[1].init.body), { dingtalk: { url: '', secret: '', mention: '13800138000' }, feishu: { url: '', secret: '', mention: 'ou_member123' } });
  assert.match(elements.get('#notification-status').textContent, /已保存/);
});

test('late notification settings cannot overwrite fields after navigation', async () => {
  const { context, elements } = await copyHarness();
  vm.runInContext('state.tab = "notifications";', context);
  let respond;
  context.fetch = () => new Promise(resolve => { respond = resolve; });
  const loading = context.loadNotificationSettings();
  vm.runInContext('state.navigation += 1;', context);
  respond({ ok: true, json: async () => ({ dingtalk: { url: 'stale-secret', secret: '' }, feishu: { url: '', secret: '' } }) });
  await loading;
  assert.ok(!elements.has('#dingtalk-url'));
});
