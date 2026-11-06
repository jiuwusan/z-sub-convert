'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, mkdir, readdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const YAML = require('yaml');
const { Store } = require('../src/repositories/store.repository');
const { Managed, CACHE_MS } = require('../src/services/managed.service');
const { Notifications } = require('../src/services/notification.service');

async function fixture(t, proxiesBySource) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, templatePath: join(__dirname, '../prds/template.yaml') };
  const store = await Store.open(options);
  let now = 100000, fail = false, hold = null, generation = 1;
  const packages = {};
  const sourceDns = {};
  const sourceDnsOptions = {};
  const sourceHosts = {};
  const calls = [];
  const service = new Managed(store, { now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), agent: init.headers['user-agent'] });
    if (hold) await hold;
    if (fail && String(url).includes('two')) return new Response('', { status: 503 });
    const packageHeader = packages[String(url).includes('two') ? 'two' : 'one'];
    return new Response(YAML.stringify({ hosts: sourceHosts[String(url).includes('two') ? 'two' : 'one'], dns: { ...sourceDnsOptions[String(url).includes('two') ? 'two' : 'one'], nameserver: sourceDns[String(url).includes('two') ? 'two' : 'one'] }, proxies: proxiesBySource?.[String(url).includes('two') ? 'two' : 'one'] ?? [{ name: String(url).includes('two') ? 'JP' : 'US', type: 'ss', server: `node-${generation}.example`, port: 443 }] }), { headers: packageHeader ? { 'subscription-userinfo': packageHeader } : {} });
  } });
  const one = await service.save('sources', { name: '来源一', url: 'https://source.test/one?token=secret', userAgent: 'custom-agent' });
  const two = await service.save('sources', { name: '来源二', url: 'https://source.test/two' });
  const selection = { baseId: store.read().bases[0].id, nameserverIds: store.read().nameservers.map(row => row.id), useSourceNameservers: false };
  const sub = await service.save('subscriptions', { ...selection, name: '合并订阅', sourceIds: [one.id, two.id], templateId: store.read().templates[0].id });
  return { store, service, sub, one, two, options, calls, packages, sourceDns, sourceDnsOptions, sourceHosts, selection, tick: v => { now += v; }, fail: () => { fail = true; }, generation: v => { generation = v; }, hold: v => { hold = v; } };
}
const sourceState = (f, id) => f.service.list().sources.find(row => row.id === id);

test('source DNS policies survive cache reuse, restart and failed refresh', async t => {
  const f = await fixture(t, { one: [{ name: 'US', type: 'ss', server: 'one.example' }], two: [{ name: 'JP', type: 'ss', server: 'two.example' }] });
  f.sourceDns.one = ['8.8.8.8'];
  f.sourceDnsOptions.one = { 'nameserver-policy': { 'custom.example': ['127.0.0.1:53', '1.1.1.1'] } };
  f.sourceDnsOptions.two = { 'proxy-server-nameserver-policy': { 'two.example': '9.9.9.9', 'bad.example': '127.0.0.1:5353' } };
  const verify = result => {
    const dns = YAML.parse(result.body).dns;
    assert.equal(dns['proxy-server-nameserver-policy']['two.example'], '9.9.9.9');
    assert.deepEqual(dns['proxy-server-nameserver-policy']['one.example'], ['8.8.8.8']);
    assert.equal(Object.hasOwn(dns['proxy-server-nameserver-policy'], 'bad.example'), false);
    assert.deepEqual(dns['nameserver-policy']['custom.example'], ['1.1.1.1']);
  };
  verify(await f.service.content(f.sub.key));
  verify(await f.service.content(f.sub.key));
  assert.equal(f.calls.length, 2);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl() { throw Error('cached only'); } });
  verify(await restarted.content(f.sub.key));
  f.tick(CACHE_MS);
  f.fail();
  const stale = await f.service.content(f.sub.key);
  assert.equal(stale.stale, true);
  verify(stale);
});

