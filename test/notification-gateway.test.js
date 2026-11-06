'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendNotification } = require('../src/gateways/notification.gateway');
const { AppError } = require('../src/utils/errors');

test('signed webhook requests use each platform timestamp unit and signature recipe', async () => {
  const sent = [];
  const options = { now: () => 1793671200000, fetchImpl: async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return new Response('{"errcode":0,"code":0}');
  } };
  await sendNotification('dingtalk', { url: 'https://oapi.dingtalk.com/robot/send?access_token=test', secret: 'SEC-test' }, 'content', 'title', options);
  await sendNotification('feishu', { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/test', secret: 'test-secret' }, 'content', 'title', options);
  assert.equal(sent[0].url.searchParams.get('timestamp'), '1793671200000');
  assert.equal(sent[0].url.searchParams.get('sign'), 'NnlEd4wlsQuhZce4ub/PCPhn4lEIzTYzbSTVHVNgoDk=');
  assert.equal(sent[1].body.timestamp, '1793671200');
  assert.equal(sent[1].body.sign, 'TYR/ytb1PXxyG4DwKetaBirbu+hvnyv5qBXHGPsYQ+U=');
  for (const { init } of sent) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.ok(init.signal instanceof AbortSignal);
  }
});

for (const [channel, responses] of [
  ['dingtalk', ['{"errcode":0}']],
  ['feishu', ['{"code":0}', '{"StatusCode":0}']],
]) {
  test(`${channel} gateway accepts documented success responses`, async () => {
    for (const body of responses) {
      await sendNotification(channel, { url: 'https://example.test/hook' }, 'content', 'title', {
        fetchImpl: async () => new Response(body),
      });
    }
  });

  test(`${channel} gateway maps transport, HTTP, JSON and business failures to safe errors`, async () => {
    for (const fetchImpl of [
      async () => { throw new Error('secret-token'); },
      async () => new Response('secret-token', { status: 503 }),
      async () => new Response('secret-token'),
      async () => new Response('{"errcode":1,"code":1,"msg":"secret-token"}'),
      async () => new Response('{}'),
    ]) {
      await assert.rejects(sendNotification(channel, { url: 'https://example.test/hook?token=secret-token' }, 'content', 'title', { fetchImpl }), error => {
        assert.ok(error instanceof AppError);
        assert.equal(error.statusCode, 502);
        assert.doesNotMatch(error.message, /secret-token/);
        return true;
      });
    }
  });
}
