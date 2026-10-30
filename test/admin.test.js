'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { createApp } = require('../server');

async function fixture(t, dataDir, upstreamHeaders = {}) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'managed-api-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  let upstreamCalls = 0;
  const upstreamBody = '\uFEFF# provider result\r\ndns: {enable: true}\r\nproxies:\r\n  - name: US test\r\n    type: ss\r\n    server: test.example\r\n    port: 443\r\nproxy-groups: []\r\nrules: ["MATCH,DIRECT"]\r\n';
  const app = createApp({ dataDir, now: () => 1793155200123, resetKey: 'this-boot-key', logger: { error() {} }, fetchImpl: async () => { upstreamCalls++; return new Response(upstreamBody, { headers: upstreamHeaders }); } });
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
  response = await f.request('/api/subscriptions', 'POST', { name: '测试订阅', sourceIds: [source.id], templateId: state.templates[0].id });
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
  assert.equal((await f.request(`/api/subscriptions/${sub.id}`, 'PATCH', { name: '改名', sourceIds: [source.id], templateId: state.templates[0].id })).status, 200);
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
  const sub = await (await f.request('/api/subscriptions', 'POST', { name: '系统订阅', sourceIds: [source.id], templateId: state.templates[0].id })).json();
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
  const lazy = await (await f.request('/api/subscriptions', 'POST', { name: '尚未访问', sourceIds: [untouched.id], templateId: state.templates[0].id })).json();
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
  const createSub = async sourceIds => (await f.request('/api/subscriptions', 'POST', { name: '套餐订阅', sourceIds, templateId: state.templates[0].id })).json();
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
