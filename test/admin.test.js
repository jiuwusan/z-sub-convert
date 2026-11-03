'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { createApp } = require('../server');
const YAML = require('yaml');
const http = require('node:http');

async function fixture(t, dataDir, upstreamHeaders = {}, upstreamOverride) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'managed-api-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  let upstreamCalls = 0;
  const upstreamBody = '\uFEFF# provider result\r\ndns: {enable: true}\r\nproxies:\r\n  - name: US test\r\n    type: ss\r\n    server: test.example\r\n    port: 443\r\nproxy-groups: []\r\nrules: ["MATCH,DIRECT"]\r\n';
  const app = createApp({ dataDir, now: () => 1793155200123, resetKey: 'this-boot-key', logger: { error() {} }, fetchImpl: async url => { upstreamCalls++; return new Response(typeof upstreamOverride === 'function' ? upstreamOverride(url) : upstreamOverride ?? upstreamBody, { headers: upstreamHeaders }); } });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie;
  let csrf;
  async function request(path, method = 'GET', body, headers = {}) {
    return fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  }
  async function login() {
    const result = await request('/api/login', 'POST', { username: 'admin', password: 'password123' });
    assert.equal(result.status, 200);
    cookie = result.headers.get('set-cookie').split(';')[0];
    csrf = (await result.json()).csrf;
    assert.match(result.headers.get('set-cookie'), /HttpOnly/);
    return { cookie, csrf };
  }
  return { app, base, dataDir, request, login, upstreamBody, upstreamCalls: () => upstreamCalls };
}

test('initializes without key, protects management with auth/CSRF and supports complete subscription CRUD', async t => {
  const f = await fixture(t);
  let response = await f.request('/api/status');
  assert.equal((await response.json()).initialized, false);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' })).status, 201);
  assert.equal((await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' })).status, 409);
  const session = await f.login();
  assert.equal((await f.request('/api/sources', 'POST', { name: '来源', url: 'https://test.test/?token=secret' }, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.request('/api/sources', 'POST', { name: '来源', url: 'https://test.test' }, { origin: 'https://evil.example' })).status, 403);
  response = await f.request('/api/sources', 'POST', { name: '来源', url: 'https://test.test/?token=secret' });
  assert.equal(response.status, 201);
  const source = await response.json();
  assert.equal((await fetch(`${f.base}/api/sources/${source.id}/preview`)).status, 401);
  assert.equal((await (await f.request(`/api/sources/${source.id}/preview`)).json()).content, null);
  assert.equal(f.upstreamCalls(), 0);
  const state = await (await f.request('/api/state')).json();
  assert.doesNotMatch(JSON.stringify(state), /secret/);
  assert.doesNotMatch(JSON.stringify(state), /hash|salt/);
  response = await f.request('/api/subscriptions', 'POST', { name: '测试订阅', sourceIds: [source.id], baseId: state.bases[0].id, nameserverIds: state.nameservers.map(row => row.id), templateId: state.templates[0].id });
  assert.equal(response.status, 201);
  const sub = await response.json();
  assert.equal((await fetch(`${f.base}/sub?key=${sub.key}`, { method: 'HEAD' })).status, 200);
  assert.equal(f.upstreamCalls(), 0);
  response = await fetch(`${f.base}/sub?key=${sub.key}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /美国/);
  const preview = await f.request(`/api/sources/${source.id}/preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  const previewData = await preview.json();
  assert.equal(previewData.proxyCount, 1);
  assert.match(previewData.content, /US test/);
  assert.equal(previewData.content, f.upstreamBody);
  assert.equal(f.upstreamCalls(), 1);
  assert.equal((await f.request(`/api/sources/${source.id}/refresh`, 'POST', {})).status, 200);
  assert.equal((await (await f.request('/api/sources/refresh-all', 'POST', {})).json()).results.length, 1);
  assert.equal((await f.request(`/api/subscriptions/${sub.id}/refresh`, 'POST', {})).status, 404);
  assert.equal((await f.request('/api/refresh-all', 'POST', {})).status, 404);
  assert.equal((await f.request(`/api/sources/${source.id}`)).status, 200);
  assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { name: '改名', sourceIds: [source.id], baseId: state.bases[0].id, nameserverIds: state.nameservers.map(row => row.id), templateId: state.templates[0].id })).status, 200);
  assert.equal((await f.request('/api/reset', 'POST', { key: 'wrong', username: 'new-admin', password: 'password123' })).status, 403);
  assert.equal((await f.request('/api/reset', 'POST', { key: 'this-boot-key', username: 'new-admin', password: 'password123' })).status, 200);
  assert.equal((await fetch(f.base + '/api/state', { headers: { cookie: session.cookie } })).status, 401);
  assert.equal((await fetch(`${f.base}/sub?key=${sub.key}`)).status, 200);
  const reopened = await fixture(t, f.dataDir);
  assert.equal((await (await reopened.request('/api/status')).json()).initialized, true);
  assert.equal((await fetch(`${reopened.base}/sub?key=${sub.key}`)).status, 200);
});

test('rejects invalid JSON and oversized requests and throttles login attempts', async t => {
  const f = await fixture(t);
  let result = await fetch(f.base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(result.status, 400);
  result = await fetch(f.base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024 + 1) }) });
  assert.equal(result.status, 413);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' });
  for (let i = 0; i < 10; i++) await f.request('/api/login', 'POST', { username: 'admin', password: 'bad' });
  assert.equal((await f.request('/api/login', 'POST', { username: 'admin', password: 'bad' })).status, 429);
  assert.equal((await fetch(f.base + '/sub?key=missing')).status, 404);
});

