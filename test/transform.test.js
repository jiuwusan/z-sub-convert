'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { transformConfig } = require('../src/domain/transform');

test('merges source hosts with template priority and preserves input mappings', () => {
  const template = makeTemplate();
  template.hosts = { 'template.test': '192.0.2.10', 'shared.test': '192.0.2.11' };
  const sourceHosts = [
    { 'shared.test': '192.0.2.12', 'source.test': ['192.0.2.13', '2001:db8::13'], 'duplicate.test': '192.0.2.14' },
    { 'duplicate.test': '192.0.2.15', '*.example.test': 'alias.test' }
  ];
  const before = structuredClone({ template, sourceHosts });
  const output = transformConfig(template, [[{ name: 'US', type: 'ss' }]], { sourceHosts });
  assert.deepEqual(output.hosts, {
    'template.test': '192.0.2.10', 'shared.test': '192.0.2.11',
    'source.test': ['192.0.2.13', '2001:db8::13'], 'duplicate.test': '192.0.2.14', '*.example.test': 'alias.test'
  });
  output.hosts['source.test'].push('192.0.2.99');
  assert.deepEqual({ template, sourceHosts }, before);
});

test('omits hosts when sources have no mapping and supports special domain keys', () => {
  const lists = [[{ name: 'US', type: 'ss' }]];
  assert.equal(Object.hasOwn(transformConfig(makeTemplate(), lists, { sourceHosts: [undefined, null, [], 'invalid'] }), 'hosts'), false);
  const hosts = JSON.parse('{"__proto__":"192.0.2.1","constructor":"192.0.2.2"}');
  assert.deepEqual(transformConfig(makeTemplate(), lists, { sourceHosts: [hosts] }).hosts, hosts);
});

