'use strict';

const { createHash } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { DAY, EXPIRY_REASON, TRAFFIC_REASON, CHANNELS, emptySettings, reasons, validate, message } = require('../domain/notification');
const { sendNotification } = require('../gateways/notification.gateway');

class Notifications {
  constructor(store, { now = Date.now, fetchImpl = fetch, logger = console } = {}) {
    this.store = store;
    this.now = now;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.running = null;
    this.pendingSources = new Set();
    this.pendingAll = false;
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
    return sendNotification(channel, config, content, title, { fetchImpl: this.fetch, now: this.now });
  }

  async test(channel) {
    if (!Object.hasOwn(CHANNELS, channel)) throw new AppError('通知渠道无效');
    const config = this.settings()[channel];
    if (!config.url) throw new AppError('请先保存该渠道的 Webhook 地址');
    await this.send(channel, config, '**测试通知发送成功。**\n\n当前渠道已连接，可接收套餐到期和剩余流量预警。');
    return { ok: true };
  }

  check(sourceId) {
    // Unscoped checks remain available for explicit internal checks. Refresh events
    // always carry a source ID so unrelated cached packages cannot send alerts.
    if (sourceId === undefined) this.pendingAll = true;
    else this.pendingSources.add(sourceId);
    return this.drainPending();
  }

  drainPending() {
    if (this.running) return this.running;
    this.running = Promise.resolve().then(async () => {
      do {
        const sourceIds = this.pendingAll ? undefined : this.pendingSources;
        this.pendingAll = false;
        this.pendingSources = new Set();
        await this.performCheck(sourceIds);
      } while (this.pendingAll || this.pendingSources.size);
    }).finally(() => {
      this.running = null;
      // Events can arrive after the loop exits but before this cleanup runs.
      // Chain the next drain so current callers and close() await those events too.
      if (this.pendingAll || this.pendingSources.size) return this.drainPending();
    });
    return this.running;
  }

  async performCheck(sourceIds) {
    const snapshot = this.store.read();
    const settings = snapshot.notifications?.settings ?? emptySettings();
    for (const source of snapshot.sources) {
      if (sourceIds && !sourceIds.has(source.id)) continue;
      if (source.cache?.revision !== source.revision) continue;
      const causes = reasons(source.cache?.userInfo, this.now());
      if (!causes.length) continue;
      for (const channel of Object.keys(CHANNELS)) {
        const config = settings[channel];
        if (!config.url) continue;
        const key = `${channel}:${source.id}`;
        const fingerprint = createHash('sha256').update(JSON.stringify(config.mention ? config : { url: config.url, secret: config.secret })).digest('hex');
        const sent = snapshot.notifications?.sent?.[key];
        const checkTime = this.now();
        const day = Math.floor((checkTime + 8 * 3600000) / DAY);
        const alertsAllowed = new Date(checkTime + 8 * 3600000).getUTCHours() >= 8;
        const previous = sent?.fingerprint === fingerprint ? sent : {};
        // Every successful source refresh writes a unique cache file, even if usage is unchanged.
        const trafficVersion = source.cache.file ?? String(source.lastSuccessAt);
        const pendingCauses = causes.filter(cause => alertsAllowed && (cause === EXPIRY_REASON
          ? previous.day !== day : previous.trafficVersion !== trafficVersion));
        if (!pendingCauses.length) continue;
        try {
          // A slow earlier webhook may outlive a failed refresh or cache/config
          // replacement. Revalidate before each send, including within a batch.
          const current = this.store.read().sources.find(row => row.id === source.id);
          if (!current || current.lastResult?.ok === false || current.revision !== source.revision
            || current.cache?.revision !== source.revision || current.cache?.file !== source.cache.file
            || current.lastSuccessAt !== source.lastSuccessAt) continue;
          const title = [pendingCauses.includes(TRAFFIC_REASON) ? 'Mihomo 流量预警' : '',
            pendingCauses.includes(EXPIRY_REASON) ? 'Mihomo 套餐即将到期' : ''].filter(Boolean).join(' / ');
          await this.send(channel, config, message(source, pendingCauses, channel), title);
          const successTime = this.now();
          // Late delivery after midnight does not consume the new morning reminder.
          const successDay = new Date(successTime + 8 * 3600000).getUTCHours() >= 8
            ? Math.floor((successTime + 8 * 3600000) / DAY) : day;
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

  async close() {
    await this.running;
  }
}

module.exports = { Notifications, reasons };