test('webhook settings and test delivery require authentication and CSRF and integrate with source refresh', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/notifications')).status, 401);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' });
  await f.login();
  const input = { dingtalk: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: '' }, feishu: { url: '', secret: '' } };
  assert.equal((await f.request('/api/notifications', 'PUT', input, { 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await f.request('/api/notifications', 'PUT', input)).status, 200);
  assert.deepEqual(await (await f.request('/api/notifications')).json(), input);
  const context = await f.app.ready;
  const deliveries = [];
  context.notifications.fetch = async (_url, init) => { deliveries.push(JSON.parse(init.body)); return new Response('{"errcode":0}'); };
  assert.equal((await f.request('/api/notifications/test/dingtalk', 'POST', {})).status, 200);
  assert.equal((await f.request('/api/notifications/test/feishu', 'POST', {})).status, 400);
  assert.equal((await f.request('/api/notifications/test/unknown', 'POST', {})).status, 400);
  assert.equal(deliveries.length, 1);
  const source = await (await f.request('/api/sources', 'POST', { name: '来源', url: 'https://provider.example/sub' })).json();
  context.managed.options.fetchImpl = async () => new Response(f.upstreamBody, { headers: { 'subscription-userinfo': 'total=100;upload=0;download=0' } });
  assert.equal((await f.request(`/api/sources/${source.id}/refresh`, 'POST', {})).status, 200);
  await context.notifications.check();
  assert.equal(deliveries.length, 2);
  assert.equal((await f.request(`/api/sources/${source.id}/refresh`, 'POST', {})).status, 200);
  await context.notifications.check();
  assert.equal(deliveries.length, 3, 'each successful low-traffic source update sends another alert');
  await context.notifications.check();
  assert.equal(deliveries.length, 3, 'checking an unchanged cache does not repeat traffic alerts');
  const state = await (await f.request('/api/state')).json();
  assert.ok(!JSON.stringify(state).includes('access_token'));
});

test('source website is optional, validated, persisted and editable without invalidating cache', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' });
  await f.login();
  const input = { name: '来源', url: 'https://provider.example/sub' };
  const created = await f.request('/api/sources', 'POST', { ...input, website: ' https://provider.example/home#plans ' });
  assert.equal(created.status, 201);
  const source = await created.json();
  assert.equal(source.website, 'https://provider.example/home#plans');
  const path = `/api/sources/${source.id}`;
  await f.request(`${path}/refresh`, 'POST', {});
  for (const website of ['https://provider.example/new', '', '   ']) {
    const response = await f.request(path, 'PATCH', { ...input, website });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).website, website.trim());
    assert.equal((await (await f.request(path)).json()).website, website.trim());
    const state = await (await f.request('/api/state')).json();
    assert.equal(state.sources[0].website, website.trim());
    assert.equal(state.sources[0].cacheStatus, 'valid');
  }
  for (const website of ['invalid', 'javascript:alert(1)', 'ftp://provider.example', 'https://user:pass@provider.example', 123, 'https://provider.example/' + 'a'.repeat(8192)]) {
    assert.equal((await f.request(path, 'PATCH', { ...input, website })).status, 400);
  }
  assert.equal((await f.request('/api/sources', 'POST', input)).status, 201);
  await f.request(path, 'PATCH', { ...input, website: 'https://provider.example' });
  await f.request(path, 'PATCH', input);
  const restarted = await fixture(t, f.dataDir);
  await restarted.login();
  assert.equal((await (await restarted.request(path)).json()).website, 'https://provider.example');
  assert.equal(f.upstreamCalls(), 1);
});

