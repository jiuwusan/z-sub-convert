'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../src/repositories/store.repository');
const { Notifications, reasons } = require('../src/services/notification.service');

const GB = 1024n ** 3n;
const NOW = Date.parse('2026-11-03T10:00:00+08:00');
const settings = { dingtalk: { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: '' }, feishu: { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', secret: '' } };

test('package alerts handle exact thresholds, overdue packages, unlimited and incomplete data', () => {
  assert.equal(reasons({ total: String(31n * GB), upload: '0', download: String(GB) }, NOW).length, 0);
  assert.equal(reasons({ total: String(31n * GB), upload: '1', download: String(GB) }, NOW).length, 1);
  assert.equal(reasons({ total: '100', upload: '100', download: '100' }, NOW).length, 1);
  assert.equal(reasons({ expire: String(NOW / 1000 + 3 * 86400) }, NOW).length, 1);
  assert.equal(reasons({ expire: String(NOW / 1000 + 3 * 86400 + 1) }, NOW).length, 0);
  assert.equal(reasons({ expire: String(NOW / 1000 - 1) }, NOW).length, 1);
  for (const info of [null, {}, { total: '0', upload: '10', download: '20', expire: '0' }, { total: '100', download: '0' }]) assert.deepEqual(reasons(info, NOW), []);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, templatePath: join(__dirname, '../prds/template.yaml') };
  const store = await Store.open(options);
  const source = { id: 'one', name: '来源一', website: 'https://provider.example', url: 'https://secret.example/token', revision: 1, lastSuccessAt: NOW, cache: { revision: 1, userInfo: { total: String(29n * GB), upload: '0', download: '0', expire: String(NOW / 1000 + 86400) } } };
  await store.update(state => { state.sources.push(source); });
  const sent = [];
  let now = NOW, fail = false;
  const fetchImpl = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), init });
    return new Response(JSON.stringify(String(url).includes('dingtalk') ? { errcode: fail ? 310000 : 0 } : { code: 0 }));
  };
  const service = new Notifications(store, { now: () => now, fetchImpl });
  return { options, store, service, sent, fetchImpl, tick: ms => { now += ms; }, fail: value => { fail = value; } };
}

test('daily usage waits until 09:00 and sends after traffic recovery', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  f.tick(-3600001);
  await f.service.check('one');
  assert.equal(f.sent.length, 0);
  f.tick(1);
  await f.service.check('one');
  await f.service.check('one');
  assert.equal(f.sent.length, 2);
  await f.store.update(state => {
    const source = state.sources[0];
    source.username = 'demo@example.test';
    source.password = 'example-secret';
    source.cache.userInfo.total = String(30n * GB);
    source.cache.file = 'recovered';
  });
  await f.service.check('one');
  const restarted = new Notifications(await Store.open(f.options), { now: () => NOW, fetchImpl: f.fetchImpl });
  await restarted.check('one');
  assert.equal(f.sent.length, 4);
  for (const item of f.sent.slice(2)) {
    const payload = JSON.stringify(item.body);
    assert.match(payload, /📊 Mihomo 套餐使用情况/);
    assert.match(payload, /\[来源一 · 访问官网\]\(https:\/\/provider\.example\/\)/);
    assert.match(payload, /账号.*demo@example.test/);
    assert.doesNotMatch(payload, /example-secret|预警原因/);
  }
});

test('notification configuration validates platform URLs and survives restart', async t => {
  const f = await fixture(t);
  assert.equal(f.service.settings().dingtalk.url, '');
  for (const url of ['http://oapi.dingtalk.com/robot/send?access_token=x', 'https://evil.example/hook', 'https://oapi.dingtalk.com.evil.example/robot/send?access_token=x', 'https://user@oapi.dingtalk.com/robot/send?access_token=x']) {
    await assert.rejects(f.service.save({ ...settings, dingtalk: { url } }));
  }
  await f.service.save(settings);
  const restarted = new Notifications(await Store.open(f.options));
  assert.deepEqual(restarted.settings(), settings);
  await f.service.save({ dingtalk: { url: '', secret: '' }, feishu: { url: '', secret: '' } });
  await f.service.check();
  assert.equal(f.sent.length, 0);
});

