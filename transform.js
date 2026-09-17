'use strict';

const { detectCountry, compareCountries } = require('./country');

const PROTOCOL_PRIORITY = Object.freeze([
  'ss',
  'ssr',
  'hysteria2',
  'trojan',
  'vmess',
  'vless',
  'tuic',
  'hysteria',
  'wireguard'
]);

function normalizeProtocol(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Every proxy must have a non-empty proxy type');
  }
  return value.trim().toLocaleLowerCase('en-US');
}

function compareProtocols(left, right) {
  const leftIndex = PROTOCOL_PRIORITY.indexOf(left);
  const rightIndex = PROTOCOL_PRIORITY.indexOf(right);
  const leftPriority = leftIndex === -1 ? PROTOCOL_PRIORITY.length : leftIndex;
  const rightPriority = rightIndex === -1 ? PROTOCOL_PRIORITY.length : rightIndex;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  return left.localeCompare(right, 'en-US');
}

function findRequiredGroup(groups, name) {
  const group = groups.find((candidate) => candidate && candidate.name === name);
  if (!group) throw new TypeError(`Template is missing required group: ${name}`);
  if (!Array.isArray(group.proxies)) {
    throw new TypeError(`Template group ${name} must contain a proxies array`);
  }
  return group;
}

function transformConfig(template, upstreamProxyLists) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    throw new TypeError('Template must be a YAML mapping');
  }
  if (!Array.isArray(template.proxies)) {
    throw new TypeError('Template must contain a proxies array');
  }
  if (!Array.isArray(template['proxy-groups'])) {
    throw new TypeError('Template must contain a proxy-groups array');
  }
  if (!Array.isArray(upstreamProxyLists)) {
    throw new TypeError('Upstream proxy lists must be an array');
  }

  const output = structuredClone(template);
  const selector = findRequiredGroup(output['proxy-groups'], '🚀 节点选择');
  const failover = findRequiredGroup(output['proxy-groups'], '🔰 故障转移');
  const records = [];

  for (const list of upstreamProxyLists) {
    if (!Array.isArray(list)) throw new TypeError('Each upstream proxy list must be an array');
    for (const proxy of list) {
      if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) {
        throw new TypeError('Every proxy must be a YAML mapping');
      }
      records.push({
        proxy,
        country: detectCountry(proxy.name),
        protocol: normalizeProtocol(proxy.type),
        sourceIndex: records.length,
        assignedName: null
      });
    }
  }

  const groupsByKey = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.protocol, record.country.code]);
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        protocol: record.protocol,
        country: record.country,
        records: []
      };
      groupsByKey.set(key, group);
    }
    group.records.push(record);
  }

  const groups = [...groupsByKey.values()].sort((left, right) => {
    const protocolOrder = compareProtocols(left.protocol, right.protocol);
    return protocolOrder || compareCountries(left.country, right.country);
  });

  const countryCounters = new Map();
  const generatedGroups = groups.map((group) => {
    const proxyNames = group.records.map((record) => {
      const next = (countryCounters.get(group.country.code) || 0) + 1;
      countryCounters.set(group.country.code, next);
      record.assignedName = `${group.country.flag} ${group.country.name} ${String(next).padStart(2, '0')}`;
      return record.assignedName;
    });
    return {
      name: `${group.country.flag} ${group.protocol.toLocaleUpperCase('en-US')} ${group.country.name}`,
      interval: 305,
      type: 'fallback',
      url: 'http://www.gstatic.com/generate_204',
      proxies: proxyNames
    };
  });

  output.proxies.push(...records
    .sort((left, right) => left.sourceIndex - right.sourceIndex)
    .map((record) => ({ ...structuredClone(record.proxy), name: record.assignedName })));

  const generatedNames = generatedGroups.map(({ name }) => name);
  selector.proxies.push(...generatedNames);
  failover.proxies.push(...generatedNames);
  output['proxy-groups'].push(...generatedGroups);

  return output;
}

module.exports = {
  PROTOCOL_PRIORITY,
  transformConfig
};
