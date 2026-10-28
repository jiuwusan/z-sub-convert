'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, readdir, readFile, writeFile } = require('node:fs/promises');
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
  let now = 100000, fail = false, hold = null, generation = 1;
  const calls = [];
  const service = new Managed(store, { now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), agent: init.headers['user-agent'] });
    if (hold) await hold;
    if (fail && String(url).includes('two')) return new Response('', { status: 503 });
    return new Response(YAML.stringify({ proxies: [{ name: String(url).includes('two') ? 'JP' : 'US', type: 'ss', server: `node-${generation}.example`, port: 443 }] }));
  } });
  const one = await service.save('sources', { name: '来源一', url: 'https://source.test/one?token=secret', userAgent: 'custom-agent' });
  const two = await service.save('sources', { name: '来源二', url: 'https://source.test/two' });
  const sub = await service.save('subscriptions', { name: '合并订阅', sourceIds: [one.id, two.id], templateId: store.read().templates[0].id });
  return { store, service, sub, one, two, options, calls, tick: v => { now += v; }, fail: () => { fail = true; }, generation: v => { generation = v; }, hold: v => { hold = v; } };
}
const sourceState = (f, id) => f.service.list().sources.find(row => row.id === id);

test('shares raw source caches across subscriptions and restart, uses per-source UA and expires at 23 hours', async t => {
  const f = await fixture(t);
  const second = await f.service.save('subscriptions', { name: '另一份订阅', sourceIds: [f.one.id], templateId: f.sub.templateId });
  assert.equal(f.calls.length, 0);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 2);
  const shared = await f.service.content(second.key);
  assert.equal(f.calls.length, 2, 'shared source must not be fetched for each system subscription');
  assert.deepEqual(f.calls.map(c => c.agent), ['custom-agent', 'clash-verge/v2.4.5']);
  const cached = f.store.read().sources.find(row => row.id === f.one.id);
  assert.equal(JSON.parse(await readFile(join(f.options.directory, cached.cache.file), 'utf8'))[0].name, 'US');
  assert.doesNotMatch(JSON.stringify(f.service.list().sources), /secret|source-cache-/);
  f.tick(CACHE_MS - 1); await f.service.content(f.sub.key); assert.equal(f.calls.length, 2);
  f.tick(1); await f.service.content(f.sub.key); assert.equal(f.calls.length, 4);
  let restartedCalls = 0;
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000 + CACHE_MS, fetchImpl: () => { restartedCalls++; throw Error('must use persisted cache'); } });
  assert.equal((await restarted.content(second.key)).body, shared.body);
  assert.equal(restartedCalls, 0);
});

test('managed URL with a pipe remains a single source', async t => {
  const f = await fixture(t);
  const source = await f.service.save('sources', { name: '带过滤参数', url: 'https://source.test/one?filter=US|JP' });
  const sub = await f.service.save('subscriptions', { name: '过滤订阅', sourceIds: [source.id], templateId: f.sub.templateId });
  await f.service.content(sub.key); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, source.url);
});

test('previews raw cached source nodes without fetching, including empty, expired and invalidated caches', async t => {
  const f = await fixture(t);
  const empty = await f.service.preview(f.one.id);
  assert.equal(empty.content, null);
  assert.equal(empty.proxyCount, 0);
  assert.equal(f.calls.length, 0);
  await f.service.refresh(f.one.id);
  const cached = await f.service.preview(f.one.id);
  assert.equal(cached.name, f.one.name);
  assert.equal(cached.cacheStatus, 'valid');
  assert.equal(cached.proxyCount, 1);
  assert.equal(YAML.parse(cached.content).proxies[0].name, 'US');
  assert.doesNotMatch(JSON.stringify(cached), /secret|source-cache-/);
  f.tick(CACHE_MS);
  assert.equal((await f.service.preview(f.one.id)).cacheStatus, 'expired');
  await f.service.save('sources', { ...f.one, userAgent: 'changed-agent' }, f.one.id);
  assert.equal((await f.service.preview(f.one.id)).cacheStatus, 'invalidated');
  assert.equal(f.calls.length, 1, 'opening a preview must never fetch upstream');
  await assert.rejects(f.service.preview('missing'), { statusCode: 404 });
});