test('source traffic threshold controls alerts and daily usage at the exact boundary', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  await f.store.update(state => {
    const source = state.sources[0];
    source.trafficThresholdGiB = 50;
    source.cache.userInfo = { total: String(50n * GB), upload: '1', download: '0' };
    state.sources.push({ ...source, id: 'other', trafficThresholdGiB: 40 });
  });
  await f.service.check('one');
  assert.equal(f.sent.length, 2);
  for (const item of f.sent) assert.match(JSON.stringify(item.body), /剩余流量小于 50 GiB/);
  await f.service.check('other');
  assert.equal(f.sent.length, 4);
  for (const item of f.sent.slice(2)) assert.match(JSON.stringify(item.body), /套餐使用情况/);
  await f.store.update(state => {
    const source = state.sources[0];
    source.cache.userInfo.upload = '0';
    source.cache.file = 'recovered';
  });
  await f.service.check('one');
  assert.equal(f.sent.length, 6);
  for (const item of f.sent.slice(4)) assert.match(JSON.stringify(item.body), /套餐使用情况/);
});

test('alerts use DingTalk Markdown and Feishu Markdown cards with escaped names and clickable official sites', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  await f.store.update(state => {
    state.sources[0].name = '机场*[测试]<at id=all>\n新行';
    state.sources[0].website = 'https://provider.example/plans(annual)?from=notice';
  });
  await f.service.check();
  const ding = f.sent[0].body;
  assert.equal(ding.msgtype, 'markdown');
  assert.equal(ding.markdown.title, 'Mihomo 流量预警 / Mihomo 套餐即将到期');
  assert.match(ding.markdown.text, /^### ⚠️ Mihomo 流量预警 \/ Mihomo 套餐即将到期\n/);
  assert.ok(ding.markdown.text.includes('机场\\*\\[测试\\]&lt;at id=all&gt; 新行'));
  assert.match(ding.markdown.text, /\*\*剩余流量：\*\* 29.00 GB/);
  assert.ok(ding.markdown.text.includes(' · 访问官网](https://provider.example/plans%28annual%29?from=notice)'));
  const feishu = f.sent[1].body;
  assert.equal(feishu.msg_type, 'interactive');
  assert.equal(feishu.card.config.wide_screen_mode, true);
  assert.equal(feishu.card.header.title.tag, 'plain_text');
  assert.equal(feishu.card.header.title.content, '⚠️ Mihomo 流量预警 / Mihomo 套餐即将到期');
  assert.equal(feishu.card.elements[0].text.tag, 'lark_md');
  assert.match(feishu.card.elements[0].text.content, /\*\*平台：\*\*/);
  assert.ok(feishu.card.elements[0].text.content.includes('机场&#42;&#91;测试&#93;&#60;at id=all&#62; 新行'));
  for (const content of [ding.markdown.text, feishu.card.elements[0].text.content]) {
    assert.match(content, /\*\*预警原因：\*\* [^\n]+\n\n\*\*剩余流量：\*\*/);
    assert.match(content, /\*\*剩余流量：\*\* 29.00 GB\n\n\*\*到期时间：\*\*/);
    assert.match(content, /\*\*平台：\*\* \[.+ · 访问官网\]\(/);
    assert.match(content, /\*\*更新时间：\*\* 2026\/11\/3 10:00:00$/);
  }
  assert.doesNotMatch(JSON.stringify(feishu), /secret.example|<at id=all>/);
});

test('Markdown notifications omit missing website links and keep unknown/unlimited package fields readable', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  await f.store.update(state => {
    delete state.sources[0].website;
    state.sources[0].cache.userInfo = { total: '0', expire: String(NOW / 1000 + 86400) };
  });
  await f.service.check();
  assert.match(f.sent[0].body.markdown.text, /无限流量/);
  assert.equal(f.sent[0].body.markdown.title, 'Mihomo 套餐即将到期');
  assert.equal(f.sent[2].body.card.header.title.content, '⚠️ Mihomo 套餐即将到期');
  assert.equal(f.sent[3].body.card.header.title.content, '📊 Mihomo 套餐使用情况');
  assert.equal(f.sent[2].body.card.header.template, 'red');
  assert.equal(f.sent[3].body.card.header.template, 'blue');
  assert.match(f.sent[1].body.markdown.text, /📊 Mihomo 套餐使用情况/);
  assert.doesNotMatch(f.sent[0].body.markdown.text, /访问官网/);
  assert.doesNotMatch(f.sent[2].body.card.elements[0].text.content, /访问官网/);
});