test('subscription hosts survive cache reuse and restart and follow source order', async t => {
  const f = await fixture(t);
  f.sourceHosts.one = { 'shared.test': '192.0.2.1', 'one.test': ['192.0.2.2', '2001:db8::2'] };
  f.sourceHosts.two = { 'shared.test': '192.0.2.3', 'two.test': 'alias.test' };
  const expected = { 'shared.test': '192.0.2.1', 'one.test': ['192.0.2.2', '2001:db8::2'], 'two.test': 'alias.test' };
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).hosts, expected);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).hosts, expected);
  assert.equal(f.calls.length, 2);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl() { throw Error('cached only'); } });
  assert.deepEqual(YAML.parse((await restarted.content(f.sub.key)).body).hosts, expected);
  await f.service.save('subscriptions', { ...f.sub, sourceIds: [f.two.id, f.one.id] }, f.sub.id);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).hosts['shared.test'], '192.0.2.3');
  f.fail();
  f.tick(CACHE_MS);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).hosts['two.test'], 'alias.test');
});

test('country filters persist per subscription, survive omitted edits and restart, and reuse complete source caches', async t => {
  const f = await fixture(t);
  assert.equal(f.service.get('subscriptions', f.sub.id).customCountries, false);
  assert.deepEqual(f.service.list().subscriptions[0].countryCodes, []);
  await f.service.save('subscriptions', {...f.sub, customCountries: true, countryCodes: ['US', 'US']}, f.sub.id);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 1);
  assert.deepEqual(f.service.get('subscriptions', f.sub.id).countryCodes, ['US']);
  const count = f.calls.length;
  const {customCountries, countryCodes, ...omitted} = f.sub;
  await f.service.save('subscriptions', {...omitted, name: '仅改名'}, f.sub.id);
  assert.equal(f.service.get('subscriptions', f.sub.id).customCountries, true);
  const restarted = new Managed(await Store.open(f.options), {now: () => 100000, fetchImpl() { throw Error('cached only'); }});
  assert.equal(YAML.parse((await restarted.content(f.sub.key)).body).proxies.length, 1);
  await f.service.save('subscriptions', {...omitted, customCountries: false}, f.sub.id);
  assert.equal(YAML.parse((await f.service.content(f.sub.key)).body).proxies.length, 2);
  assert.equal(f.calls.length, count);
  for (const values of [{customCountries:true,countryCodes:[]}, {countryCodes:['ZZ']}, {customCountries:null}]) await assert.rejects(f.service.save('subscriptions', {...f.sub, ...values}, f.sub.id), /国家/);
});

test('country candidates aggregate selected sources, share cache and respect manual source update mode', async t => {
  const f = await fixture(t, {one: [{name:'🇺🇸 one',type:'ss'}, {name:'unknown',type:'ss'}], two:[{name:'United States two',type:'trojan'}, {name:'日本',type:'ss'}]});
  const result = await f.service.countries([f.one.id, f.two.id, f.one.id]);
  assert.deepEqual(result.countries.map(({code,count}) => ({code,count})), [{code:'US',count:2}, {code:'JP',count:1}, {code:'OTHER',count:1}]);
  assert.equal(result.stale, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|source\.test|server|password/);
  await f.service.countries([f.one.id, f.two.id]);
  assert.equal(f.calls.length, 2);
  const source = await f.service.save('sources', {name:'manual',url:'https://source.test/manual',updateMode:'manual'});
  await assert.rejects(f.service.countries([source.id, f.one.id]), /手动更新/);
  assert.equal(f.calls.length, 2);
  for (const ids of [[], null, ['missing'], [1], Array(51).fill(f.one.id)]) await assert.rejects(f.service.countries(ids));
  f.tick(CACHE_MS);
  f.fail();
  const stale = await f.service.countries([f.one.id, f.two.id]);
  assert.equal(stale.stale, true);
  assert.equal(stale.countries.reduce((sum, row) => sum + row.count, 0), 4);
});