test('failed source refresh keeps its data and timestamp while other sources update independently', async t => {
  const f = await fixture(t); await f.service.content(f.sub.key);
  const oldSuccess = sourceState(f, f.two.id).lastSuccessAt;
  f.fail(); f.generation(2); f.tick(CACHE_MS);
  const result = await f.service.content(f.sub.key);
  assert.equal(result.stale, true);
  assert.deepEqual(YAML.parse(result.body).proxies.map(p => p.server), ['node-2.example', 'node-1.example']);
  assert.equal(sourceState(f, f.two.id).lastSuccessAt, oldSuccess);
  assert.equal(sourceState(f, f.two.id).lastResult.ok, false);
  const missing = await f.service.save('sources', { name: '尚无缓存', url: 'https://source.test/two-missing' });
  const empty = await f.service.save('subscriptions', { name: '缺一个来源', sourceIds: [f.one.id, missing.id], templateId: f.sub.templateId });
  await assert.rejects(f.service.content(empty.key));
  const results = await f.service.refreshAll();
  assert.equal(results.length, 3); assert.equal(results.filter(row => row.ok).length, 1);
});

test('coalesces source fetches across subscriptions and rejects old refreshes after source edits', async t => {
  const f = await fixture(t);
  const second = await f.service.save('subscriptions', { name: '共享来源', sourceIds: [f.one.id], templateId: f.sub.templateId });
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const requests = [f.service.content(f.sub.key), f.service.content(second.key)];
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 2);
  release(); await Promise.all(requests); f.tick(CACHE_MS);
  let unblock; f.hold(new Promise(resolve => { unblock = resolve; }));
  const refresh = f.service.refresh(f.one.id); await new Promise(resolve => setImmediate(resolve));
  await f.service.save('sources', { ...f.one, userAgent: 'updated-agent' }, f.one.id);
  unblock(); await assert.rejects(refresh, /配置已变更/);
  assert.equal(sourceState(f, f.one.id).cacheStatus, 'invalidated');
  f.hold(null); await f.service.content(second.key); assert.equal(f.calls.at(-1).agent, 'updated-agent');
});

test('template and association edits re-render without refetching valid sources, source TTL is independent', async t => {
  const f = await fixture(t); await f.service.content(f.sub.key);
  const template = f.service.get('templates', f.sub.templateId);
  const changed = YAML.parse(template.content); changed['mixed-port'] = 8899;
  await f.service.save('templates', { ...template, content: YAML.stringify(changed) }, template.id);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body)['mixed-port'], 8899);
  await f.service.save('subscriptions', { ...f.sub, sourceIds: [f.two.id], name: '改关联' }, f.sub.id);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 1); assert.equal(f.calls.length, 2);
  f.tick(60 * 60 * 1000); await f.service.refresh(f.one.id);
  f.tick(CACHE_MS - 60 * 60 * 1000); await f.service.content(f.sub.key);
  assert.equal(f.calls.length, 4); assert.equal(sourceState(f, f.one.id).cacheStatus, 'valid');
});

test('refresh-all includes unused sources and subscribers use the updated data', async t => {
  const f = await fixture(t);
  const unused = await f.service.save('sources', { name: '尚未使用', url: 'https://source.test/unused' });
  await f.service.refresh(f.one.id); assert.equal(f.calls.length, 1);
  await f.service.content(f.sub.key); assert.equal(f.calls.length, 2);
  f.generation(3); const results = await f.service.refreshAll();
  assert.equal(results.length, 3); assert.equal(f.calls.length, 5); assert.equal(sourceState(f, unused.id).cacheStatus, 'valid');
  assert.ok(YAML.parse((await f.service.content(f.sub.key)).body).proxies.every(p => p.server === 'node-3.example'));
  assert.equal(f.calls.length, 5);
});

