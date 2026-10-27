'use strict';

const { mkdir, readFile, writeFile, rename, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

class Store {
  static async open({ directory, templatePath }) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new Store(directory);
    try {
      store.state = JSON.parse(await readFile(store.path, 'utf8'));
      if (![1, 2].includes(store.state.version) || !['sources', 'templates', 'subscriptions'].every(k => Array.isArray(store.state[k]))) {
        throw new Error('Unsupported or invalid data file');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const content = await readFile(templatePath, 'utf8');
      store.state = { version: 2, account: null, sources: [], templates: [{ id: randomUUID(), name: '默认模板', content }], subscriptions: [] };
      await store.persist(store.state);
    }
    if (store.state.version === 1) {
      const obsolete = store.state.subscriptions.map(row => row.cache?.file).filter(file => /^cache-[a-z0-9-]+\.yaml$/.test(file || ''));
      await store.update(state => {
        state.version = 2;
        for (const source of state.sources) Object.assign(source, { revision: 1, cache: null, lastSuccessAt: null, lastResult: null });
        for (const sub of state.subscriptions) {
          for (const key of ['cache', 'revision', 'lastSuccessAt', 'lastResult']) delete sub[key];
        }
      });
      for (const file of obsolete) await unlink(join(directory, file)).catch(() => {});
    }
    return store;
  }

  constructor(directory) {
    this.directory = directory;
    this.path = join(directory, 'state.json');
    this.queue = Promise.resolve();
  }

  read() { return structuredClone(this.state); }

  async persist(state) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  update(change) {
    const work = this.queue.then(async () => {
      const next = this.read();
      const result = await change(next);
      await this.persist(next);
      this.state = next;
      return structuredClone(result);
    });
    this.queue = work.catch(() => {});
    return work;
  }
}

module.exports = { Store };
