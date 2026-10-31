'use strict';

const { mkdir, readdir, readFile, appendFile, writeFile, rename, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { AppError } = require('./auth');
const RETENTION_MS = 72 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const FILE_PATTERN = /^([a-zA-Z0-9-]+)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

class CallRecords {
  constructor(directory, { now = Date.now, isActive = () => true, logger = console, directoryName = 'call-records' } = {}) {
    if (!['call-records', 'source-refresh-records'].includes(directoryName)) throw new AppError('记录目录无效');
    this.directory = join(directory, directoryName);
    this.now = now;
    this.isActive = isActive;
    this.logger = logger;
    this.queues = new Map();
    this.closed = false;
  }

  validateId(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new AppError('调用记录标识无效', 400);
  }

  enqueue(id, work) {
    this.validateId(id);
    const job = (this.queues.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(id, job);
    job.finally(() => { if (this.queues.get(id) === job) this.queues.delete(id); }).catch(() => {});
    return job;
  }

  async files(id) {
    try {
      return (await readdir(this.directory)).filter(name => {
        const match = FILE_PATTERN.exec(name);
        return match && (!id || match[1] === id);
      }).sort();
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async read(name) {
    let content;
    try { content = await readFile(join(this.directory, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return content.split('\n').flatMap(line => {
      try {
        const row = JSON.parse(line);
        return row && typeof row.id === 'string' && Number.isFinite(row.at) && ['GET', 'HEAD'].includes(row.method) ? [row] : [];
      } catch { return []; }
    });
  }

  async append(id, input) {
    if (this.closed) return;
    return this.enqueue(id, async () => {
      if (!this.isActive(id) || input.at < this.now() - RETENTION_MS) return;
      if (!Number.isFinite(input.at) || !['GET', 'HEAD'].includes(input.method)) throw new AppError('调用记录内容无效');
      const clean = value => String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);
      const record = { id: randomUUID(), at: input.at, method: input.method, ip: clean(input.ip), userAgent: clean(input.userAgent),
        status: input.status, durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0,
        error: input.error ? clean(input.error) : null };
      if (['on-demand', 'manual', 'all'].includes(input.trigger)) record.trigger = input.trigger;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = `${id}-${new Date(record.at).toISOString().slice(0, 10)}.jsonl`;
      // Leading newline isolates a partial final line left by an interrupted append.
      await appendFile(join(this.directory, file), `\n${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
  }

  async list(id, page = 1) {
    this.validateId(id);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw new AppError('调用记录页码无效', 400);
    return this.enqueue(id, async () => {
      const records = [];
      for (const file of await this.files(id)) for (const row of await this.read(file)) records.push(row);
      const recent = records.filter(row => row.at >= this.now() - RETENTION_MS).reverse().sort((a, b) => b.at - a.at);
      return { records: recent.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: recent.length, page, pageSize: PAGE_SIZE };
    });
  }

  async remove(id) {
    return this.enqueue(id, async () => {
      for (const file of await this.files(id)) await unlink(join(this.directory, file));
    });
  }

  async cleanup() {
    if (this.closed) return;
    const ids = new Set((await this.files()).map(file => FILE_PATTERN.exec(file)[1]));
    for (const id of ids) {
      if (this.closed) return;
      await this.enqueue(id, async () => {
        if (this.closed) return;
        const cutoff = this.now() - RETENTION_MS;
        const day = new Date(cutoff).toISOString().slice(0, 10);
        for (const file of await this.files(id)) {
          const fileDay = FILE_PATTERN.exec(file)[2];
          if (!this.isActive(id) || fileDay < day) { await unlink(join(this.directory, file)); continue; }
          if (fileDay !== day) continue;
          const records = await this.read(file);
          const recent = records.filter(row => row.at >= cutoff);
          if (!recent.length) { await unlink(join(this.directory, file)); continue; }
          if (recent.length === records.length) continue;
          const temporary = join(this.directory, `${file}.${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, recent.map(row => JSON.stringify(row)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
            await rename(temporary, join(this.directory, file));
          } finally { await unlink(temporary).catch(() => {}); }
        }
      });
    }
  }

  start() {
    this.timer = setInterval(() => this.cleanup().catch(() => this.logger.error('Unable to clean subscription call records')), 15 * 60 * 1000);
    this.timer.unref();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.queues.values()]);
  }
}

module.exports = { CallRecords, RETENTION_MS };
