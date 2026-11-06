'use strict';
const { Store } = require('../repositories/store.repository');
const { CallRecords } = require('../repositories/call-record.repository');
const { AssetRepository } = require('../repositories/asset.repository');
const { Auth } = require('../services/auth.service');
const { Managed } = require('../services/managed.service');
const { Notifications } = require('../services/notification.service');
const { RecordService } = require('../services/record.service');
const { AssetService } = require('../services/asset.service');
const { ConversionService } = require('../services/conversion.service');
const { createAdminHandler } = require('../routes/admin.routes');
const { createSubscriptionController } = require('../controllers/subscription.controller');
const { createSystemController } = require('../controllers/system.controller');
const { ASSETS } = require('../config/assets');
function createRuntime(config, version) {
  const { dataDir, templatePath, now, logger } = config;
  const ready = dataDir ? Store.open({ directory: dataDir, templatePath }).then(async store => {
    const auth = new Auth(store, { resetKey: config.resetKey, now });
    const callRecords = new CallRecords(dataDir, { now, logger, isActive: id => store.read().subscriptions.some(sub => sub.id === id) });
    const sourceRecords = new CallRecords(dataDir, { now, logger, directoryName: 'source-refresh-records', isActive: id => store.read().sources.some(source => source.id === id) });
    await callRecords.cleanup().catch(() => logger.error('Unable to clean subscription call records'));
    await sourceRecords.cleanup().catch(() => logger.error('Unable to clean source refresh records'));
    callRecords.start();
    sourceRecords.start();
    const notifications = new Notifications(store, { now, logger, fetchImpl: config.notificationFetchImpl });
    const managed = new Managed(store, { ...config, callRecords, sourceRecords, notifications });
    const callHistory = new RecordService(callRecords);
    const sourceHistory = new RecordService(sourceRecords);
    const admin = createAdminHandler({ auth, managed, callRecords: callHistory, sourceRecords: sourceHistory, notifications, now });
    return { store, auth, managed, callRecords, sourceRecords, callHistory, notifications, admin };
  }) : Promise.resolve(null);
  ready.catch(() => {});
  return {
    ready, now, logger, assetPaths: new Set(Object.keys(ASSETS)),
    subscription: createSubscriptionController({ ready, conversion: new ConversionService(config), now }),
    system: createSystemController({ assets: ASSETS, assetService: new AssetService(new AssetRepository(config.publicDir)), version })
  };
}
module.exports = { createRuntime };
