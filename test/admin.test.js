'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { once } = require('node:events');
const { createApp } = require('../server');

async function fixture(t, dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'managed-api-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  let upstreamCalls = 0;
  const upstreamBody = '# provider result\r\ndns: {enable: true}\r\nproxies:\r\n  - name: US test\r\n    type: ss\r\n    server: test.example\r\n    port: 443\r\nproxy-groups: []\r\nrules: ["MATCH,DIRECT"]\r\n';
  const app = createApp({ dataDir, resetKey: 'this-boot-key', logger: { error() {} }, fetchImpl: async () => { upstreamCalls++; return new Response(upstreamBody); } });
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
