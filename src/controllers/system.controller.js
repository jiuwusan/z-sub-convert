'use strict';
const { AppError } = require('../utils/errors');
const { send, sendJson } = require('../utils/http-response');
function createSystemController({ assets, assetService, version }) {
  return {
    version(request, response) { sendJson(response, 200, version, request.method === 'HEAD'); },
    async asset(request, response, url) {
      if (!['GET', 'HEAD'].includes(request.method)) throw new AppError('请求方法不允许', 405);
      const [file, type] = assets[url.pathname];
      const body = await assetService.read(file);
      response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      send(response, 200, { 'content-type': type, 'cache-control': 'no-cache' }, body, request.method === 'HEAD');
    }
  };
}
module.exports = { createSystemController };
