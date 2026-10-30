'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { splitTemplate, composeTemplate, chooseNameservers, validateRuleTemplate } = require('../template-parts');
const seed = YAML.parse(readFileSync(join(__dirname, '../prds/template.yaml'), 'utf8'));

test('splits the initial seed into base, single addresses and rule fields without mutating it', () => {
  const original = structuredClone(seed);
  const { base, rules, nameservers } = splitTemplate(seed);
  assert.equal(base.dns.nameserver, undefined);
  assert.deepEqual(base.dns['proxy-server-nameserver'], seed.dns['proxy-server-nameserver']);
  for (const key of ['proxies', 'proxy-groups', 'rules']) { assert.equal(base[key], undefined); assert.deepEqual(rules[key], seed[key]); }
  assert.deepEqual(nameservers, seed.dns.nameserver);
  assert.deepEqual(seed, original);
  assert.deepEqual(composeTemplate(YAML.stringify(base), YAML.stringify(rules), nameservers), seed);
});

test('only rule templates enforce required structures and groups', () => {
  assert.equal(validateRuleTemplate(YAML.stringify(seed)), YAML.stringify(seed));
  for (const key of ['proxies', 'proxy-groups', 'rules']) {
    const invalid = structuredClone(seed); invalid[key] = 'invalid';
    assert.throws(() => validateRuleTemplate(YAML.stringify(invalid)), /校验失败/);
  }
  const missing = structuredClone(seed); missing['proxy-groups'] = [];
  assert.throws(() => validateRuleTemplate(YAML.stringify(missing)), /节点选择/);
});

test('composition gives each part its own fields and preserves all other base settings', () => {
  const base = { dns: { enable: true, nameserver: ['ignored'], 'nameserver-policy': { 'example.test': '1.1.1.1' } }, port: 7890, rules: ['ignored'], proxies: ['ignored'] };
  const rules = { ...seed, port: 8888, dns: { enable: false } };
  const output = composeTemplate(YAML.stringify(base), YAML.stringify(rules), ['https://dns.google/dns-query#🚀 节点选择']);
  assert.equal(output.port, 7890);
  assert.deepEqual(output.rules, seed.rules);
  assert.deepEqual(output.dns, { enable: true, nameserver: ['https://dns.google/dns-query#🚀 节点选择'], 'nameserver-policy': { 'example.test': '1.1.1.1' } });
  assert.throws(() => composeTemplate('[]', YAML.stringify(seed), ['1.1.1.1']), /基础模板/);
  assert.throws(() => composeTemplate('dns: false', YAML.stringify(seed), ['1.1.1.1']), /dns/);
});

test('source mode uses any available source addresses and only falls back when all sources lack them', () => {
  const first = 'https://dns.google/dns-query#🚀 节点选择';
  const second = 'tls://dns.example';
  assert.deepEqual(chooseNameservers(true, [[first, first], [], [second]], ['fallback']), [first, second]);
  assert.deepEqual(chooseNameservers(true, [[], undefined, [null, '', 42]], [' fallback ', 'fallback']), ['fallback']);
  assert.deepEqual(chooseNameservers(false, [[first]], [second]), [second]);
  assert.deepEqual(chooseNameservers(true, [[first]], []), [first]);
  assert.throws(() => chooseNameservers(true, [[], [' \n ']], []), /nameserver/);
  assert.throws(() => chooseNameservers(false, [[first]], []), /nameserver/);
});
