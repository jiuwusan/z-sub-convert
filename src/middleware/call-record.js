'use strict';
function createCallRecorder(request, response, { calledAt, started }, logger) {
  let invocation;
  const record = () => {
    if (!invocation) return;
    const { id, history, error } = invocation;
    invocation = null;
    const disconnected = !response.writableFinished;
    history.append(id, {
      at: calledAt, method: request.method,
      ip: (request.socket.remoteAddress || '').replace(/^::ffff:/, ''), userAgent: request.headers['user-agent'] || '',
      status: disconnected ? 499 : response.statusCode, error: disconnected ? '客户端断开连接' : error,
      durationMs: performance.now() - started
    }).catch(() => logger.error('Unable to save subscription call record'));
  };
  return {
    track(id, history) {
      invocation = { id, history, error: null };
      response.once('finish', record);
      response.once('close', record);
      if (response.destroyed) record();
    },
    fail(message) { if (invocation) invocation.error = message; }
  };
}
module.exports = { createCallRecorder };
