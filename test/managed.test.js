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
  const packages = {};
  const sourceDns = {};
  const calls = [];
  const service = new Managed(store, { now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), agent: init.headers['user-agent'] });
    if (hold) await hold;
    if (fail && String(url).includes('two')) return new Response('', { status: 503 });
    const packageHeader = packages[String(url).includes('two') ? 'two' : 'one'];
    return new Response(YAML.stringify({ dns: { nameserver: sourceDns[String(url).includes('two') ? 'two' : 'one'] }, proxies: [{ name: String(url).includes('two') ? 'JP' : 'US', type: 'ss', server: `node-${generation}.example`, port: 443 }] }), { headers: packageHeader ? { 'subscription-userinfo': packageHeader } : {} });
  } });
  const one = await service.save('sources', { name: '来源一', url: 'https://source.test/one?token=secret', userAgent: 'custom-agent' });
  const two = await service.save('sources', { name: '来源二', url: 'https://source.test/two' });
  const selection = { baseId: store.read().bases[0].id, nameserverIds: store.read().nameservers.map(row => row.id), useSourceNameservers: false };
  const sub = await service.save('subscriptions', { ...selection, name: '合并订阅', sourceIds: [one.id, two.id], templateId: store.read().templates[0].id });
  return { store, service, sub, one, two, options, calls, packages, sourceDns, selection, tick: v => { now += v; }, fail: () => { fail = true; }, generation: v => { generation = v; }, hold: v => { hold = v; } };
}
const sourceState = (f, id) => f.service.list().sources.find(row => row.id === id);

test('shares raw source caches across subscriptions and restart, uses per-source UA and expires at 2 hours', async t => {
  assert.equal(CACHE_MS, 2 * 60 * 60 * 1000);
  const f = await fixture(t);
  const second = await f.service.save('subscriptions', { name: '另一份订阅', sourceIds: [f.one.id], ...f.selection, templateId: f.sub.templateId });
  assert.equal(f.calls.length, 0);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 2);
  const shared = await f.service.content(second.key);
  assert.equal(f.calls.length, 2, 'shared source must not be fetched for each system subscription');
  assert.deepEqual(f.calls.map(c => c.agent), ['custom-agent', 'clash-verge/v2.4.5']);
  const cached = f.store.read().sources.find(row => row.id === f.one.id);
  assert.equal(YAML.parse(await readFile(join(f.options.directory, cached.cache.file), 'utf8')).proxies[0].name, 'US');
  assert.doesNotMatch(JSON.stringify(f.service.list().sources), /secret|source-cache-/);
  f.tick(CACHE_MS - 1); await f.service.content(f.sub.key); assert.equal(f.calls.length, 2);
  f.tick(1); await f.service.content(f.sub.key); assert.equal(f.calls.length, 4);
  let restartedCalls = 0;
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000 + CACHE_MS, fetchImpl: () => { restartedCalls++; throw Error('must use persisted cache'); } });
  assert.equal((await restarted.content(second.key)).body, shared.body);
  assert.equal(restartedCalls, 0);
});

test('persists package info with the same body cache and two-hour lifetime across restart and sharing', async t => {
  const f = await fixture(t);
  f.packages.one = 'upload=10; download=20; total=100; expire=1800000000';
  f.packages.two = 'upload=1; download=2; total=200; expire=1900000000';
  const result = await f.service.content(f.sub.key);
  assert.deepEqual(result.userInfo, { upload: '11', download: '22', total: '300', expire: '1900000000' });
  assert.deepEqual(result.packageCoverage, { available: 2, total: 2 });
  assert.equal(sourceState(f, f.one.id).userInfo.total, '100');
  assert.equal(f.service.list().subscriptions[0].userInfo.total, '300');
  assert.equal((await f.service.preview(f.one.id)).userInfo.total, '100');
  const second = await f.service.save('subscriptions', { name: '重复选择', sourceIds: [f.one.id, f.one.id], ...f.selection, templateId: f.sub.templateId });
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl: () => { throw Error('cached only'); } });
  assert.equal((await restarted.content(second.key)).userInfo.total, '100');
  f.packages.one = 'total=500';
  f.tick(2 * 60 * 60 * 1000 - 1);
  assert.equal((await f.service.content(second.key)).userInfo.total, '100');
  assert.equal(f.calls.length, 2);
  f.tick(1);
  assert.deepEqual((await f.service.content(second.key)).userInfo, { total: '500' });
  assert.equal(f.calls.length, 3, 'a single GET updates body and package together');
});

