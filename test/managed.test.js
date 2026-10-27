'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const YAML = require('yaml');
const { Store } = require('../store');
const { Managed, CACHE_MS } = require('../managed');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, templatePath: join(__dirname, '../prds/template.yaml') };
  const store = await Store.open(options);
  let now = 100000;
  let fail = false;
  let hold = null;
  const calls = [];
  const service = new Managed(store, { now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), agent: init.headers['user-agent'] });
    if (hold) await hold;
    if (fail && String(url).includes('two')) return new Response('', { status: 503 });
    return new Response(YAML.stringify({ proxies: [{ name: String(url).includes('two') ? 'JP' : 'US', type: 'ss', server: 'node.example', port: 443 }] }));
  } });
  const one = await service.save('sources', { name: '来源一', url: 'https://source.test/one?token=secret', userAgent: 'custom-agent' });
  const two = await service.save('sources', { name: '来源二', url: 'https://source.test/two' });
  const sub = await service.save('subscriptions', { name: '合并订阅', sourceIds: [one.id, two.id], templateId: store.read().templates[0].id });
  return { store, service, sub, one, two, options, calls, tick: value => { now += value; }, fail: () => { fail = true; }, hold: value => { hold = value; } };
}

test('saves without fetching, masks tokens, merges sources with per-source UA and caches exactly 23 hours', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.service.list().sources), /secret/);
  const first = await f.service.content(f.sub.key);
  assert.equal(YAML.parse(first.body).proxies.length, 2);
  assert.deepEqual(f.calls.map(c => c.agent), ['custom-agent', 'clash-verge/v2.4.5']);
  f.tick(CACHE_MS - 1);
  await f.service.content(f.sub.key);
  assert.equal(f.calls.length, 2);
  f.tick(1);
  await f.service.content(f.sub.key);
  assert.equal(f.calls.length, 4);
  let restartedCalls = 0;
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000 + CACHE_MS, fetchImpl: () => { restartedCalls++; throw Error('must use persisted cache'); } });
  const result = await restarted.content(f.sub.key);
  assert.equal(result.body, first.body);
  assert.equal(restartedCalls, 0);
});

test('treats a managed source URL containing a pipe as one source rather than legacy merge syntax', async t => {
  const f = await fixture(t);
  const source = await f.service.save('sources', { name: '带过滤参数', url: 'https://source.test/one?filter=US|JP' });
  const sub = await f.service.save('subscriptions', { name: '过滤订阅', sourceIds: [source.id], templateId: f.sub.templateId });
  await f.service.content(sub.key);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, source.url);
});

test('refresh failures preserve all old content and success timestamp, while no-cache failure rejects', async t => {
  const f = await fixture(t);
  const first = await f.service.content(f.sub.key);
  const success = f.service.list().subscriptions[0].lastSuccessAt;
  f.fail();
  f.tick(CACHE_MS);
  const fallback = await f.service.content(f.sub.key);
  assert.equal(fallback.body, first.body);
  assert.equal(fallback.stale, true);
  assert.equal(f.service.list().subscriptions[0].lastSuccessAt, success);
  assert.equal(f.service.list().subscriptions[0].lastResult.ok, false);
  const empty = await f.service.save('subscriptions', { name: '无缓存', sourceIds: [f.two.id], templateId: f.sub.templateId });
  await assert.rejects(f.service.content(empty.key));
  const results = await f.service.refreshAll();
  assert.equal(results.length, 2);
  assert.ok(results.every(r => !r.ok));
});

test('coalesces simultaneous requests and rejects outdated in-flight refresh after edits', async t => {
  const f = await fixture(t);
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const first = f.service.content(f.sub.key);
  const second = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.length, 2);
  f.tick(CACHE_MS);
  let unblock;
  f.hold(new Promise(resolve => { unblock = resolve; }));
  const refresh = f.service.refresh(f.sub.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('sources', { ...f.one, userAgent: 'updated-agent' }, f.one.id);
  unblock();
  await assert.rejects(refresh, /配置已变更/);
  assert.equal(f.service.list().subscriptions[0].cacheStatus, 'invalidated');
  f.hold(null);
  await f.service.content(f.sub.key);
  assert.equal(f.calls.at(-2).agent, 'updated-agent');
});

test('validates templates and references, invalidates dependent edits but not renames, and revokes deleted links', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.save('templates', { name: '坏模板', content: 'proxies: []\nproxy-groups: []' }), /节点选择/);
  await assert.rejects(f.service.save('sources', { name: '坏来源', url: 'file:///secret' }));
  await assert.rejects(f.service.save('sources', { name: '换行', url: 'https://test.test', userAgent: 'x\r\ny' }));
  await assert.rejects(f.service.save('subscriptions', { name: '缺来源', sourceIds: ['missing'], templateId: f.sub.templateId }));
  await f.service.content(f.sub.key);
  await f.service.save('sources', { ...f.one, name: '新名字' }, f.one.id);
  assert.equal(f.service.list().subscriptions[0].cacheStatus, 'valid');
  const template = f.service.get('templates', f.sub.templateId);
  await f.service.save('templates', { ...template, content: `${template.content}\n# changed` }, template.id);
  assert.equal(f.service.list().subscriptions[0].cacheStatus, 'invalidated');
  await assert.rejects(f.service.remove('sources', f.one.id), /引用/);
  await assert.rejects(f.service.remove('templates', template.id), /引用/);
  await f.service.remove('subscriptions', f.sub.id);
  await assert.rejects(f.service.content(f.sub.key), /不存在/);
});

test('cache write and metadata rename failures leave the previous successful cache usable', async t => {
  const f = await fixture(t);
  const original = await f.service.content(f.sub.key);
  const success = f.service.list().subscriptions[0].lastSuccessAt;
  const directory = f.store.directory;
  f.store.directory = join(directory, 'unavailable-directory');
  await assert.rejects(f.service.refresh(f.sub.id));
  f.store.directory = directory;
  assert.equal((await f.service.content(f.sub.key)).body, original.body);
  assert.equal(f.service.list().subscriptions[0].lastSuccessAt, success);
  const metadataPath = f.store.path;
  const blocked = join(directory, 'blocked-metadata');
  await mkdir(blocked);
  f.store.path = blocked;
  await assert.rejects(f.service.refresh(f.sub.id));
  f.store.path = metadataPath;
  assert.equal((await f.service.content(f.sub.key)).body, original.body);
  assert.equal(f.service.list().subscriptions[0].lastSuccessAt, success);
  assert.equal((await readdir(directory)).filter(name => name.startsWith('cache-')).length, 1);
  await f.service.refresh(f.sub.id);
  assert.equal(f.service.list().subscriptions[0].lastResult.ok, true);
});
