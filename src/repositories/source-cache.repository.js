'use strict';

const { readFile, writeFile, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseSubscriptionDocument } = require('../domain/subscription-parser');
const { SubscriptionError } = require('../utils/errors');

class SourceCacheRepository {
  constructor(directory) {
    this.directory = directory;
  }

  path(file) {
    return join(typeof this.directory === 'function' ? this.directory() : this.directory, file);
  }

  async write(content) {
    const file = `source-cache-${randomUUID()}.yaml`;
    try {
      await writeFile(this.path(file), content, { encoding: 'utf8', mode: 0o600 });
      return file;
    } catch (error) {
      await this.discard(file);
      throw error;
    }
  }

  async discard(file) {
    await unlink(this.path(file)).catch(() => {});
  }

  async read(cache) {
    if (!cache) return null;
    try {
      const content = await readFile(this.path(cache.file), 'utf8');
      if (cache.file.endsWith('.yaml')) return { ...parseSubscriptionDocument(content), content };
      const proxies = JSON.parse(content);
      return Array.isArray(proxies) && proxies.length && proxies.every(proxy => proxy && typeof proxy.type === 'string' && proxy.type.trim())
        ? { proxies, content: null } : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof SubscriptionError) return null;
      throw error;
    }
  }
}

module.exports = { SourceCacheRepository };
