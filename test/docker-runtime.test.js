'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, appendFile, cp, access, symlink, rm, mkdir } = require('node:fs/promises');
const { join, relative } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

test('Docker source copy includes new runtime modules and excludes local configuration and data', async t => {
  const root = join(__dirname, '..');
  const directory = await mkdtemp(join(tmpdir(), 'sub-convert-docker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = join(directory, 'context');
  const runtime = join(directory, 'runtime');
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  // These tests cover the simple path and * patterns used by this project's .dockerignore.
  const patterns = (await readFile(join(root, '.dockerignore'), 'utf8')).split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => new RegExp(`(?:^|/)${line.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}(?:/|$)`));
  const copyContext = (source, destination) => cp(source, destination, { recursive: true,
    filter: file => !patterns.some(pattern => pattern.test(relative(source, file).replace(/\\/g, '/'))) });
  await copyContext(root, context);
  await writeFile(join(context, 'future-runtime.js'), 'module.exports = true;');
  await appendFile(join(context, 'server.js'), '\nrequire("./future-runtime");\n');
  await writeFile(join(context, '.env'), 'LOCAL_SECRET=test');
  await writeFile(join(context, '.env.production'), 'LOCAL_SECRET=test');
  await writeFile(join(context, 'private.key'), 'test-key');
  await writeFile(join(context, 'runtime.log'), 'test-log');
  await mkdir(join(context, 'data'), { recursive: true });
  await writeFile(join(context, 'data', 'state.json'), '{"private":"test"}');
  await mkdir(runtime);
  // Assemble the runtime from the actual COPY instructions, using the context ignore rules.
  for (const line of dockerfile.split(/\r?\n/)) {
    if (!/^COPY\s/.test(line)) continue;
    const paths = line.split(/\s+/).slice(1).filter(part => !part.startsWith('--'));
    const destination = paths.pop();
    if (!['.', './'].includes(destination)) continue;
    for (const file of paths) {
      if (file === '.') await copyContext(context, runtime);
      else await cp(join(context, file), join(runtime, file), { recursive: true });
    }
  }
  await symlink(join(root, 'node_modules'), join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = spawnSync(process.execPath, ['-e', "require('./server')"], {
    cwd: runtime, encoding: 'utf8', windowsHide: true, timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  for (const file of ['prds/template.yaml', 'public/index.html', 'public/admin.js', 'ecosystem.config.cjs']) {
    await access(join(runtime, file));
  }
  for (const file of ['.env', '.env.production', 'private.key', 'runtime.log', 'data/state.json', '.git', '.github', 'test', 'docs']) {
    await assert.rejects(access(join(runtime, file)), { code: 'ENOENT' });
  }
});
