'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { readFile, writeFile, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const YAML = require('yaml');
const { AppError } = require('./auth');
const { fetchOne, SubscriptionError } = require('./fetch-subscriptions');
const { transformConfig } = require('./transform');

const CACHE_MS = 23 * 60 * 60 * 1000;
const DEFAULT_AGENT = 'clash-verge/v2.4.5';
const RESOURCES = ['sources', 'templates', 'subscriptions'];

function text(value, label, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new AppError(`${label}必填，且不能超过 ${maximum} 个字符`);
  }
  return value.trim();
}

function validateTemplate(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new AppError('模板不能为空，且不能超过 1 MiB');
  try { transformConfig(YAML.parse(content), []); }
  catch (error) { throw new AppError(`模板校验失败：${error.message}`); }
  return content;
}

// Do not expose credentials in the authority, query values or secret path segments.
function summarizeUrl(raw) {
  const url = new URL(raw);
  const path = url.pathname === '/' ? '/' : '/•••';
  return `${url.protocol}//${url.host}${path}${url.search ? '?•••' : ''}`;
}

function find(state, resource, id) {
  const record = state[resource]?.find(row => row.id === id);
  if (!record) throw new AppError('记录不存在', 404);
  return record;
}

class Managed {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options;
    this.now = options.now || Date.now;
    this.inflight = new Map();
  }

  get(resource, id) {
    if (!RESOURCES.includes(resource)) throw new AppError('记录类型不存在', 404);
    const record = find(this.store.read(), resource, id);
    if (resource === 'subscriptions') {
      const { cache, ...safe } = record;
      return safe;
    }
    return record;
  }

  status(record) {
    if (!record.cache) return 'empty';
    if (record.cache.revision !== record.revision) return 'invalidated';
    return this.now() - record.lastSuccessAt >= CACHE_MS ? 'expired' : 'valid';
  }

  list() {
    const state = this.store.read();
    return {
      sources: state.sources.map(({ url, ...row }) => ({ ...row, urlSummary: summarizeUrl(url) })),
      templates: state.templates.map(({ content, ...row }) => row),
      subscriptions: state.subscriptions.map(({ cache, ...row }) => ({
        ...row,
        sourceNames: row.sourceIds.map(id => find(state, 'sources', id).name),
        templateName: find(state, 'templates', row.templateId).name,
        cacheStatus: this.status({ ...row, cache }),
        refreshing: this.inflight.has(row.id)
      }))
    };
  }

  async save(resource, input, id) {
    if (!RESOURCES.includes(resource)) throw new AppError('记录类型不存在', 404);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('请求内容无效');
    const name = text(input.name, '名称');
    let fields;
    if (resource === 'sources') {
      const rawUrl = text(input.url, '订阅链接', 8192);
      let url;
      try { url = new URL(rawUrl); } catch { throw new AppError('订阅链接格式无效'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new AppError('订阅链接须为 HTTP/HTTPS，且不包含账号密码或片段');
      }
      const userAgent = text(input.userAgent ?? DEFAULT_AGENT, 'User-Agent', 512);
      if (!/^[\x20-\x7e]+$/.test(userAgent)) throw new AppError('User-Agent 只能包含可打印 ASCII 字符');
      fields = { name, url: url.href, userAgent };
    } else if (resource === 'templates') {
      fields = { name, content: validateTemplate(input.content) };
    } else {
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 50 || input.sourceIds.some(v => typeof v !== 'string')) {
        throw new AppError('请选择 1–50 个第三方订阅源');
      }
      fields = { name, sourceIds: [...new Set(input.sourceIds)], templateId: input.templateId };
    }
    return this.store.update(state => {
      const existing = id ? find(state, resource, id) : null;
      if (resource === 'subscriptions') {
        for (const sourceId of fields.sourceIds) find(state, 'sources', sourceId);
        find(state, 'templates', fields.templateId);
      }
      let changed = false;
      if (existing) {
        if (resource === 'sources') changed = existing.url !== fields.url || existing.userAgent !== fields.userAgent;
        if (resource === 'templates') changed = existing.content !== fields.content;
        if (resource === 'subscriptions') changed = JSON.stringify(existing.sourceIds) !== JSON.stringify(fields.sourceIds) || existing.templateId !== fields.templateId;
        Object.assign(existing, fields);
      } else {
        const record = { id: randomUUID(), ...fields };
        if (resource === 'subscriptions') Object.assign(record, { key: randomBytes(24).toString('hex'), revision: 1, cache: null, lastSuccessAt: null, lastResult: null });
        state[resource].push(record);
        return resource === 'subscriptions' ? { ...record, cache: undefined } : record;
      }
      if (changed) {
        for (const sub of state.subscriptions) {
          if ((resource === 'subscriptions' && sub.id === id)
            || (resource === 'sources' && sub.sourceIds.includes(id))
            || (resource === 'templates' && sub.templateId === id)) sub.revision += 1;
        }
      }
      const { cache, ...safe } = existing;
      return safe;
    });
  }

  async remove(resource, id) {
    if (!RESOURCES.includes(resource)) throw new AppError('记录类型不存在', 404);
    let cache;
    await this.store.update(state => {
      const record = find(state, resource, id);
      if (resource !== 'subscriptions' && state.subscriptions.some(sub => resource === 'sources' ? sub.sourceIds.includes(id) : sub.templateId === id)) {
        throw new AppError('记录正在被系统订阅引用，请先调整关联', 409);
      }
      cache = record.cache;
      state[resource] = state[resource].filter(row => row.id !== id);
    });
    if (cache) await this.discard(cache.file);
  }

  async discard(file) { await unlink(join(this.store.directory, file)).catch(() => {}); }

  async cached(record) {
    if (!record.cache) return null;
    try { return await readFile(join(this.store.directory, record.cache.file), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  refresh(id) {
    const state = this.store.read();
    const sub = find(state, 'subscriptions', id);
    const current = this.inflight.get(id);
    if (current?.revision === sub.revision) return current.promise;
    const job = { revision: sub.revision };
    job.promise = this.performRefresh(state, sub).finally(() => {
      if (this.inflight.get(id) === job) this.inflight.delete(id);
    });
    this.inflight.set(id, job);
    return job.promise;
  }

  async performRefresh(snapshot, sub) {
    let file;
    let previous;
    try {
      const lists = await Promise.all(sub.sourceIds.map(async id => {
        const source = find(snapshot, 'sources', id);
        return fetchOne(new URL(source.url), { ...this.options, userAgent: source.userAgent });
      }));
      const template = YAML.parse(find(snapshot, 'templates', sub.templateId).content);
      const body = YAML.stringify(transformConfig(template, lists), { lineWidth: 0 });
      file = `cache-${randomUUID()}.yaml`;
      await writeFile(join(this.store.directory, file), body, { encoding: 'utf8', mode: 0o600 });
      await this.store.update(state => {
        const record = find(state, 'subscriptions', sub.id);
        if (record.revision !== sub.revision) throw new AppError('配置已变更，请重新刷新', 409);
        previous = record.cache?.file;
        record.cache = { file, revision: sub.revision };
        record.lastSuccessAt = this.now();
        record.lastResult = { ok: true, message: '刷新成功', at: this.now() };
      });
      if (previous) await this.discard(previous);
      return { id: sub.id, name: sub.name, ok: true, message: '刷新成功' };
    } catch (error) {
      if (file) await this.discard(file);
      const message = error instanceof SubscriptionError || error instanceof AppError ? error.message : '刷新失败，请稍后重试';
      await this.store.update(state => {
        const record = state.subscriptions.find(row => row.id === sub.id);
        if (record?.revision === sub.revision) record.lastResult = { ok: false, message, at: this.now() };
      });
      if (error instanceof SubscriptionError || error instanceof AppError) throw error;
      throw new AppError(message, 502);
    }
  }

  async content(key) {
    let record = this.store.read().subscriptions.find(row => row.key === key);
    if (!record) throw new AppError('订阅不存在', 404);
    if (this.status(record) === 'valid') {
      const body = await this.cached(record);
      if (body !== null) return { body, stale: false };
    }
    let failure;
    try { await this.refresh(record.id); } catch (error) { failure = error; }
    record = this.store.read().subscriptions.find(row => row.id === record.id);
    if (!record) throw new AppError('订阅不存在', 404);
    const body = await this.cached(record);
    if (body !== null) return { body, stale: Boolean(failure) || this.status(record) !== 'valid' };
    throw failure || new AppError('订阅缓存不可用，请重新刷新', 502);
  }

  async refreshAll() {
    const items = this.store.read().subscriptions;
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try { results[index] = await this.refresh(items[index].id); }
        catch (error) { results[index] = { id: items[index].id, name: items[index].name, ok: false, message: error.message }; }
      }
    }));
    return results;
  }
}

module.exports = { Managed, CACHE_MS, DEFAULT_AGENT, validateTemplate };