test('downloads full source caches and generated subscriptions with name-timestamp filenames', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' });
  await f.login();
  const source = await (await f.request('/api/sources', 'POST', { name: '第三方来源', url: 'https://provider.example/sub' })).json();
  const sourcePath = `/api/sources/${source.id}/download`;
  assert.equal((await fetch(f.base + sourcePath)).status, 401);
  const empty = await f.request(sourcePath);
  assert.equal(empty.status, 409);
  assert.match((await empty.json()).error, /更新/);
  assert.equal(f.upstreamCalls(), 0);
  await f.request(`/api/sources/${source.id}/refresh`, 'POST', {});
  const original = await f.request(sourcePath);
  assert.equal(original.status, 200);
  assert.equal(original.headers.get('cache-control'), 'no-store');
  assert.match(original.headers.get('content-type'), /yaml/);
  const sourceFilename = decodeURIComponent(original.headers.get('content-disposition').split("filename*=UTF-8''")[1]);
  assert.equal(sourceFilename, '第三方来源-1793155200123.yaml');
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), Buffer.from(f.upstreamBody));
  const state = await (await f.request('/api/state')).json();
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '系统订阅', sourceIds: [source.id], baseId: state.bases[0].id, nameserverIds: state.nameservers.map(row => row.id), templateId: state.templates[0].id })).json();
  const subPath = `/api/subscriptions/${sub.id}/download`;
  assert.equal((await fetch(f.base + subPath)).status, 401);
  const generated = await f.request(subPath);
  assert.equal(generated.status, 200);
  assert.equal(decodeURIComponent(generated.headers.get('content-disposition').split("filename*=UTF-8''")[1]), '系统订阅-1793155200123.yaml');
  assert.match(await generated.text(), /美国/);
  const publicSub = await fetch(`${f.base}/sub?key=${sub.key}`);
  assert.equal(decodeURIComponent(publicSub.headers.get('content-disposition').split("filename*=UTF-8''")[1]), '系统订阅-1793155200123.yaml');
  assert.equal(f.upstreamCalls(), 1);
  const untouched = await (await f.request('/api/sources', 'POST', { name: '未更新来源', url: 'https://provider.example/unfetched' })).json();
  const lazy = await (await f.request('/api/subscriptions', 'POST', { name: '尚未访问', sourceIds: [untouched.id], baseId: state.bases[0].id, nameserverIds: state.nameservers.map(row => row.id), templateId: state.templates[0].id })).json();
  for (const path of [sourcePath, subPath, `/api/subscriptions/${lazy.id}/download`, `/sub?key=${lazy.key}`]) {
    const result = await f.request(path, 'HEAD');
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '');
    assert.match(result.headers.get('content-disposition'), /attachment/);
  }
  assert.equal(f.upstreamCalls(), 1);
  const context = await f.app.ready;
  const legacyFile = 'source-cache-legacy.json';
  await writeFile(join(f.dataDir, legacyFile), JSON.stringify([{ name: 'US old', type: 'ss', server: 'old.example', port: 443 }]));
  await context.store.update(data => {
    const record = data.sources.find(row => row.id === untouched.id);
    record.cache = { file: legacyFile, revision: record.revision }; record.lastSuccessAt = 1793155200123;
  });
  const legacyDownload = await f.request(`/api/sources/${untouched.id}/download`);
  assert.equal(legacyDownload.status, 409);
  assert.match((await legacyDownload.json()).error, /旧缓存/);
  assert.equal(f.upstreamCalls(), 1);
});

test('public and authenticated downloads expose cached package headers on GET and HEAD without extra fetches', async t => {
  const headers = { 'subscription-userinfo': 'upload=1; download=2; total=100; expire=1800000000' };
  const f = await fixture(t, undefined, headers);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' });
  await f.login();
  const createSource = async name => (await f.request('/api/sources', 'POST', { name, url: `https://provider.example/${name}` })).json();
  const first = await createSource('first'); const second = await createSource('second'); const empty = await createSource('empty');
  const state = await (await f.request('/api/state')).json();
  const createSub = async sourceIds => (await f.request('/api/subscriptions', 'POST', { name: '套餐订阅', sourceIds, baseId: state.bases[0].id, nameserverIds: state.nameservers.map(row => row.id), templateId: state.templates[0].id })).json();
  const sub = await createSub([first.id, second.id, first.id, empty.id]);
  const head = await f.request(`/sub?key=${sub.key}`, 'HEAD');
  assert.equal(head.headers.get('subscription-userinfo'), null);
  assert.equal(f.upstreamCalls(), 0);
  await f.request(`/api/sources/${first.id}/refresh`, 'POST', {});
  headers['subscription-userinfo'] = 'upload=3; download=4; total=200; expire=1900000000';
  await f.request(`/api/sources/${second.id}/refresh`, 'POST', {});
  delete headers['subscription-userinfo'];
  await f.request(`/api/sources/${empty.id}/refresh`, 'POST', {});
  const expected = 'upload=4; download=6; total=300; expire=1900000000';
  for (const method of ['GET', 'HEAD']) {
    for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
      const result = await f.request(path, method);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('subscription-userinfo'), expected);
      assert.match(result.headers.get('content-disposition'), /1793155200123/);
      if (method === 'HEAD') assert.equal(await result.text(), '');
    }
    const source = await f.request(`/api/sources/${first.id}/download`, method);
    assert.equal(source.headers.get('subscription-userinfo'), 'upload=1; download=2; total=100; expire=1800000000');
  }
  assert.equal(f.upstreamCalls(), 3);
  const current = await (await f.request('/api/state')).json();
  assert.deepEqual(current.subscriptions[0].packageCoverage, { available: 2, total: 3 });
  assert.equal(current.sources[0].userInfo.total, '100');
  assert.doesNotMatch(JSON.stringify(current), /source-cache-/);
  await f.request(`/api/sources/${first.id}/refresh`, 'POST', {});
  await f.request(`/api/sources/${second.id}/refresh`, 'POST', {});
  assert.equal((await f.request(`/sub?key=${sub.key}`)).headers.get('subscription-userinfo'), null);
});