test('country selection changed during source reads takes effect before rendering without refetch', async t => {
  const f = await fixture(t);
  let release;
  f.hold(new Promise(resolve => {release = resolve;}));
  const pending = f.service.content(f.sub.key);
  while (f.calls.length < 2) await new Promise(resolve => setImmediate(resolve));
  await f.service.save('subscriptions', {...f.sub,customCountries:true,countryCodes:['JP']}, f.sub.id);
  release();
  const result = YAML.parse((await pending).body);
  assert.equal(result.proxies.length, 1);
  assert.match(result.proxies[0].name, /日本/);
  assert.equal(f.calls.length, 2);
});

test('only successful upstream refreshes trigger alerts for the corresponding source', async t => {
  const f = await fixture(t);
  f.packages.one = 'upload=0; download=0; total=100';
  f.packages.two = 'upload=0; download=0; total=100';
  await f.service.content(f.sub.key); // Existing caches must not be scanned when another source succeeds.
  const sent = [];
  const notifications = new Notifications(f.store, { now: () => Date.parse('2026-11-04T10:00:00+08:00'), logger: { error() {} }, fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{"errcode":0}');
  } });
  await notifications.save({ dingtalk: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: '' }, feishu: { url: '', secret: '' } });
  f.service.options.notifications = notifications;
  await f.service.refresh(f.one.id);
  await notifications.close();
  assert.equal(sent.length, 1);
  assert.match(sent[0].markdown.text, /来源一/);
  await f.service.content(f.sub.key);
  await notifications.close();
  assert.equal(sent.length, 1, 'cache hits do not trigger alerts');
  f.fail();
  await assert.rejects(f.service.refresh(f.two.id));
  await notifications.close();
  assert.equal(sent.length, 1, 'failed refresh does not trigger an alert from old cache');
  const metadataPath = f.store.path;
  f.store.path = f.options.directory;
  await assert.rejects(f.service.refresh(f.one.id));
  f.store.path = metadataPath;
  await notifications.close();
  assert.equal(sent.length, 1, 'failed cache persistence does not trigger alerts');
});

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
  assert.deepEqual(output.proxies.map(proxy => proxy.name), ['🇯🇵 来源二 日本 01']);
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
  assert.equal(f.service.list().subscriptions[0].baseName, '默认模板');
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

test('source update modes default to auto, persist and survive edits that omit the mode', async t => {
  const f = await fixture(t);
  assert.equal(f.one.updateMode, 'auto');
  await f.service.save('sources', { ...f.one, updateMode: 'manual' }, f.one.id);
  await f.service.save('sources', { name: '改名', url: f.one.url, userAgent: f.one.userAgent }, f.one.id);
  assert.equal(f.service.get('sources', f.one.id).updateMode, 'manual');
  const reopened = new Managed(await Store.open(f.options));
  assert.equal(reopened.list().sources.find(row => row.id === f.one.id).updateMode, 'manual');
  await f.store.update(state => { delete state.sources.find(row => row.id === f.two.id).updateMode; });
  assert.equal(f.service.get('sources', f.two.id).updateMode, 'auto');
  assert.equal(sourceState(f, f.two.id).updateMode, 'auto');
  for (const updateMode of ['invalid', null, true]) await assert.rejects(f.service.save('sources', { ...f.one, updateMode }, f.one.id), /更新模式/);
});

