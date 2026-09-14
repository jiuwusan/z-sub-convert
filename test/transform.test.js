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

test('sorts generated groups by protocol then country and injects both template groups', () => {
  const template = makeTemplate();
  const output = transformConfig(template, [[
    { name: 'US hy2', type: 'hysteria2', server: 'hy.example', port: 443 },
    { name: 'Japan ss', type: 'ss', server: 'jp.example', port: 443 },
    { name: 'SG ss', type: 'ss', server: 'sg.example', port: 443 },
    { name: 'US ssr', type: 'ssr', server: 'ssr.example', port: 443 },
    { name: 'SG trojan', type: 'trojan', server: 'trojan.example', port: 443 }
  ]]);

  const generatedNames = output['proxy-groups'].slice(3).map(({ name }) => name);
  assert.deepEqual(generatedNames, [
    '🇸🇬 SS 新加坡',
    '🇯🇵 SS 日本',
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
