'use strict';

const { timingSafeEqual } = require('node:crypto');

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { equal };