test('optional mention targets persist and are included in both test and alert messages', async t => {
  const f = await fixture(t);
  const configured = { dingtalk: { ...settings.dingtalk, mention: '13800138000' }, feishu: { ...settings.feishu, mention: 'ou_member123' } };
  await f.service.save(configured);
  assert.deepEqual(f.service.settings(), configured);
  const restarted = new Notifications(await Store.open(f.options), { now: () => NOW, fetchImpl: f.fetchImpl });
  assert.deepEqual(restarted.settings(), configured);
  await restarted.test('dingtalk');
  await restarted.test('feishu');
  await restarted.check();
  assert.equal(f.sent.length, 4);
  for (const index of [0, 2]) {
    assert.deepEqual(f.sent[index].body.at, { atMobiles: ['13800138000'], isAtAll: false });
    assert.match(f.sent[index].body.markdown.text, /\n\n@13800138000$/);
  }
  for (const index of [1, 3]) assert.match(f.sent[index].body.card.elements[0].text.content, /\n\n<at id=ou_member123><\/at>$/);
  await restarted.save({ ...configured, dingtalk: { ...configured.dingtalk, mention: '' }, feishu: { ...configured.feishu, mention: '' } });
  await restarted.test('dingtalk');
  await restarted.test('feishu');
  assert.equal(f.sent[4].body.at, undefined);
  assert.doesNotMatch(f.sent[4].body.markdown.text, /@13800138000/);
  assert.doesNotMatch(f.sent[5].body.card.elements[0].text.content, /<at /);
});

test('mention validation rejects invalid types, injected tags and all-member mentions', async t => {
  const f = await fixture(t);
  for (const [channel, invalid] of [['dingtalk', ['name', '13800138000,13900139000', 123, '<at id=all>']], ['feishu', ['all', 'member@example.com', '<at id=all></at>', 'ou_x\nall', 'ou_x"', 123, 'a'.repeat(65)]]]) {
    for (const mention of invalid) await assert.rejects(f.service.save({ ...settings, [channel]: { ...settings[channel], mention } }));
  }
  await f.service.save({ ...settings, dingtalk: { ...settings.dingtalk, mention: ' 13800138000 ' }, feishu: { ...settings.feishu, mention: ' member_123 ' } });
  assert.equal(f.service.settings().dingtalk.mention, '13800138000');
  assert.equal(f.service.settings().feishu.mention, 'member_123');
});

test('checks combine reasons, persist daily deduplication, isolate failures and retry unsuccessful channels', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  f.fail(true);
  await Promise.all([f.service.check(), f.service.check()]);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].body.markdown.text, /来源一/);
  assert.match(f.sent[0].body.markdown.text, /https:\/\/provider.example/);
  assert.doesNotMatch(JSON.stringify(f.sent), /secret.example/);
  assert.match(f.sent[0].body.markdown.text, /30\s*GB/);
  assert.match(f.sent[0].body.markdown.text, /到期/);
  f.fail(false);
  await f.service.check();
  assert.equal(f.sent.length, 3);
  const restarted = new Notifications(await Store.open(f.options), { now: () => NOW, fetchImpl: f.fetchImpl });
  await restarted.check();
  assert.equal(f.sent.length, 3);
  f.tick(86400000);
  await f.service.check();
  assert.equal(f.sent.length, 5);
  await f.store.update(state => { state.sources[0].revision++; });
  f.tick(86400000);
  await f.service.check();
  assert.equal(f.sent.length, 5);
});