test('manual sources never fetch on access but retain old caches and allow explicit and refresh-all requests', async t => {
  const f = await fixture(t);
  await f.service.save('sources', { ...f.one, updateMode: 'manual' }, f.one.id);
  const sub = await f.service.save('subscriptions', { ...f.sub, name: '仅手动', sourceIds: [f.one.id] });
  await assert.rejects(f.service.content(sub.key), /仅手动更新.*手动更新/);
  assert.equal(f.calls.length, 0);
  await f.service.refresh(f.one.id);
  const before = f.store.read().sources.find(row => row.id === f.one.id);
  f.tick(CACHE_MS);
  const stale = await f.service.content(sub.key);
  assert.equal(stale.stale, true); assert.equal(f.calls.length, 1);
  assert.match(stale.body, /node-1.example/);
  await f.service.save('sources', { ...f.one, updateMode: 'manual', userAgent: 'changed-agent' }, f.one.id);
  assert.equal((await f.service.content(sub.key)).body, stale.body);
  let denied = 0;
  f.service.options.fetchImpl = async () => { denied++; return new Response('', { status: 403 }); };
  await assert.rejects(f.service.refresh(f.one.id), /HTTP 403/);
  assert.equal(denied, 1);
  assert.equal(sourceState(f, f.one.id).lastSuccessAt, before.lastSuccessAt);
  assert.equal((await f.service.content(sub.key)).body, stale.body); assert.equal(denied, 1);
  assert.equal((await f.service.refreshAll()).filter(row => !row.ok).length, 2);
  assert.equal(denied, 3, 'refresh-all includes manual sources');
  await f.service.save('sources', { ...f.one, updateMode: 'auto', userAgent: 'changed-agent' }, f.one.id);
  await f.service.content(sub.key); await f.service.content(sub.key);
  assert.equal(denied, 5, 'automatic retry behavior is unchanged regardless of upstream status');
});

test('switching mode preserves cache metadata and lets an already started refresh finish', async t => {
  const f = await fixture(t);
  const sub = await f.service.save('subscriptions', { ...f.sub, sourceIds: [f.one.id] });
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('sources', { ...f.one, updateMode: 'manual' }, f.one.id);
  release(); await pending;
  const original = f.store.read().sources.find(row => row.id === f.one.id);
  assert.equal(original.updateMode, 'manual');
  assert.equal(f.calls.length, 1);
  await f.service.save('sources', { ...f.one, updateMode: 'auto' }, f.one.id);
  const switched = f.store.read().sources.find(row => row.id === f.one.id);
  assert.deepEqual(switched.cache, original.cache);
  assert.equal(switched.lastSuccessAt, original.lastSuccessAt);
  assert.equal(switched.revision, original.revision);
});

test('remove-failover is per subscription, defaults false and persists without refetching cached sources', async t => {
  const f = await fixture(t);
  assert.equal(f.sub.removeFailover, false);
  const normal = await f.service.content(f.sub.key);
  assert.ok(YAML.parse(normal.body)['proxy-groups'].some(group => group.name === '🔰 故障转移'));
  const originalTemplate = f.service.get('templates', f.sub.templateId).content;
  await f.service.save('subscriptions', { ...f.sub, removeFailover: true }, f.sub.id);
  const removed = await f.service.content(f.sub.key);
  assert.equal(YAML.parse(removed.body)['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
  assert.ok(YAML.parse(removed.body)['proxy-groups'].some(group => group.type === 'fallback'));
  assert.equal(f.calls.length, 2);
  assert.equal(f.service.get('templates', f.sub.templateId).content, originalTemplate);
  const { removeFailover, ...withoutOption } = f.service.get('subscriptions', f.sub.id);
  await f.service.save('subscriptions', { ...withoutOption, name: '改名' }, f.sub.id);
  assert.equal(f.service.get('subscriptions', f.sub.id).removeFailover, true);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl: async () => { throw Error('must use cache'); } });
  assert.equal(restarted.list().subscriptions[0].removeFailover, true);
  assert.equal((await restarted.content(f.sub.key)).body, removed.body);
  for (const value of ['true', null, 1]) await assert.rejects(f.service.save('subscriptions', { ...f.sub, removeFailover: value }, f.sub.id), /故障转移/);
  await f.store.update(state => { delete state.subscriptions[0].removeFailover; });
  assert.equal(f.service.get('subscriptions', f.sub.id).removeFailover, false);
  assert.equal(f.service.list().subscriptions[0].removeFailover, false);
});

