'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformConfig } = require('../transform');

function template(proxies = []) {
  return { proxies, 'proxy-groups': [
    { name: '🚀 节点选择', type: 'select', proxies: [] },
    { name: '🔰 故障转移', type: 'fallback', proxies: [] }
  ], rules: ['MATCH,🚀 节点选择'] };
}

test('prepends exact direct rules for unique template and subscription servers', () => {
  const base = template([{ name: 'own', type: 'ss', server: 'own.example' }]);
  const sources = [[
    { name: 'US one', type: 'anytls', server: 'ENTRY.Example.' },
    { name: 'US two', type: 'anytls', server: 'entry.example' },
    { name: 'US unicode separator', type: 'anytls', server: 'entry.example。' },
    { name: 'US v4', type: 'ss', server: '203.0.113.8' },
    { name: 'US v6', type: 'ss', server: '2001:0DB8:0:0:0:0:0:8' },
    { name: 'US v6 duplicate', type: 'ss', server: '[2001:db8::8]' }
  ]];
  const output = transformConfig(base, sources);
  assert.deepEqual(output.rules, [
    'DOMAIN,own.example,DIRECT',
    'DOMAIN,entry.example,DIRECT',
    'IP-CIDR,203.0.113.8/32,DIRECT,no-resolve',
    'IP-CIDR6,2001:db8::8/128,DIRECT,no-resolve',
    'MATCH,🚀 节点选择'
  ]);
  assert.deepEqual(base.rules, ['MATCH,🚀 节点选择']);
  assert.equal(sources[0][0].server, 'ENTRY.Example.');
});

test('moves existing direct rules ahead of matching proxies without duplication', () => {
  const base = template([{ name: 'US', type: 'ss', server: 'entry.example' }]);
  base.rules = ['DOMAIN,entry.example,🚀 节点选择','MATCH,🚀 节点选择','DOMAIN,entry.example,DIRECT'];
  const first = transformConfig(base, []);
  assert.deepEqual(first.rules, ['DOMAIN,entry.example,DIRECT','DOMAIN,entry.example,🚀 节点选择','MATCH,🚀 节点选择']);
  assert.deepEqual(transformConfig(first, []).rules, first.rules);
});

test('skips missing or invalid server fields instead of injecting rules', () => {
  const base = template();
  const output = transformConfig(base, [[undefined, null, '', 'bad,Proxy', 'x\nMATCH,DIRECT', 'https://entry.example/', 'bad host', 'entry.example:443', 'fe80::1%eth0', '[fe80::1%12]'].map((server,index) => ({name:`US ${index}`,type:'ss',server}))]);
  assert.deepEqual(output.rules, base.rules);
});
