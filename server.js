'use strict';

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const YAML = require('yaml');
const packageMetadata = require('./package.json');
const {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  SubscriptionError,
  fetchSubscriptions
} = require('./fetch-subscriptions');
const { transformConfig } = require('./transform');
const { Store } = require('./store');
const { Auth, AppError } = require('./auth');
const { Managed } = require('./managed');
const { createAdminHandler } = require('./admin-api');
const { sendDownload } = require('./download');

class TemplateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'TemplateError';
    this.statusCode = 500;
  }
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

async function loadTemplate(templatePath) {
  let source;
  try {
    source = await readFile(templatePath, 'utf8');
  } catch (error) {
    throw new TemplateError('Unable to load the configured template', { cause: error });
  }
  try {
    return YAML.parse(source);
  } catch (error) {
    throw new TemplateError('The configured template is not valid YAML', { cause: error });
  }
}

function send(response, statusCode, headers, body, headOnly) {
  response.writeHead(statusCode, headers);
  response.end(headOnly ? undefined : body);
}

function sendJson(response, statusCode, payload, headOnly = false, extraHeaders = {}) {
  send(response, statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders
  }, JSON.stringify(payload), headOnly);
}

function createApp(options = {}) {
  const templatePath = options.templatePath || process.env.TEMPLATE_PATH || path.join(__dirname, 'prds', 'template.yaml');
  const timeoutMs = options.timeoutMs ?? positiveInteger(process.env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'UPSTREAM_TIMEOUT_MS');
  const maxBytes = options.maxBytes ?? positiveInteger(process.env.MAX_UPSTREAM_BYTES, DEFAULT_MAX_BYTES, 'MAX_UPSTREAM_BYTES');
  const logger = options.logger || console;
  const now = options.now || Date.now;

  const dataDir = options.dataDir || process.env.DATA_DIR;
  const ready = dataDir ? Store.open({ directory: dataDir, templatePath }).then(store => {
    const auth = new Auth(store, { resetKey: options.resetKey, now });
    const managed = new Managed(store, { ...options, now, timeoutMs, maxBytes });
    return { store, auth, managed, admin: createAdminHandler({ store, auth, managed, now }) };
  }) : Promise.resolve(null);
  ready.catch(() => {}); // Request/startup paths report initialization failures.
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/admin': ['index.html', 'text/html; charset=utf-8'],
    '/admin/': ['index.html', 'text/html; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    '/router.js': ['router.js', 'text/javascript; charset=utf-8'],
    '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8']
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    const headOnly = request.method === 'HEAD';

    if (requestUrl.pathname.startsWith('/api/') || assets[requestUrl.pathname]) {
      try {
        const context = await ready;
        if (!context) throw new AppError('后台尚未启用，请配置 DATA_DIR', 503);
        if (requestUrl.pathname.startsWith('/api/')) await context.admin(request, response, requestUrl);
        else {
          if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('请求方法不允许', 405);
          const [file, type] = assets[requestUrl.pathname];
          const body = await readFile(path.join(__dirname, 'public', file));
          response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
          send(response, 200, { 'content-type': type, 'cache-control': 'no-cache' }, body, headOnly);
        }
      } catch (error) {
        const status = error instanceof AppError || error instanceof SubscriptionError ? error.statusCode : 500;
        sendJson(response, status, { error: status === 500 ? '服务暂不可用，请检查服务器日志' : error.message }, headOnly);
        if (status === 500) logger.error('Admin request failed');
      }
      return;
    }

    if (request.method !== 'GET' && !headOnly) {
      sendJson(response, 405, { error: 'Method not allowed' }, false, { allow: 'GET, HEAD' });
      return;
    }

    if (requestUrl.pathname === '/version') {
      sendJson(response, 200, {
        name: packageMetadata.name,
        version: packageMetadata.version
      }, headOnly);
      return;
    }

    if (requestUrl.pathname !== '/sub') {
      sendJson(response, 404, { error: 'Not found' }, headOnly);
      return;
    }

    try {
      if (requestUrl.searchParams.has('key')) {
        const context = await ready;
        if (!context) throw new AppError('订阅不存在', 404);
        const key = requestUrl.searchParams.get('key');
        if (headOnly) {
          const sub = context.store.read().subscriptions.find(row => row.key === key);
          if (!sub) throw new AppError('订阅不存在', 404);
          sendDownload(response, { ...context.managed.subscriptionInfo(sub.id), content: '', timestamp: now(), headOnly: true });
          return;
        }
        const result = await context.managed.content(key);
        sendDownload(response, { name: result.name, content: result.body, timestamp: now(), stale: result.stale, userInfo: result.userInfo });
        return;
      }
      const proxyLists = await fetchSubscriptions(requestUrl.searchParams.get('url'), {
        fetchImpl: options.fetchImpl,
        timeoutMs,
        maxBytes
      });
      const template = await loadTemplate(templatePath);
      let output;
      try {
        output = transformConfig(template, proxyLists);
      } catch (error) {
        throw new TemplateError('The configured template or upstream proxies have an invalid structure', { cause: error });
      }
      const body = YAML.stringify(output, { lineWidth: 0 });
      send(response, 200, {
        'content-type': 'text/yaml; charset=utf-8',
        'content-disposition': `attachment; filename="config-clash-meta-${now()}.yaml"`
      }, body, headOnly);
    } catch (error) {
      const statusCode = error instanceof SubscriptionError || error instanceof TemplateError || error instanceof AppError
        ? error.statusCode
        : 500;
      const message = statusCode === 500 && !(error instanceof TemplateError)
        ? 'Internal server error'
        : error.message;
      logger.error(`${error.name || 'Error'}: ${message}`);
      sendJson(response, statusCode, { error: message }, headOnly);
    }
  });
  server.ready = ready;
  return server;
}

function start() {
  const host = process.env.HOST || '0.0.0.0';
  const port = positiveInteger(process.env.PORT, 25500, 'PORT');
  const server = createApp({ dataDir: process.env.DATA_DIR || path.join(__dirname, 'data') });
  server.ready.then(context => {
    console.log(`Account reset key (rotates on startup): ${context.auth.resetKey}`);
    server.listen(port, host, () => {
      console.log(`clash-sub-convert listening on http://${host}:${port}`);
    });
  }).catch(() => {
    console.error('Unable to initialize data directory. Check DATA_DIR permissions and state.json.');
    process.exitCode = 1;
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  createApp,
  start
};