test('applies the latest remove-failover setting when changed during pending upstream reads', async t => {
  const f = await fixture(t);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('subscriptions', { ...f.sub, removeFailover: true }, f.sub.id);
  release();
  const output = YAML.parse((await pending).body);
  assert.equal(output['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
  assert.equal(f.calls.length, 2);
});

const sortingSources = {
  one: [1, 2, 3].map(n => ({ name: `US ${n}`, type: 'ss', server: `one-${n}`, port: 443 })),
  two: [1, 2, 3].map(n => ({ name: `US ${n}`, type: 'ss', server: `two-${n}`, port: 443 }))
};
const sortedUsNames = ['02', '01', '03'].map(n => `🇺🇸 来源一 美国 ${n}`);
const usGroup = body => YAML.parse(body)['proxy-groups'].find(group => group.name === '🇺🇸 来源一 SS 美国').proxies;

test('even-first is per subscription, defaults false and persists without refetching', async t => {
  const f = await fixture(t, sortingSources);
  assert.equal(f.sub.evenNodesFirst, false);
  const original = await f.service.content(f.sub.key);
  assert.deepEqual(usGroup(original.body), ['01', '02', '03'].map(n => `🇺🇸 来源一 美国 ${n}`));
  await f.service.save('subscriptions', { ...f.sub, evenNodesFirst: true, removeFailover: true }, f.sub.id);
  const sorted = await f.service.content(f.sub.key);
  assert.deepEqual(usGroup(sorted.body), sortedUsNames);
  assert.equal(YAML.parse(sorted.body)['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
  assert.equal(f.calls.length, 2);
  const other = await f.service.save('subscriptions', { ...f.sub, name: '其他订阅' });
  assert.deepEqual(usGroup((await f.service.content(other.key)).body), usGroup(original.body));
  const { evenNodesFirst, ...omitted } = f.service.get('subscriptions', f.sub.id);
  await f.service.save('subscriptions', omitted, f.sub.id);
  assert.equal(f.service.get('subscriptions', f.sub.id).evenNodesFirst, true);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl: () => { throw Error('must use cache'); } });
  assert.equal(restarted.list().subscriptions[0].evenNodesFirst, true);
  assert.deepEqual(usGroup((await restarted.content(f.sub.key)).body), sortedUsNames);
  for (const value of ['true', null, 1]) await assert.rejects(f.service.save('subscriptions', { ...f.sub, evenNodesFirst: value }, f.sub.id), /偶数/);
  await f.store.update(state => { delete state.subscriptions[0].evenNodesFirst; });
  assert.equal(f.service.get('subscriptions', f.sub.id).evenNodesFirst, false);
  assert.equal(f.service.list().subscriptions[0].evenNodesFirst, false);
  assert.deepEqual(usGroup((await f.service.content(f.sub.key)).body), usGroup(original.body));
  assert.equal(f.calls.length, 2);
});

test('applies the latest even-first setting during pending upstream reads', async t => {
  const f = await fixture(t, sortingSources);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('subscriptions', { ...f.sub, evenNodesFirst: true }, f.sub.id);
  release();
  assert.deepEqual(usGroup((await pending).body), sortedUsNames);
  assert.equal(f.calls.length, 2);
});

test('selects DNS sources independently of node aggregation and preserves cached selections across restart', async t => {
  const f = await fixture(t);
  f.sourceDns.one = ['https://one.example/dns-query', 'https://shared.example/dns-query'];
  f.sourceDns.two = ['https://two.example/dns-query', 'https://shared.example/dns-query'];
  assert.deepEqual(f.sub.nameserverSourceIds, []);
  const ns = body => YAML.parse(body).dns.nameserver;
  await f.service.save('subscriptions', { ...f.sub, useSourceNameservers: true }, f.sub.id);
  const merged = await f.service.content(f.sub.key);
  assert.deepEqual(ns(merged.body), [f.sourceDns.one[0], f.sourceDns.one[1], f.sourceDns.two[0]]);
  const selected = { ...f.sub, useSourceNameservers: true, nameserverSourceIds: [f.two.id, f.two.id] };
  await f.service.save('subscriptions', selected, f.sub.id);
  const chosen = await f.service.content(f.sub.key);
  assert.deepEqual(ns(chosen.body), f.sourceDns.two);
  assert.equal(YAML.parse(chosen.body).proxies.length, 2, 'DNS selection does not filter nodes');
  assert.deepEqual(f.service.list().subscriptions[0].nameserverSourceIds, [f.two.id]);
  const { nameserverSourceIds, ...omitted } = f.service.get('subscriptions', f.sub.id);
  await f.service.save('subscriptions', omitted, f.sub.id);
  assert.deepEqual(f.service.get('subscriptions', f.sub.id).nameserverSourceIds, [f.two.id]);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl: () => { throw Error('cached only'); } });
  assert.deepEqual(restarted.get('subscriptions', f.sub.id).nameserverSourceIds, [f.two.id]);
  assert.deepEqual(ns((await restarted.content(f.sub.key)).body), f.sourceDns.two);
  await f.service.save('subscriptions', { ...selected, nameserverSourceIds: [f.two.id, f.one.id] }, f.sub.id);
  assert.deepEqual(ns((await f.service.content(f.sub.key)).body), ns(merged.body));
  await f.service.save('subscriptions', { ...selected, nameserverSourceIds: [] }, f.sub.id);
  assert.deepEqual(ns((await f.service.content(f.sub.key)).body), ns(merged.body));
  await f.store.update(state => { delete state.subscriptions[0].nameserverSourceIds; });
  assert.deepEqual(f.service.get('subscriptions', f.sub.id).nameserverSourceIds, []);
  assert.deepEqual(f.service.list().subscriptions[0].nameserverSourceIds, []);
  assert.equal(f.calls.length, 2);
});

