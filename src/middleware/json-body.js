'use strict';

const { AppError } = require('../utils/errors');
const MAX_BODY = 2 * 1024 * 1024;

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new AppError('请使用 application/json', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) {
      // Drain the remaining request so the connection can receive the error response.
      request.resume();
      throw new AppError('请求内容不能超过 2 MiB', 413);
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('JSON 格式无效'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AppError('请求内容须为 JSON 对象');
  return data;
}

module.exports = { readJson };
