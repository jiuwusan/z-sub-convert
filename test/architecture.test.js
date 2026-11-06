const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'architecture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source);
  }
  return root;
}

function analyze(t, files) {
  return require('../scripts/check-architecture').checkArchitecture(fixture(t, files));
}

test('architecture accepts layered composition and ignores require text in comments and strings', (t) => {
  assert.deepEqual(analyze(t, {
    'server.js': "require('./src/app');",
    'src/app.js': "require('./bootstrap');",
    'src/bootstrap/index.js': "require('../services/account');",
    'src/services/account.js': "require('../domain/account'); require('../utils/errors');",
    'src/domain/account.js': "require('yaml'); require('../utils/errors'); // require('fs')\nconst text = \"require('http')\";",
    'src/utils/errors.js': 'module.exports = {};',
  }), []);
});

test('architecture rejects forbidden layer edges and unclassified runtime files', (t) => {
  const errors = analyze(t, {
    'src/domain/account.js': "require('../services/account');",
    'src/services/account.js': 'module.exports = {};',
    'src/legacy.js': 'module.exports = {};',
  });
  assert.ok(errors.some((error) => error.includes('domain -> services')));
  assert.ok(errors.some((error) => error.includes('unclassified')));
});

test('architecture rejects cycles even within an allowed layer', (t) => {
  const errors = analyze(t, {
    'src/services/a.js': "require('./b');",
    'src/services/b.js': "require('./a');",
  });
  assert.ok(errors.some((error) => error.includes('cycle') && error.includes('a.js') && error.includes('b.js')));
});

test('architecture rejects dynamic loading and missing local modules', (t) => {
  const errors = analyze(t, {
    'src/services/a.js': "require(variable); require('./missing'); import('node:fs');",
  });
  assert.ok(errors.some((error) => error.includes('dynamic')));
  assert.ok(errors.some((error) => error.includes('unresolved')));
});

test('architecture enforces domain purity and service transport boundaries', (t) => {
  const errors = analyze(t, {
    'src/domain/a.js': "require('node:fs/promises'); require('child_process'); process.env.SECRET; globalThis.fetch('https://example.com');",
    'src/services/a.js': "require('https'); fetch('https://example.com'); function handler(request, response) { response.end(request.url); }",
  });
  assert.ok(errors.filter((error) => error.includes('forbidden')).length >= 7);
});

test('architecture allows pure IP validation and injectable service fetch handles without calling them', (t) => {
  assert.deepEqual(analyze(t, {
    'src/domain/a.js': "const { isIP } = require('node:net'); module.exports = isIP('127.0.0.1');",
    'src/services/a.js': 'module.exports = class { constructor(fetchImpl) { this.fetch = fetchImpl; } };',
  }), []);
  assert.ok(analyze(t, { 'src/domain/a.js': "require('node:net').connect(80);" }).some((error) => error.includes('forbidden')));
  assert.ok(analyze(t, { 'src/services/a.js': 'class A { run() { this.fetch("https://example.com"); } }' }).some((error) => error.includes('forbidden')));
});

test('architecture rejects cross-boundary paths outside src and malformed runtime syntax', (t) => {
  const errors = analyze(t, {
    'server.js': 'module.exports = {};',
    'src/domain/a.js': "require('../../server');",
    'src/utils/b.js': 'function {',
  });
  assert.ok(errors.some((error) => error.includes('domain -> entry')));
  assert.ok(errors.some((error) => error.includes('syntax')));
});
