'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { transformConfig } = require('../transform');

function makeTemplate() {
  return {
    proxies: [],
    'proxy-groups': [
      { name: '🚀 节点选择', type: 'select', proxies: ['🔰 故障转移'] },
      { name: '🔰 故障转移', type: 'fallback', proxies: [] },
      { name: '保留组', type: 'select', proxies: ['DIRECT'] }
    ],
    rules: ['MATCH,🚀 节点选择']
  };
}

test('keeps proxies already present in the template', () => {
  const template = makeTemplate();
  template.proxies.push({ name: '自有节点', type: 'ss', server: 'own.example', port: 443 });
  const output = transformConfig(template, [[
    { name: 'SG ss', type: 'ss', server: 'sg.example', port: 443 }
  ]]);

  assert.deepEqual(output.proxies.map(({ name }) => name), [
    '自有节点',
    '🇸🇬 新加坡 01'
  ]);
  assert.equal(output.proxies[0].server, 'own.example');
});

test('sorts generated groups by protocol then country and injects both template groups', () => {
  const template = makeTemplate();
  const output = transformConfig(template, [[
    { name: 'US hy2', type: 'hysteria2', server: 'hy.example', port: 443 },
    { name: 'Japan ss', type: 'ss', server: 'jp.example', port: 443 },
    { name: 'US ss', type: 'ss', server: 'us.example', port: 443 },
    { name: 'SG ss', type: 'ss', server: 'sg.example', port: 443 },
    { name: 'US ssr', type: 'ssr', server: 'ssr.example', port: 443 },
    { name: 'SG trojan', type: 'trojan', server: 'trojan.example', port: 443 }
  ]]);

  const generatedNames = output['proxy-groups'].slice(3).map(({ name }) => name);
  assert.deepEqual(generatedNames, [
    '🇺🇸 SS 美国',
    '🇯🇵 SS 日本',
    '🇸🇬 SS 新加坡',
    '🇺🇸 SSR 美国',
    '🇺🇸 HYSTERIA2 美国',
    '🇸🇬 TROJAN 新加坡'
  ]);
  assert.deepEqual(output['proxy-groups'][0].proxies, [
    '🔰 故障转移', ...generatedNames
  ]);
  assert.deepEqual(output['proxy-groups'][1].proxies, generatedNames);
});

test('keeps source proxy order but numbers each country across protocol groups', () => {
  const source = [
    { name: 'Singapore hy2', type: 'hysteria2', server: 'one', port: 1 },
    { name: 'Singapore ss', type: 'ss', server: 'two', port: 2, udp: true },
    { name: 'Singapore ss second', type: 'ss', server: 'three', port: 3 }
  ];
  const output = transformConfig(makeTemplate(), [source]);

  assert.deepEqual(output.proxies.map(({ name }) => name), [
    '🇸🇬 新加坡 03',
    '🇸🇬 新加坡 01',
    '🇸🇬 新加坡 02'
  ]);
  assert.equal(output.proxies[1].udp, true);
  assert.equal(source[0].name, 'Singapore hy2');
  assert.equal(new Set(output.proxies.map(({ name }) => name)).size, 3);
});

for (const [count, expectedNames] of [
  [1, ['🇸🇬 新加坡 01']],
  [2, ['🇸🇬 新加坡 02', '🇸🇬 新加坡 01']],
  [3, ['🇸🇬 新加坡 02', '🇸🇬 新加坡 01', '🇸🇬 新加坡 03']]
]) {
  test(`swaps only the first two children in a country group with ${count} proxies`, () => {
    const source = Array.from({ length: count }, (_, index) => ({
      name: `SG ${index + 1}`, type: 'ss', server: `sg-${index + 1}`, port: 443
    }));
    const output = transformConfig(makeTemplate(), [source]);
    const group = output['proxy-groups'].find(({ name }) => name === '🇸🇬 SS 新加坡');

    assert.deepEqual(group.proxies, expectedNames);
    assert.deepEqual(output.proxies.map(({ server }) => server), source.map(({ server }) => server));
    assert.equal(output.proxies[0].name, '🇸🇬 新加坡 01');
  });
}

test('pads proxy numbers to two digits without truncating 100', () => {
  const proxies = Array.from({ length: 100 }, (_, index) => ({
    name: `JP ${index + 1}`,
    type: 'ss',
    server: `server-${index + 1}`,
    port: 443
  }));
  const output = transformConfig(makeTemplate(), [proxies]);

  assert.equal(output.proxies[0].name, '🇯🇵 日本 01');
  assert.equal(output.proxies[99].name, '🇯🇵 日本 100');
});

test('orders unknown protocols alphabetically and puts unknown country last', () => {
  const output = transformConfig(makeTemplate(), [[
    { name: 'Moon', type: 'zeta', server: 'one', port: 1 },
    { name: 'Canada', type: 'alpha', server: 'two', port: 2 },
    { name: 'Moon', type: 'alpha', server: 'three', port: 3 }
  ]]);

  assert.deepEqual(output['proxy-groups'].slice(3).map(({ name }) => name), [
    '🇨🇦 ALPHA 加拿大',
    '🏳️ ALPHA 其他',
    '🏳️ ZETA 其他'
  ]);
});