test('manages three independent parts and uses selected manual DNS as source-mode fallback', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const create = async (resource, body) => {
    const response = await f.request(`/api/${resource}`, 'POST', body);
    assert.equal(response.status, 201);
    return response.json();
  };
  const base = await create('bases', { name: '基础', content: 'mixed-port: 8899\ndns: {enable: true, nameserver: [ignored]}' });
  const ns = await create('nameservers', { name: '备用', address: 'https://dns.google/dns-query#🚀 节点选择' });
  const state = await (await f.request('/api/state')).json();
  const ruleContent = (await (await f.request(`/api/templates/${state.templates[0].id}`)).json()).content;
  const rule = await create('templates', { name: '规则', content: ruleContent });
  assert.equal((await f.request('/api/templates', 'POST', { name: '坏规则', content: 'proxies: []\nproxy-groups: []\nrules: []' })).status, 400);
  assert.equal((await f.request('/api/bases', 'POST', { name: '语法错误', content: '[' })).status, 400);
  const source = await create('sources', { name: '来源', url: 'https://provider.example/sub' });
  const sub = await create('subscriptions', { name: '拆分订阅', baseId: base.id, templateId: rule.id, sourceIds: [source.id], useSourceNameservers: true, nameserverIds: [ns.id] });
  assert.equal(f.upstreamCalls(), 0);
  const result = YAML.parse(await (await f.request(`/sub?key=${sub.key}`)).text());
  assert.equal(result['mixed-port'], 8899);
  assert.deepEqual(result.dns.nameserver, [ns.address]);
  assert.match(result.proxies[0].name, /美国/);
  for (const [resource,id] of [['bases', base.id], ['nameservers', ns.id], ['templates', rule.id]]) {
    assert.equal((await f.request(`/api/${resource}/${id}`, 'DELETE')).status, 409);
  }
  const edited = await f.request(`/api/nameservers/${ns.id}`, 'PATCH', { ...ns, address: '1.1.1.1' });
  assert.equal(edited.status, 200);
  assert.deepEqual(YAML.parse(await (await f.request(`/sub?key=${sub.key}`)).text()).dns.nameserver, ['1.1.1.1']);
  assert.equal(f.upstreamCalls(), 1);
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, nameserverIds: [] });
  const missing = await f.request(`/sub?key=${sub.key}`);
  assert.equal(missing.status, 422); assert.match((await missing.json()).error, /nameserver/);
});

test('downloads base and rule template originals with authentication and named timestamps', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const ruleSeed = (await (await f.request(`/api/templates/${state.templates[0].id}`)).json()).content;
  for (const [resource, name, content] of [
    ['bases', '基础模板备份', '\uFEFF# base comment\r\nport: 7890\r\n'],
    ['templates', '规则模板备份', '\uFEFF# rule comment\r\n' + ruleSeed.replace(/\r?\n/g, '\r\n')]
  ]) {
    const record = await (await f.request(`/api/${resource}`, 'POST', { name, content })).json();
    const path = `/api/${resource}/${record.id}/download`;
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await fetch(f.base + path, { method })).status, 401);
      const result = await f.request(path, method);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('content-type'), /yaml/);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(decodeURIComponent(result.headers.get('content-disposition').split("filename*=UTF-8''")[1]), `${name}-1793155200123.yaml`);
      assert.equal(result.headers.get('subscription-userinfo'), null);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(content));
    }
    const latest = '# edited\n' + content.replace(/^\uFEFF/, '');
    await f.request(`/api/${resource}/${record.id}`, 'PATCH', { name, content: latest });
    assert.deepEqual(Buffer.from(await (await f.request(path)).arrayBuffer()), Buffer.from(latest));
    assert.equal((await f.request(`/api/${resource}/missing/download`)).status, 404);
  }
  assert.equal((await f.request(`/api/nameservers/${state.nameservers[0].id}/download`)).status, 404);
  assert.equal(f.upstreamCalls(), 0);
});

