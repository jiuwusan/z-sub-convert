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

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    const headOnly = request.method === 'HEAD';

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
      const statusCode = error instanceof SubscriptionError || error instanceof TemplateError
        ? error.statusCode
        : 500;
      const message = statusCode === 500 && !(error instanceof TemplateError)
        ? 'Internal server error'
        : error.message;
      logger.error(`${error.name || 'Error'}: ${message}`);
      sendJson(response, statusCode, { error: message }, headOnly);
    }
  });
}

function start() {
  const host = process.env.HOST || '0.0.0.0';
  const port = positiveInteger(process.env.PORT, 25500, 'PORT');
  const server = createApp();
  server.listen(port, host, () => {
    console.log(`clash-sub-convert listening on http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = {
  createApp,
  start
};
