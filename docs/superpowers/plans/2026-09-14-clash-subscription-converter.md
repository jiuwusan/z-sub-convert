# Clash.Meta Subscription Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and containerize a Node.js service that merges Clash YAML subscriptions, normalizes their nodes into protocol-country groups, and injects them into the supplied Clash.Meta template.

**Architecture:** A flat set of CommonJS modules separates country recognition, transformation, upstream fetching, and HTTP concerns. The service parses and serializes YAML structurally, uses Node 22 native HTTP/fetch/test APIs, and runs under PM2 in a Node Alpine container.

**Tech Stack:** Node.js 22, CommonJS, `yaml`, Node test runner, PM2, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-14-clash-subscription-converter-design.md`

## Global Constraints

- The application files remain at repository root; only tests live under `test/`.
- `GET /sub` requires only `url`; `target` and unknown query parameters are ignored.
- Output is always Clash.Meta/Mihomo-compatible YAML.
- Every upstream request sends exactly `User-Agent: clash-meta`.
- Protocol priority is `ss`, `ssr`, `hysteria2`, `trojan`, `vmess`, `vless`, `tuic`, `hysteria`, `wireguard`, then alphabetical unknown protocols.
- Country priority starts with 新加坡, 日本, 美国, 香港, 台湾, 韩国; alphabetical recognized countries follow and 其他 is last.
- Docker uses `node:22-alpine`, `pm2-runtime`, and `max_memory_restart: 256M`.
- The image bundles `prds/template.yaml`; a host mount is optional.
- This directory is not currently a Git repository, so commit steps are documented but skipped unless Git is initialized externally.

---

### Task 1: Project Skeleton and Country Recognition

**Files:**
- Create: `package.json`
- Create: `country.js`
- Create: `test/country.test.js`

**Interfaces:**
- Produces: `detectCountry(name: unknown): { code: string, flag: string, name: string, priority: number }`
- Produces: `compareCountries(a, b): number`

- [ ] **Step 1: Create package metadata and write failing country tests**

```json
{
  "name": "clash-sub-convert",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22" },
  "scripts": { "start": "node server.js", "test": "node --test" },
  "dependencies": { "pm2": "^7.0.4", "yaml": "^2.8.1" },
  "overrides": { "js-yaml": "^5.4.2" }
}
```

Tests import `detectCountry` and verify flags, Chinese/English names, independent `SG`/`JP`/`US` tokens, substring rejection such as `usage`, and the `🏳️/其他` fallback.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm install && node --test test/country.test.js`

Expected: failure because `country.js` does not exist.

- [ ] **Step 3: Implement the country table and boundary-safe detector**

```js
const COUNTRIES = [
  { code: 'SG', flag: '🇸🇬', name: '新加坡', aliases: ['新加坡', 'Singapore'], priority: 0 },
  { code: 'JP', flag: '🇯🇵', name: '日本', aliases: ['日本', 'Japan'], priority: 1 }
];

function detectCountry(value) {
  const text = typeof value === 'string' ? value : '';
  // flag, alias, then boundary-safe code matching; otherwise return 其他
}
```

Include a practical global country/region mapping, not only the six priority entries.

- [ ] **Step 4: Run the country tests and verify GREEN**

Run: `node --test test/country.test.js`

Expected: all country tests pass with no warnings.

- [ ] **Step 5: Commit if Git is available**

```bash
git add package.json package-lock.json country.js test/country.test.js
git commit -m "feat: add country recognition"
```

---

### Task 2: Proxy Transformation and Template Injection

**Files:**
- Create: `transform.js`
- Create: `test/transform.test.js`

**Interfaces:**
- Consumes: `detectCountry(name)` and `compareCountries(a, b)` from `country.js`
- Produces: `transformConfig(template: object, upstreamProxyLists: object[][]): object`
- Produces: `PROTOCOL_PRIORITY: readonly string[]`