test('records public GET/HEAD successes and failures for 3 days while excluding admin downloads', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const source = await (await f.request('/api/sources', 'POST', { name: '来源', url: 'https://provider.example/?token=private-token' })).json();
  const selection = { sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) };
  const sub = await (await f.request('/api/subscriptions', 'POST', { ...selection, name: '调用测试' })).json();
  const path = `/api/subscriptions/${sub.id}/calls`;
  assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await (await f.request(path)).json()).total, 0);
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${f.base}/sub?key=${sub.key}`, { method, headers: { 'user-agent': 'clash-test/v1', 'x-forwarded-for': '203.0.113.99' } });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  let calls = await (await f.request(path)).json();
  assert.equal(calls.total, 2); assert.equal(calls.records[0].method, 'HEAD');
  for (const row of calls.records) {
    assert.equal(row.status, 200); assert.equal(row.userAgent, 'clash-test/v1'); assert.equal(row.ip, '127.0.0.1');
    assert.ok(row.durationMs >= 0); assert.equal(row.error, null); assert.equal(row.at, 1793155200123);
  }
  for (const method of ['GET', 'HEAD']) {
    const download = await f.request(`/api/subscriptions/${sub.id}/download`, method);
    assert.equal(download.status, 200); await download.arrayBuffer();
  }
  assert.equal((await (await f.request(path)).json()).total, 2);
  assert.equal((await f.request('/sub?key=invalid')).status, 404);
  assert.equal((await (await f.request(path)).json()).total, 2);
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...selection, name: '调用测试', useSourceNameservers: true, nameserverIds: [] });
  assert.equal((await f.request(`/sub?key=${sub.key}`)).status, 422);
  calls = await (await f.request(path)).json();
  assert.equal(calls.records[0].status, 422); assert.match(calls.records[0].error, /nameserver/);
  const context = await f.app.ready;
  context.managed.options.fetchImpl = async () => new Response('', { status: 503 });
  const failed = await (await f.request('/api/sources', 'POST', { name: '失败来源', url: 'https://fail.example/?token=other-private-token' })).json();
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...selection, sourceIds: [failed.id], name: '调用测试' });
  assert.equal((await f.request(`/sub?key=${sub.key}`, 'HEAD')).status, 200, 'HEAD still does not fetch upstream');
  assert.equal((await f.request(`/sub?key=${sub.key}`)).status, 502);
  calls = await (await f.request(path)).json();
  assert.equal(calls.records[0].status, 502); assert.match(calls.records[0].error, /503/);
  assert.equal(calls.total, 5);
  assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${sub.key}|private-token|provider.example|fail.example|"body"|"url"`));
  assert.equal((await f.request(path + '?page=0')).status, 400);
  assert.equal((await f.request('/api/subscriptions/missing/calls')).status, 404);
  assert.equal((await f.request(`/api/sources/${source.id}/calls`)).status, 404);
  await context.callRecords.append(sub.id, { at: 1793155200123 - 72 * 60 * 60 * 1000 - 1, method: 'GET', status: 200 });
  assert.equal((await (await f.request(path)).json()).total, 5);
  await f.request(`/api/subscriptions/${sub.id}`, 'DELETE');
  assert.equal((await f.request(path)).status, 404);
  assert.equal((await context.callRecords.list(sub.id)).total, 0);
});

test('call-record write failures do not fail public subscriptions', async t => {
  const f = await fixture(t);
  const context = await f.app.ready;
  const source = await context.managed.save('sources', { name: '来源', url: 'https://provider.example/sub' });
  const state = context.store.read();
  const sub = await context.managed.save('subscriptions', { name: '记录失败', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) });
  const directory = context.callRecords.directory;
  const blocked = join(f.dataDir, 'blocked-call-records'); await writeFile(blocked, 'blocked');
  context.callRecords.directory = blocked;
  const result = await f.request(`/sub?key=${sub.key}`);
  assert.equal(result.status, 200); assert.match(await result.text(), /美国/);
  context.callRecords.directory = directory;
});

