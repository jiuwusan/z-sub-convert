'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUserinfo, aggregateUserinfo, formatUserinfo } = require('../userinfo');

test('parses only valid known nonnegative integer fields without inventing missing fields', () => {
  assert.deepEqual(parseUserinfo(' Upload = 001 ; download=2; total=9007199254740993; expire=1893456000; token=secret'),
    { upload: '1', download: '2', total: '9007199254740993', expire: '1893456000' });
  assert.deepEqual(parseUserinfo('total=1024'), { total: '1024' });
  assert.deepEqual(parseUserinfo('total=0; expire=0'), { total: '0', expire: '0' });
  for (const value of [null, '', 'secret=abc', 'upload=-1; download=NaN; total=1.5; expire=Infinity', 'total=18446744073709551616; expire=253402300800', 'total=1\r\nx-header: injected', 'total=1;'.repeat(600)]) {
    assert.equal(parseUserinfo(value), null, String(value).slice(0, 60));
  }
  assert.deepEqual(parseUserinfo('upload=bad; total=3; expire=5'), { total: '3', expire: '5' });
  assert.deepEqual(parseUserinfo('total=1; total=2; download=3'), { download: '3' });
});

test('aggregates exact traffic sums and latest expiry with partial source coverage', () => {
  const result = aggregateUserinfo([
    { upload: '9007199254740993', download: '4', total: '10000000000000000', expire: '1800000000' },
    { upload: '2', download: '6', total: '20000000000000000', expire: '1900000000' },
    null
  ]);
  assert.deepEqual(result, { userInfo: { upload: '9007199254740995', download: '10', total: '30000000000000000', expire: '1900000000' }, coverage: { available: 2, total: 3 } });
  assert.equal(formatUserinfo(result.userInfo), 'upload=9007199254740995; download=10; total=30000000000000000; expire=1900000000');
  assert.deepEqual(aggregateUserinfo([null, undefined]), { userInfo: null, coverage: { available: 0, total: 2 } });
  assert.deepEqual(aggregateUserinfo([{ total: '10' }, { expire: '1' }]).userInfo, { total: '10', expire: '1' });
  assert.equal(formatUserinfo(null), null);
  assert.equal(formatUserinfo({ total: '1\r\ninjected: x' }), null);
});

test('preserves unlimited traffic and permanent expiry when aggregating', () => {
  assert.deepEqual(aggregateUserinfo([
    { upload: '4', download: '5', total: '10', expire: '1900000000' },
    { upload: '1', download: '2', total: '0', expire: '0' }
  ]).userInfo, { upload: '5', download: '7', total: '0', expire: '0' });
});
