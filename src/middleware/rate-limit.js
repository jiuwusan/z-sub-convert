'use strict';

const { AppError } = require('../utils/errors');

function createRateLimit() {
  const attempts = new Map();
  function rateLimit(request, path) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = `${request.socket.remoteAddress}:${path}`;
    const value = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (value.count >= 10) throw new AppError('尝试次数过多，请 15 分钟后重试', 429);
    if (attempts.size >= 1024 && !attempts.has(key)) throw new AppError('请求过于频繁，请稍后重试', 429);
    value.count += 1;
    attempts.set(key, value);
    return () => attempts.delete(key);
  }

  return rateLimit;
}

module.exports = { createRateLimit };