test('failed refresh retains matching package/body/timestamp and missing headers clear old package on success', async t => {
  const f = await fixture(t);
  f.packages.one = 'total=100'; f.packages.two = 'total=200';
  await f.service.content(f.sub.key);
  const old = f.store.read().sources.find(row => row.id === f.two.id);
  f.fail(); f.tick(CACHE_MS); f.packages.one = null; f.packages.two = 'total=900';
  const result = await f.service.content(f.sub.key);
  assert.equal(result.stale, true);
  assert.deepEqual(result.userInfo, { total: '200' });
  assert.deepEqual(result.packageCoverage, { available: 1, total: 2 });
  assert.equal(sourceState(f, f.one.id).userInfo, null);
  assert.equal(sourceState(f, f.two.id).lastSuccessAt, old.lastSuccessAt);
  assert.deepEqual(f.store.read().sources.find(row => row.id === f.two.id).cache, old.cache);
  assert.deepEqual(f.service.list().subscriptions[0].packageCoverage, { available: 1, total: 2 });
});

test('package info follows legacy caches, configuration edits and atomic file/metadata write failures', async t => {
  const f = await fixture(t);
  f.packages.one = 'total=100';
  await f.service.refresh(f.one.id);
  const original = f.store.read().sources.find(row => row.id === f.one.id).cache;
  f.packages.one = 'total=500';
  const directory = f.store.directory;
  f.store.directory = join(directory, 'missing');
  await assert.rejects(f.service.refresh(f.one.id)); f.store.directory = directory;
  assert.deepEqual(f.store.read().sources.find(row => row.id === f.one.id).cache, original);
  const metadataPath = f.store.path; const blocked = join(directory, 'blocked-package'); await mkdir(blocked);
  f.store.path = blocked; await assert.rejects(f.service.refresh(f.one.id)); f.store.path = metadataPath;
  assert.deepEqual(f.store.read().sources.find(row => row.id === f.one.id).cache, original);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.refresh(f.one.id);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('sources', { ...f.one, userAgent: 'new-agent' }, f.one.id);
  release(); await assert.rejects(pending, /配置已变更/);
  assert.deepEqual(f.store.read().sources.find(row => row.id === f.one.id).cache, original);
  f.hold(null); await f.service.refresh(f.one.id);
  assert.equal(sourceState(f, f.one.id).userInfo.total, '500');
  await f.store.update(state => { delete state.sources.find(row => row.id === f.one.id).cache.userInfo; });
  assert.equal(sourceState(f, f.one.id).userInfo, null);
  assert.equal(f.service.subscriptionInfo(f.sub.id).userInfo, null);
  assert.equal(f.service.subscriptionInfo(f.sub.id).packageCoverage.available, 0);
});

test('managed URL with a pipe remains a single source', async t => {
  const f = await fixture(t);
  const source = await f.service.save('sources', { name: '带过滤参数', url: 'https://source.test/one?filter=US|JP' });
  const sub = await f.service.save('subscriptions', { name: '过滤订阅', sourceIds: [source.id], ...f.selection, templateId: f.sub.templateId });
  await f.service.content(sub.key); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, source.url);
});

