'use strict';

const { SESSION_MS } = require('../services/auth.service');
const { sendJson } = require('../utils/http-response');
const EXPIRED_COOKIE = 'sub_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

function createAuthController({ auth, readJson }) {
  return {
    status(request, response, token) {
      sendJson(response, 200, auth.status(token));
    },
    async setup(request, response, clearRate) {
      const data = await readJson(request);
      await auth.setup(data.username, data.password);
      clearRate();
      sendJson(response, 201, { ok: true });
    },
    async reset(request, response, clearRate) {
      const data = await readJson(request);
      await auth.reset(data.key, data.username, data.password);
      clearRate();
      response.setHeader('set-cookie', EXPIRED_COOKIE);
      sendJson(response, 200, { ok: true });
    },
    async login(request, response, clearRate) {
      const data = await readJson(request);
      const loggedIn = await auth.login(data.username, data.password);
      clearRate();
      const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
      response.setHeader('set-cookie', `sub_session=${loggedIn.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
      sendJson(response, 200, { username: loggedIn.username, csrf: loggedIn.csrf });
    },
    logout(request, response, token) {
      auth.logout(token);
      response.setHeader('set-cookie', EXPIRED_COOKIE);
      sendJson(response, 200, { ok: true });
    }
  };
}

module.exports = { createAuthController };