test('slow call-record storage never holds a public response and aborted processing records 499', async t => {
  const f = await fixture(t);
  const context = await f.app.ready;
  const source = await context.managed.save('sources', { name: '来源', url: 'https://provider.example/sub' });
  const state = context.store.read();
  const sub = await context.managed.save('subscriptions', { name: '中断测试', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) });
  let releaseQueue;
  const blocking = context.callRecords.enqueue(sub.id, () => new Promise(resolve => { releaseQueue = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const response = f.request(`/sub?key=${sub.key}`, 'HEAD');
  const arrived = await Promise.race([response.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 150))]);
  releaseQueue(); await blocking; await response;
  assert.equal(arrived, true, 'logging must not delay the subscription response');
  let upstreamStarted, releaseUpstream;
  const started = new Promise(resolve => { upstreamStarted = resolve; });
  context.managed.options.fetchImpl = async () => { upstreamStarted(); await new Promise(resolve => { releaseUpstream = resolve; }); return new Response(f.upstreamBody); };
  const request = http.get(`${f.base}/sub?key=${sub.key}`);
  request.on('error', () => {});
  await started;
  const closed = new Promise(resolve => request.once('close', resolve)); request.destroy(); await closed;
  releaseUpstream();
  let calls;
  for (let i = 0; i < 50; i++) {
    calls = await context.callRecords.list(sub.id);
    if (calls.records.some(row => row.status === 499)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(calls.records.some(row => row.status === 499 && /断开/.test(row.error)));
});

test('records source cache refreshes with triggers, failures and deduplicated inflight updates', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const context = await f.app.ready;
  const state = context.store.read();
  const source = await context.managed.save('sources', { name: '来源', url: 'https://provider.example/?token=private-source-token', userAgent: 'custom-agent' });
  const path = `/api/sources/${source.id}/updates`;
  assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal((await f.request(path)).status, 200);
  assert.equal((await (await f.request(path)).json()).total, 0);
  const sub = await context.managed.save('subscriptions', { name: '系统', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) });
  const result = await f.request(`/sub?key=${sub.key}`); await result.arrayBuffer();
  let records = await (await f.request(path)).json();
  assert.equal(records.total, 1); assert.equal(records.records[0].trigger, 'on-demand');
  assert.equal(records.records[0].userAgent, 'custom-agent'); assert.equal(records.records[0].status, 200);
  for (const p of [`/sub?key=${sub.key}`, `/api/sources/${source.id}/preview`, `/api/sources/${source.id}/download`]) await (await f.request(p)).arrayBuffer();
  assert.equal((await (await f.request(path)).json()).total, 1, 'cache reads do not count as refreshes');
  await f.request(`/api/sources/${source.id}/refresh`, 'POST', {});
  await f.request('/api/sources/refresh-all', 'POST', {});
  records = await (await f.request(path)).json();
  assert.deepEqual(records.records.map(row => row.trigger), ['all', 'manual', 'on-demand']);
  let started, release;
  const pending = new Promise(resolve => { started = resolve; });
  context.managed.options.fetchImpl = async () => { started(); await new Promise(resolve => { release = resolve; }); return new Response(f.upstreamBody); };
  const first = context.managed.refresh(source.id);
  await pending;
  const second = context.managed.refresh(source.id);
  release(); await Promise.all([first, second]);
  assert.equal((await (await f.request(path)).json()).total, 4, 'merged refreshes create one record');
  const successAt = context.managed.get('sources', source.id).lastSuccessAt;
  context.managed.options.fetchImpl = async () => new Response('', { status: 503 });
  assert.equal((await f.request(`/api/sources/${source.id}/refresh`, 'POST', {})).status, 502);
  records = await (await f.request(path)).json();
  assert.equal(records.total, 5); assert.equal(records.records[0].status, 502); assert.match(records.records[0].error, /503/);
  assert.equal(context.managed.get('sources', source.id).lastSuccessAt, successAt);
  assert.doesNotMatch(JSON.stringify(records), /private-source-token|provider.example|"url"|"body"/);
  const callHistory = await context.callRecords.list(sub.id);
  assert.equal(callHistory.total, 2, 'source refreshes do not create system-call records');
  assert.equal((await f.request(path + '?page=0')).status, 400);
  assert.equal((await f.request(`/api/subscriptions/${sub.id}/updates`)).status, 404);
  await f.request(`/api/subscriptions/${sub.id}`, 'DELETE');
  await f.request(`/api/sources/${source.id}`, 'DELETE');
  assert.equal((await f.request(path)).status, 404);
  assert.equal((await context.sourceRecords.list(source.id)).total, 0);
});

test('source refresh records preserve the attempted UA after configuration races and tolerate journal failures', async t => {
  const f = await fixture(t);
  const context = await f.app.ready;
  const source = await context.managed.save('sources', { name: '来源', url: 'https://provider.example/sub', userAgent: 'old-agent' });
  let started, release;
  const pending = new Promise(resolve => { started = resolve; });
  context.managed.options.fetchImpl = async () => { started(); await new Promise(resolve => { release = resolve; }); return new Response(f.upstreamBody); };
  const refreshing = context.managed.refresh(source.id);
  await pending;
  await context.managed.save('sources', { ...source, userAgent: 'new-agent' }, source.id);
  release(); await assert.rejects(refreshing, { statusCode: 409 });
  const records = await context.sourceRecords.list(source.id);
  assert.equal(records.records[0].userAgent, 'old-agent');
  assert.equal(records.records[0].status, 409);
  assert.equal(context.managed.list().sources[0].cacheStatus, 'empty');
  context.managed.options.fetchImpl = async () => new Response(f.upstreamBody);
  const directory = context.sourceRecords.directory;
  const blocked = join(f.dataDir, 'blocked-source-records'); await writeFile(blocked, 'blocked');
  context.sourceRecords.directory = blocked;
  assert.equal((await context.managed.refresh(source.id)).ok, true);
  await assert.rejects(context.sourceRecords.list(source.id));
  context.sourceRecords.directory = directory;
  assert.equal(context.managed.list().sources[0].cacheStatus, 'valid');
  assert.equal((await context.sourceRecords.list(source.id)).total, 1);
});