test('selected sources without DNS use manual fallback instead of unselected sources', async t => {
  const f = await fixture(t);
  f.sourceDns.one = ['https://one.example/dns-query'];
  const selected = { ...f.sub, useSourceNameservers: true, nameserverSourceIds: [f.two.id] };
  await f.service.save('subscriptions', selected, f.sub.id);
  const manual = f.sub.nameserverIds.map(id => f.service.get('nameservers', id).address);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, manual);
  await f.service.save('subscriptions', { ...selected, nameserverIds: [] }, f.sub.id);
  await assert.rejects(f.service.content(f.sub.key), /nameserver/);
  await f.service.save('subscriptions', { ...selected, useSourceNameservers: false, nameserverSourceIds: [f.one.id] }, f.sub.id);
  assert.deepEqual(YAML.parse((await f.service.content(f.sub.key)).body).dns.nameserver, manual);
  assert.deepEqual(f.service.get('subscriptions', f.sub.id).nameserverSourceIds, [f.one.id]);
  assert.equal(f.calls.length, 2);
});

test('validates DNS source IDs and removes stale selections when associated sources change', async t => {
  const f = await fixture(t);
  for (const value of [null, true, 'bad', [1], Array(51).fill(f.one.id), ['missing']]) {
    await assert.rejects(f.service.save('subscriptions', { ...f.sub, nameserverSourceIds: value }, f.sub.id), /nameserver/);
  }
  const outsider = await f.service.save('sources', { name: '未关联', url: 'https://outside.example/sub' });
  await assert.rejects(f.service.save('subscriptions', { ...f.sub, nameserverSourceIds: [outsider.id] }, f.sub.id), /nameserver/);
  await f.service.save('subscriptions', { ...f.sub, nameserverSourceIds: [f.one.id] }, f.sub.id);
  const { nameserverSourceIds, ...omitted } = f.service.get('subscriptions', f.sub.id);
  await f.service.save('subscriptions', { ...omitted, sourceIds: [f.two.id] }, f.sub.id);
  assert.deepEqual(f.service.get('subscriptions', f.sub.id).nameserverSourceIds, []);
  assert.deepEqual(f.service.list().subscriptions[0].sourceIds, [f.two.id]);
});

test('uses latest DNS source selection after pending source reads without extra fetches', async t => {
  const f = await fixture(t);
  f.sourceDns.one = ['https://one.example/dns-query'];
  f.sourceDns.two = ['https://two.example/dns-query'];
  await f.service.save('subscriptions', { ...f.sub, useSourceNameservers: true }, f.sub.id);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('subscriptions', { ...f.sub, useSourceNameservers: true, nameserverSourceIds: [f.two.id] }, f.sub.id);
  release();
  assert.deepEqual(YAML.parse((await pending).body).dns.nameserver, f.sourceDns.two);
  assert.equal(f.calls.length, 2);
});

