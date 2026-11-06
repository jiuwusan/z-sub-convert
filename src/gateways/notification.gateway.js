'use strict';

const { createHmac } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { CHANNELS } = require('../domain/notification');

async function sendNotification(channel, config, content, title = 'Mihomo 通知测试', { fetchImpl = fetch, now = Date.now } = {}) {
  const url = new URL(config.url);
  if (config.mention) content += channel === 'dingtalk' ? `\n\n@${config.mention}` : `\n\n<at id=${config.mention}></at>`;
  const body = channel === 'dingtalk'
    ? { msgtype: 'markdown', markdown: { title, text: `### ⚠️ ${title}\n\n${content}` } }
    : { msg_type: 'interactive', card: { config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `⚠️ ${title}` }, template: 'red' },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] } };
  if (channel === 'dingtalk' && config.mention) body.at = { atMobiles: [config.mention], isAtAll: false };
  if (config.secret) {
    const timestamp = String(channel === 'dingtalk' ? now() : Math.floor(now() / 1000));
    if (channel === 'dingtalk') {
      url.searchParams.set('timestamp', timestamp);
      url.searchParams.set('sign', createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64'));
    } else {
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', `${timestamp}\n${config.secret}`).update('').digest('base64');
    }
  }
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error();
    const data = await response.json();
    const code = channel === 'dingtalk' ? data.errcode : data.code ?? data.StatusCode;
    if (code !== 0) throw Error();
  } catch { throw new AppError(`${CHANNELS[channel]}发送失败，请检查 Webhook、签名密钥和机器人安全设置`, 502); }
}

module.exports = { sendNotification };
