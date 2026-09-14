'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectCountry, compareCountries } = require('../country');

test('detects countries by flag, Chinese name, English name, and independent code', () => {
  assert.deepEqual(detectCountry('🇸🇬 premium'), {
    code: 'SG', flag: '🇸🇬', name: '新加坡', priority: 0
  });
  assert.equal(detectCountry('日本高速节点').code, 'JP');
  assert.equal(detectCountry('United States west').code, 'US');
  assert.equal(detectCountry('edge-HK-02').code, 'HK');
});

test('matches country codes case-insensitively at token boundaries', () => {
  assert.equal(detectCountry('fast_jp_01').code, 'JP');
  assert.equal(detectCountry('[us] premium').code, 'US');
});

test('does not treat country codes embedded in words as aliases', () => {
  assert.equal(detectCountry('usage node').code, 'OTHER');
  assert.equal(detectCountry('music node').code, 'OTHER');
  assert.equal(detectCountry('telegram node').code, 'OTHER');
});

test('returns the neutral other country for missing or unknown names', () => {
  const expected = {
    code: 'OTHER', flag: '🏳️', name: '其他', priority: Number.MAX_SAFE_INTEGER
  };
  assert.deepEqual(detectCountry('Moon relay'), expected);
  assert.deepEqual(detectCountry(undefined), expected);
});

test('orders priority countries first, recognized countries alphabetically, and other last', () => {
  const countries = [
    detectCountry('Canada'),
    detectCountry('Moon'),
    detectCountry('Japan'),
    detectCountry('Germany'),
    detectCountry('Singapore')
  ];

  countries.sort(compareCountries);

  assert.deepEqual(countries.map(({ name }) => name), [
    '新加坡', '日本', '德国', '加拿大', '其他'
  ]);
});
