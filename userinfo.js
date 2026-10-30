'use strict';

const FIELDS = ['upload', 'download', 'total', 'expire'];
const MAX_TRAFFIC = (1n << 64n) - 1n;
const MAX_EXPIRE = 253402300799n; // Last second of year 9999; safe to display as a date.

function integer(value, maximum) {
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) return null;
  const number = BigInt(value);
  return number <= maximum ? number.toString() : null;
}

function parseUserinfo(header) {
  if (typeof header !== 'string' || header.length > 4096 || /[\x00-\x1f\x7f]/.test(header)) return null;
  const info = {};
  const seen = new Set();
  for (const part of header.split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(.*?)\s*$/i.exec(part);
    if (!match) continue;
    const field = match[1].toLowerCase();
    if (seen.has(field)) { delete info[field]; continue; }
    seen.add(field);
    const value = integer(match[2], field === 'expire' ? MAX_EXPIRE : MAX_TRAFFIC);
    if (value !== null) info[field] = value;
  }
  return Object.keys(info).length ? info : null;
}

function aggregateUserinfo(items) {
  const info = {};
  let available = 0;
  for (const item of items) {
    if (!item) continue;
    let provided = false;
    for (const field of FIELDS) {
      const value = integer(item[field], field === 'expire' ? MAX_EXPIRE : MAX_TRAFFIC);
      if (value === null) continue;
      provided = true;
      const current = info[field];
      if (current === undefined) info[field] = value;
      else if (field === 'expire') info[field] = current === '0' || value === '0' ? '0' : (BigInt(current) > BigInt(value) ? current : value);
      else if (field === 'total' && (current === '0' || value === '0')) info[field] = '0';
      else info[field] = (BigInt(current) + BigInt(value)).toString();
    }
    if (provided) available++;
  }
  return { userInfo: available ? info : null, coverage: { available, total: items.length } };
}

function formatUserinfo(info) {
  const parts = [];
  for (const field of FIELDS) {
    const value = integer(info?.[field], field === 'expire' ? MAX_EXPIRE : MAX_TRAFFIC * 50n);
    if (value !== null) parts.push(`${field}=${value}`);
  }
  return parts.length ? parts.join('; ') : null;
}

module.exports = { parseUserinfo, aggregateUserinfo, formatUserinfo };
