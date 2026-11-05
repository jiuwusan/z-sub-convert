'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformConfig } = require('../transform');

function template(dns) {
  return { ...(dns === undefined ? {} : { dns }), proxies: [], 'proxy-groups': [
    { name: '🚀 节点选择', type: 'select', proxies: ['🔰 故障转移'] },
    { name: '🔰 故障转移', type: 'fallback', proxies: [] }
  ], rules: [] };
}
const node = server => ({ name: 'US', type: 'ss', server });

test('source DNS generates policies per source domain and excludes IP nodes', () => {
  const output = transformConfig(template({ nameserver: ['9.9.9.9'] }), [
    [node('A.Example.'), node('192.0.2.1'), node('[2001:db8::1]'), node('a.example')], [node('b.example')]
  ], { sourceDns: [{ 'proxy-server-nameserver': ['1.1.1.1'] }, { 'proxy-server-nameserver': ['8.8.8.8'] }] });
  assert.deepEqual(output.dns['proxy-server-nameserver-policy'], { 'a.example': ['1.1.1.1'], 'b.example': ['8.8.8.8'] });
  assert.deepEqual(output.dns['proxy-server-nameserver'], ['9.9.9.9']);
});

test('local proxy DNS endpoints are replaced with same-source nameservers and deduplicated', () => {
  for (const local of ['127.0.0.1:5353', 'udp://127.0.0.1:5353', 'tcp://127.0.0.1:5353#DIRECT', 'tls://127.0.0.1:853', 'https://127.0.0.1:8443/dns-query']) {
    const output = transformConfig(template(), [[node('node.example')]], { sourceDns: [{
      'proxy-server-nameserver': [local, '1.1.1.1'], nameserver: ['127.0.0.1:53', '8.8.8.8', '8.8.8.8']
    }] });
    assert.deepEqual(output.dns['proxy-server-nameserver-policy'], { 'node.example': ['8.8.8.8', '1.1.1.1'] });
    assert.ok(output.dns['proxy-server-nameserver'].length);
  }
});

test('both source policies filter local values and retain external values and string shape', () => {
  const policies = {
    'local.example': '127.0.0.1:5353', 'all-local.example': ['tcp://127.0.0.1:53'],
    'mixed.example': ['127.0.0.1:53', 'https://doh.example/dns-query?note=127.0.0.1:53'],
    'string.example': '8.8.8.8', 'invalid.example': null
  };
  const output = transformConfig(template(), [[node('node.example')]], { sourceDns: [{
    'proxy-server-nameserver-policy': policies, 'nameserver-policy': policies
  }] });
  for (const key of ['proxy-server-nameserver-policy', 'nameserver-policy']) assert.deepEqual(output.dns[key], {
    'mixed.example': ['https://doh.example/dns-query?note=127.0.0.1:53'], 'string.example': '8.8.8.8'
  });
  assert.ok(output.dns['proxy-server-nameserver'].length);
});

test('template and source explicit policies take priority over generated defaults', () => {
  const base = template({ 'proxy-server-nameserver': ['9.9.9.9'],
    'proxy-server-nameserver-policy': { 'template.example': '9.9.9.9', '+.local.example': '9.9.9.9' },
    'nameserver-policy': { 'template.example': '9.9.9.9' }
  });
  const output = transformConfig(base, [[node('template.example'), node('a.local.example'), node('node.source.example'), node('duplicate.example')], [node('duplicate.example')]], { sourceDns: [
    { 'proxy-server-nameserver': ['1.1.1.1'], 'proxy-server-nameserver-policy': { '*.source.example': '8.8.8.8', 'template.example': '1.1.1.1' }, 'nameserver-policy': { 'template.example': '1.1.1.1' } },
    { 'proxy-server-nameserver': ['8.8.8.8'], 'proxy-server-nameserver-policy': { '*.source.example': '4.4.4.4' } }
  ] });
  assert.deepEqual(output.dns['proxy-server-nameserver-policy'], {
    'template.example': '9.9.9.9', '+.local.example': '9.9.9.9', '*.source.example': '8.8.8.8', 'duplicate.example': ['1.1.1.1']
  });
  assert.equal(output.dns['nameserver-policy']['template.example'], '9.9.9.9');
});