test('signed test messages use platform payloads and business errors fail without consuming alert deduplication', async t => {
  const f = await fixture(t);
  await f.service.save({ dingtalk: { ...settings.dingtalk, secret: 'SEC-test' }, feishu: { ...settings.feishu, secret: 'test-secret' } });
  await f.service.test('dingtalk');
  await f.service.test('feishu');
  assert.equal(new URL(f.sent[0].url).searchParams.get('timestamp'), String(NOW));
  assert.ok(new URL(f.sent[0].url).searchParams.get('sign'));
  assert.equal(f.sent[1].body.timestamp, String(NOW / 1000));
  assert.ok(f.sent[1].body.sign);
  assert.equal(f.sent[1].body.msg_type, 'interactive');
  assert.equal(f.sent[0].body.markdown.title, 'Mihomo 通知测试');
  assert.equal(f.sent[1].body.card.header.title.content, '✅ Mihomo 通知测试');
  assert.equal(f.sent[0].init.redirect, 'error');
  assert.ok(f.sent[0].init.signal);
  f.fail(true);
  await assert.rejects(f.service.test('dingtalk'), /钉钉/);
  f.fail(false);
  await f.service.check();
  assert.equal(f.sent.length, 5);
});

test('a source updated while another notification is in flight is checked before the shared run completes', async t => {
  const f = await fixture(t);
  await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
  let release, started;
  const sending = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  f.service.fetch = async () => {
    calls++;
    if (calls === 1) { started(); await blocked; }
    return new Response('{"errcode":0}');
  };
  const first = f.service.check();
  await sending;
  await f.store.update(state => { state.sources.push({ ...state.sources[0], id: 'two', name: '来源二' }); });
  const second = f.service.check();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
});

test('late sends crossing Beijing midnight do not consume the next morning expiry quota', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  f.tick(14 * 3600000 - 100);
  const original = f.service.fetch;
  f.service.fetch = async (...args) => {
    f.tick(200);
    return original(...args);
  };
  await f.service.check();
  assert.equal(f.sent.length, 1);
  await f.service.check();
  assert.equal(f.sent.length, 1);
  f.tick(9 * 3600000);
  await f.service.check();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[1].body.markdown.title, 'Mihomo 套餐即将到期');
  assert.equal(f.sent[2].body.card.header.title.content, '⚠️ Mihomo 流量预警 / Mihomo 套餐即将到期');
});

test('startup, hourly time passage and saving settings do not send cached alerts', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  await f.service.save(settings);
  f.service.start?.();
  t.mock.timers.tick(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0);
  t.mock.timers.tick(24 * 3600000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0);
  await f.service.close();
});

test('a successful source event only checks that source and retries its own failed sends', async t => {
  const f = await fixture(t);
  await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
  await f.store.update(state => { state.sources.push({ ...state.sources[0], id: 'two', name: '来源二' }); });
  f.fail(true);
  await f.service.check('one');
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].body.markdown.text, /来源一/);
  f.fail(false);
  await f.service.check('two');
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].body.markdown.text, /来源二/);
  await f.service.check('one');
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2].body.markdown.text, /来源一/);
  await f.service.check('missing');
  assert.equal(f.sent.length, 3);
});

test('concurrent source events are retained without checking unrelated cached sources', async t => {
  const f = await fixture(t);
  await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
  await f.store.update(state => {
    for (const id of ['two', 'three', 'unrelated']) state.sources.push({ ...state.sources[0], id, name: id });
  });
  let release, started;
  const sending = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const fetchImpl = f.service.fetch;
  f.service.fetch = async (...args) => {
    if (!f.sent.length) { started(); await blocked; }
    return fetchImpl(...args);
  };
  const first = f.service.check('one');
  await sending;
  const second = f.service.check('two');
  const third = f.service.check('three');
  release();
  await Promise.all([first, second, third]);
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[0].body.markdown.text, /来源一/);
  assert.match(f.sent[1].body.markdown.text, /\*\*平台：\*\* \[two · 访问官网\]/);
  assert.match(f.sent[2].body.markdown.text, /\*\*平台：\*\* \[three · 访问官网\]/);
  assert.doesNotMatch(JSON.stringify(f.sent), /unrelated/);
});

