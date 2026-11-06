'use strict';
const path = require('node:path');
const ROOT_DIR = path.resolve(__dirname, '../..');
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function loadConfig(options = {}, env = process.env) {
  return {
    ...options,
    host: options.host || env.HOST || '0.0.0.0',
    port: options.port ?? positiveInteger(env.PORT, 25500, 'PORT'),
    templatePath: options.templatePath || env.TEMPLATE_PATH || path.join(ROOT_DIR, 'prds', 'template.yaml'),
    dataDir: options.dataDir || env.DATA_DIR || (options.defaultDataDir ? path.join(ROOT_DIR, 'data') : undefined),
    publicDir: path.join(ROOT_DIR, 'public'),
    timeoutMs: options.timeoutMs ?? positiveInteger(env.UPSTREAM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'UPSTREAM_TIMEOUT_MS'),
    maxBytes: options.maxBytes ?? positiveInteger(env.MAX_UPSTREAM_BYTES, DEFAULT_MAX_BYTES, 'MAX_UPSTREAM_BYTES'),
    logger: options.logger || console,
    now: options.now || Date.now
  };
}
module.exports = { ROOT_DIR, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, loadConfig, positiveInteger };
