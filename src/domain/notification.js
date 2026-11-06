'use strict';

const { AppError } = require('../utils/errors');
const DAY = 86400000;
const GB = 1024n ** 3n;
const EXPIRY_REASON = '套餐将在 3 天内到期或已到期';
const TRAFFIC_REASON = '剩余流量小于 30 GB';
const CHANNELS = { dingtalk: '钉钉', feishu: '飞书' };
const emptySettings = () => ({ dingtalk: { url: '', secret: '' }, feishu: { url: '', secret: '' } });

function reasons(info, now) {
  if (!info) return [];
  const result = [];
  if (info.expire && info.expire !== '0' && Number(info.expire) * 1000 <= now + 3 * DAY) result.push(EXPIRY_REASON);
  if (info.total && info.total !== '0' && info.upload !== undefined && info.download !== undefined
    && BigInt(info.total) - BigInt(info.upload) - BigInt(info.download) < 30n * GB) result.push(TRAFFIC_REASON);
  return result;
}

function validate(input) {
  if (!input || typeof input !== 'object') throw new AppError('通知配置无效');
  const settings = emptySettings();
  for (const channel of Object.keys(CHANNELS)) {
    const item = input[channel];
    if (!item || typeof item.url !== 'string' || item.url.length > 8192 || (item.secret !== undefined && (typeof item.secret !== 'string' || item.secret.length > 512))) throw new AppError(`${CHANNELS[channel]}配置无效`);
    const url = item.url.trim(), secret = (item.secret ?? '').trim();
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch { throw new AppError(`${CHANNELS[channel]} Webhook 地址无效`); }
      const valid = channel === 'dingtalk'
        ? parsed.hostname === 'oapi.dingtalk.com' && parsed.pathname === '/robot/send' && Boolean(parsed.searchParams.get('access_token'))
        : parsed.hostname === 'open.feishu.cn' && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(parsed.pathname) && !parsed.search;
      if (!valid || parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.hash) throw new AppError(`${CHANNELS[channel]}须使用官方 HTTPS Webhook 地址`);
    }
    settings[channel] = { url, secret };
    if (item.mention !== undefined) {
      if (typeof item.mention !== 'string' || item.mention.trim().length > 64) throw new AppError(`${CHANNELS[channel]} @ 对象格式无效`);
      const mention = item.mention.trim();
      const valid = channel === 'dingtalk' ? /^\+?\d{5,20}$/.test(mention) : /^[a-zA-Z0-9_-]{1,64}$/.test(mention) && mention.toLowerCase() !== 'all';
      if (mention && !valid) throw new AppError(channel === 'dingtalk' ? '钉钉 @ 对象须填写单个群成员手机号' : '飞书 @ 对象须填写单个群成员 Open ID 或 User ID');
      settings[channel].mention = mention;
    }
  }
  return settings;
}

function escapeMarkdown(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
}

function escapeFeishu(value) {
  return String(value).replace(/[\r\n]+/g, ' ')
    .replace(/[&<>\\`*_[\]{}()#!|~+\-/$"':]/g, char => `&#${char.charCodeAt(0)};`);
}

function message(source, causes, channel) {
  const info = source.cache.userInfo;
  let remaining = '未提供';
  if (info.total === '0') remaining = '无限流量';
  else if (info.total !== undefined && info.upload !== undefined && info.download !== undefined) {
    const bytes = BigInt(info.total) - BigInt(info.upload) - BigInt(info.download);
    remaining = `${(Number(bytes > 0n ? bytes : 0n) / Number(GB)).toFixed(2)} GB`;
  }
  const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const website = source.website ? new URL(source.website).href.replace(/[()<>\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) : '';
  const escape = channel === 'feishu' ? escapeFeishu : escapeMarkdown;
  return [`**来源：** ${escape(source.name)}`, `**预警原因：** ${causes.join('；')}`,
    `**剩余流量：** ${remaining}`, `**到期时间：** ${info.expire === '0' ? '长期有效' : info.expire ? time(Number(info.expire) * 1000) : '未提供'}`,
    ...(website ? [`**官网：** [访问官网](${website})`] : []), `**更新时间：** ${time(source.lastSuccessAt)}`].join('\n\n');
}

module.exports = { DAY, EXPIRY_REASON, TRAFFIC_REASON, CHANNELS, emptySettings, reasons, validate, escapeMarkdown, escapeFeishu, message };
