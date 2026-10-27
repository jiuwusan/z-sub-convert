'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Store } = require('../store');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'managed-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const templatePath = join(directory, 'seed.yaml');
  await writeFile(templatePath, 'proxies: []\nproxy-groups:\n  - name: 🚀 节点选择\n    proxies: []\n  - name: 🔰 故障转移\n    proxies: []\n');
  return { directory, templatePath };
}
test('seeds template once, serializes concurrent transactions and persists restart state', async t => {
  const options = await fixture(t);
  const store = await Store.open(options);
  assert.equal(store.read().templates[0].name, '默认模板');
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.update(state => state.sources.push({ id: String(i) }))));
  await store.update(state => { state.templates[0].name = '自定义'; });
  const snapshot = store.read();
  snapshot.sources.length = 0;
  assert.equal(store.read().sources.length, 12);
  await writeFile(options.templatePath, 'changed seed');
  const reopened = await Store.open(options);
  assert.equal(reopened.read().sources.length, 12);
  assert.equal(reopened.read().templates[0].name, '自定义');
});
test('failed transaction leaves state intact and does not block future writes', async t => {
  const store = await Store.open(await fixture(t));
  await assert.rejects(store.update(state => { state.sources.push({ id: 'bad' }); throw Error('abort'); }));
  await store.update(state => state.sources.push({ id: 'good' }));
  assert.deepEqual(store.read().sources, [{ id: 'good' }]);
});

test('failed atomic rename preserves in-memory and on-disk records', async t => {
  const options = await fixture(t);
  const store = await Store.open(options);
  const originalPath = store.path;
  const blocked = join(options.directory, 'blocked');
  await mkdir(blocked);
  store.path = blocked;
  await assert.rejects(store.update(state => state.sources.push({ id: 'lost-write' })));
  assert.equal(store.read().sources.length, 0);
  store.path = originalPath;
  await store.update(state => state.sources.push({ id: 'saved-write' }));
  assert.deepEqual((await Store.open(options)).read().sources, [{ id: 'saved-write' }]);
});