test('country whitelist filters nodes and references before grouping without changing shared inputs or template nodes', () => {
  const template = makeTemplate();
  template.proxies.push({ name: '自有节点', type: 'ss', server: 'own.example' });
  const lists = [[{ name: 'US one', type: 'ss' }, { name: '日本', type: 'ss' }, { name: 'mystery', type: 'trojan' }], [{ name: '🇺🇸 two', type: 'ss' }]];
  const original = structuredClone(lists);
  const filtered = transformConfig(template, lists, { customCountries: true, countryCodes: ['US', 'OTHER'], sourceNames: ['A', 'B'] });
  assert.equal(filtered.proxies.length, 4);
  assert.ok(filtered.proxies.every(proxy => !proxy.name.includes('日本')));
  const names = new Set([...filtered.proxies, ...filtered['proxy-groups']].map(row => row.name));
  for (const group of filtered['proxy-groups']) for (const name of group.proxies) assert.ok(name === 'DIRECT' || names.has(name), name);
  assert.deepEqual(lists, original);
  assert.equal(transformConfig(template, lists, { customCountries: false, countryCodes: ['US'] }).proxies.length, 5);
  assert.equal(transformConfig(template, lists).proxies.length, 5);
  assert.throws(() => transformConfig(template, lists, { customCountries: true, countryCodes: ['DE'] }), /没有.*国家.*节点|无.*匹配/);
  for (const options of [{customCountries:'true'}, {customCountries:null}, {countryCodes:null}, {countryCodes:'US'}, {countryCodes:['bad']}, {countryCodes:[1]}, {customCountries:true,countryCodes:[]}]) {
    assert.throws(() => transformConfig(template, lists, options), /国家/);
  }
});

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
  [2, ['🇸🇬 新加坡 01', '🇸🇬 新加坡 02']],
  [3, ['🇸🇬 新加坡 01', '🇸🇬 新加坡 02', '🇸🇬 新加坡 03']]
]) {
  test(`keeps original order by default in a country group with ${count} proxies`, () => {
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

test('optionally puts even-numbered nodes first with stable order and unchanged top-level proxies', () => {
  for (const count of [0, 1, 2, 3, 6, 101]) {
    const source = Array.from({ length: count }, (_, index) => ({ name: `SG ${index + 1}`, type: 'ss', server: `sg-${index + 1}`, port: 443 }));
    const normal = transformConfig(makeTemplate(), [source], { evenNodesFirst: false });
    const sorted = transformConfig(makeTemplate(), [source], { evenNodesFirst: true });
    const names = normal.proxies.map(proxy => proxy.name);
    const expected = [...names.filter((_, index) => (index + 1) % 2 === 0), ...names.filter((_, index) => (index + 1) % 2 === 1)];
    const group = sorted['proxy-groups'].find(group => group.name === '🇸🇬 SS 新加坡');
    assert.deepEqual(group?.proxies ?? [], expected);
    assert.deepEqual(sorted.proxies, normal.proxies);
    assert.deepEqual(sorted['proxy-groups'].map(group => group.name), normal['proxy-groups'].map(group => group.name));
  }
});

test('even-first uses country-wide assigned numbers across protocols and merges sources stably', () => {
  const source = [
    [{ name: 'SG SS', type: 'ss' }, { name: 'SG HY 1', type: 'hysteria2' }, { name: 'JP', type: 'ss' }],
    [{ name: 'SG HY 2', type: 'hysteria2' }, { name: 'SG HY 3', type: 'hysteria2' }]
  ];
  const output = transformConfig(makeTemplate(), source, { evenNodesFirst: true });
  assert.deepEqual(output['proxy-groups'].find(group => group.name === '🇸🇬 HYSTERIA2 新加坡').proxies,
    ['🇸🇬 新加坡 02', '🇸🇬 新加坡 04', '🇸🇬 新加坡 03']);
  assert.deepEqual(output.proxies.map(proxy => proxy.name), ['🇸🇬 新加坡 01', '🇸🇬 新加坡 02', '🇯🇵 日本 01', '🇸🇬 新加坡 03', '🇸🇬 新加坡 04']);
});

test('splits countries by source and orders country then subscription source then protocol', () => {
  const sources = [
    [{ name: 'JP', type: 'ss' }, { name: 'US HY', type: 'hysteria2' }, { name: 'US SS', type: 'ss' }],
    [{ name: 'JP', type: 'ss' }, { name: 'US', type: 'ss' }]
  ];
  const template = makeTemplate();
  const output = transformConfig(template, sources, { sourceNames: ['A', 'B'] });
  const names = ['🇺🇸 A SS 美国', '🇺🇸 A HYSTERIA2 美国', '🇺🇸 B SS 美国', '🇯🇵 A SS 日本', '🇯🇵 B SS 日本'];
  assert.deepEqual(output['proxy-groups'].slice(3).map(group => group.name), names);
  assert.deepEqual(output['proxy-groups'][0].proxies, ['🔰 故障转移', ...names]);
  assert.deepEqual(output['proxy-groups'][1].proxies, names);
  assert.deepEqual(output.proxies.map(proxy => proxy.name), ['🇯🇵 A 日本 01', '🇺🇸 A 美国 02', '🇺🇸 A 美国 01', '🇯🇵 B 日本 01', '🇺🇸 B 美国 01']);
  assert.deepEqual(output['proxy-groups'][2], template['proxy-groups'][2]);
  assert.equal(template.proxies.length, 0);
  const reversed = transformConfig(template, sources, { sourceNames: ['B', 'A'] });
  assert.deepEqual(reversed['proxy-groups'].slice(3).map(group => group.name), ['🇺🇸 B SS 美国', '🇺🇸 B HYSTERIA2 美国', '🇺🇸 A SS 美国', '🇯🇵 B SS 日本', '🇯🇵 A SS 日本']);
});

test('source-scoped numbering and even-first preserve all per-source fallback members', () => {
  const source = () => [
    { name: 'US', type: 'ss' },
    ...[1, 2, 3].map(i => ({ name: `US HY ${i}`, type: 'hysteria2' }))
  ];
  const output = transformConfig(makeTemplate(), [source(), source()], { sourceNames: ['A', 'B'], evenNodesFirst: true, removeFailover: true });
  for (const name of ['A', 'B']) {
    const group = output['proxy-groups'].find(group => group.name === `🇺🇸 ${name} HYSTERIA2 美国`);
    assert.deepEqual(group.proxies, ['02', '04', '03'].map(n => `🇺🇸 ${name} 美国 ${n}`));
    assert.equal(group.type, 'fallback');
  }
  assert.equal(output['proxy-groups'].some(group => group.name === '🔰 故障转移'), false);
  assert.equal(new Set(output.proxies.map(proxy => proxy.name)).size, 8);
});

test('source names and template name collisions remain unique with valid group references', () => {
  const template = makeTemplate();
  template.proxies.push({ name: '🇺🇸 A 美国 01', type: 'ss' });
  template['proxy-groups'].push({ name: '🇺🇸 A SS 美国', type: 'select', proxies: ['DIRECT'] });
  const source = [{ name: 'US', type: 'ss' }];
  const output = transformConfig(template, [source, source, source], { sourceNames: ['A', 'A', 'A (2)'] });
  assert.ok(output['proxy-groups'].slice(4).every(group => group.name.includes(' A')));
  const allNames = [...output.proxies, ...output['proxy-groups']].map(record => record.name);
  assert.equal(new Set(allNames).size, allNames.length);
  for (const group of output['proxy-groups']) for (const name of group.proxies) assert.ok(name === 'DIRECT' || allNames.includes(name), name);
  assert.deepEqual(output.proxies[0], template.proxies[0]);
});

test('rejects mismatched or invalid source-name metadata', () => {
  for (const sourceNames of [[], [''], [null], ['A', 'B'], 'A']) {
    assert.throws(() => transformConfig(makeTemplate(), [[]], { sourceNames }), /source names/i);
  }
});

test('configures only generated country groups for each supported type', () => {
  for (const countryGroupType of ['url-test', 'fallback', 'select', 'load-balance']) {
    const template = makeTemplate();
    const before = structuredClone(template);
    const output = transformConfig(template, [[{ name: 'US', type: 'ss' }]], { countryGroupType, countryTestUrl: 'https://test.example/204', sourceNames: ['A'] });
    const group = output['proxy-groups'].find(g => g.name === '🇺🇸 A SS 美国');
    assert.equal(group.type, countryGroupType);
    assert.equal(group.url, countryGroupType === 'select' ? undefined : 'https://test.example/204');
    assert.equal(group.interval, countryGroupType === 'select' ? undefined : 305);
    assert.equal(group.strategy, countryGroupType === 'load-balance' ? 'consistent-hashing' : undefined);
    assert.deepEqual(group.proxies, ['🇺🇸 A 美国 01']);
    assert.deepEqual(output['proxy-groups'][2], before['proxy-groups'][2]);
    assert.deepEqual(template, before);
  }
});

test('custom country test intervals apply to automatic groups and leave template groups intact', () => {
  for (const countryGroupType of ['fallback', 'url-test', 'load-balance', 'select']) {
    const template = makeTemplate();
    const original = structuredClone(template['proxy-groups']);
    const result = transformConfig(template, [[{ name: 'US', type: 'ss' }]], { countryGroupType, countryTestInterval: 120 });
    const generated = result['proxy-groups'].at(-1);
    assert.equal(generated.interval, countryGroupType === 'select' ? undefined : 120);
    for (const group of original) assert.equal(result['proxy-groups'].find(row => row.name === group.name).interval, group.interval);
  }
  for (const countryTestInterval of [0, -1, 1.5, null, '120', 86401]) {
    assert.throws(() => transformConfig(makeTemplate(), [[]], { countryTestInterval }), /间隔/);
  }
});

test('rejects invalid country group types and test URLs', () => {
  for (const countryGroupType of ['bad', null, 1, '', 'relay']) assert.throws(() => transformConfig(makeTemplate(), [[]], { countryGroupType }), /国家分组/);
  for (const countryTestUrl of ['', null, 1, 'ftp://test.example', 'http://', 'https://test.example/\npath', 'https://test.example/a\tb', 'https://test.example/a\0b', 'https://test.example/a\x7fb']) assert.throws(() => transformConfig(makeTemplate(), [[]], { countryTestUrl }), /测试 URL/);
});

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

test('optionally removes the top failover group while keeping members in the main selector', () => {
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
  assert.deepEqual(output['proxy-groups'].find(group => group.name === '其他选择').proxies, ['🚀 节点选择', 'DIRECT']);
  assert.equal(output['proxy-groups'].find(group => group.name === '🇺🇸 SS 美国').type, 'fallback');
  assert.deepEqual(output.proxies, normal.proxies);
  assert.deepEqual(template, original);
});

test('AI group does not gain country groups when removing failover', () => {
  for (const members of [
    ['🚀 节点选择', '🔰 故障转移'],
    ['🔰 故障转移'],
    ['🚀 节点选择']
  ]) {
    const template = makeTemplate();
    template['proxy-groups'].push({ name: '💬 Ai平台', type: 'select', proxies: members });
    const source = [[{ name: 'US', type: 'ss', server: 'us.example', port: 443 }]];
    const normal = transformConfig(template, source);
    assert.deepEqual(normal['proxy-groups'].find(group => group.name === '💬 Ai平台').proxies, members);
    const output = transformConfig(template, source, { removeFailover: true });
    assert.deepEqual(output['proxy-groups'].find(group => group.name === '💬 Ai平台').proxies, ['🚀 节点选择']);
    const main = output['proxy-groups'].find(group => group.name === '🚀 节点选择');
    assert.ok(main.proxies.includes('🇺🇸 SS 美国'));
    assert.equal(main.proxies.includes(main.name), false);
  }
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
