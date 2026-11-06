'use strict';
const http = require('node:http');
const { loadConfig } = require('./config');
const { createRuntime } = require('./bootstrap/context');
const { createRouter } = require('./routes');
const { name, version } = require('../package.json');
function createApp(options = {}) {
  const runtime = createRuntime(loadConfig(options), { name, version });
  const server = http.createServer(createRouter(runtime));
  server.once('close', () => {
    runtime.ready.then(context => context && Promise.all([
      context.callRecords.close(), context.sourceRecords.close(), context.notifications.close()
    ])).catch(() => {});
  });
  server.ready = runtime.ready;
  return server;
}
module.exports = { createApp };
