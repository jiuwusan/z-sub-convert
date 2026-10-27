'use strict';

const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const SESSION_MS = 12 * 60 * 60 * 1000;

class AppError extends Error {
  constructor(message, statusCode = 400) { super(message); this.name = 'AppError'; this.statusCode = statusCode; }
}

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function credentials(username, password) {
  if (typeof username !== 'string' || !username.trim() || username.trim().length > 64) {
    throw new AppError('用户名必填，且不能超过 64 个字符');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new AppError('密码长度须为 8–128 个字符');
  }
  return username.trim();
}

async function accountFor(username, password) {
  username = credentials(username, password);
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt, 64)).toString('hex');
  return { username, salt, hash };
}

class Auth {
  constructor(store, { resetKey = randomBytes(32).toString('hex'), now = Date.now } = {}) {
    this.store = store;
    this.resetKey = resetKey;
    this.now = now;
    this.sessions = new Map();
  }

  async setup(username, password) {
    if (this.store.read().account) throw new AppError('账号已经初始化，请登录', 409);
    const account = await accountFor(username, password);
    await this.store.update(state => {
      if (state.account) throw new AppError('账号已经初始化，请登录', 409);
      state.account = account;
    });
  }

  async login(username, password) {
    username = typeof username === 'string' ? username.trim() : '';
    const account = this.store.read().account;
    if (!account) throw new AppError('请先初始化账号', 409);
    if (typeof password !== 'string' || password.length > 128) throw new AppError('用户名或密码错误', 401);
    const hash = (await derive(password, account.salt, 64)).toString('hex');
    if (!equal(hash, account.hash) || username !== account.username || this.store.read().account.hash !== account.hash) {
      throw new AppError('用户名或密码错误', 401);
    }
    for (const [token, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(token);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    const session = { username: account.username, csrf: randomBytes(32).toString('hex'), expires: this.now() + SESSION_MS };
    this.sessions.set(token, session);
    return { token, ...session };
  }

  session(token) {
    const value = this.sessions.get(token);
    if (!value || value.expires <= this.now()) { this.sessions.delete(token); return null; }
    return { ...value };
  }

  logout(token) { this.sessions.delete(token); }

  async reset(key, username, password) {
    if (!equal(key, this.resetKey)) throw new AppError('重置 key 无效，请查看当前启动日志', 403);
    const account = await accountFor(username, password);
    await this.store.update(state => {
      if (!state.account) throw new AppError('请先初始化账号', 409);
      state.account = account;
    });
    this.sessions.clear();
  }
}

module.exports = { Auth, AppError, equal, SESSION_MS };