test('renders the latest template/selection when edited during pending source reads', async t => {
  const f = await fixture(t);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  const template = f.service.get('templates', f.sub.templateId);
  const content = YAML.parse(template.content); content['mixed-port'] = 8899;
  await f.service.save('templates', { ...template, content: YAML.stringify(content) }, template.id);
  await f.service.save('subscriptions', { ...f.sub, sourceIds: [f.two.id] }, f.sub.id);
  await f.service.remove('sources', f.one.id);
  release();
  const output = YAML.parse((await pending).body);
  assert.equal(output['mixed-port'], 8899);
  assert.deepEqual(output.proxies.map(proxy => proxy.name), ['🇯🇵 日本 01']);
  assert.equal(f.calls.length, 2);
});

test('validates references/templates and revokes deleted subscription keys', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.save('templates', { name: '坏模板', content: 'proxies: []\nproxy-groups: []' }), /节点选择/);
  await assert.rejects(f.service.save('sources', { name: '坏来源', url: 'file:///secret' }));
  await assert.rejects(f.service.save('sources', { name: '换行', url: 'https://test.test', userAgent: 'x\r\ny' }));
  await assert.rejects(f.service.save('subscriptions', { name: '缺来源', sourceIds: ['missing'], templateId: f.sub.templateId }));
  await f.service.content(f.sub.key); await f.service.save('sources', { ...f.one, name: '新名字' }, f.one.id);
  assert.equal(sourceState(f, f.one.id).cacheStatus, 'valid');
  await assert.rejects(f.service.remove('sources', f.one.id), /引用/);
  await assert.rejects(f.service.remove('templates', f.sub.templateId), /引用/);
  await f.service.remove('subscriptions', f.sub.id); await assert.rejects(f.service.content(f.sub.key), /不存在/);
  await f.service.remove('sources', f.one.id); assert.equal(f.service.list().sources.length, 1);
});

test('source cache file and metadata write failures preserve the previous cache', async t => {
  const f = await fixture(t); await f.service.content(f.sub.key);
  const success = sourceState(f, f.one.id).lastSuccessAt; const directory = f.store.directory;
  f.store.directory = join(directory, 'unavailable-directory'); await assert.rejects(f.service.refresh(f.one.id)); f.store.directory = directory;
  const metadataPath = f.store.path; const blocked = join(directory, 'blocked-metadata'); await mkdir(blocked);
  f.store.path = blocked; await assert.rejects(f.service.refresh(f.one.id)); f.store.path = metadataPath;
  assert.equal(sourceState(f, f.one.id).lastSuccessAt, success);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 2);
  assert.equal((await readdir(directory)).filter(name => name.startsWith('source-cache-')).length, 2);
});

test('upgrades v1 preserving credentials/references/keys, does not mistake rendered output for raw data', async t => {
  const f = await fixture(t); const legacy = f.store.read(); legacy.version = 1; legacy.account = { username: 'kept', salt: 'kept', hash: 'kept' };
  legacy.subscriptions[0].cache = { file: 'cache-legacy.yaml', revision: 1 }; legacy.subscriptions[0].lastSuccessAt = 1000;
  await writeFile(join(f.options.directory, 'state.json'), JSON.stringify(legacy));
  await writeFile(join(f.options.directory, 'cache-legacy.yaml'), 'proxies: []');
  const migrated = await Store.open(f.options);
  assert.equal(migrated.read().version, 2); assert.equal(migrated.read().account.username, 'kept');
  assert.equal(migrated.read().subscriptions[0].key, f.sub.key);
  assert.deepEqual(migrated.read().subscriptions[0].sourceIds, [f.one.id, f.two.id]);
  assert.equal(migrated.read().sources[0].cache, null); assert.equal(migrated.read().subscriptions[0].cache, undefined);
  assert.equal((await Store.open(f.options)).read().version, 2);
  let calls = 0;
  const service = new Managed(migrated, { fetchImpl: async () => { calls++; return new Response('proxies:\n  - name: US\n    type: ss\n    server: migrated.example\n    port: 443\n'); } });
  assert.equal(YAML.parse((await service.content(f.sub.key)).body).proxies.length, 2);
  assert.equal(calls, 2);
});
