'use strict';
const { formatUserinfo } = require('./userinfo');

function attachment(name, timestamp) {
  const safe = String(name || 'subscription').toWellFormed().normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  let stem = '';
  for (const character of safe) {
    if (Buffer.byteLength(stem + character, 'utf8') > 180) break;
    stem += character;
  }
  const filename = `${stem || 'subscription'}-${timestamp}.yaml`;
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="subscription-${timestamp}.yaml"; filename*=UTF-8''${encoded}`;
}

function sendDownload(response, { name, content, timestamp, headOnly = false, stale, userInfo }) {
  const packageHeader = formatUserinfo(userInfo);
  response.writeHead(200, {
    'content-type': 'text/yaml; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': attachment(name, timestamp),
    ...(packageHeader ? { 'subscription-userinfo': packageHeader } : {}),
    ...(typeof stale === 'boolean' ? { 'x-subscription-cache': stale ? 'stale' : 'fresh' } : {})
  });
  response.end(headOnly ? undefined : content);
}

module.exports = { attachment, sendDownload };
