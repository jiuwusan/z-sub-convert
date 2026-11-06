'use strict';

const { AppError } = require('../utils/errors');
const { equal } = require('../utils/security');

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

function requireSession(session) {
  if (!session) throw new AppError('请先登录', 401);
}

function sessionFrom(auth, token) {
  return auth.session(token);
}

function checkCsrf(request, session) {
  if (!equal(request.headers['x-csrf-token'], session.csrf)) throw new AppError('页面会话已失效，请刷新后重试', 403);
}

module.exports = { tokenFrom, sessionFrom, checkOrigin, requireSession, checkCsrf };
