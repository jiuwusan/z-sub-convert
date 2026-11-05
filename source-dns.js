'use strict';

const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

const POLICY_KEYS = ['proxy-server-nameserver-policy', 'nameserver-policy'];
const mapping = value => value && typeof value === 'object' && !Array.isArray(value);
const addresses = value => [...new Set((Array.isArray(value) ? value : [value])
  .filter(address => typeof address === 'string' && address.trim() && !/[\r\n]/u.test(address))
  .map(address => address.trim()))];

function localResolver(address) {
  try {
    const endpoint = new URL(address.includes('://') ? address : `udp://${address}`);
    return endpoint.hostname === '127.0.0.1';
  } catch { return false; }
}

const externalAddresses = value => addresses(value).filter(address => !localResolver(address));

function rewriteResolver(address, proxyNames) {
  const index = address.indexOf('#');
  if (index === -1 || !proxyNames?.size) return address;
  const fragments = address.slice(index + 1).split('&').map(fragment => {
    let name;
    try { name = decodeURIComponent(fragment); } catch { return fragment; }
    return proxyNames.has(name) ? encodeURIComponent(proxyNames.get(name)) : fragment;
  });
  return address.slice(0, index + 1) + fragments.join('&');
}

function domainName(value) {
  if (typeof value !== 'string') return null;
  const host = value.trim().replace(/\.$/u, '');
  if (!host || isIP(host) || /[,\s/\\#?@%:\[\]]/u.test(host)) return null;
  const domain = domainToASCII(host).toLowerCase();
  return domain && /^[a-z0-9_.-]+$/u.test(domain) && !domain.includes('..') ? domain : null;
}

function matchesDomain(pattern, domain) {
  pattern = pattern.toLowerCase().replace(/\.$/u, '');
  if (pattern.startsWith('+.')) return domain === pattern.slice(2) || domain.endsWith(pattern.slice(1));
  if (pattern.startsWith('.')) return domain.endsWith(pattern);
  const labels = pattern.split('.');
  const actual = domain.split('.');
  return labels.length === actual.length && labels.every((label, index) => label === '*' || label === actual[index]);
}

function nodeDomains(proxies, hosts) {
  const pending = proxies.map(proxy => proxy.server);
  const domains = new Set();
  const aliases = mapping(hosts) ? Object.entries(hosts) : [];
  for (let index = 0; index < pending.length; index++) {
    const domain = domainName(pending[index]);
    if (!domain || domains.has(domain)) continue;
    domains.add(domain);
    const alias = aliases.find(([key]) => key.toLowerCase() === domain)
      ?? aliases.find(([key]) => matchesDomain(key, domain));
    if (alias) pending.push(...(Array.isArray(alias[1]) ? alias[1] : [alias[1]]));
  }
  return domains;
}

function mergeSourceDns(output, sources) {
  const policies = Object.fromEntries(POLICY_KEYS.map(key => [key, new Map(mapping(output.dns?.[key]) ? Object.entries(output.dns[key]) : [])]));
  const changed = new Set();
  for (const { dns, proxyNames } of sources) {
    for (const key of POLICY_KEYS) {
      if (!mapping(dns?.[key])) continue;
      for (const [pattern, value] of Object.entries(dns[key])) {
        const usable = externalAddresses(value).map(address => rewriteResolver(address, proxyNames));
        if (!usable.length || policies[key].has(pattern)) continue;
        policies[key].set(pattern, typeof value === 'string' ? usable[0] : usable);
        changed.add(key);
      }
    }
  }
  const proxyPolicy = policies['proxy-server-nameserver-policy'];
  const explicitPatterns = [...proxyPolicy.keys()];
  for (const { dns, proxies, proxyNames } of sources) {
    const fallback = externalAddresses(dns?.nameserver).map(address => rewriteResolver(address, proxyNames));
    const resolvers = [...new Set(addresses(dns?.['proxy-server-nameserver']).flatMap(address => localResolver(address) ? fallback : [rewriteResolver(address, proxyNames)]))];
    if (!resolvers.length) continue;
    for (const domain of nodeDomains(proxies, output.hosts)) {
      if (proxyPolicy.has(domain) || explicitPatterns.some(pattern => matchesDomain(pattern, domain))) continue;
      proxyPolicy.set(domain, resolvers);
      changed.add('proxy-server-nameserver-policy');
    }
  }
  if (!changed.size) return;
  output.dns ??= {};
  for (const key of changed) output.dns[key] = structuredClone(Object.fromEntries(policies[key]));
}

module.exports = { mergeSourceDns };