test('rejects proxies without a usable type', () => {
  assert.throws(
    () => transformConfig(makeTemplate(), [[{ name: 'SG', server: 'one', port: 1 }]]),
    /proxy type/i
  );
});

test('rejects missing required template structures', () => {
  assert.throws(
    () => transformConfig({ proxies: [], 'proxy-groups': [] }, [[]]),
    /节点选择/
  );
  const template = makeTemplate();
  template['proxy-groups'][1].proxies = 'invalid';
  assert.throws(() => transformConfig(template, [[]]), /proxies array/i);
});

test('optionally removes only the top failover group and expands its members without duplicates', () => {
  const template = makeTemplate();
  template['proxy-groups'][1].proxies = ['DIRECT'];
  template['proxy-groups'].push({ name: '其他选择', type: 'select', proxies: ['🔰 故障转移', 'DIRECT'] });
  const source = [[{ name: 'US', type: 'ss', server: 'us.example', port: 443 }]];
  const original = structuredClone(template);
  const normal = transformConfig(template, source);
  assert.ok(normal['proxy-groups'].some(group => group.name === '🔰 故障转移'));
  const output = transformConfig(template, source, { removeFailover: true });
  assert.equal(output['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
  assert.deepEqual(output['proxy-groups'].find(group => group.name === '🚀 节点选择').proxies, ['DIRECT', '🇺🇸 SS 美国']);
  assert.deepEqual(output['proxy-groups'].find(group => group.name === '其他选择').proxies, ['DIRECT', '🇺🇸 SS 美国']);
  assert.equal(output['proxy-groups'].find(group => group.name === '🇺🇸 SS 美国').type, 'fallback');
  assert.deepEqual(output.proxies, normal.proxies);
  assert.deepEqual(template, original);
});

test('removing failover rewrites rule, DNS and dialer references without changing credentials or matching text', () => {
  const template = makeTemplate();
  template.rules = ['MATCH,🔰 故障转移', 'IP-CIDR,1.1.1.0/24,🔰 故障转移,no-resolve', 'DOMAIN,🔰 故障转移,DIRECT'];
  template['sub-rules'] = { child: ['DOMAIN,example.com,🔰 故障转移'] };
  template.dns = { nameserver: ['https://dns.google/dns-query#🔰 故障转移&ecs=1.1.1.1', 'https://dns.google/dns-query#' + encodeURIComponent('🔰 故障转移')], 'nameserver-policy': { 'example.com': 'tls://dns.example#🔰 故障转移' } };
  template['proxy-providers'] = { provider: { override: { 'dialer-proxy': '🔰 故障转移' } } };
  const output = transformConfig(template, [[{ name: 'US', type: 'ss', password: '🔰 故障转移', 'dialer-proxy': '🔰 故障转移' }]], { removeFailover: true });
  assert.deepEqual(output.rules, ['MATCH,🚀 节点选择', 'IP-CIDR,1.1.1.0/24,🚀 节点选择,no-resolve', 'DOMAIN,🔰 故障转移,DIRECT']);
  assert.deepEqual(output['sub-rules'].child, ['DOMAIN,example.com,🚀 节点选择']);
  assert.equal(output.dns.nameserver[0], 'https://dns.google/dns-query#🚀 节点选择&ecs=1.1.1.1');
  assert.equal(decodeURIComponent(output.dns.nameserver[1].split('#')[1]), '🚀 节点选择');
  assert.equal(output.dns['nameserver-policy']['example.com'], 'tls://dns.example#🚀 节点选择');
  assert.equal(output.proxies[0]['dialer-proxy'], '🚀 节点选择');
  assert.equal(output.proxies[0].password, '🔰 故障转移');
  assert.equal(output['proxy-providers'].provider.override['dialer-proxy'], '🚀 节点选择');
});

test('removing failover handles src options and preserves SUB-RULE identifiers', () => {
  const template = makeTemplate();
  template.rules = [
    'IP-CIDR,192.168.0.0/16,🔰 故障转移,src',
    'IP-CIDR,192.168.0.0/16,🔰 故障转移,src,no-resolve',
    'SUB-RULE,(NETWORK,UDP),🔰 故障转移'
  ];
  template['sub-rules'] = { '🔰 故障转移': ['MATCH,🔰 故障转移'] };
  const output = transformConfig(template, [[]], { removeFailover: true });
  assert.deepEqual(output.rules, [
    'IP-CIDR,192.168.0.0/16,🚀 节点选择,src',
    'IP-CIDR,192.168.0.0/16,🚀 节点选择,src,no-resolve',
    'SUB-RULE,(NETWORK,UDP),🔰 故障转移'
  ]);
  assert.deepEqual(output['sub-rules']['🔰 故障转移'], ['MATCH,🚀 节点选择']);
});