test('previews complete cached source responses without fetching, including empty, expired and invalidated caches', async t => {
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

test('preserves full provider response including comments, formatting and non-proxy sections across restart', async t => {
  const f = await fixture(t);
  const content = '\uFEFF# original provider comment\r\ndns: {enable: true, nameserver: [1.1.1.1]}\r\nproxies:\r\n  - {name: US full, type: ss, server: full.example, port: 443}\r\nproxy-groups:\r\n  - {name: provider-select, type: select, proxies: [US full]}\r\nrules: ["DOMAIN,provider.example,DIRECT"]\r\nprovider-only: preserved\r\n';
  let calls = 0;
  const service = new Managed(f.store, { now: () => 100000, fetchImpl: async () => { calls++; return new Response(content); } });
  await service.refresh(f.one.id);
  assert.equal((await service.preview(f.one.id)).content, content);
  assert.equal(calls, 1);
  const record = f.store.read().sources.find(row => row.id === f.one.id);
  assert.equal(await readFile(join(f.options.directory, record.cache.file), 'utf8'), content);
  const restarted = new Managed(await Store.open(f.options), { fetchImpl: async () => { throw Error('preview must not fetch'); } });
  assert.equal((await restarted.preview(f.one.id)).content, content);
  const output = YAML.parse((await service.content(f.sub.key)).body);
  assert.equal(output.proxies.length, 2);
  assert.equal(output['provider-only'], undefined, 'provider settings must not replace the selected system template');
});

test('legacy node-only caches remain usable and preview requests an explicit update without fetching', async t => {
  const f = await fixture(t);
  const file = 'source-cache-legacy.json';
  await writeFile(join(f.options.directory, file), JSON.stringify([{ name: 'US legacy', type: 'ss', server: 'legacy.example', port: 443 }]));
  await f.store.update(state => {
    const source = state.sources.find(row => row.id === f.one.id);
    source.cache = { file, revision: source.revision }; source.lastSuccessAt = 100000;
  });
  const old = await f.service.preview(f.one.id);
  assert.equal(old.content, null);
  assert.equal(old.requiresUpdate, true);
  assert.equal(old.proxyCount, 1);
  const sub = await f.service.save('subscriptions', { name: 'legacy', sourceIds: [f.one.id], ...f.selection, templateId: f.sub.templateId });
  assert.equal(YAML.parse((await f.service.content(sub.key)).body).proxies[0].server, 'legacy.example');
  assert.equal(f.calls.length, 0);
  await f.service.refresh(f.one.id);
  assert.equal((await f.service.preview(f.one.id)).requiresUpdate, false);
  assert.ok((await f.service.preview(f.one.id)).content);
  assert.equal(f.calls.length, 1);
});

test('failed source refresh keeps its data and timestamp while other sources update independently', async t => {
  const f = await fixture(t); await f.service.content(f.sub.key);
  const oldSuccess = sourceState(f, f.two.id).lastSuccessAt;
  const oldPreview = (await f.service.preview(f.two.id)).content;
  f.fail(); f.generation(2); f.tick(CACHE_MS);
  const result = await f.service.content(f.sub.key);
  assert.equal(result.stale, true);
  assert.deepEqual(YAML.parse(result.body).proxies.map(p => p.server), ['node-2.example', 'node-1.example']);
  assert.equal(sourceState(f, f.two.id).lastSuccessAt, oldSuccess);
  assert.equal(sourceState(f, f.two.id).lastResult.ok, false);
  assert.equal((await f.service.preview(f.two.id)).content, oldPreview);
  const missing = await f.service.save('sources', { name: '尚无缓存', url: 'https://source.test/two-missing' });
  const empty = await f.service.save('subscriptions', { name: '缺一个来源', sourceIds: [f.one.id, missing.id], ...f.selection, templateId: f.sub.templateId });
  await assert.rejects(f.service.content(empty.key));
  const results = await f.service.refreshAll();
  assert.equal(results.length, 3); assert.equal(results.filter(row => row.ok).length, 1);
});

test('coalesces source fetches across subscriptions and rejects old refreshes after source edits', async t => {
  const f = await fixture(t);
  const second = await f.service.save('subscriptions', { name: '共享来源', sourceIds: [f.one.id], ...f.selection, templateId: f.sub.templateId });
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
  const template = f.service.get('bases', f.sub.baseId);
  const changed = YAML.parse(template.content); changed['mixed-port'] = 8899;
  await f.service.save('bases', { ...template, content: YAML.stringify(changed) }, template.id);
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
  const template = f.service.get('bases', f.sub.baseId);
  const content = YAML.parse(template.content); content['mixed-port'] = 8899;
  await f.service.save('bases', { ...template, content: YAML.stringify(content) }, template.id);
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
  await assert.rejects(f.service.save('subscriptions', { name: '缺来源', sourceIds: ['missing'], ...f.selection, templateId: f.sub.templateId }));
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

test('does not migrate or delete legacy configuration and cache files', async t => {
  const f = await fixture(t); const legacy = f.store.read(); legacy.version = 1;
  const original = JSON.stringify(legacy);
  await writeFile(join(f.options.directory, 'state.json'), original);
  await writeFile(join(f.options.directory, 'cache-legacy.yaml'), 'kept');
  await assert.rejects(Store.open(f.options), /数据版本/);
  assert.equal(await readFile(join(f.options.directory, 'state.json'), 'utf8'), original);
  assert.equal(await readFile(join(f.options.directory, 'cache-legacy.yaml'), 'utf8'), 'kept');
});

test('composes independently selected parts and uses source DNS only when available in shared cache', async t => {
  const f = await fixture(t);
  const primary = 'https://dns.google/dns-query#🚀 节点选择';
  f.sourceDns.one = [primary, primary];
  f.sourceDns.two = ['tls://dns.example'];
  const manual = await f.service.save('nameservers', { name: '手动', address: '1.1.1.1' });
  const selected = { ...f.sub, nameserverIds: [manual.id], useSourceNameservers: true };
  await f.service.save('subscriptions', selected, f.sub.id);
  let result = YAML.parse((await f.service.content(f.sub.key)).body);
  assert.deepEqual(result.dns.nameserver, [primary, 'tls://dns.example']);
  assert.deepEqual(result.dns['proxy-server-nameserver'], ['https://doh.pub/dns-query', 'https://dns.alidns.com/dns-query']);
  assert.equal(f.calls.length, 2);
  f.sourceDns.one = []; f.sourceDns.two = [];
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, [primary, 'tls://dns.example']);
  await f.service.refresh(f.one.id);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, ['tls://dns.example'], 'one source without DNS must not add manual fallback');
  await f.service.refresh(f.two.id);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, ['1.1.1.1']);
  await f.service.save('nameservers', { ...manual, address: '9.9.9.9' }, manual.id);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, ['9.9.9.9']);
  assert.equal(f.calls.length, 4);
  await f.service.save('subscriptions', { ...selected, nameserverIds: [], useSourceNameservers: true }, f.sub.id);
  await assert.rejects(f.service.content(f.sub.key), { statusCode: 422 });
  await assert.rejects(f.service.save('subscriptions', { ...selected, nameserverIds: [], useSourceNameservers: false }, f.sub.id), /nameserver/);
});

