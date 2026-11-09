'use strict';

const { AppError } = require('../utils/errors');
const DAY = 86400000;
const GB = 1024n ** 3n;
const EXPIRY_REASON = '套餐将在 3 天内到期或已到期';
const TRAFFIC_REASON = '剩余流量小于 30 GB';
const DEFAULT_TRAFFIC_THRESHOLD_GIB = 30;
const MAX_TRAFFIC_THRESHOLD_GIB = 2 ** 33 - 1;
const CHANNELS = { dingtalk: '钉钉', feishu: '飞书' };
const USAGE_NOTIFICATION_TITLE = 'Mihomo 套餐使用情况';
const emptySettings = () => ({ dingtalk: { url: '', secret: '' }, feishu: { url: '', secret: '' } });

function remainingBytes(info) {
  if (!info?.total || info.total === '0' || info.upload === undefined || info.download === undefined) return null;
  return BigInt(info.total) - BigInt(info.upload) - BigInt(info.download);
}

function hasUsableTraffic(info, threshold = DEFAULT_TRAFFIC_THRESHOLD_GIB) {
  const bytes = remainingBytes(info);
  return info?.total === '0' || (bytes !== null && bytes >= BigInt(threshold) * GB);
}

function reasons(info, now, threshold = DEFAULT_TRAFFIC_THRESHOLD_GIB) {
  if (!info) return [];
  const result = [];
  if (info.expire && info.expire !== '0' && Number(info.expire) * 1000 <= now + 3 * DAY) result.push(EXPIRY_REASON);
  const bytes = remainingBytes(info);
  if (bytes !== null && bytes < BigInt(threshold) * GB) result.push(TRAFFIC_REASON);
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

function identity(source, channel) {
  const escape = channel === 'feishu' ? escapeFeishu : escapeMarkdown;
  const name = escape(source.name);
  const website = source.website ? new URL(source.website).href.replace(/[()<>\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) : '';
  const platform = website ? `[${name} · 访问官网](${website})` : name;
  return [`**平台：** ${platform}`, ...(source.username ? [`**账号：** ${escape(source.username)}`] : [])];
}

function message(source, causes, channel) {
  const info = source.cache.userInfo;
  const bytes = remainingBytes(info);
  let remaining = '未提供';
  if (info.total === '0') remaining = '无限流量';
  else if (bytes !== null) {
    remaining = `${(Number(bytes > 0n ? bytes : 0n) / Number(GB)).toFixed(2)} GB`;
  }
  const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const threshold = source.trafficThresholdGiB ?? DEFAULT_TRAFFIC_THRESHOLD_GIB;
  const causeText = causes.map(cause => cause === TRAFFIC_REASON && threshold !== DEFAULT_TRAFFIC_THRESHOLD_GIB
    ? `剩余流量小于 ${threshold} GiB` : cause).join('；');
  return [...identity(source, channel), ...(causeText ? [`**预警原因：** ${causeText}`] : []),
    `**剩余流量：** ${remaining}`, `**到期时间：** ${info.expire === '0' ? '长期有效' : info.expire ? time(Number(info.expire) * 1000) : '未提供'}`,
    `**更新时间：** ${time(source.lastSuccessAt)}`].join('\n\n');
}

function testMessage(channel) {
  return [...identity({ name: 'E-IX', website: 'https://provider.example/', username: 'subscriber@example.test' }, channel),
    '**测试通知发送成功。**', '当前渠道已连接，可接收套餐使用情况、套餐到期和剩余流量预警。'].join('\n\n');
}

module.exports = { DAY, EXPIRY_REASON, TRAFFIC_REASON, DEFAULT_TRAFFIC_THRESHOLD_GIB, MAX_TRAFFIC_THRESHOLD_GIB, CHANNELS, USAGE_NOTIFICATION_TITLE, emptySettings, reasons, validate, escapeMarkdown, escapeFeishu, message, hasUsableTraffic, testMessage };
