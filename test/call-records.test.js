'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile, readdir, appendFile } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { CallRecords, RETENTION_MS } = require('../call-records');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'call-records-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 31, 12);
  const active = new Set(['one', 'two']);
  const options = { now: () => now, isActive: id => active.has(id) };
  const records = new CallRecords(directory, options);
  t.after(() => records.close());
  return { directory, records, options, active, now: () => now, tick: value => { now += value; } };
}
const entry = at => ({ at, method: 'GET', ip: '127.0.0.1', userAgent: 'Clash', status: 200, durationMs: 12, error: null });

test('keeps more than 200 calls per subscription, paginates newest first and persists across restart', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 220 }, (_, i) => f.records.append('one', { ...entry(f.now() - 220 + i), key: 'secret', url: 'https://secret', body: 'private' })));
  await f.records.append('two', entry(f.now()));
  const first = await f.records.list('one');
  assert.equal(first.total, 220); assert.equal(first.pageSize, 50); assert.equal(first.records.length, 50);
  assert.equal(first.records[0].at, f.now() - 1);
  assert.equal((await f.records.list('one', 5)).records.length, 20);
  assert.equal((await f.records.list('two')).total, 1);
  const restarted = new CallRecords(f.directory, f.options);
  assert.equal((await restarted.list('one')).total, 220);
  const disk = (await Promise.all((await readdir(join(f.directory, 'call-records'))).map(name => readFile(join(f.directory, 'call-records', name), 'utf8')))).join('');
  assert.doesNotMatch(disk, /secret|private|"key"|"url"|"body"/);
  await assert.rejects(f.records.list('one', 0), { statusCode: 400 });
  await assert.rejects(f.records.list('../outside'), /记录标识/);
});

test('strictly filters 72 hours including exact boundary and cleanup removes expired files and lines', async t => {
  const f = await fixture(t);
  assert.equal(RETENTION_MS, 72 * 60 * 60 * 1000);
  await f.records.append('one', entry(f.now()));
  f.tick(1); await f.records.append('one', entry(f.now()));
  f.tick(24 * 60 * 60 * 1000); await f.records.append('one', entry(f.now()));
  f.tick(RETENTION_MS - 24 * 60 * 60 * 1000 - 1);
  assert.equal((await f.records.list('one')).total, 3, 'exactly 72 hours is retained');
  f.tick(1);
  assert.equal((await f.records.list('one')).total, 2);
  await f.records.cleanup();
  const files = await readdir(join(f.directory, 'call-records'));
  const contents = (await Promise.all(files.map(name => readFile(join(f.directory, 'call-records', name), 'utf8')))).join('');
  assert.equal(contents.split('\n').filter(Boolean).length, 2);
  f.tick(RETENTION_MS); await f.records.cleanup();
  assert.deepEqual(await readdir(join(f.directory, 'call-records')), []);
});

test('ignores broken tail lines and serializes delete against pending and late writes', async t => {
  const f = await fixture(t);
  await f.records.append('one', entry(f.now()));
  const file = (await readdir(join(f.directory, 'call-records')))[0];
  await appendFile(join(f.directory, 'call-records', file), '{broken');
  await f.records.append('one', entry(f.now()));
  assert.equal((await f.records.list('one')).total, 2);
  const pending = f.records.append('one', entry(f.now()));
  f.active.delete('one');
  await Promise.all([pending, f.records.remove('one'), f.records.append('one', entry(f.now()))]);
  assert.equal((await f.records.list('one')).total, 0);
  assert.deepEqual(await readdir(join(f.directory, 'call-records')), []);
  await f.records.append('two', entry(f.now())); f.active.delete('two');
  await f.records.cleanup();
  assert.deepEqual(await readdir(join(f.directory, 'call-records')), []);
});

test('closing flushes records already queued before stopping new writes', async t => {
  const f = await fixture(t);
  let release;
  const blocking = f.records.enqueue('one', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const pending = f.records.append('one', entry(f.now()));
  const closing = f.records.close();
  release(); await Promise.all([blocking, pending, closing]);
  await f.records.append('one', entry(f.now()));
  const reopened = new CallRecords(f.directory, f.options);
  assert.equal((await reopened.list('one')).total, 1);
});

test('source-update journals are isolated and only retain known update triggers', async t => {
  const f = await fixture(t);
  const updates = new CallRecords(f.directory, { ...f.options, directoryName: 'source-refresh-records' });
  await updates.append('one', { ...entry(f.now()), trigger: 'manual' });
  assert.equal((await f.records.list('one')).total, 0);
  assert.equal((await updates.list('one')).records[0].trigger, 'manual');
  await updates.append('one', { ...entry(f.now()), trigger: 'secret-token' });
  assert.equal((await updates.list('one')).records[0].trigger, undefined);
  assert.throws(() => new CallRecords(f.directory, { directoryName: '../outside' }), /记录目录/);
});
