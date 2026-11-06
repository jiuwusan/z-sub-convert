'use strict';
const { AppError } = require('../utils/errors');
const { sendJson } = require('../utils/http-response');
const { securityHeaders } = require('../middleware/security-headers');
const { adminError, publicError, publicErrorDetails } = require('../middleware/error-handler');
const { createCallRecorder } = require('../middleware/call-record');
function createRouter({ ready, subscription, system, assetPaths, now, logger }) {
  return async function route(request, response) {
    const metadata = { calledAt: now(), started: performance.now() };
    securityHeaders(response);
    const url = new URL(request.url || '/', 'http://localhost');
    const headOnly = request.method === 'HEAD';
    if (url.pathname.startsWith('/api/') || assetPaths.has(url.pathname)) {
      try {
        const context = await ready;
        if (!context) throw new AppError('后台尚未启用，请配置 DATA_DIR', 503);
        if (url.pathname.startsWith('/api/')) await context.admin(request, response, url);
        else await system.asset(request, response, url);
      } catch (error) { adminError(error, response, headOnly, logger); }
      return;
    }
    if (request.method !== 'GET' && !headOnly) {
      sendJson(response, 405, { error: 'Method not allowed' }, false, { allow: 'GET, HEAD' });
      return;
    }
    if (url.pathname === '/version') { system.version(request, response); return; }
    if (url.pathname !== '/sub') { sendJson(response, 404, { error: 'Not found' }, headOnly); return; }
    const invocation = createCallRecorder(request, response, metadata, logger);
    try { await subscription.download(request, response, url, invocation); }
    catch (error) {
      const details = publicErrorDetails(error);
      invocation.fail(details.message);
      publicError(error, response, headOnly, logger, details);
    }
  };
}
module.exports = { createRouter };
