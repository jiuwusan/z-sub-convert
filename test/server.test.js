'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const YAML = require('yaml');

const { createApp } = require('../server');

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function makeTemplate(t, value = null) {
  const directory = await mkdtemp(join(tmpdir(), 'sub-convert-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'template.yaml');
  const template = value || {
    proxies: [],
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['🔰 故障转移'] },
      { name: '🔰 故障转移', type: 'fallback', proxies: [] }
    ],
    rules: ['MATCH,🚀 节点选择']
  };
  await writeFile(path, typeof template === 'string' ? template : YAML.stringify(template), 'utf8');
  return path;
}

test('converts multiple subscriptions and ignores target and unknown parameters', async (t) => {
  const receivedAgents = [];
  const upstream = http.createServer((request, response) => {
    receivedAgents.push(request.headers['user-agent']);
    const isFirst = request.url === '/one';
    response.end(YAML.stringify({ proxies: [{
      name: isFirst ? 'SG first' : 'Japan second',
      type: isFirst ? 'ss' : 'hysteria2',
      server: isFirst ? 'one.example' : 'two.example',
      port: 443
    }] }));
  });
  const upstreamUrl = await listen(t, upstream);
  const templatePath = await makeTemplate(t);
  const appUrl = await listen(t, createApp({
    templatePath,
    now: () => 1789353600123,
    logger: { error() {} }
  }));
  const rawUrl = `${upstreamUrl}/one|${upstreamUrl}/two`;

  const response = await fetch(`${appUrl}/sub?url=${encodeURIComponent(rawUrl)}&target=clash&emoji=false`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/yaml;\s*charset=utf-8/i);
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="config-clash-meta-1789353600123.yaml"'
  );
  const output = YAML.parse(await response.text());
  assert.deepEqual(output.proxies.map(({ name }) => name), [
    '🇸🇬 新加坡 01', '🇯🇵 日本 01'
  ]);
  assert.deepEqual(output['proxy-groups'].slice(-2).map(({ name }) => name), [
    '🇸🇬 SS 新加坡', '🇯🇵 HYSTERIA2 日本'
  ]);
  assert.deepEqual(receivedAgents, ['clash-meta', 'clash-meta']);
});

test('serves version and structured route errors', async (t) => {
  const templatePath = await makeTemplate(t);
  const appUrl = await listen(t, createApp({ templatePath, logger: { error() {} } }));

  const versionResponse = await fetch(`${appUrl}/version`);
  assert.equal(versionResponse.status, 200);
  assert.deepEqual(await versionResponse.json(), {
    name: 'clash-sub-convert', version: '1.0.0'
  });

  const missingResponse = await fetch(`${appUrl}/sub`);
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /url query parameter/i);

  const missingRoute = await fetch(`${appUrl}/missing`);
  assert.equal(missingRoute.status, 404);

  const methodResponse = await fetch(`${appUrl}/sub`, { method: 'POST' });
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'GET, HEAD');
});

test('returns 502 for bad upstreams without exposing their URL', async (t) => {
  const upstream = http.createServer((_request, response) => {
    response.writeHead(503);
    response.end('secret');
  });
  const upstreamUrl = await listen(t, upstream);
  const templatePath = await makeTemplate(t);
  const messages = [];
  const appUrl = await listen(t, createApp({
    templatePath,
    logger: { error(message) { messages.push(message); } }
  }));

  const response = await fetch(`${appUrl}/sub?url=${encodeURIComponent(`${upstreamUrl}/token-secret`)}`);

  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /token-secret/);
  assert.doesNotMatch(messages.join('\n'), /token-secret/);
});

test('returns 500 when the configured template is invalid', async (t) => {
  const templatePath = await makeTemplate(t, 'proxy-groups: []\n');
  const upstream = http.createServer((_request, response) => {
    response.end('proxies:\n  - name: SG\n    type: ss\n');
  });
  const upstreamUrl = await listen(t, upstream);
  const appUrl = await listen(t, createApp({ templatePath, logger: { error() {} } }));

  const response = await fetch(`${appUrl}/sub?url=${encodeURIComponent(upstreamUrl)}`);

  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /template/i);
});
