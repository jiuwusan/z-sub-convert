'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

const {
  SubscriptionError,
  fetchSubscriptionDocument,
  splitSubscriptionUrls,
  fetchSubscriptions
} = require('../fetch-subscriptions');

test('fetches and validates a complete document while preserving original text and legacy proxy extraction', async () => {
  const content = '\uFEFF# provider comment\r\ndns: { enable: true }\r\nproxies:\r\n  - { name: US, type: ss }\r\nproxy-groups: []\r\nrules: [MATCH,DIRECT]\r\n';
  const options = { fetchImpl: async () => new Response(content) };
  const result = await fetchSubscriptionDocument(new URL('https://provider.example/sub'), options);
  assert.equal(result.content, content);
  assert.deepEqual(result.proxies, [{ name: 'US', type: 'ss' }]);
  assert.deepEqual(await fetchSubscriptions('https://provider.example/sub', options), [[{ name: 'US', type: 'ss' }]]);
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('splits pipe-separated HTTP URLs and rejects invalid input', () => {
  const urls = splitSubscriptionUrls('https://one.example/sub|http://two.example/sub');
  assert.deepEqual(urls.map(String), [
    'https://one.example/sub',
    'http://two.example/sub'
  ]);
  assert.throws(() => splitSubscriptionUrls(''), { statusCode: 400 });
  assert.throws(() => splitSubscriptionUrls('file:///tmp/sub.yaml'), { statusCode: 400 });
  assert.throws(() => splitSubscriptionUrls('not-a-url'), { statusCode: 400 });
});

test('fetches concurrently with clash-verge user-agent while preserving URL order', async (t) => {
  const seenAgents = [];
  const baseUrl = await listen(t, (request, response) => {
    seenAgents.push(request.headers['user-agent']);
    const isSlow = request.url === '/slow';
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end(`proxies:\n  - name: ${isSlow ? 'first' : 'second'}\n    type: ss\n`);
    }, isSlow ? 40 : 0);
  });

  const result = await fetchSubscriptions(`${baseUrl}/slow|${baseUrl}/fast`);

  assert.deepEqual(result.map((list) => list[0].name), ['first', 'second']);
  assert.deepEqual(seenAgents.sort(), ['clash-verge/v2.4.5', 'clash-verge/v2.4.5']);
});

test('maps upstream status and invalid subscription YAML to safe 502 errors', async (t) => {
  const baseUrl = await listen(t, (request, response) => {
    if (request.url === '/status') {
      response.writeHead(503);
      response.end('unavailable');
      return;
    }
    if (request.url === '/invalid') {
      response.end('proxies: [');
      return;
    }
    if (request.url === '/bad-proxy') {
      response.end('proxies:\n  - name: SG without type\n');
      return;
    }
    response.end('proxies: []');
  });

  for (const path of ['/status', '/invalid', '/bad-proxy', '/empty']) {
    await assert.rejects(
      fetchSubscriptions(`${baseUrl}${path}`),
      (error) => error instanceof SubscriptionError && error.statusCode === 502
    );
  }
});

test('aborts slow upstream requests at the configured timeout', async (t) => {
  const baseUrl = await listen(t, (_request, response) => {
    setTimeout(() => response.end('proxies: []'), 100);
  });

  await assert.rejects(
    fetchSubscriptions(baseUrl, { timeoutMs: 10 }),
    (error) => error instanceof SubscriptionError && error.statusCode === 502 && /timed out/i.test(error.message)
  );
});

test('rejects declared and streamed bodies above the configured size', async (t) => {
  const baseUrl = await listen(t, (request, response) => {
    if (request.url === '/declared') {
      response.writeHead(200, { 'content-length': '1000' });
      response.end('short');
      return;
    }
    response.writeHead(200);
    response.write('proxies:\n');
    response.end(`  - name: ${'x'.repeat(200)}\n    type: ss\n`);
  });

  for (const path of ['/declared', '/streamed']) {
    await assert.rejects(
      fetchSubscriptions(`${baseUrl}${path}`, { maxBytes: 64 }),
      (error) => error instanceof SubscriptionError && error.statusCode === 502 && /too large/i.test(error.message)
    );
  }
});

test('reports safe underlying network codes without exposing subscription URLs or certificate details', async () => {
  const sensitive = 'https://private.example/secret-path?token=do-not-expose';
  const cases = [
    { error: new TypeError('fetch failed', { cause: Object.assign(new Error(sensitive), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }), codes: ['UND_ERR_CONNECT_TIMEOUT'] },
    { error: new TypeError('fetch failed', { cause: Object.assign(new Error(sensitive), { code: 'ENOTFOUND' }) }), codes: ['ENOTFOUND'] },
    { error: new TypeError('fetch failed', { cause: Object.assign(new Error(sensitive), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }), codes: ['UNABLE_TO_VERIFY_LEAF_SIGNATURE'] },
    { error: new TypeError('fetch failed', { cause: new AggregateError([
      Object.assign(new Error(sensitive), { code: 'ENETUNREACH' }),
      Object.assign(new Error(sensitive), { code: 'ETIMEDOUT' })
    ]) }), codes: ['ENETUNREACH', 'ETIMEDOUT'] },
    { error: Object.assign(new Error(sensitive), { code: sensitive }), codes: [] }
  ];
  for (const { error, codes } of cases) {
    await assert.rejects(fetchSubscriptions(sensitive, { fetchImpl: async () => { throw error; } }), actual => {
      assert.equal(actual.statusCode, 502);
      for (const code of codes) assert.ok(actual.message.includes(code), `Missing ${code} in public error`);
      assert.doesNotMatch(actual.message, /private\.example|secret-path|do-not-expose/);
      assert.equal(actual.cause, error);
      return true;
    });
  }
});
