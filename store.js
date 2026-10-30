'use strict';

const { mkdir, readFile, writeFile, rename, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const YAML = require('yaml');
const { splitTemplate } = require('./template-parts');
const DNS_NAMES = new Map([
  ['cloudflare-dns.com', 'Cloudflare'],
  ['dns.google', 'Google'],
  ['doh.pub', 'Tencent'],
  ['dns.alidns.com', 'Alidns']
]);

function defaultDnsName(address, index) {
  try { return DNS_NAMES.get(new URL(address).hostname) || `默认 DNS ${index + 1}`; }
  catch { return `默认 DNS ${index + 1}`; }
}

class Store {
  static async open({ directory, templatePath }) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new Store(directory);
    try {
      store.state = JSON.parse(await readFile(store.path, 'utf8'));
      if (store.state.version !== 3) {
        throw Object.assign(new Error('数据版本不兼容；请保留旧数据，使用新的 DATA_DIR 重新维护三类模板'), { code: 'UNSUPPORTED_DATA_VERSION' });
      }
      if (!['sources', 'bases', 'nameservers', 'templates', 'subscriptions'].every(k => Array.isArray(store.state[k]))) {
        throw new Error('Invalid data file');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const content = await readFile(templatePath, 'utf8');
      const parts = splitTemplate(YAML.parse(content));
      store.state = { version: 3, account: null, sources: [],
        bases: [{ id: randomUUID(), name: '默认模板', content: YAML.stringify(parts.base, { lineWidth: 0 }) }],
        nameservers: parts.nameservers.map((address, index) => ({ id: randomUUID(), name: defaultDnsName(address, index), address })),
        templates: [{ id: randomUUID(), name: '默认模板', content: YAML.stringify(parts.rules, { lineWidth: 0 }) }], subscriptions: [] };
      await store.persist(store.state);
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