test('manual update mode is configurable through source APIs and never fetches on subscription access', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const created = await f.request('/api/sources', 'POST', { name: '仅手动来源', url: 'https://provider.example/sub', updateMode: 'manual' });
  const source = await created.json();
  assert.equal(source.updateMode, 'manual');
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '仅手动订阅', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) })).json();
  const empty = await f.request(`/sub?key=${sub.key}`);
  assert.equal(empty.status, 409); assert.match((await empty.json()).error, /仅手动更新/);
  assert.equal(f.upstreamCalls(), 0);
  assert.equal((await (await f.request(`/api/sources/${source.id}/updates`)).json()).total, 0);
  assert.equal((await f.request(`/api/sources/${source.id}/refresh`, 'POST', {})).status, 200);
  assert.equal(f.upstreamCalls(), 1);
  const context = await f.app.ready;
  context.managed.now = () => 1793155200123 + 2 * 60 * 60 * 1000;
  const cached = await f.request(`/sub?key=${sub.key}`);
  assert.equal(cached.status, 200); assert.equal(cached.headers.get('x-subscription-cache'), 'stale');
  assert.match(await cached.text(), /美国/); assert.equal(f.upstreamCalls(), 1);
  assert.equal((await (await f.request('/api/state')).json()).sources[0].updateMode, 'manual');
  await f.request(`/api/sources/${source.id}`, 'PATCH', { ...source, updateMode: 'auto' });
  const automatic = await f.request(`/sub?key=${sub.key}`); await automatic.arrayBuffer();
  assert.equal(f.upstreamCalls(), 2);
  assert.equal((await (await f.request(`/api/sources/${source.id}/updates`)).json()).records[0].trigger, 'on-demand');
  assert.equal((await f.request('/api/sources', 'POST', { name: '无效模式', url: source.url, updateMode: 'bad' })).status, 400);
});

test('system links and downloads honor the remove-failover option while shared templates stay intact', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const source = await (await f.request('/api/sources', 'POST', { name: '来源', url: 'https://provider.example/sub' })).json();
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '移除故障转移', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id), removeFailover: true })).json();
  assert.equal(sub.removeFailover, true);
  for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
    const result = await f.request(path);
    assert.equal(result.status, 200);
    const body = YAML.parse(await result.text());
    assert.equal(body['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
    assert.deepEqual(body['proxy-groups'].find(group => group.name === '🚀 节点选择').proxies, ['🇺🇸 来源 SS 美国']);
  }
  assert.equal(f.upstreamCalls(), 1);
  const template = await f.request(`/api/templates/${sub.templateId}/download`);
  assert.ok(YAML.parse(await template.text())['proxy-groups'].some(group => group.name === '🔰 故障转移'));
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, removeFailover: false });
  assert.ok(YAML.parse(await (await f.request(`/sub?key=${sub.key}`)).text())['proxy-groups'].some(group => group.name === '🔰 故障转移'));
  assert.equal(f.upstreamCalls(), 1);
});

test('system links and downloads apply even-first and revert without updating source caches', async t => {
  const upstream = YAML.stringify({ proxies: Array.from({ length: 6 }, (_, i) => ({ name: `US ${i + 1}`, type: 'ss', server: `us-${i + 1}`, port: 443 })) });
  const f = await fixture(t, undefined, {}, upstream);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const source = await (await f.request('/api/sources', 'POST', { name: '来源', url: 'https://provider.example/sub' })).json();
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '偶数前置', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) })).json();
  assert.equal(sub.evenNodesFirst, false);
  const groupNames = async path => {
    const result = await f.request(path);
    assert.equal(result.status, 200);
    return YAML.parse(await result.text())['proxy-groups'].find(group => group.name === '🇺🇸 来源 SS 美国').proxies;
  };
  const original = ['01', '02', '03', '04', '05', '06'].map(n => `🇺🇸 来源 美国 ${n}`);
  assert.deepEqual(await groupNames(`/sub?key=${sub.key}`), original);
  const saved = await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, evenNodesFirst: true });
  assert.equal((await saved.json()).evenNodesFirst, true);
  for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
    assert.deepEqual(await groupNames(path), ['02', '04', '06', '01', '03', '05'].map(n => `🇺🇸 来源 美国 ${n}`));
  }
  assert.equal((await (await f.request('/api/state')).json()).subscriptions[0].evenNodesFirst, true);
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, evenNodesFirst: false });
  assert.deepEqual(await groupNames(`/sub?key=${sub.key}`), original);
  assert.equal(f.upstreamCalls(), 1);
});

test('system links and downloads honor selected DNS sources and empty selection aggregates all', async t => {
  const f = await fixture(t, undefined, {}, url => YAML.stringify({
    dns: { nameserver: [String(url).includes('/two') ? 'https://two.example/dns-query' : 'https://one.example/dns-query'] },
    proxies: [{ name: 'US', type: 'ss', server: 'us.example', port: 443 }]
  }));
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const one = await (await f.request('/api/sources', 'POST', { name: '来源一', url: 'https://provider.example/one' })).json();
  const two = await (await f.request('/api/sources', 'POST', { name: '来源二', url: 'https://provider.example/two' })).json();
  const input = { name: '指定DNS来源', sourceIds: [one.id, two.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id), useSourceNameservers: true, nameserverSourceIds: [two.id] };
  const created = await f.request('/api/subscriptions', 'POST', input);
  assert.equal(created.status, 201);
  const sub = await created.json();
  assert.deepEqual(sub.nameserverSourceIds, [two.id]);
  for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
    const result = await f.request(path);
    assert.equal(result.status, 200);
    const output = YAML.parse(await result.text());
    assert.deepEqual(output.dns.nameserver, ['https://two.example/dns-query']);
    assert.equal(output.proxies.length, 2);
  }
  assert.deepEqual((await (await f.request('/api/state')).json()).subscriptions[0].nameserverSourceIds, [two.id]);
  assert.deepEqual((await (await f.request(`/api/subscriptions/${sub.id}`)).json()).nameserverSourceIds, [two.id]);
  await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...input, nameserverSourceIds: [] });
  const merged = YAML.parse(await (await f.request(`/sub?key=${sub.key}`)).text());
  assert.deepEqual(merged.dns.nameserver, ['https://one.example/dns-query', 'https://two.example/dns-query']);
  assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...input, nameserverSourceIds: ['missing'] })).status, 400);
  assert.equal(f.upstreamCalls(), 2);
});

