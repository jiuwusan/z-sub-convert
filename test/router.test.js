'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoute, hashFor } = require('../public/router');

test('resolves deep links and normalizes unknown hashes to the subscription page', () => {
  const session = { initialized: true, authenticated: true };
  for (const name of ['subscriptions', 'sources', 'bases', 'nameservers', 'templates']) {
    assert.deepEqual(resolveRoute(`#/${name}`, session), { name, hash: `#/${name}`, returnTo: name });
  }
  for (const hash of ['', '#/missing', '#/sources/extra', '#/%ZZ']) {
    assert.equal(resolveRoute(hash, session).hash, '#/subscriptions');
  }
});

test('preserves a requested protected page across login redirects and browser reloads', () => {
  const guard = resolveRoute('#/sources', { initialized: true, authenticated: false });
  assert.equal(guard.name, 'login');
  assert.equal(guard.hash, '#/login?next=sources');
  assert.equal(resolveRoute(guard.hash, { initialized: true, authenticated: false }).returnTo, 'sources');
  assert.equal(resolveRoute(guard.hash, { initialized: true, authenticated: true }).hash, '#/sources');
});

test('routes uninitialized accounts to setup and disallows setup after initialization', () => {
  const setup = resolveRoute('#/templates', { initialized: false, authenticated: false });
  assert.equal(setup.hash, '#/setup?next=templates');
  assert.equal(resolveRoute(setup.hash, { initialized: true, authenticated: false }).hash, '#/login?next=templates');
  assert.equal(resolveRoute(setup.hash, { initialized: true, authenticated: true }).hash, '#/templates');
});

test('allows reset while signed out, preserves return destination and rejects external redirect targets', () => {
  assert.equal(hashFor('reset', 'sources'), '#/reset?next=sources');
  assert.equal(resolveRoute('#/reset?next=sources', { initialized: true, authenticated: false }).name, 'reset');
  for (const value of ['https://example.com', '//example.com', 'reset', '../sources']) {
    assert.equal(resolveRoute(`#/login?next=${encodeURIComponent(value)}`, { initialized: true, authenticated: true }).hash, '#/subscriptions');
  }
  assert.equal(hashFor('unknown'), '#/subscriptions');
});