- [ ] **Step 1: Write failing transformation tests**

Create fixture objects in the test and assert that:

```js
const output = transformConfig(template, [[
  { name: 'SG one', type: 'ss', server: 'one.example', port: 443 },
  { name: '日本 two', type: 'hysteria2', server: 'two.example', port: 8443 }
]]);

assert.deepEqual(output.proxies.map(({ name }) => name), [
  '🇸🇬-新加坡-01',
  '🇯🇵-日本-01'
]);
assert.deepEqual(output['proxy-groups'].slice(-2).map(({ name }) => name), [
  '🇸🇬-SS-新加坡',
  '🇯🇵-HYSTERIA2-日本'
]);
```

Also cover exact ordering, per-country numbering continued across protocols, global name uniqueness, number 100, arbitrary field preservation, unknown countries/protocols, missing proxy type, and required template structure errors.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/transform.test.js`

Expected: failure because `transform.js` does not exist.

- [ ] **Step 3: Implement minimal deterministic transformation**

```js
const PROTOCOL_PRIORITY = Object.freeze([
  'ss', 'ssr', 'hysteria2', 'trojan', 'vmess',
  'vless', 'tuic', 'hysteria', 'wireguard'
]);

function transformConfig(template, upstreamProxyLists) {
  // validate and clone template, classify proxies, sort groups,
  // rename nodes, append fallback groups, and inject references
  return output;
}
```

Use a stable composite key such as `JSON.stringify([protocol, country.code])`, preserve source order within each group, and never mutate the caller's template or proxy objects.

- [ ] **Step 4: Run the transformation tests and verify GREEN**

Run: `node --test test/transform.test.js`

Expected: all transformation tests pass.

- [ ] **Step 5: Commit if Git is available**

```bash
git add transform.js test/transform.test.js
git commit -m "feat: transform and group clash proxies"
```

---

### Task 3: Concurrent Subscription Fetching

**Files:**
- Create: `fetch-subscriptions.js`
- Create: `test/fetch-subscriptions.test.js`

**Interfaces:**
- Produces: `splitSubscriptionUrls(rawUrl: unknown): URL[]`
- Produces: `fetchSubscriptions(rawUrl, options?): Promise<object[][]>`
- Options: `{ fetchImpl?: typeof fetch, timeoutMs?: number, maxBytes?: number }`

- [ ] **Step 1: Write failing fetch tests using local HTTP servers or injected fetch**

```js
const lists = await fetchSubscriptions(`${slowUrl}|${fastUrl}`, {
  timeoutMs: 1000,
  maxBytes: 1024 * 1024
});
assert.equal(lists[0][0].name, 'first');
assert.equal(lists[1][0].name, 'second');
assert.equal(receivedUserAgent, 'clash-meta');
```

Cover URL splitting, HTTP/HTTPS validation, source-order preservation despite completion order, non-2xx status, timeout, content-length and streamed body limits, invalid YAML, and missing/empty `proxies`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test test/fetch-subscriptions.test.js`

Expected: failure because `fetch-subscriptions.js` does not exist.

- [ ] **Step 3: Implement validation, bounded reads, and parsing**

```js
async function fetchSubscriptions(rawUrl, options = {}) {
  const urls = splitSubscriptionUrls(rawUrl);
  return Promise.all(urls.map((url) => fetchOne(url, options)));
}
```

Use `AbortSignal.timeout(timeoutMs)`, check `content-length` when present, enforce the limit while reading chunks, decode UTF-8, parse with `YAML.parse`, and throw typed errors carrying an HTTP status without including full source URLs.

- [ ] **Step 4: Run fetch tests and verify GREEN**

Run: `node --test test/fetch-subscriptions.test.js`

Expected: all fetch tests pass without leaked server handles.

- [ ] **Step 5: Commit if Git is available**

```bash
git add fetch-subscriptions.js test/fetch-subscriptions.test.js
git commit -m "feat: fetch yaml subscriptions safely"
```

