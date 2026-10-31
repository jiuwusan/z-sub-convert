'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { readFile, writeFile, unlink } = require('node:fs/promises');
const { join } = require('node:path');
const YAML = require('yaml');
const { AppError } = require('./auth');
const { fetchSubscriptionDocument, parseSubscriptionDocument, SubscriptionError } = require('./fetch-subscriptions');
const { transformConfig } = require('./transform');
const { aggregateUserinfo } = require('./userinfo');
const { parseTemplate, validateRuleTemplate: validateTemplate, chooseNameservers, composeTemplate } = require('./template-parts');

const CACHE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_AGENT = 'clash-verge/v2.4.5';
const RESOURCES = ['sources', 'bases', 'nameservers', 'templates', 'subscriptions'];

function text(value, label, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new AppError(`${label}必填，且不能超过 ${maximum} 个字符`);
  }
  return value.trim();
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
    const { cache, ...safe } = record;
    return safe;
  }

  status(record) {
    if (!record.cache) return 'empty';
    if (record.cache.revision !== record.revision) return 'invalidated';
    return this.now() - record.lastSuccessAt >= CACHE_MS ? 'expired' : 'valid';
  }

  list() {
    const state = this.store.read();
    return {
      sources: state.sources.map(({ url, cache, ...row }) => ({
        ...row, urlSummary: summarizeUrl(url), cacheStatus: this.status({ ...row, cache }), refreshing: this.inflight.has(row.id),
        userInfo: cache?.userInfo ?? null
      })),
      templates: state.templates.map(({ content, ...row }) => row),
      bases: state.bases.map(({ content, ...row }) => row),
      nameservers: state.nameservers,
      subscriptions: state.subscriptions.map(row => ({
        ...row,
        sourceNames: row.sourceIds.map(id => find(state, 'sources', id).name),
        templateName: find(state, 'templates', row.templateId).name,
        baseName: find(state, 'bases', row.baseId).name,
        nameserverNames: row.nameserverIds.map(id => find(state, 'nameservers', id).name),
        ...this.packageInfo([...new Set(row.sourceIds)].map(id => find(state, 'sources', id).cache?.userInfo))
      }))
    };
  }

  packageInfo(items) {
    const { userInfo, coverage } = aggregateUserinfo(items);
    return { userInfo, packageCoverage: coverage };
  }

  subscriptionInfo(id) {
    const state = this.store.read();
    const sub = find(state, 'subscriptions', id);
    const sources = [...new Set(sub.sourceIds)].map(sourceId => find(state, 'sources', sourceId));
    return { name: sub.name, ...this.packageInfo(sources.map(source => source.cache?.userInfo)),
      stale: sources.some(source => this.status(source) !== 'valid') };
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
    } else if (resource === 'bases') {
      parseTemplate(input.content);
      fields = { name, content: input.content };
    } else if (resource === 'nameservers') {
      const address = text(input.address, 'nameserver 地址', 8192);
      if (/[\r\n]/.test(address)) throw new AppError('每条 nameserver 只能维护一个地址');
      fields = { name, address };
    } else {
      if (!Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 50 || input.sourceIds.some(v => typeof v !== 'string')) {
        throw new AppError('请选择 1–50 个第三方订阅源');
      }
      if (!Array.isArray(input.nameserverIds) || input.nameserverIds.length > 50 || input.nameserverIds.some(id => typeof id !== 'string')) {
        throw new AppError('请选择不超过 50 个 nameserver');
      }
      if (input.useSourceNameservers !== undefined && typeof input.useSourceNameservers !== 'boolean') throw new AppError('订阅源 nameserver 开关无效');
      if (!input.useSourceNameservers && !input.nameserverIds.length) throw new AppError('请至少选择一个 nameserver');
      fields = { name, sourceIds: [...new Set(input.sourceIds)], templateId: input.templateId,
        baseId: input.baseId, nameserverIds: [...new Set(input.nameserverIds)], useSourceNameservers: input.useSourceNameservers ?? false };
    }
    return this.store.update(state => {
      const existing = id ? find(state, resource, id) : null;
      if (resource === 'subscriptions') {
        for (const sourceId of fields.sourceIds) find(state, 'sources', sourceId);
        find(state, 'templates', fields.templateId);
        find(state, 'bases', fields.baseId);
        for (const nameserverId of fields.nameserverIds) find(state, 'nameservers', nameserverId);
      }
      let changed = false;
      if (existing) {
        if (resource === 'sources') changed = existing.url !== fields.url || existing.userAgent !== fields.userAgent;
        Object.assign(existing, fields);
      } else {
        const record = { id: randomUUID(), ...fields };
        if (resource === 'subscriptions') record.key = randomBytes(24).toString('hex');
        if (resource === 'sources') Object.assign(record, { revision: 1, cache: null, lastSuccessAt: null, lastResult: null });
        state[resource].push(record);
        const { cache, ...safe } = record;
        return safe;
      }
      if (changed) existing.revision += 1;
      const { cache, ...safe } = existing;
      return safe;
    });
  }

  async remove(resource, id) {
    if (!RESOURCES.includes(resource)) throw new AppError('记录类型不存在', 404);
    let cache;
    await this.store.update(state => {
      const record = find(state, resource, id);
      if (resource !== 'subscriptions' && state.subscriptions.some(sub => resource === 'sources' ? sub.sourceIds.includes(id)
        : resource === 'bases' ? sub.baseId === id : resource === 'nameservers' ? sub.nameserverIds.includes(id) : sub.templateId === id)) {
        throw new AppError('记录正在被系统订阅引用，请先调整关联', 409);
      }
      cache = record.cache;
      state[resource] = state[resource].filter(row => row.id !== id);
    });
    if (cache) await this.discard(cache.file);
    if (resource === 'subscriptions' && this.options.callRecords) {
      await this.options.callRecords.remove(id).catch(() => this.options.logger?.error('Unable to remove subscription call records'));
    }
    if (resource === 'sources' && this.options.sourceRecords) {
      await this.options.sourceRecords.remove(id).catch(() => this.options.logger?.error('Unable to remove source refresh records'));
    }
  }

  async discard(file) { await unlink(join(this.store.directory, file)).catch(() => {}); }

  async cached(record) {
    if (!record.cache) return null;
    try {
      const content = await readFile(join(this.store.directory, record.cache.file), 'utf8');
      if (record.cache.file.endsWith('.yaml')) return { ...parseSubscriptionDocument(content), content };
      const proxies = JSON.parse(content);
      return Array.isArray(proxies) && proxies.length && proxies.every(proxy => proxy && typeof proxy.type === 'string' && proxy.type.trim())
        ? { proxies, content: null } : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError || error instanceof SubscriptionError) return null;
      throw error;
    }
  }

  refresh(id, trigger = 'manual') {
    const source = find(this.store.read(), 'sources', id);
    const current = this.inflight.get(id);
    if (current?.revision === source.revision) return current.promise;
    const job = { revision: source.revision };
    job.promise = this.performRefresh(source, trigger).finally(() => {
      if (this.inflight.get(id) === job) this.inflight.delete(id);
    });
    this.inflight.set(id, job);
    return job.promise;
  }

  async performRefresh(source, trigger) {
    let file;
    let previous;
    const at = this.now();
    const started = performance.now();
    const outcome = { status: 200, error: null };
    try {
      const { content, userInfo } = await fetchSubscriptionDocument(new URL(source.url), { ...this.options, userAgent: source.userAgent });
      file = `source-cache-${randomUUID()}.yaml`;
      await writeFile(join(this.store.directory, file), content, { encoding: 'utf8', mode: 0o600 });
      await this.store.update(state => {
        const record = find(state, 'sources', source.id);
        if (record.revision !== source.revision) throw new AppError('配置已变更，请重试更新', 409);
        previous = record.cache?.file;
        record.cache = { file, revision: source.revision, userInfo };
        record.lastSuccessAt = this.now();
        record.lastResult = { ok: true, message: '更新成功', at: this.now() };
      });
      if (previous) await this.discard(previous);
      return { id: source.id, name: source.name, ok: true, message: '更新成功' };
    } catch (error) {
      if (file) await this.discard(file);
      const message = error instanceof SubscriptionError || error instanceof AppError ? error.message : '更新失败，请稍后重试';
      outcome.status = error instanceof SubscriptionError || error instanceof AppError ? error.statusCode : 502;
      outcome.error = message;
      await this.store.update(state => {
        const record = state.sources.find(row => row.id === source.id);
        if (record?.revision === source.revision) record.lastResult = { ok: false, message, at: this.now() };
      });
      if (error instanceof SubscriptionError || error instanceof AppError) throw error;
      throw new AppError(message, 502);
    } finally {
      if (this.options.sourceRecords) {
        this.options.sourceRecords.append(source.id, { at, method: 'GET', trigger, userAgent: source.userAgent,
          ...outcome, durationMs: performance.now() - started }).catch(() => this.options.logger?.error('Unable to save source refresh record'));
      }
    }
  }

  async currentSource(id) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const source = find(this.store.read(), 'sources', id);
      const cached = await this.cached(source);
      const current = find(this.store.read(), 'sources', id);
      if (current.revision !== source.revision || current.cache?.file !== source.cache?.file) continue;
      return { source, proxies: cached?.proxies ?? null, content: cached?.content ?? null, nameservers: cached?.nameservers ?? [] };
    }
    throw new AppError('来源正在更新，请重试', 409);
  }

  async sourceContent(id) {
    let { source, proxies, nameservers } = await this.currentSource(id);
    if (proxies !== null && (this.status(source) === 'valid' || this.inflight.get(id)?.revision === source.revision)) {
      return { proxies, nameservers, userInfo: source.cache?.userInfo ?? null, revision: source.revision, stale: this.status(source) !== 'valid' };
    }
    let failure;
    try { await this.refresh(id, 'on-demand'); } catch (error) { failure = error; }
    ({ source, proxies, nameservers } = await this.currentSource(id));
    if (proxies !== null) return { proxies, nameservers, userInfo: source.cache?.userInfo ?? null, revision: source.revision, stale: Boolean(failure) || this.status(source) !== 'valid' };
    throw failure || new AppError('来源缓存不可用，请重试更新', 502);
  }

  async preview(id) {
    const { source, proxies, content } = await this.currentSource(id);
    return {
      name: source.name,
      cacheStatus: proxies === null ? 'empty' : this.status(source),
      lastSuccessAt: source.lastSuccessAt,
      proxyCount: proxies?.length || 0,
      content,
      userInfo: proxies === null ? null : source.cache?.userInfo ?? null,
      requiresUpdate: proxies !== null && content === null
    };
  }

  configuration(state, sub) {
    return JSON.stringify([sub.sourceIds, sub.templateId, find(state, 'templates', sub.templateId).content,
      sub.baseId, find(state, 'bases', sub.baseId).content, sub.useSourceNameservers, sub.nameserverIds,
      sub.nameserverIds.map(id => find(state, 'nameservers', id).address),
      sub.sourceIds.map(id => find(state, 'sources', id).revision)]);
  }

  async content(key) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = this.store.read();
      const sub = snapshot.subscriptions.find(row => row.key === key);
      if (!sub) throw new AppError('订阅不存在', 404);
      const configuration = this.configuration(snapshot, sub);
      const sourceIds = [...new Set(sub.sourceIds)];
      const results = await Promise.allSettled(sourceIds.map(id => this.sourceContent(id)));
      const latest = this.store.read();
      const current = latest.subscriptions.find(row => row.key === key);
      if (!current) throw new AppError('订阅不存在', 404);
      if (this.configuration(latest, current) !== configuration) continue;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const sources = results.map(result => result.value);
      if (sources.some((result, index) => result.revision !== find(snapshot, 'sources', sourceIds[index]).revision)) continue;
      const nameservers = chooseNameservers(current.useSourceNameservers, sources.map(result => result.nameservers),
        current.nameserverIds.map(id => find(latest, 'nameservers', id).address));
      const template = composeTemplate(find(latest, 'bases', current.baseId).content, find(latest, 'templates', current.templateId).content, nameservers);
      const body = YAML.stringify(transformConfig(template, sources.map(result => result.proxies)), { lineWidth: 0 });
      return { name: current.name, body, stale: sources.some(result => result.stale), ...this.packageInfo(sources.map(result => result.userInfo)) };
    }
    throw new AppError('配置已变更，请重试', 409);
  }

  async refreshAll() {
    const items = this.store.read().sources;
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try { results[index] = await this.refresh(items[index].id, 'all'); }
        catch (error) { results[index] = { id: items[index].id, name: items[index].name, ok: false, message: error.message }; }
      }
    }));
    return results;
  }
}

module.exports = { Managed, CACHE_MS, DEFAULT_AGENT, validateTemplate };