test('system downloads and public links expose source-scoped country groups in country-first order', async t => {
  const f = await fixture(t, undefined, {}, url => YAML.stringify({ dns: { nameserver: [String(url).includes('/two') ? 'https://b.example/dns-query' : 'https://a.example/dns-query'] }, proxies: [
    { name: 'JP', type: 'ss', server: 'jp.example', port: 443 },
    { name: 'US', type: 'ss', server: 'us.example', port: 443 }
  ] }));
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const one = await (await f.request('/api/sources', 'POST', { name: 'A', url: 'https://provider.example/one' })).json();
  const two = await (await f.request('/api/sources', 'POST', { name: 'B', url: 'https://provider.example/two' })).json();
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '来源国家排序', sourceIds: [one.id, two.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id), useSourceNameservers: true })).json();
  const expected = ['🇺🇸 A SS 美国', '🇺🇸 B SS 美国', '🇯🇵 A SS 日本', '🇯🇵 B SS 日本'];
  for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    const body = YAML.parse(await response.text());
    assert.deepEqual(body['proxy-groups'].find(group => group.name === '🚀 节点选择').proxies, ['🔰 故障转移', ...expected]);
    assert.deepEqual(body['proxy-groups'].find(group => group.name === '🔰 故障转移').proxies, expected);
    assert.deepEqual(body.proxies.map(proxy => proxy.name), ['🇯🇵 A 日本 01', '🇺🇸 A 美国 01', '🇯🇵 B 日本 01', '🇺🇸 B 美国 01']);
    assert.deepEqual(body.dns.nameserver, ['https://a.example/dns-query', 'https://b.example/dns-query']);
  }
  const updated = await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, sourceIds: [two.id, one.id] });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).sourceIds, [two.id, one.id]);
  assert.deepEqual((await (await f.request(`/api/subscriptions/${sub.id}`)).json()).sourceIds, [two.id, one.id]);
  for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
    const output = YAML.parse(await (await f.request(path)).text());
    assert.deepEqual(output['proxy-groups'].find(group => group.name === '🔰 故障转移').proxies, ['🇺🇸 B SS 美国', '🇺🇸 A SS 美国', '🇯🇵 B SS 日本', '🇯🇵 A SS 日本']);
    assert.deepEqual(output.dns.nameserver, ['https://b.example/dns-query', 'https://a.example/dns-query']);
  }
  assert.equal(f.upstreamCalls(), 2);
});

test('system links and downloads apply country group type and test URL while retaining defaults', async t => {
  const f = await fixture(t);
  await f.request('/api/setup', 'POST', { username: 'admin', password: 'password123' }); await f.login();
  const state = await (await f.request('/api/state')).json();
  const source = await (await f.request('/api/sources', 'POST', { name: 'A', url: 'https://provider.example/sub' })).json();
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '分组配置', sourceIds: [source.id], baseId: state.bases[0].id, templateId: state.templates[0].id, nameserverIds: state.nameservers.map(row => row.id) })).json();
  assert.equal(sub.countryGroupType, 'fallback');
  assert.equal(sub.countryTestUrl, 'http://www.gstatic.com/generate_204');
  for (const countryGroupType of ['url-test', 'fallback', 'select', 'load-balance']) {
    const saved = await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, countryGroupType, countryTestUrl: 'https://test.example/check' });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).countryGroupType, countryGroupType);
    for (const path of [`/sub?key=${sub.key}`, `/api/subscriptions/${sub.id}/download`]) {
      const response = await f.request(path);
      assert.equal(response.status, 200);
      const body = YAML.parse(await response.text());
      const group = body['proxy-groups'].find(g => g.name === '🇺🇸 A SS 美国');
      assert.equal(group.type, countryGroupType);
      assert.equal(group.url, countryGroupType === 'select' ? undefined : 'https://test.example/check');
      assert.equal(group.interval, countryGroupType === 'select' ? undefined : 305);
      assert.equal(body['proxy-groups'].find(g => g.name === '🔰 故障转移').type, 'fallback');
    }
  }
  const detail = await (await f.request(`/api/subscriptions/${sub.id}`)).json();
  assert.equal(detail.countryTestUrl, 'https://test.example/check');
  assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, countryGroupType: 'bad' })).status, 400);
  assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, countryTestUrl: 'file:///secret' })).status, 400);
  for (const countryTestUrl of ['https://test.example/a\tb', 'https://test.example/a\0b']) {
    assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { ...sub, countryTestUrl })).status, 400);
  }
  assert.equal(f.upstreamCalls(), 1);
});
