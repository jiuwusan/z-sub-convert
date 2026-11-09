'use strict';

const { createHash } = require('node:crypto');
const { AppError } = require('../utils/errors');
const { DAY, EXPIRY_REASON, TRAFFIC_REASON, CHANNELS, USAGE_NOTIFICATION_TITLE, emptySettings, reasons, validate, message, hasUsableTraffic, testMessage } = require('../domain/notification');
const { sendNotification } = require('../gateways/notification.gateway');

const BEIJING_OFFSET = 8 * 3600000;
const START_HOUR = 9;
const beijingDay = time => Math.floor((time + BEIJING_OFFSET) / DAY);
const canSend = time => new Date(time + BEIJING_OFFSET).getUTCHours() >= START_HOUR;

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

  async send(channel, config, content, title, icon) {
    return sendNotification(channel, config, content, title, { fetchImpl: this.fetch, now: this.now, icon });
  }

  async test(channel) {
    if (!Object.hasOwn(CHANNELS, channel)) throw new AppError('通知渠道无效');
    const config = this.settings()[channel];
    if (!config.url) throw new AppError('请先保存该渠道的 Webhook 地址');
    await this.send(channel, config, testMessage(channel), 'Mihomo 通知测试', '✅');
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
    for (const source of snapshot.sources) {
      if (sourceIds && !sourceIds.has(source.id)) continue;
      if (source.cache?.revision !== source.revision) continue;
      for (const channel of Object.keys(CHANNELS)) {
        await this.checkChannel(source, channel, false);
        await this.checkChannel(source, channel, true);
      }
    }
  }

  async checkChannel(source, channel, usage) {
    const checkTime = this.now();
    if (!canSend(checkTime)) return;
    const snapshot = this.store.read();
    const current = snapshot.sources.find(row => row.id === source.id);
    // Revalidate after any earlier delivery before using the refreshed cache.
    if (!current || current.lastResult?.ok === false || current.revision !== source.revision
      || current.cache?.revision !== source.revision || current.cache?.file !== source.cache.file
      || current.lastSuccessAt !== source.lastSuccessAt) return;
    const settings = snapshot.notifications?.settings ?? emptySettings();
    const config = settings[channel];
    if (!config.url) return;
    const key = `${channel}:${source.id}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(config.mention ? config : { url: config.url, secret: config.secret })).digest('hex');
    const sent = snapshot.notifications?.sent?.[key];
    const previous = sent?.fingerprint === fingerprint ? sent : { usageDay: sent?.usageDay };
    const day = beijingDay(checkTime);
    const info = current.cache.userInfo;
    const trafficVersion = source.cache.file ?? String(source.lastSuccessAt);
    const threshold = current.trafficThresholdGiB;
    const pendingCauses = usage ? [] : reasons(info, checkTime, threshold).filter(cause => cause === EXPIRY_REASON
      ? previous.day !== day : previous.trafficVersion !== trafficVersion);
    if (usage ? previous.usageDay === day || !hasUsableTraffic(info, threshold) : !pendingCauses.length) return;
    const title = usage ? USAGE_NOTIFICATION_TITLE : [
      pendingCauses.includes(TRAFFIC_REASON) ? 'Mihomo 流量预警' : '',
      pendingCauses.includes(EXPIRY_REASON) ? 'Mihomo 套餐即将到期' : ''
    ].filter(Boolean).join(' / ');
    try {
      await this.send(channel, config, message(current, pendingCauses, channel), title, usage ? '📊' : '⚠️');
      const successTime = this.now();
      const successDay = canSend(successTime) ? beijingDay(successTime) : day;
      await this.store.update(state => {
        state.notifications ??= { settings, sent: {} };
        const records = state.notifications.sent ??= {};
        records[key] = usage ? { ...records[key], usageDay: successDay } : { ...previous, fingerprint,
          ...(pendingCauses.includes(EXPIRY_REASON) ? { day: successDay } : {}),
          ...(pendingCauses.includes(TRAFFIC_REASON) ? { trafficVersion } : {}) };
        const ids = new Set(state.sources.map(row => row.id));
        for (const entry of Object.keys(records)) if (!ids.has(entry.split(':')[1])) delete records[entry];
      });
    } catch { this.logger.error(`${CHANNELS[channel]}套餐提醒发送失败`); }
  }

  async close() {
    await this.running;
  }
}

module.exports = { Notifications, reasons };
