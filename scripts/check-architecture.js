const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('espree');

const allowed = {
  routes: ['routes', 'controllers', 'middleware', 'utils'],
  controllers: ['controllers', 'services', 'domain', 'utils', 'config'],
  middleware: ['middleware', 'services', 'utils'],
  services: ['services', 'gateways', 'repositories', 'domain', 'utils'],
  gateways: ['domain', 'utils'],
  repositories: ['domain', 'utils'],
  domain: ['domain', 'utils'],
  utils: ['utils'],
  config: ['config', 'utils'],
};

function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}

function runtimeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? runtimeFiles(filename) : /\.[cm]?js$/.test(entry.name) ? [filename] : [];
  });
}

function checkArchitecture(root = path.resolve(__dirname, '..')) {
  const files = runtimeFiles(path.join(root, 'src'));
  if (fs.existsSync(path.join(root, 'server.js'))) files.push(path.join(root, 'server.js'));
  const graph = new Map(files.map((file) => [file, []]));
  const errors = [];
  const relative = (file) => path.relative(root, file).replaceAll('\\', '/');
  const layerOf = (file) => {
    const name = relative(file);
    if (name === 'server.js') return 'entry';
    if (name === 'src/app.js' || name.startsWith('src/bootstrap/')) return 'composition';
    return name.startsWith('src/') ? name.split('/')[1] : 'outside';
  };

  for (const file of files) {
    const layer = layerOf(file);
    const report = (node, message) => errors.push(`${relative(file)}:${node?.loc?.start.line || 1}: ${message}`);
    if (!allowed[layer] && !['entry', 'composition'].includes(layer)) report(null, 'unclassified runtime module');
    let ast;
    try {
      ast = parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'commonjs', loc: true });
    } catch (error) {
      report(null, `syntax: ${error.message}`);
      continue;
    }
    walk(ast, (node, parent) => {
      if (node.type === 'ImportExpression') report(node, 'dynamic import is forbidden; use static require');
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
        const dependency = node.arguments[0];
        if (node.arguments.length !== 1 || dependency?.type !== 'Literal' || typeof dependency.value !== 'string') {
          report(node, 'dynamic require is forbidden');
          return;
        }
        const name = dependency.value;
        const builtin = name.replace(/^node:/, '').split('/')[0];
        const pureIpValidation = layer === 'domain' && builtin === 'net' && parent?.type === 'VariableDeclarator'
          && parent.id.type === 'ObjectPattern' && parent.id.properties.length > 0
          && parent.id.properties.every((property) => property.type === 'Property' && property.key.name === 'isIP' && !property.computed);
        if (!pureIpValidation && ['domain', 'services'].includes(layer) && ['fs', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'child_process', 'undici'].includes(builtin)) {
          report(node, `forbidden I/O dependency ${name} in ${layer}`);
        }
        if (!name.startsWith('.') && !path.isAbsolute(name)) return;
        const base = path.resolve(path.dirname(file), name);
        const resolved = [base, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js')]
          .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (!resolved) {
          report(node, `unresolved dependency ${name}`);
          return;
        }
        const targetLayer = layerOf(resolved);
        if (allowed[layer] && !allowed[layer].includes(targetLayer)) report(node, `forbidden dependency ${layer} -> ${targetLayer} (${relative(resolved)})`);
        if (graph.has(resolved)) graph.get(file).push(resolved);
        else if (!['entry', 'composition'].includes(layer)) report(node, `dependency outside runtime graph: ${name}`);
      }
      if (!['domain', 'services'].includes(layer)) return;
      if (node.type === 'CallExpression') {
        const callee = node.callee;
        const callsFetch = callee.type === 'Identifier' && callee.name === 'fetch'
          || callee.type === 'MemberExpression' && (callee.property.name === 'fetch' || callee.property.value === 'fetch');
        if (callsFetch) report(node, `forbidden fetch call in ${layer}`);
      }
      // Exclude object/member keys; references, bindings and destructuring still get checked.
      if (node.type !== 'Identifier') return;
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) {
        if (node.name === 'env' || layer === 'domain' && node.name === 'fetch') report(node, `forbidden ${node.name} access in ${layer}`);
        return;
      }
      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return;
      const forbidden = ['Request', 'Response', 'XMLHttpRequest', 'WebSocket', 'req', 'res', 'request', 'response'];
      if (layer === 'domain') forbidden.push('process', 'fetch');
      if (forbidden.includes(node.name)) report(node, `forbidden ${node.name} in ${layer}`);
    });
  }

  const visited = new Set();
  const active = [];
  function detectCycle(file) {
    const index = active.indexOf(file);
    if (index !== -1) {
      errors.push(`cycle: ${[...active.slice(index), file].map(relative).join(' -> ')}`);
      return;
    }
    if (visited.has(file)) return;
    active.push(file);
    for (const dependency of graph.get(file)) detectCycle(dependency);
    active.pop();
    visited.add(file);
  }
  files.forEach(detectCycle);
  return [...new Set(errors)];
}

if (require.main === module) {
  const errors = checkArchitecture();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Architecture checks passed.');
}

module.exports = { checkArchitecture };
