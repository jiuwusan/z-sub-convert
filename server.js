'use strict';
const { createApp } = require('./src/app');
const { loadConfig } = require('./src/config');
function start() {
  const config = loadConfig({ defaultDataDir: true });
  const server = createApp(config);
  server.ready.then(context => {
    console.log(`Account reset key (rotates on startup): ${context.auth.resetKey}`);
    server.listen(config.port, config.host, () => {
      console.log(`clash-sub-convert listening on http://${config.host}:${config.port}`);
    });
  }).catch(error => {
    console.error(error.code === 'UNSUPPORTED_DATA_VERSION' ? error.message : 'Unable to initialize data directory. Check DATA_DIR permissions and state.json.');
    process.exitCode = 1;
  });
  return server;
}
if (require.main === module) start();
module.exports = { createApp, start };
