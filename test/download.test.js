'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachment } = require('../download');

function filename(header) { return decodeURIComponent(header.split("filename*=UTF-8''")[1]); }

test('names attachments with Unicode source name and Unix millisecond timestamp', () => {
  assert.equal(filename(attachment('第三方订阅', 1793155200123)), '第三方订阅-1793155200123.yaml');
  assert.equal(filename(attachment("User's (test)", 123)), "User's (test)-123.yaml");
});

test('attachment filenames cannot inject headers or paths and fit filesystem byte limits', () => {
  const header = attachment('../来源/\\name:"\r\n*?<>|', 123);
  assert.doesNotMatch(header, /\r|\n/);
  assert.doesNotMatch(filename(header), /[\\/:"*?<>|\r\n]/);
  assert.ok(Buffer.byteLength(filename(attachment('模板'.repeat(100), 1793155200123))) <= 240);
  assert.doesNotThrow(() => attachment('bad\uD800name', 123));
});
