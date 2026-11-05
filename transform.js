'use strict';

const { detectCountry, compareCountries, countryFilterOptions } = require('./country');

const DEFAULT_COUNTRY_GROUP_TYPE = 'fallback';
const DEFAULT_COUNTRY_TEST_URL = 'http://www.gstatic.com/generate_204';
const DEFAULT_COUNTRY_TEST_INTERVAL = 305;
const COUNTRY_GROUP_TYPES = Object.freeze(['fallback', 'url-test', 'select', 'load-balance']);

function countryGroupOptions({ countryGroupType = DEFAULT_COUNTRY_GROUP_TYPE, countryTestUrl = DEFAULT_COUNTRY_TEST_URL, countryTestInterval = DEFAULT_COUNTRY_TEST_INTERVAL } = {}) {
  if (!COUNTRY_GROUP_TYPES.includes(countryGroupType)) throw new TypeError('国家分组类型无效');
  if (typeof countryTestUrl !== 'string' || !countryTestUrl.trim() || countryTestUrl.length > 8192 || /[\x00-\x1f\x7f]/.test(countryTestUrl)) throw new TypeError('国家分组测试 URL 须为有效 HTTP/HTTPS 地址');
  const value = countryTestUrl.trim();
  let url;
  try { url = new URL(value); } catch { throw new TypeError('国家分组测试 URL 须为有效 HTTP/HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new TypeError('国家分组测试 URL 须为不带账户的 HTTP/HTTPS 地址');
  if (!Number.isInteger(countryTestInterval) || countryTestInterval < 1 || countryTestInterval > 86400) throw new TypeError('国家分组测试间隔须为 1–86400 的整数秒');
  return { countryGroupType, countryTestUrl: value, countryTestInterval };
}
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

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

function removeFailoverGroup(output, failover) {
  const removed = '🔰 故障转移';
  const selector = '🚀 节点选择';
  const members = failover.proxies.filter(name => name !== removed);
  output['proxy-groups'] = output['proxy-groups'].filter(group => group.name !== removed);
  for (const group of output['proxy-groups']) {
    if (Array.isArray(group.proxies) && group.proxies.includes(removed)) {
      // Only the main selector inherits members; service groups keep their scope.
      const replacement = group.name === selector ? members : [selector];
      group.proxies = [...new Set(group.proxies.flatMap(name => name === removed ? replacement : [name]))];
    }
  }
  const rewriteRule = rule => {
    // SUB-RULE ends in a child rule identifier, not a proxy policy.
    if (typeof rule !== 'string' || /^\s*SUB-RULE\s*,/iu.test(rule)) return rule;
    return rule.replace(/,(\s*)🔰 故障转移(?=\s*(?:,\s*(?:no-resolve|src)\s*)*$)/u, `,$1${selector}`);
  };
  if (Array.isArray(output.rules)) output.rules = output.rules.map(rewriteRule);
  for (const [name, rules] of Object.entries(output['sub-rules'] || {})) {
    if (Array.isArray(rules)) output['sub-rules'][name] = rules.map(rewriteRule);
  }
  const seenDns = new WeakSet();
  const rewriteDns = value => {
    if (typeof value === 'string') {
      const index = value.indexOf('#');
      if (index === -1) return value;
      const fragments = value.slice(index + 1).split('&').map(fragment => {
        try {
          return decodeURIComponent(fragment) === removed ? fragment === removed ? selector : encodeURIComponent(selector) : fragment;
        } catch { return fragment; }
      });
      return value.slice(0, index + 1) + fragments.join('&');
    }
    if (value && typeof value === 'object' && !seenDns.has(value)) {
      seenDns.add(value);
      for (const key of Object.keys(value)) value[key] = rewriteDns(value[key]);
    }
    return value;
  };
  if (output.dns) output.dns = rewriteDns(output.dns);
  for (const proxy of [...output.proxies, ...Object.values(output['proxy-providers'] || {}).map(provider => provider?.override)]) {
    if (proxy?.['dialer-proxy'] === removed) proxy['dialer-proxy'] = selector;
  }
}

function claimName(name, used) {
  let candidate = name;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${name} (${suffix})`;
  used.add(candidate);
  return candidate;
}

function addProxyServerDirectRules(config) {
  const direct = new Set();
  for (const proxy of config.proxies || []) {
    if (typeof proxy?.server !== 'string') continue;
    const value = proxy.server.trim();
    if (!value || /[,\s/\\#?@%]/u.test(value)) continue;
    const host = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    const family = isIP(host);
    if (family === 4) direct.add(`IP-CIDR,${host}/32,DIRECT,no-resolve`);
    else if (family === 6) {
      const address = new URL(`http://[${host}]/`).hostname.slice(1, -1);
      direct.add(`IP-CIDR6,${address}/128,DIRECT,no-resolve`);
    } else {
      const domain = domainToASCII(host).replace(/\.$/u, '').toLowerCase();
      if (domain && /^[a-z0-9_.-]+$/u.test(domain) && !domain.includes('..')) direct.add(`DOMAIN,${domain},DIRECT`);
    }
  }
  if (direct.size) config.rules = [...direct, ...(config.rules || []).filter(rule => !direct.has(rule))];
  return config;
}

