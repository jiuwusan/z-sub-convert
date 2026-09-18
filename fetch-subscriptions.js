'use strict';

const YAML = require('yaml');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

class SubscriptionError extends Error {
  constructor(message, statusCode, options) {
    super(message, options);
    this.name = 'SubscriptionError';
    this.statusCode = statusCode;
  }
}

function splitSubscriptionUrls(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new SubscriptionError('The url query parameter is required', 400);
  }

  return rawUrl.split('|').map((part) => {
    let url;
    try {
      url = new URL(part.trim());
    } catch (error) {
      throw new SubscriptionError('The url query parameter contains an invalid URL', 400, { cause: error });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SubscriptionError('Subscription URLs must use http or https', 400);
    }
    return url;
  });
}

async function readBoundedBody(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SubscriptionError('Upstream subscription is too large', 502);
  }
  if (!response.body) {
    throw new SubscriptionError('Upstream subscription returned no body', 502);
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > maxBytes) {
      throw new SubscriptionError('Upstream subscription is too large', 502);
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function fetchOne(url, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'clash-verge/v2.4.5' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw new SubscriptionError(`Upstream subscription returned HTTP ${response.status}`, 502);
    }
    const text = await readBoundedBody(response, maxBytes);
    let document;
    try {
      document = YAML.parse(text);
    } catch (error) {
      throw new SubscriptionError('Upstream subscription is not valid YAML', 502, { cause: error });
    }
    if (!document || !Array.isArray(document.proxies) || document.proxies.length === 0) {
      throw new SubscriptionError('Upstream subscription contains no proxies', 502);
    }
    const hasInvalidProxy = document.proxies.some((proxy) => (
      !proxy
      || typeof proxy !== 'object'
      || Array.isArray(proxy)
      || typeof proxy.type !== 'string'
      || proxy.type.trim() === ''
    ));
    if (hasInvalidProxy) {
      throw new SubscriptionError('Upstream subscription contains an invalid proxy', 502);
    }
    return document.proxies;
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new SubscriptionError('Upstream subscription request timed out', 502, { cause: error });
    }
    throw new SubscriptionError('Unable to fetch upstream subscription', 502, { cause: error });
  }
}

async function fetchSubscriptions(rawUrl, options = {}) {
  const urls = splitSubscriptionUrls(rawUrl);
  return Promise.all(urls.map((url) => fetchOne(url, options)));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  SubscriptionError,
  splitSubscriptionUrls,
  fetchSubscriptions
};
