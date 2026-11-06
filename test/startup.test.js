'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

async function launch(t, directory, cwd = join(__dirname, '..')) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [join(__dirname, '../server.js')], {
    cwd,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  t.after(stop);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(Error('Service exited during startup')); });
  });
  const resetKey = /Account reset key \(rotates on startup\): ([a-f0-9]{64})/.exec(output)?.[1];
  assert.ok(resetKey, 'startup logs must contain a random reset key');
  return { resetKey, base: `http://127.0.0.1:${port}`, stop };
}

test('real startup serves the admin, persists initialization and rotates the logged reset key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await launch(t, directory);
  const home = await fetch(first.base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /订阅管理/);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const setup = await fetch(first.base + '/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ' admin ', password: 'password123' }) });
  assert.equal(setup.status, 201);
  await first.stop();
  const second = await launch(t, directory);
  assert.notEqual(second.resetKey, first.resetKey);
  assert.equal((await (await fetch(second.base + '/api/status')).json()).initialized, true);
  const reset = key => fetch(second.base + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, username: 'new-admin', password: 'new-password123' }) });
  assert.equal((await reset(first.resetKey)).status, 403);
  assert.equal((await reset(second.resetKey)).status, 200);
  await second.stop();
});

test('startup outside the repository still resolves bundled templates and browser assets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'managed-startup-cwd-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await launch(t, join(directory, 'state'), directory);
  const home = await fetch(app.base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /订阅管理/);
  const script = await fetch(`${app.base}/admin.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const status = await fetch(`${app.base}/api/status`);
  assert.deepEqual(await status.json(), { initialized: false, authenticated: false });
  await app.stop();
});