function transformConfig(template, upstreamProxyLists, { removeFailover = false, evenNodesFirst = false, sourceNames, countryGroupType, countryTestUrl, countryTestInterval, customCountries, countryCodes } = {}) {
  const groupOptions = countryGroupOptions({ countryGroupType, countryTestUrl, countryTestInterval });
  const filter = countryFilterOptions({customCountries, countryCodes});
  const selectedCountries = new Set(filter.countryCodes);
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
  if (sourceNames !== undefined && (!Array.isArray(sourceNames) || sourceNames.length !== upstreamProxyLists.length || sourceNames.some(name => typeof name !== 'string' || !name.trim()))) {
    throw new TypeError('Source names must match upstream proxy lists and contain non-empty names');
  }
  const reservedSourceNames = new Set(sourceNames?.map(name => name.trim()));
  const seenSourceNames = new Set();
  const sourceLabels = sourceNames?.map(name => {
    name = name.trim();
    if (seenSourceNames.has(name)) return claimName(name, reservedSourceNames);
    seenSourceNames.add(name);
    return name;
  });

  const output = structuredClone(template);
  const selector = findRequiredGroup(output['proxy-groups'], '🚀 节点选择');
  const failover = findRequiredGroup(output['proxy-groups'], '🔰 故障转移');
  const records = [];
  const usedNames = new Set([...output.proxies, ...output['proxy-groups']].map(record => record?.name));

  for (const [listIndex, list] of upstreamProxyLists.entries()) {
    if (!Array.isArray(list)) throw new TypeError('Each upstream proxy list must be an array');
    for (const proxy of list) {
      if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)) {
        throw new TypeError('Every proxy must be a YAML mapping');
      }
      const country = detectCountry(proxy.name);
      if (filter.customCountries && !selectedCountries.has(country.code)) continue;
      records.push({
        proxy,
        country,
        protocol: normalizeProtocol(proxy.type),
        sourceOrder: sourceLabels ? listIndex : 0,
        sourceName: sourceLabels?.[listIndex] ?? '',
        sourceIndex: records.length,
        assignedName: null
      });
    }
  }

  if (filter.customCountries && !records.length) throw new TypeError('没有符合所选国家的节点，请调整国家或更新来源');
  const groupsByKey = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.sourceOrder, record.protocol, record.country.code]);
    let group = groupsByKey.get(key);
    if (!group) {
      group = {
        protocol: record.protocol,
        country: record.country,
        sourceOrder: record.sourceOrder,
        sourceName: record.sourceName,
        records: []
      };
      groupsByKey.set(key, group);
    }
    group.records.push(record);
  }

  const groups = [...groupsByKey.values()].sort((left, right) => {
    if (sourceLabels) return compareCountries(left.country, right.country) || left.sourceOrder - right.sourceOrder || compareProtocols(left.protocol, right.protocol);
    const protocolOrder = compareProtocols(left.protocol, right.protocol);
    return protocolOrder || compareCountries(left.country, right.country);
  });

  const countryCounters = new Map();
  const generatedGroups = groups.map((group) => {
    const counterKey = JSON.stringify([group.sourceOrder, group.country.code]);
    const firstNumber = (countryCounters.get(counterKey) || 0) + 1;
    const prefix = `${group.country.flag} ${group.sourceName ? group.sourceName + ' ' : ''}`;
    const groupName = `${prefix}${group.protocol.toLocaleUpperCase('en-US')} ${group.country.name}`;
    const assignedGroupName = sourceLabels ? claimName(groupName, usedNames) : groupName;
    let proxyNames = group.records.map((record) => {
      const next = (countryCounters.get(counterKey) || 0) + 1;
      countryCounters.set(counterKey, next);
      const name = `${prefix}${group.country.name} ${String(next).padStart(2, '0')}`;
      record.assignedName = sourceLabels ? claimName(name, usedNames) : name;
      return record.assignedName;
    });
    if (evenNodesFirst) {
      proxyNames = [
        ...proxyNames.filter((_, index) => (firstNumber + index) % 2 === 0),
        ...proxyNames.filter((_, index) => (firstNumber + index) % 2 === 1)
      ];
    }
    return {
      name: assignedGroupName,
      type: groupOptions.countryGroupType,
      ...(groupOptions.countryGroupType === 'select' ? {} : { interval: groupOptions.countryTestInterval, url: groupOptions.countryTestUrl }),
      ...(groupOptions.countryGroupType === 'load-balance' ? { strategy: 'consistent-hashing' } : {}),
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
  if (removeFailover) removeFailoverGroup(output, failover);

  addProxyServerDirectRules(output);

  return output;
}

module.exports = {
  DEFAULT_COUNTRY_GROUP_TYPE,
  DEFAULT_COUNTRY_TEST_URL,
  DEFAULT_COUNTRY_TEST_INTERVAL,
  countryGroupOptions,
  PROTOCOL_PRIORITY,
  addProxyServerDirectRules,
  transformConfig
};