test('source events arriving during drain cleanup are checked before callers and close complete', async () => {
  const service = new Notifications({});
  const checked = [];
  let release, started;
  const secondStarted = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  service.performCheck = async ids => {
    checked.push([...ids]);
    if (checked.length === 1) {
      queueMicrotask(() => queueMicrotask(() => service.check('two')));
    } else {
      started();
      await blocked;
    }
  };
  let completed = false, closed = false;
  const first = service.check('one').then(() => { completed = true; });
  const closing = service.close().then(() => { closed = true; });
  // Flush the completion/cleanup handoff without blocking forever if it loses the event.
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(checked, [['one'], ['two']]);
  await secondStarted;
  assert.equal(completed, false);
  assert.equal(closed, false);
  release();
  await Promise.all([first, closing]);
  assert.equal(completed, true);
  assert.equal(closed, true);
  assert.equal(service.running, null);
});

for (const sameBatch of [false, true]) {
  test(`a later source failure prevents stale alerts ${sameBatch ? 'within a shared snapshot' : 'from a queued success event'}`, async t => {
    const f = await fixture(t);
    await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
    await f.store.update(state => {
      state.sources.push({ ...state.sources[0], id: 'two', name: '来源二', lastResult: { ok: true, at: NOW } });
    });
    let release, started;
    const sending = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const fetchImpl = f.service.fetch;
    f.service.fetch = async (...args) => {
      if (!f.sent.length) { started(); await blocked; }
      return fetchImpl(...args);
    };
    const first = f.service.check('one');
    const second = sameBatch ? f.service.check('two') : null;
    await sending;
    const queued = sameBatch ? second : f.service.check('two');
    await f.store.update(state => {
      state.sources[1].lastResult = { ok: false, message: '更新失败', at: NOW + 1 };
    });
    release();
    await Promise.all([first, queued]);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].body.markdown.text, /来源一/);
    assert.equal(f.store.read().notifications.sent['dingtalk:two'], undefined);
    await f.store.update(state => { state.sources[1].lastResult = { ok: true, at: NOW + 2 }; });
    await f.service.check('two');
    assert.equal(f.sent.length, 2, 'a later successful refresh can still alert');
    assert.match(f.sent[1].body.markdown.text, /来源二/);
  });
}

for (const change of ['failure', 'revision', 'cache']) {
  test(`each channel revalidates the source after another channel waits: ${change}`, async t => {
    const f = await fixture(t);
    await f.service.save(settings);
    let release, started;
    const sending = new Promise(resolve => { started = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const fetchImpl = f.service.fetch;
    f.service.fetch = async (...args) => {
      if (!f.sent.length) { started(); await blocked; }
      return fetchImpl(...args);
    };
    const checking = f.service.check('one');
    await sending;
    await f.store.update(state => {
      const source = state.sources[0];
      if (change === 'failure') source.lastResult = { ok: false, at: NOW + 1 };
      if (change === 'revision') source.revision++;
      if (change === 'cache') source.cache.file = 'newer-cache.yaml';
    });
    release();
    await checking;
    assert.equal(f.sent.length, 1, 'the second channel must not send the obsolete snapshot');
    assert.equal(f.store.read().notifications.sent['feishu:one'], undefined);
  });
}

test('low traffic alerts for every successful update, even with unchanged usage, without daily cache repeats', async t => {
  const f = await fixture(t);
  await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
  await f.store.update(state => { state.sources[0].cache.file = 'cache-1.yaml'; delete state.sources[0].cache.userInfo.expire; });
  await f.service.check();
  assert.equal(f.sent.length, 1);
  await f.service.check();
  assert.equal(f.sent.length, 1);
  await f.store.update(state => { state.sources[0].cache.file = 'cache-2.yaml'; });
  await f.service.check();
  assert.equal(f.sent.length, 2);
  f.tick(86400000);
  await f.service.check();
  assert.equal(f.sent.length, 2, 'the same low traffic cache does not repeat on the next day');
  const restarted = new Notifications(await Store.open(f.options), { now: () => NOW + 86400000, fetchImpl: f.fetchImpl });
  await restarted.check();
  assert.equal(f.sent.length, 2);
});

test('expiry stays daily while subsequent updates still alert on low traffic', async t => {
  const f = await fixture(t);
  await f.service.save({ ...settings, feishu: { url: '', secret: '' } });
  await f.store.update(state => { state.sources[0].cache.file = 'cache-1.yaml'; });
  await f.service.check();
  assert.match(f.sent[0].body.markdown.text, /套餐将在/);
  await f.store.update(state => { state.sources[0].cache.file = 'cache-2.yaml'; });
  await f.service.check();
  assert.equal(f.sent.length, 2);
  assert.doesNotMatch(f.sent[1].body.markdown.text, /套餐将在/);
  assert.match(f.sent[1].body.markdown.text, /剩余流量小于/);
  assert.equal(f.sent[1].body.markdown.title, 'Mihomo 流量预警');
  f.tick(86400000);
  await f.service.check();
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2].body.markdown.text, /套餐将在/);
  assert.equal(f.sent[2].body.markdown.title, 'Mihomo 套餐即将到期');
  assert.doesNotMatch(f.sent[2].body.markdown.text, /剩余流量小于/);
  await f.store.update(state => { state.sources[0].cache.file = 'cache-3.yaml'; state.sources[0].cache.userInfo.total = String(100n * GB); });
  await f.service.check();
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[3].body.markdown.title, 'Mihomo 套餐使用情况');
});