test('names groups and nodes by current source, uses country-first source order and renames without refetch', async t => {
  const nodes = [{ name: 'JP', type: 'ss' }, { name: 'US', type: 'ss' }];
  const f = await fixture(t, { one: nodes, two: nodes });
  const groups = body => YAML.parse(body)['proxy-groups'].filter(group => group.name.includes(' SS '));
  const normal = await f.service.content(f.sub.key);
  assert.deepEqual(groups(normal.body).map(group => group.name), ['🇺🇸 来源一 SS 美国', '🇺🇸 来源二 SS 美国', '🇯🇵 来源一 SS 日本', '🇯🇵 来源二 SS 日本']);
  assert.deepEqual(YAML.parse(normal.body).proxies.map(proxy => proxy.name), ['🇯🇵 来源一 日本 01', '🇺🇸 来源一 美国 01', '🇯🇵 来源二 日本 01', '🇺🇸 来源二 美国 01']);
  await f.service.save('subscriptions', { ...f.sub, sourceIds: [f.two.id, f.one.id] }, f.sub.id);
  assert.deepEqual(groups((await f.service.content(f.sub.key)).body).map(group => group.name), ['🇺🇸 来源二 SS 美国', '🇺🇸 来源一 SS 美国', '🇯🇵 来源二 SS 日本', '🇯🇵 来源一 SS 日本']);
  const oldRevision = sourceState(f, f.one.id).revision;
  await f.service.save('sources', { ...f.service.get('sources', f.one.id), name: '新名称' }, f.one.id);
  const renamed = YAML.parse((await f.service.content(f.sub.key)).body);
  assert.ok(renamed.proxies.some(proxy => proxy.name === '🇺🇸 新名称 美国 01'));
  assert.ok(renamed['proxy-groups'].some(group => group.name === '🇺🇸 新名称 SS 美国'));
  assert.equal(sourceState(f, f.one.id).revision, oldRevision);
  assert.equal(f.calls.length, 2);
});

test('uses the latest source name changed during pending reads', async t => {
  const f = await fixture(t);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('sources', { ...f.service.get('sources', f.one.id), name: '新名称' }, f.one.id);
  release();
  const output = YAML.parse((await pending).body);
  assert.ok(output.proxies.some(proxy => proxy.name === '🇺🇸 新名称 美国 01'));
  assert.ok(output['proxy-groups'].some(group => group.name === '🇺🇸 新名称 SS 美国'));
  assert.equal(f.calls.length, 2);
});

