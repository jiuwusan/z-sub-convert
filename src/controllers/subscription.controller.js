'use strict';
const { AppError } = require('../utils/errors');
const { send } = require('../utils/http-response');
const { sendDownload } = require('./download-response');
function createSubscriptionController({ ready, conversion, now }) {
  return {
    async download(request, response, url, invocation) {
      const headOnly = request.method === 'HEAD';
      if (url.searchParams.has('key')) {
        const context = await ready;
        if (!context) throw new AppError('订阅不存在', 404);
        const key = url.searchParams.get('key');
        const sub = context.managed.subscriptionByKey(key);
        invocation.track(sub.id, context.callHistory);
        if (headOnly) {
          sendDownload(response, { ...context.managed.subscriptionInfo(sub.id), content: '', timestamp: now(), headOnly: true });
          return;
        }
        const result = await context.managed.content(key);
        sendDownload(response, { name: result.name, content: result.body, timestamp: now(), stale: result.stale, userInfo: result.userInfo });
        return;
      }
      const body = await conversion.convert(url.searchParams.get('url'));
      send(response, 200, {
        'content-type': 'text/yaml; charset=utf-8',
        'content-disposition': `attachment; filename="config-clash-meta-${now()}.yaml"`
      }, body, headOnly);
    }
  };
}
module.exports = { createSubscriptionController };
