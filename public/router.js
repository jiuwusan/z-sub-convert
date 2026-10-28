(function (root, factory) {
  'use strict';
  const routes = factory();
  if (typeof module === 'object' && module.exports) module.exports = routes;
  else root.SubConvertRoutes = routes;
})(globalThis, function () {
  'use strict';
  const pages = new Set(['subscriptions', 'sources', 'templates']);
  const authPages = new Set(['login', 'setup', 'reset']);
  const destination = value => pages.has(value) ? value : 'subscriptions';

  function hashFor(name, returnTo = 'subscriptions') {
    if (pages.has(name)) return `#/${name}`;
    if (!authPages.has(name)) return '#/subscriptions';
    const next = destination(returnTo);
    return `#/${name}${next === 'subscriptions' ? '' : `?next=${next}`}`;
  }

  function resolveRoute(hash, status) {
    const [path, query = ''] = String(hash || '').replace(/^#\/?/, '').split('?', 2);
    const requested = path.replace(/\/$/, '');
    const params = new URLSearchParams(query);
    const next = params.get('next');
    const returnTo = pages.has(requested) ? requested : authPages.has(requested)
      ? destination(next === null ? status.returnTo : next) : 'subscriptions';
    const name = !status.initialized ? 'setup' : !status.authenticated
      ? requested === 'reset' ? 'reset' : 'login' : returnTo;
    return { name, hash: hashFor(name, returnTo), returnTo };
  }

  return { hashFor, resolveRoute };
});