---

### Task 4: HTTP Service and End-to-End Behavior

**Files:**
- Create: `server.js`
- Create: `test/server.test.js`

**Interfaces:**
- Consumes: `fetchSubscriptions(rawUrl, options)`
- Consumes: `transformConfig(template, upstreamProxyLists)`
- Produces: `createApp(options?): http.Server`
- Produces: `start(): http.Server`

- [ ] **Step 1: Write failing HTTP integration tests**

```js
const response = await fetch(`${baseUrl}/sub?url=${encodeURIComponent(upstreamUrl)}&target=anything`);
assert.equal(response.status, 200);
assert.match(response.headers.get('content-type'), /^text\/yaml/);
const config = YAML.parse(await response.text());
assert.equal(config.proxies[0].name, '🇸🇬-新加坡-01');
```

Cover `/version`, missing URL, ignored target/unknown parameters, unknown routes, unsupported methods, upstream 502 errors, invalid template 500 errors, YAML response headers, and a multi-URL end-to-end conversion.

- [ ] **Step 2: Run the server tests and verify RED**

Run: `node --test test/server.test.js`

Expected: failure because `server.js` does not exist.

- [ ] **Step 3: Implement the server**

```js
function createApp(options = {}) {
  return http.createServer(async (request, response) => {
    // route GET /sub and GET /version; serialize JSON errors
  });
}

if (require.main === module) start();
```

Read and parse the template per conversion, resolve environment defaults once at startup, and sanitize logged error messages.

- [ ] **Step 4: Run all tests and verify GREEN**

Run: `npm test`

Expected: all tests pass with no warnings or open handles.

- [ ] **Step 5: Commit if Git is available**

```bash
git add server.js test/server.test.js
git commit -m "feat: expose subconverter-compatible endpoint"
```

---

### Task 5: PM2, Docker Compose, and Documentation

**Files:**
- Create: `ecosystem.config.cjs`
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: `server.js`, `package.json`, and bundled `prds/template.yaml`
- Produces: container listening on port `25500`

- [ ] **Step 1: Add production deployment configuration**

```js
module.exports = {
  apps: [{
    name: 'clash-sub-convert',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '256M'
  }]
};
```

The Dockerfile installs locked production dependencies plus PM2, copies the application and bundled template, switches to the `node` user, and starts `pm2-runtime ecosystem.config.cjs`. Compose publishes `${PORT:-25500}:25500`, supplies environment variables, and uses `restart: unless-stopped`. Document an optional template override as a commented Compose volume example and as a README command, while leaving the default deployment mount-free.

- [ ] **Step 2: Add README usage and operational documentation**

Document `npm ci`, `npm start`, `docker compose up -d --build`, `/version`, one URL, multiple pipe-separated URLs, URL encoding, ignored `target`, environment settings, bundled-template behavior, optional read-only override, and the PM2 256 MB restart threshold.

- [ ] **Step 3: Verify tests and deployment artifacts**

Run: `npm test`

Run: `docker compose config`

Run: `docker build -t clash-sub-convert:test .`

Expected: tests pass, Compose renders a valid service definition, and the image builds successfully. Inspect the rendered Compose configuration to confirm port `25500`, environment defaults, and `restart: unless-stopped`.

- [ ] **Step 4: Perform live acceptance checks**

Start the service, request `/version`, convert `prds/第三方订阅测试链接.txt`, parse the returned YAML, and confirm every reference in the two injected template groups resolves to a generated group. Then start the Compose service without a template mount, inspect `pm2 jlist` inside the container to confirm the `256M` memory restart setting, and repeat `/version` and conversion checks.

- [ ] **Step 5: Commit if Git is available**

```bash
git add ecosystem.config.cjs Dockerfile .dockerignore docker-compose.yml README.md
git commit -m "feat: add pm2 docker deployment"
```
