'use strict';

const YAML = require('yaml');
const { uniqueAddresses } = require('./template-parts');
const { SubscriptionError } = require('../utils/errors');

function parseSubscriptionDocument(content) {
  let document;
  try {
    document = YAML.parse(content);
  } catch (error) {
    throw new SubscriptionError('Upstream subscription is not valid YAML', 502, { cause: error });
  }
  if (!document || !Array.isArray(document.proxies) || document.proxies.length === 0) {
    throw new SubscriptionError('Upstream subscription contains no proxies', 502);
  }
  const hasInvalidProxy = document.proxies.some((proxy) => (
    !proxy
    || typeof proxy !== 'object'
    || Array.isArray(proxy)
    || typeof proxy.type !== 'string'
    || proxy.type.trim() === ''
  ));
  if (hasInvalidProxy) throw new SubscriptionError('Upstream subscription contains an invalid proxy', 502);
  return {
    proxies: document.proxies,
    dns: Object.fromEntries(['nameserver', 'proxy-server-nameserver', 'proxy-server-nameserver-policy', 'nameserver-policy']
      .filter(key => Object.hasOwn(document.dns || {}, key)).map(key => [key, document.dns[key]])),
    nameservers: uniqueAddresses(document.dns?.nameserver),
    hosts: document.hosts && typeof document.hosts === 'object' && !Array.isArray(document.hosts) ? document.hosts : {}
  };
}

function parseSubscription(content) {
  return parseSubscriptionDocument(content).proxies;
}

module.exports = { parseSubscriptionDocument, parseSubscription };
