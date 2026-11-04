'use strict';

const { createHmac, createHash } = require('node:crypto');
const { AppError } = require('./auth');
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
  }
  return settings;
}

function escapeMarkdown(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]{}()#!|]/g, '\\$&');
}

function escapeFeishu(value) {
  return String(value).replace(/[\r\n]+/g, ' ')
    .replace(/[&<>\\`*_[\]{}()#!|~+\-\/$"':]/g, char => `&#${char.charCodeAt(0)};`);
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

class Notifications {
  constructor(store, { now = Date.now, fetchImpl = fetch, logger = console } = {}) {
    this.store = store;
    this.now = now;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.running = null;
  }

  settings() { return this.store.read().notifications?.settings ?? emptySettings(); }

  async save(input) {
    const settings = validate(input);
    await this.store.update(state => {
      state.notifications ??= { sent: {} };
      state.notifications.settings = settings;
    });
    return settings;
  }

  async send(channel, config, content, title = 'Mihomo 通知测试') {
    const url = new URL(config.url);
    const body = channel === 'dingtalk'
      ? { msgtype: 'markdown', markdown: { title, text: `### ⚠️ ${title}\n\n${content}` } }
      : { msg_type: 'interactive', card: { config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `⚠️ ${title}` }, template: 'red' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content } }] } };
    if (config.secret) {
      const timestamp = String(channel === 'dingtalk' ? this.now() : Math.floor(this.now() / 1000));
      if (channel === 'dingtalk') {
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('sign', createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64'));
      } else {
        body.timestamp = timestamp;
        body.sign = createHmac('sha256', `${timestamp}\n${config.secret}`).update('').digest('base64');
      }
    }
    try {
      const response = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error();
      const data = await response.json();
      const code = channel === 'dingtalk' ? data.errcode : data.code ?? data.StatusCode;
      if (code !== 0) throw Error();
    } catch { throw new AppError(`${CHANNELS[channel]}发送失败，请检查 Webhook、签名密钥和机器人安全设置`, 502); }
  }

  async test(channel) {
    if (!Object.hasOwn(CHANNELS, channel)) throw new AppError('通知渠道无效');
    const config = this.settings()[channel];
    if (!config.url) throw new AppError('请先保存该渠道的 Webhook 地址');
    await this.send(channel, config, '**测试通知发送成功。**\n\n当前渠道已连接，可接收套餐到期和剩余流量预警。');
    return { ok: true };
  }

  check() {
    if (this.running) {
      this.pending = true;
      return this.running;
    }
    this.running = Promise.resolve().then(async () => {
      do {
        this.pending = false;
        await this.performCheck();
      } while (this.pending);
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async performCheck() {
    const snapshot = this.store.read();
    const settings = snapshot.notifications?.settings ?? emptySettings();
    for (const source of snapshot.sources) {
      if (source.cache?.revision !== source.revision) continue;
      const causes = reasons(source.cache?.userInfo, this.now());
      if (!causes.length) continue;
      for (const channel of Object.keys(CHANNELS)) {
        const config = settings[channel];
        if (!config.url) continue;
        const key = `${channel}:${source.id}`;
        const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
        const sent = snapshot.notifications?.sent?.[key];
        const day = Math.floor((this.now() + 8 * 3600000) / DAY);
        const previous = sent?.fingerprint === fingerprint ? sent : {};
        // Every successful source refresh writes a unique cache file, even if usage is unchanged.
        const trafficVersion = source.cache.file ?? String(source.lastSuccessAt);
        const pendingCauses = causes.filter(cause => cause === EXPIRY_REASON
          ? previous.day !== day : previous.trafficVersion !== trafficVersion);
        if (!pendingCauses.length) continue;
        try {
          const title = [pendingCauses.includes(TRAFFIC_REASON) ? 'Mihomo 流量预警' : '',
            pendingCauses.includes(EXPIRY_REASON) ? 'Mihomo 套餐即将到期' : ''].filter(Boolean).join(' / ');
          await this.send(channel, config, message(source, pendingCauses, channel), title);
          const successDay = Math.floor((this.now() + 8 * 3600000) / DAY);
          await this.store.update(state => {
            state.notifications ??= { settings, sent: {} };
            state.notifications.sent ??= {};
            state.notifications.sent[key] = { ...previous, fingerprint,
              ...(pendingCauses.includes(EXPIRY_REASON) ? { day: successDay } : {}),
              ...(pendingCauses.includes(TRAFFIC_REASON) ? { trafficVersion } : {}) };
            const ids = new Set(state.sources.map(row => row.id));
            for (const entry of Object.keys(state.notifications.sent)) if (!ids.has(entry.split(':')[1])) delete state.notifications.sent[entry];
          });
        } catch { this.logger.error(`${CHANNELS[channel]}套餐提醒发送失败`); }
      }
    }
  }

  start() {
    const run = () => { this.check().catch(() => this.logger.error('套餐提醒检查失败')); };
    this.initial = setTimeout(run, 0);
    this.initial.unref();
    this.timer = setInterval(run, 3600000);
    this.timer.unref();
  }

  async close() {
    clearTimeout(this.initial);
    clearInterval(this.timer);
    await this.running;
  }
}

module.exports = { Notifications, reasons };