test('protects all selected parts and applies manual DNS irrespective of source mode availability', async t => {
  const f = await fixture(t);
  f.sourceDns.one = ['provider-dns'];
  const manual = await f.service.save('nameservers', { name: '自定义协议', address: 'quic://dns.example#🚀 节点选择' });
  await f.service.save('subscriptions', { ...f.sub, nameserverIds: [manual.id, manual.id] }, f.sub.id);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, [manual.address]);
  for (const [resource,id] of [['bases', f.sub.baseId], ['templates', f.sub.templateId], ['nameservers', manual.id]]) {
    await assert.rejects(f.service.remove(resource, id), /引用/);
  }
  const base = await f.service.save('bases', { name: '任意 YAML', content: '[]' });
  assert.equal(base.content, '[]', 'base templates have no business structure validation at save');
  await assert.rejects(f.service.save('bases', { name: '语法错误', content: 'dns: [' }), /YAML/);
  await assert.rejects(f.service.save('subscriptions', { ...f.sub, baseId: 'missing' }, f.sub.id), /不存在/);
  await assert.rejects(f.service.save('subscriptions', { ...f.sub, nameserverIds: ['missing'] }, f.sub.id), /不存在/);
  assert.equal(f.service.list().subscriptions[0].baseName, '默认基础模板');
  assert.deepEqual(f.service.list().subscriptions[0].nameserverNames, ['自定义协议']);
  await f.service.remove('subscriptions', f.sub.id);
  await f.service.remove('nameservers', manual.id);
});

test('uses the latest manual address and base selection when edited during a source fetch', async t => {
  const f = await fixture(t);
  const selectedId = f.sub.nameserverIds[0];
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  const address = f.service.get('nameservers', selectedId);
  await f.service.save('nameservers', { ...address, address: 'tls://latest.example' }, address.id);
  const base = await f.service.save('bases', { name: '新基础', content: 'mixed-port: 8899' });
  await f.service.save('subscriptions', { ...f.sub, baseId: base.id, nameserverIds: [selectedId] }, f.sub.id);
  release();
  const output = YAML.parse((await pending).body);
  assert.equal(output['mixed-port'], 8899);
  assert.deepEqual(output.dns.nameserver, ['tls://latest.example']);
  assert.equal(f.calls.length, 2);
});