test('expiry waits until Beijing 09:00 across restart without consuming its daily quota', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  await f.store.update(state => { delete state.sources[0].cache.userInfo.total; });
  let now = Date.parse('2026-11-04T00:00:00+08:00');
  let service = new Notifications(f.store, { now: () => now, fetchImpl: f.fetchImpl });
  await service.check();
  now = Date.parse('2026-11-04T08:59:59.999+08:00');
  await service.check();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.store.read().notifications.sent, {});
  service = new Notifications(await Store.open(f.options), { now: () => now, fetchImpl: f.fetchImpl });
  now = Date.parse('2026-11-04T01:00:00Z'); // 09:00 Beijing, independent of server time zone.
  await service.check();
  await service.check();
  assert.equal(f.sent.length, 2);
  now = Date.parse('2026-11-05T00:00:00+08:00');
  await service.check();
  now = Date.parse('2026-11-05T08:59:59.999+08:00');
  await service.check();
  assert.equal(f.sent.length, 2);
  now = Date.parse('2026-11-05T09:00:00+08:00');
  await service.check();
  await service.check();
  assert.equal(f.sent.length, 4);
});

test('traffic and expiry both wait until Beijing 09:00 without consuming send quotas', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  let now = Date.parse('2026-11-04T08:59:59+08:00');
  let service = new Notifications(f.store, { now: () => now, fetchImpl: f.fetchImpl });
  await service.check();
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.store.read().notifications.sent, {});
  service = new Notifications(await Store.open(f.options), { now: () => now, fetchImpl: f.fetchImpl });
  now += 1000;
  await service.check();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].body.markdown.title, 'Mihomo 流量预警 / Mihomo 套餐即将到期');
  assert.equal(f.sent[1].body.card.header.title.content, '⚠️ Mihomo 流量预警 / Mihomo 套餐即将到期');
  await service.check();
  assert.equal(f.sent.length, 2);
});

test('traffic-only alerts wait until Beijing 09:00 across restart and still send on subsequent updates', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  await f.store.update(state => { state.sources[0].cache.userInfo.expire = '0'; });
  let now = Date.parse('2026-11-06T00:00:00+08:00');
  let service = new Notifications(f.store, { now: () => now, fetchImpl: f.fetchImpl });
  await service.check('one');
  now = Date.parse('2026-11-06T08:59:59.999+08:00');
  await service.check('one');
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.store.read().notifications.sent, {});
  const store = await Store.open(f.options);
  service = new Notifications(store, { now: () => now, fetchImpl: f.fetchImpl });
  now = Date.parse('2026-11-06T01:00:00Z');
  await service.check('one');
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].body.markdown.title, 'Mihomo 流量预警');
  assert.equal(f.sent[1].body.card.header.title.content, '⚠️ Mihomo 流量预警');
  await service.check('one');
  assert.equal(f.sent.length, 2);
  await store.update(state => { state.sources[0].cache.file = 'new-cache.yaml'; });
  await service.check('one');
  assert.equal(f.sent.length, 4);
});
