'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const routes = require('../public/router');

async function copyHarness() {
  const elements = new Map();
  let rejectClipboard;
  const location = { origin: 'https://admin.example', hash: '#/login' };
  const context = vm.createContext({
    URL, URLSearchParams, setTimeout, clearTimeout,
    SubConvertRoutes: routes,
    location,
    history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    window: { addEventListener() {} },
    navigator: { clipboard: { writeText: () => new Promise((_resolve, reject) => { rejectClipboard = reject; }) } },
    fetch: async () => ({ ok: true, json: async () => ({ initialized: true, authenticated: false }) }),
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          value: '', open: false, addEventListener() {},
          close() { this.open = false; }, showModal() { this.open = true; }, select() { this.selected = true; }
        });
        return elements.get(selector);
      },
      querySelectorAll() { return []; }
    }
  });
  vm.runInContext(readFileSync(join(__dirname, '../public/admin.js'), 'utf8'), context);
  await context.initialize();
  vm.runInContext('state.authenticated = true; state.navigation = 1;', context);
  return { context, elements, denyClipboard: () => rejectClipboard(Error('denied')) };
}

test('clipboard fallback respects navigation/logout and still opens on the originating authenticated page', async () => {
  for (const change of ['state.navigation += 1;', 'state.authenticated = false;', '']) {
    const { context, elements, denyClipboard } = await copyHarness();
    const copying = context.copyLink({ key: 'test-key' });
    vm.runInContext(change, context);
    denyClipboard();
    await copying;
    const dialog = elements.get('#copy-dialog');
    if (change) assert.ok(!dialog?.open, 'A stale clipboard failure must not open a dialog');
    else {
      assert.equal(dialog.open, true);
      assert.equal(elements.get('#copy-url').value, 'https://admin.example/sub?key=test-key');
      assert.equal(elements.get('#copy-url').selected, true);
    }
  }
});