test('country group options persist per subscription with defaults, validation and cached output changes', async t => {
  const f = await fixture(t);
  assert.equal(f.sub.countryGroupType, 'fallback');
  assert.equal(f.sub.countryTestUrl, 'http://www.gstatic.com/generate_204');
  const template = f.service.get('templates', f.sub.templateId).content;
  await f.service.content(f.sub.key);
  for (const type of ['fallback', 'url-test', 'load-balance', 'select']) {
    await f.service.save('subscriptions', { ...f.sub, countryGroupType: type, countryTestUrl: 'https://test.example/check' }, f.sub.id);
    const body = YAML.parse((await f.service.content(f.sub.key)).body);
    const generated = body['proxy-groups'].filter(group => group.name.includes(' SS '));
    assert.equal(generated.length, 2);
    assert.ok(generated.every(group => group.type === type));
    assert.ok(generated.every(group => group.url === (type === 'select' ? undefined : 'https://test.example/check')));
    assert.equal(f.calls.length, 2);
  }
  assert.equal(f.service.get('templates', f.sub.templateId).content, template);
  const { countryGroupType, countryTestUrl, ...omitted } = f.service.get('subscriptions', f.sub.id);
  await f.service.save('subscriptions', omitted, f.sub.id);
  assert.equal(f.service.get('subscriptions', f.sub.id).countryGroupType, 'select');
  assert.equal(f.service.get('subscriptions', f.sub.id).countryTestUrl, 'https://test.example/check');
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000, fetchImpl: () => { throw Error('cached only'); } });
  assert.equal(restarted.list().subscriptions[0].countryGroupType, 'select');
  assert.equal(restarted.list().subscriptions[0].countryTestUrl, 'https://test.example/check');
  const other = await f.service.save('subscriptions', { ...omitted, name: '其他订阅' });
  assert.equal(other.countryTestUrl, 'http://www.gstatic.com/generate_204');
  for (const options of [{countryGroupType:null},{countryGroupType:'bad'},{countryTestUrl:null},{countryTestUrl:''},{countryTestUrl:'ftp://bad.example'}]) {
    await assert.rejects(f.service.save('subscriptions', { ...f.sub, ...options }, f.sub.id), /国家分组/);
  }
  await f.store.update(state => { delete state.subscriptions[0].countryGroupType; delete state.subscriptions[0].countryTestUrl; });
  assert.equal(f.service.get('subscriptions', f.sub.id).countryGroupType, 'fallback');
  assert.equal(f.service.list().subscriptions[0].countryTestUrl, 'http://www.gstatic.com/generate_204');
  assert.ok(YAML.parse((await f.service.content(f.sub.key)).body)['proxy-groups'].filter(g => g.name.includes(' SS ')).every(g => g.type === 'fallback' && g.url === 'http://www.gstatic.com/generate_204'));
});

test('country test interval defaults, persists and survives omitted updates and select mode', async t => {
  const f = await fixture(t);
  assert.equal(f.sub.countryTestInterval, 305);
  await f.service.content(f.sub.key);
  const previousConfig = f.service.configuration(f.store.read(), f.sub);
  await f.service.save('subscriptions', { ...f.sub, countryTestInterval: 120 }, f.sub.id);
  const record = f.service.get('subscriptions', f.sub.id);
  assert.notEqual(f.service.configuration(f.store.read(), record), previousConfig);
  assert.ok(YAML.parse((await f.service.content(f.sub.key)).body)['proxy-groups'].filter(g => g.name.includes(' SS ')).every(g => g.interval === 120));
  const { countryTestInterval, ...omitted } = record;
  await f.service.save('subscriptions', { ...omitted, countryGroupType: 'select' }, f.sub.id);
  assert.equal(f.service.get('subscriptions', f.sub.id).countryTestInterval, 120);
  const restarted = new Managed(await Store.open(f.options), { now: () => 100000 });
  assert.equal(restarted.list().subscriptions[0].countryTestInterval, 120);
  await f.service.save('subscriptions', omitted, f.sub.id);
  assert.ok(YAML.parse((await f.service.content(f.sub.key)).body)['proxy-groups'].filter(g => g.name.includes(' SS ')).every(g => g.interval === 120));
  assert.equal(f.calls.length, 2);
  await f.store.update(state => { delete state.subscriptions[0].countryTestInterval; });
  assert.equal(f.service.get('subscriptions', f.sub.id).countryTestInterval, 305);
  assert.equal(f.service.list().subscriptions[0].countryTestInterval, 305);
  for (const value of [null, 0, -1, 1.5, '120', 86401]) await assert.rejects(f.service.save('subscriptions', { ...omitted, countryTestInterval: value }, f.sub.id), /间隔/);
});

test('country group options changed during upstream reads use latest values without refetching', async t => {
  const f = await fixture(t);
  let release; f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.service.content(f.sub.key);
  await new Promise(resolve => setImmediate(resolve));
  await f.service.save('subscriptions', { ...f.sub, countryGroupType: 'url-test', countryTestUrl: 'https://test.example/new' }, f.sub.id);
  release();
  assert.ok(YAML.parse((await pending).body)['proxy-groups'].filter(g => g.name.includes(' SS ')).every(g => g.type === 'url-test' && g.url === 'https://test.example/new'));
  assert.equal(f.calls.length, 2);
});
