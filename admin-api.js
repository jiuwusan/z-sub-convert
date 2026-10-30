'use strict';

const { AppError, equal, SESSION_MS } = require('./auth');
const { sendDownload } = require('./download');
const MAX_BODY = 2 * 1024 * 1024;

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new AppError('请使用 application/json', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) {
      // Drain the remaining request so the connection can receive the error response.
      request.resume();
      throw new AppError('请求内容不能超过 2 MiB', 413);
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('JSON 格式无效'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('请求内容须为 JSON 对象');
  return data;
}

function tokenFrom(request) {
  return (request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('sub_session='))?.slice(12);
}

function checkOrigin(request) {
  if (!request.headers.origin) return;
  try {
    const origin = new URL(request.headers.origin);
    if (['https:', 'http:'].includes(origin.protocol) && origin.host === request.headers.host) return;
  } catch {}
  throw new AppError('请求来源不允许', 403);
}

function createAdminHandler({ managed, auth, store, now = Date.now }) {
  const attempts = new Map();
  function rateLimit(request, path) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = `${request.socket.remoteAddress}:${path}`;
    const value = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (value.count >= 10) throw new AppError('尝试次数过多，请 15 分钟后重试', 429);
    if (attempts.size >= 1024 && !attempts.has(key)) throw new AppError('请求过于频繁，请稍后重试', 429);
    value.count += 1;
    attempts.set(key, value);
    return () => attempts.delete(key);
  }

  return async function admin(request, response, url) {
    const path = url.pathname;
    const method = request.method;
    const token = tokenFrom(request);
    const session = auth.session(token);
    response.setHeader('cache-control', 'no-store');
    const json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(method === 'HEAD' ? undefined : JSON.stringify(body));
    };
    if (path === '/api/status' && method === 'GET') {
      json(200, { initialized: Boolean(store.read().account), authenticated: Boolean(session), ...(session ? { username: session.username, csrf: session.csrf } : {}) });
      return;
    }
    const write = !['GET', 'HEAD'].includes(method);
    if (write) checkOrigin(request);
    if (['/api/setup', '/api/login', '/api/reset'].includes(path) && method === 'POST') {
      const clearRate = rateLimit(request, path);
      const data = await readJson(request);
      if (path === '/api/setup') {
        await auth.setup(data.username, data.password);
        clearRate();
        json(201, { ok: true });
      } else if (path === '/api/reset') {
        await auth.reset(data.key, data.username, data.password);
        clearRate();
        response.setHeader('set-cookie', 'sub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        json(200, { ok: true });
      } else {
        const loggedIn = await auth.login(data.username, data.password);
        clearRate();
        const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
        response.setHeader('set-cookie', `sub_session=${loggedIn.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
        json(200, { username: loggedIn.username, csrf: loggedIn.csrf });
      }
      return;
    }
    if (!session) throw new AppError('请先登录', 401);
    if (write && !equal(request.headers['x-csrf-token'], session.csrf)) throw new AppError('页面会话已失效，请刷新后重试', 403);
    if (path === '/api/logout' && method === 'POST') {
      auth.logout(token);
      response.setHeader('set-cookie', 'sub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
      json(200, { ok: true });
      return;
    }
    if (path === '/api/state' && method === 'GET') { json(200, managed.list()); return; }
    if (path === '/api/sources/refresh-all' && method === 'POST') {
      json(200, { results: await managed.refreshAll() });
      return;
    }
    const match = /^\/api\/(sources|templates|subscriptions)(?:\/([a-zA-Z0-9-]+))?(\/(?:refresh|preview|download))?$/.exec(path);
    if (!match) throw new AppError('接口不存在', 404);
    const [, resource, id, action] = match;
    if (action === '/download') {
      if (!id || !['GET', 'HEAD'].includes(method)) throw new AppError('接口不存在', 404);
      if (resource === 'sources') {
        const preview = await managed.preview(id);
        if (preview.content === null) throw new AppError(preview.requiresUpdate
          ? '旧缓存仅包含节点，请先更新来源后下载完整订阅结果' : '暂无可用缓存，请先更新来源后下载', 409);
        sendDownload(response, { name: preview.name, content: preview.content, timestamp: now(), headOnly: method === 'HEAD', userInfo: preview.userInfo });
      } else if (resource === 'subscriptions') {
        const sub = managed.get(resource, id);
        const result = method === 'HEAD' ? { ...managed.subscriptionInfo(id), body: '' } : await managed.content(sub.key);
        sendDownload(response, { name: result.name, content: result.body, timestamp: now(), headOnly: method === 'HEAD', stale: result.stale, userInfo: result.userInfo });
      } else throw new AppError('接口不存在', 404);
    } else if (action === '/preview') {
      if (resource !== 'sources' || !id || method !== 'GET') throw new AppError('接口不存在', 404);
      json(200, await managed.preview(id));
    } else if (action) {
      if (resource !== 'sources' || !id || method !== 'POST') throw new AppError('接口不存在', 404);
      json(200, await managed.refresh(id));
    } else if (id && method === 'GET') json(200, managed.get(resource, id));
    else if (!id && method === 'POST') json(201, await managed.save(resource, await readJson(request)));
    else if (id && method === 'PATCH') json(200, await managed.save(resource, await readJson(request), id));
    else if (id && method === 'DELETE') { await managed.remove(resource, id); json(200, { ok: true }); }
    else throw new AppError('请求方法不允许', 405);
  };
}

module.exports = { createAdminHandler };
