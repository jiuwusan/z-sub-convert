'use strict';

const { AppError } = require('../utils/errors');
const { sendDownload } = require('./download-response');
const { sendJson } = require('../utils/http-response');

function createAdminController({ managed, callRecords, sourceRecords, notifications, readJson, now = Date.now }) {
  const json = (request, response, status, payload) => sendJson(response, status, payload, request.method === 'HEAD');
  return {
    state(request, response) { json(request, response, 200, managed.list()); },
    async countries(request, response) {
      const data = await readJson(request);
      json(request, response, 200, await managed.countries(data.sourceIds));
    },
    notificationSettings(request, response) { json(request, response, 200, notifications.settings()); },
    async saveNotifications(request, response) { json(request, response, 200, await notifications.save(await readJson(request))); },
    async testNotification(request, response, channel) { json(request, response, 200, await notifications.test(channel)); },
    async refreshAll(request, response) { json(request, response, 200, { results: await managed.refreshAll() }); },
    async history(request, response, url, { resource, id, sourceHistory }) {
      managed.get(resource, id);
      json(request, response, 200, await (sourceHistory ? sourceRecords : callRecords).list(id, Number(url.searchParams.get('page') ?? 1)));
    },
    async download(request, response, { resource, id }) {
      const headOnly = request.method === 'HEAD';
      if (resource === 'bases' || resource === 'templates') {
        const template = managed.get(resource, id);
        sendDownload(response, { name: template.name, content: template.content, timestamp: now(), headOnly });
      } else if (resource === 'sources') {
        const preview = await managed.preview(id);
        if (preview.content === null) throw new AppError(preview.requiresUpdate
          ? '旧缓存仅包含节点，请先更新来源后下载完整订阅结果' : '暂无可用缓存，请先更新来源后下载', 409);
        sendDownload(response, { name: preview.name, content: preview.content, timestamp: now(), headOnly, userInfo: preview.userInfo });
      } else {
        const sub = managed.get(resource, id);
        const result = headOnly ? { ...managed.subscriptionInfo(id), body: '' } : await managed.content(sub.key);
        sendDownload(response, { name: result.name, content: result.body, timestamp: now(), headOnly, stale: result.stale, userInfo: result.userInfo });
      }
    },
    async preview(request, response, id) { json(request, response, 200, await managed.preview(id)); },
    async refresh(request, response, id) { json(request, response, 200, await managed.refresh(id)); },
    get(request, response, { resource, id }) { json(request, response, 200, managed.get(resource, id)); },
    async create(request, response, resource) { json(request, response, 201, await managed.save(resource, await readJson(request))); },
    async update(request, response, { resource, id }) { json(request, response, 200, await managed.save(resource, await readJson(request), id)); },
    async remove(request, response, { resource, id }) {
      await managed.remove(resource, id);
      json(request, response, 200, { ok: true });
    }
  };
}

module.exports = { createAdminController };
