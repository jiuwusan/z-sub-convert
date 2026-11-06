'use strict';

const { AppError } = require('../utils/errors');
const { createAuthController } = require('../controllers/auth.controller');
const { createAdminController } = require('../controllers/admin.controller');
const { tokenFrom, sessionFrom, checkOrigin, requireSession, checkCsrf } = require('../middleware/admin-security');
const { readJson } = require('../middleware/json-body');
const { createRateLimit } = require('../middleware/rate-limit');

function createAdminHandler({ managed, auth, callRecords, sourceRecords, notifications, now = Date.now }) {
  const account = createAuthController({ auth, readJson });
  const controller = createAdminController({ managed, callRecords, sourceRecords, notifications, readJson, now });
  const rateLimit = createRateLimit();

  return async function admin(request, response, url) {
    const path = url.pathname;
    const method = request.method;
    const token = tokenFrom(request);
    response.setHeader('cache-control', 'no-store');
    if (path === '/api/status' && method === 'GET') return account.status(request, response, token);
    const session = sessionFrom(auth, token);
    const write = !['GET', 'HEAD'].includes(method);
    if (write) checkOrigin(request);
    if (['/api/setup', '/api/login', '/api/reset'].includes(path) && method === 'POST') {
      const clearRate = rateLimit(request, path);
      return account[path.slice('/api/'.length)](request, response, clearRate);
    }
    requireSession(session);
    if (write) checkCsrf(request, session);
    if (path === '/api/logout' && method === 'POST') return account.logout(request, response, token);
    if (path === '/api/state' && method === 'GET') return controller.state(request, response);
    if (path === '/api/subscriptions/countries') {
      if (method !== 'POST') throw new AppError('请求方法不允许', 405);
      return controller.countries(request, response);
    }
    if (path === '/api/notifications') {
      if (method === 'GET') return controller.notificationSettings(request, response);
      if (method === 'PUT') return controller.saveNotifications(request, response);
      throw new AppError('请求方法不允许', 405);
    }
    if (path.startsWith('/api/notifications/test/') && method === 'POST') {
      return controller.testNotification(request, response, path.slice('/api/notifications/test/'.length));
    }
    if (path === '/api/sources/refresh-all' && method === 'POST') return controller.refreshAll(request, response);
    const match = /^\/api\/(sources|bases|nameservers|templates|subscriptions)(?:\/([a-zA-Z0-9-]+))?(\/(?:refresh|preview|download|calls|updates))?$/.exec(path);
    if (!match) throw new AppError('接口不存在', 404);
    const [, resource, id, action] = match;
    const params = { resource, id };
    if (action === '/calls' || action === '/updates') {
      const sourceHistory = action === '/updates';
      if (resource !== (sourceHistory ? 'sources' : 'subscriptions') || !id || method !== 'GET') throw new AppError('接口不存在', 404);
      return controller.history(request, response, url, { ...params, sourceHistory });
    }
    if (action === '/download') {
      if (!id || !['GET', 'HEAD'].includes(method) || resource === 'nameservers') throw new AppError('接口不存在', 404);
      return controller.download(request, response, params);
    }
    if (action === '/preview') {
      if (resource !== 'sources' || !id || method !== 'GET') throw new AppError('接口不存在', 404);
      return controller.preview(request, response, id);
    }
    if (action) {
      if (resource !== 'sources' || !id || method !== 'POST') throw new AppError('接口不存在', 404);
      return controller.refresh(request, response, id);
    }
    if (id && method === 'GET') return controller.get(request, response, params);
    if (!id && method === 'POST') return controller.create(request, response, resource);
    if (id && method === 'PATCH') return controller.update(request, response, params);
    if (id && method === 'DELETE') return controller.remove(request, response, params);
    throw new AppError('请求方法不允许', 405);
  };
}

module.exports = { createAdminHandler };
