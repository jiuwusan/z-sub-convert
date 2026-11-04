'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Store } = require('../store');
const { Notifications, reasons } = require('../notifications');

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
  assert.ok(ding.markdown.text.includes('[访问官网](https://provider.example/plans%28annual%29?from=notice)'));
  const feishu = f.sent[1].body;
  assert.equal(feishu.msg_type, 'interactive');
  assert.equal(feishu.card.config.wide_screen_mode, true);
  assert.equal(feishu.card.header.title.tag, 'plain_text');
  assert.equal(feishu.card.header.title.content, '⚠️ Mihomo 流量预警 / Mihomo 套餐即将到期');
  assert.equal(feishu.card.elements[0].text.tag, 'lark_md');
  assert.match(feishu.card.elements[0].text.content, /\*\*来源：\*\*/);
  assert.ok(feishu.card.elements[0].text.content.includes('机场&#42;&#91;测试&#93;&#60;at id=all&#62; 新行'));
  for (const content of [ding.markdown.text, feishu.card.elements[0].text.content]) {
    assert.match(content, /\*\*预警原因：\*\* [^\n]+\n\n\*\*剩余流量：\*\*/);
    assert.match(content, /\*\*剩余流量：\*\* 29.00 GB\n\n\*\*到期时间：\*\*/);
    assert.match(content, /\*\*官网：\*\* \[访问官网\]/);
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
  assert.equal(f.sent[1].body.card.header.title.content, '⚠️ Mihomo 套餐即将到期');
  assert.doesNotMatch(f.sent[0].body.markdown.text, /访问官网/);
  assert.doesNotMatch(f.sent[1].body.card.elements[0].text.content, /访问官网/);
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
  assert.equal(f.sent[1].body.card.header.title.content, '⚠️ Mihomo 通知测试');
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

test('successful sends crossing Beijing midnight are recorded on the actual success day', async t => {
  const f = await fixture(t);
  await f.service.save(settings);
  f.tick(14 * 3600000 - 100);
  const original = f.service.fetch;
  f.service.fetch = async (...args) => {
    f.tick(200);
    return original(...args);
  };
  await f.service.check();
  assert.equal(f.sent.length, 2);
  await f.service.check();
  assert.equal(f.sent.length, 2);
});

test('scheduler checks at startup and hourly and stops when closed', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  f.service.check = async () => { calls++; };
  f.service.start();
  t.mock.timers.tick(0);
  assert.equal(calls, 1);
  t.mock.timers.tick(3600000);
  assert.equal(calls, 2);
  await f.service.close();
  t.mock.timers.tick(3600000);
  assert.equal(calls, 2);
});

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
  assert.equal(f.sent.length, 3);
});