test('wildcards follow label boundaries and explicit exact matches are case insensitive', () => {
  const output = transformConfig(template(), [[node('a.example'), node('a.b.example'), node('example'), node('EXACT.test')]], { sourceDns: [{
    'proxy-server-nameserver': ['1.1.1.1'], 'proxy-server-nameserver-policy': { '*.example': '8.8.8.8', 'exact.test': '9.9.9.9' }
  }] });
  assert.deepEqual(output.dns['proxy-server-nameserver-policy'], {
    '*.example': '8.8.8.8', 'exact.test': '9.9.9.9', 'a.b.example': ['1.1.1.1'], example: ['1.1.1.1']
  });
});

test('missing source DNS and unusable local-only DNS preserve existing output', () => {
  const base = template();
  const lists = [[node('a.example')]];
  for (const sourceDns of [[], [undefined], [null], [{}], [{ 'proxy-server-nameserver': ['127.0.0.1:53'], nameserver: ['127.0.0.1:54'], 'nameserver-policy': { a: '127.0.0.1:53' } }]]) {
    assert.deepEqual(transformConfig(base, lists, { sourceDns }), transformConfig(base, lists));
  }
});

test('policies follow hosts aliases with cycles bounded and inputs stay unchanged', () => {
  const base = template({ 'proxy-server-nameserver': ['9.9.9.9'] });
  const sourceHosts = [{ 'a.example': 'b.example', 'b.example': 'a.example' }];
  const sourceDns = [{ 'proxy-server-nameserver': ['1.1.1.1'] }];
  const before = structuredClone({ base, sourceHosts, sourceDns });
  const output = transformConfig(base, [[node('a.example')]], { sourceDns, sourceHosts });
  assert.deepEqual(output.dns['proxy-server-nameserver-policy'], { 'a.example': ['1.1.1.1'], 'b.example': ['1.1.1.1'] });
  output.dns['proxy-server-nameserver-policy']['a.example'].push('8.8.8.8');
  assert.deepEqual({ base, sourceHosts, sourceDns }, before);
});

test('country filters exclude automatic policy for removed nodes but preserve imported policy', () => {
  const output = transformConfig(template(), [[node('us.example'), { ...node('jp.example'), name: 'JP' }]], {
    sourceDns: [{ 'proxy-server-nameserver': ['1.1.1.1'], 'nameserver-policy': { 'other.example': '8.8.8.8' } }], customCountries: true, countryCodes: ['US']
  });
  assert.deepEqual(output.dns['proxy-server-nameserver-policy'], { 'us.example': ['1.1.1.1'] });
  assert.deepEqual(output.dns['nameserver-policy'], { 'other.example': '8.8.8.8' });
});

test('source resolver fragments follow renamed source nodes and preserve DNS options', () => {
  const output = transformConfig(template(), [[{ ...node('node.example'), name: 'US relay' }]], {
    sourceDns: [{
      'proxy-server-nameserver': ['https://dns.example/dns-query#US%20relay&h3=true'],
      'proxy-server-nameserver-policy': { 'explicit.example': 'tls://dns.example#US relay' },
      'nameserver-policy': { 'app.example': ['https://dns.example/dns-query#US%20relay', '1.1.1.1#DIRECT'] }
    }]
  });
  assert.equal(output.proxies[0].name, '🇺🇸 美国 01');
  const renamed = encodeURIComponent('🇺🇸 美国 01');
  assert.deepEqual(output.dns['proxy-server-nameserver-policy']['node.example'], [`https://dns.example/dns-query#${renamed}&h3=true`]);
  assert.equal(output.dns['proxy-server-nameserver-policy']['explicit.example'], `tls://dns.example#${renamed}`);
  assert.deepEqual(output.dns['nameserver-policy']['app.example'], [`https://dns.example/dns-query#${renamed}`, '1.1.1.1#DIRECT']);
});
