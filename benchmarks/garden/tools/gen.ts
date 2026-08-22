/**
 * Generate the app-side artifacts from wiring.json + MANIFEST.json:
 *   - app/server.mjs     (static imports + routes; the analyzed entrypoint)
 *   - app/__redteam.mjs  (red-team module; NEVER referenced by the analyzed
 *                         tree — injected at boot via `node --import`)
 *   - app/vuln-entry.mjs (hazard-free sub-entry for the VEX check)
 *   - garden-map.json    (the machine-readable join of manifest truth and
 *                         physical files, consumed by the scorer/harnesses)
 *
 * Usage: bun benchmarks/garden/tools/gen.ts
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GARDEN = path.resolve(import.meta.dirname, '..');
const APP = path.join(GARDEN, 'app');
const FAB = path.join(GARDEN, 'fab');
const manifest = JSON.parse(readFileSync(path.join(GARDEN, 'MANIFEST.json'), 'utf8'));
const wiring = JSON.parse(readFileSync(path.join(GARDEN, 'wiring.json'), 'utf8'));

// ---- ownership: every npm package name under fab/ -> owning fab id ---------
const fabOwned = new Map<string, string>(); // npmName -> fab id
for (const e of readdirSync(FAB, { withFileTypes: true, recursive: true })) {
  if (!e.isFile() || e.name !== 'package.json') continue;
  const abs = path.join(e.parentPath, e.name);
  const pj = JSON.parse(readFileSync(abs, 'utf8'));
  const rel = path.relative(FAB, abs);
  const fabId = rel.split(path.sep)[0].replace(/^fab-/, '');
  fabOwned.set(pj.name, fabId);
}

const wiringById = new Map<string, any>(wiring.packages.map((p: any) => [p.id, p]));

// ---- symbol records ---------------------------------------------------------
const specToPkg = (spec: string): string => {
  const nm = spec.lastIndexOf('node_modules/');
  if (nm >= 0) return spec.slice(nm + 'node_modules/'.length).split('/')[0];
  return spec.split('/')[0];
};
const fileToPkg = (file: string): string => {
  const nm = file.lastIndexOf('node_modules/');
  if (nm >= 0) return file.slice(nm + 'node_modules/'.length).split('/')[0];
  return file.split('/')[1]; // fab/fab-<id>/...
};

const symbols: any[] = [];
const mustRemove: any[] = [];
const mutationTargets: any[] = [];
const forceTargets: any[] = [];
const starPackages: { npmPkg: string }[] = [];

for (const entry of manifest.fabricatedPackages) {
  const w = wiringById.get(entry.id);
  if (!w) throw new Error(`no wiring for ${entry.id}`);
  const siblingPkg = new Map<string, string>(); // symbol -> npmPkg from wiring
  for (const f of w.forceTargets) siblingPkg.set(f.symbol, specToPkg(f.spec));
  for (const m of w.mutationTargets) siblingPkg.set(m.symbol, fileToPkg(m.file));
  const nestedOwned = [...fabOwned.entries()].filter(([, id]) => id === entry.id).map(([n]) => n);
  const soleNested = nestedOwned.filter((n) => n !== `fab-${entry.id}`);

  for (const s of entry.symbols) {
    if (s.name === '*') {
      for (const npmPkg of nestedOwned) starPackages.push({ npmPkg });
      continue;
    }
    const sibling = siblingPkg.get(s.name)
      ?? [...siblingPkg.values()][0]
      ?? (soleNested.length === 1 ? soleNested[0] : `fab-${entry.id}`);
    const npmPkg = siblingPkg.get(s.name) ?? (s.truth === 'MUST_RETAIN_CONSERVATIVELY' ? sibling : `fab-${entry.id}`);
    symbols.push({ key: `${entry.id}:${s.name}`, id: entry.id, npmPkg, symbol: s.name, truth: s.truth, sentinel: s.sentinel });
    if (s.truth === 'MUST_REMOVE') {
      const fts = w.forceTargets.filter((f: any) => f.symbol === s.name);
      if (!fts.length) throw new Error(`${entry.id}: MUST_REMOVE ${s.name} has no forceTarget`);
      for (const ft of fts) {
        if (ft.sentinel !== s.sentinel) throw new Error(`${entry.id}:${s.name} sentinel mismatch wiring vs manifest`);
      }
      // ESM import() rejects directory specifiers — resolve node_modules dirs to their entry file.
      const fixSpec = (spec: string) =>
        spec.includes('/node_modules/') && !/\.(c|m)?js$/.test(spec) ? `${spec}/index.js` : spec;
      const loaders = fts.map((ft: any) => ({ spec: fixSpec(ft.spec), exportName: ft.exportName }));
      mustRemove.push({ id: entry.id, symbol: s.name, sentinel: s.sentinel, npmPkg, loaders });
      forceTargets.push({ id: entry.id, symbol: s.name, sentinel: s.sentinel, loaders });
    }
    if (s.truth === 'MUST_RETAIN') {
      const mt = w.mutationTargets.find((m: any) => m.symbol === s.name);
      if (!mt) throw new Error(`${entry.id}: MUST_RETAIN ${s.name} has no mutationTarget`);
    }
  }
  for (const mt of w.mutationTargets) {
    mutationTargets.push({
      id: entry.id,
      symbol: mt.symbol,
      marker: mt.marker,
      endpoint: mt.endpoint,
      file: path.join('node_modules', path.relative('fab', mt.file)), // app-relative
    });
  }
}

// require-finite ships two physical bodies for one MUST_RETAIN symbol — the
// wiring lists both markers; both are kept above (dedupe not desired).

// ---- routes ----------------------------------------------------------------
const routes: { path: string; pattern: string; expr?: string; awaited?: boolean; source: string }[] = [];
for (const p of wiring.packages) {
  for (const r of p.routes) {
    routes.push({ path: r.path, pattern: r.path.split('?')[0], expr: r.expr, awaited: !!r.awaited, source: p.id });
  }
}
const realPaths = [
  '/real/validator/isEmail', '/real/validator/isURL', '/real/lodash', '/real/depd',
  '/real/optional-require', '/real/require-at', '/real/better-sqlite3', '/real/sqljs', '/real/express-view',
];
for (const rp of realPaths) routes.push({ path: rp, pattern: rp, source: 'real' });

const dupPatterns = routes.map((r) => r.pattern).filter((v, i, a) => a.indexOf(v) !== i);
if (dupPatterns.length) throw new Error(`duplicate route patterns: ${dupPatterns.join(', ')}`);

// ---- validator ground truth -------------------------------------------------
const validatorUsed = ['isEmail', 'isURL'];
const { createRequire } = await import('node:module');
const appRequire = createRequire(path.join(APP, 'server.mjs'));
const validatorObj = appRequire('validator');
const validatorFnExports = Object.keys(validatorObj).filter((k) => typeof validatorObj[k] === 'function');
const validatorCeiling = validatorFnExports.filter((k) => !validatorUsed.includes(k)).length;

// ---- real-package mutation targets ------------------------------------------
const realMutations = [
  {
    label: 'validator:isEmail',
    file: 'node_modules/validator/lib/isEmail.js',
    endpoint: '/real/validator/isEmail',
    append: `module.exports = { default: function () { throw new Error('GARDEN_MUTATED:validator:isEmail'); } };`,
  },
  {
    label: 'validator:isURL',
    file: 'node_modules/validator/lib/isURL.js',
    endpoint: '/real/validator/isURL',
    append: `module.exports = { default: function () { throw new Error('GARDEN_MUTATED:validator:isURL'); } };`,
  },
];

// ---- garden-map.json --------------------------------------------------------
const gardenMap = {
  $schema: 'reducer-garden-map/1',
  packages: wiring.packages.map((p: any) => ({ id: p.id, npmPkg: `fab-${p.id}`, importStmt: p.importStmt })),
  fabOwnedPackages: [...fabOwned.keys()],
  fabOwnerById: Object.fromEntries(fabOwned),
  symbols,
  starPackages,
  mustRemove,
  forceTargets,
  mutationTargets,
  realMutations,
  routes: routes.map((r) => ({ path: r.path, source: r.source })),
  validatorUsed,
  validatorCeiling,
  validatorFnExports,
};
writeFileSync(path.join(GARDEN, 'garden-map.json'), JSON.stringify(gardenMap, null, 2));

// ---- app/server.mjs ---------------------------------------------------------
const importLines = wiring.packages.map((p: any) => p.importStmt);
const routeLines = routes
  .filter((r) => r.expr)
  .map((r) => `app.get(${JSON.stringify(r.pattern)}, wrap(async (req) => (${r.expr})));`);

const server = `// GENERATED by benchmarks/garden/tools/gen.ts — do not hand-edit.
// The Reducer Oracle / Torture Garden service. Every import below is a static
// edge the analyzer is expected to see; the __force handler reaches
// MUST_REMOVE symbols ONLY through the boot-injected red-team module
// (globalThis) so the analyzed tree carries no reference to them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { registerRealRoutes } from './real.cjs';
${importLines.join('\n')}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.engine('html', (file, options, cb) => {
  try {
    const src = readFileSync(file, 'utf8');
    cb(null, src.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => String(options[k] ?? '')));
  } catch (err) {
    cb(err);
  }
});
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'html');

const wrap = (fn) => async (req, res) => {
  try {
    const value = await fn(req);
    res.json({ ok: true, value });
  } catch (err) {
    res.status(500).json({ ok: false, name: err && err.name, message: String(err && err.message).slice(0, 300) });
  }
};

${routeLines.join('\n')}

registerRealRoutes(app, wrap);

// Red team: deliberately invoke MUST_REMOVE symbols. Fails closed on a
// reduced build (ReducerReachabilityViolation or module-missing), 503 when
// the harness did not inject the red-team module.
app.get('/fab/:id/__force/:symbol', async (req, res) => {
  const key = req.params.id + ':' + req.params.symbol;
  const rt = globalThis.__gardenRedteam;
  if (!rt) return res.status(503).json({ ok: false, mode: 'redteam-not-injected' });
  const entry = rt[key];
  if (!entry) return res.status(404).json({ ok: false, mode: 'unknown-force-target', key });
  if (!entry.fns || entry.fns.length === 0) {
    return res.status(500).json({ ok: false, failClosed: true, mode: 'module-missing', error: String(entry.loadErrors || 'no loadable bodies').slice(0, 300) });
  }
  try {
    const values = [];
    for (const fn of entry.fns) values.push(String(await fn('garden')));
    return res.json({ ok: true, mode: 'invoked', value: values.join(' | ') });
  } catch (err) {
    const isViolation = err && err.name === 'ReducerReachabilityViolation';
    return res.status(500).json({
      ok: false, failClosed: true, mode: isViolation ? 'stub-throw' : 'error',
      name: err && err.name, message: String(err && err.message).slice(0, 300),
    });
  }
});

const server = app.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log('garden-listening:' + server.address().port);
});
`;
writeFileSync(path.join(APP, 'server.mjs'), server);

// ---- app/__redteam.mjs ------------------------------------------------------
const redteam = `// GENERATED by benchmarks/garden/tools/gen.ts — RED-TEAM module.
// Loaded ONLY via \`node --import ./__redteam.mjs server.mjs\` by the harness.
// It must never be imported by the analyzed tree: it references MUST_REMOVE
// symbols, whose unreachability from the service is the ground truth.
globalThis.__gardenRedteam = Object.create(null);
const targets = ${JSON.stringify(forceTargets.map((f) => ({ key: `${f.id}:${f.symbol}`, loaders: f.loaders })), null, 2)};
for (const t of targets) {
  const fns = [];
  const loadErrors = [];
  for (const l of t.loaders) {
    try {
      const m = await import(l.spec);
      const fn = m[l.exportName] ?? (m.default ? m.default[l.exportName] : undefined);
      if (typeof fn !== 'function') throw new Error('export not found: ' + l.exportName + ' in ' + l.spec);
      fns.push(fn);
    } catch (err) {
      loadErrors.push(String(err));
    }
  }
  globalThis.__gardenRedteam[t.key] = { fns, loadErrors };
}
`;
writeFileSync(path.join(APP, '__redteam.mjs'), redteam);

// ---- app/vuln-entry.mjs -----------------------------------------------------
writeFileSync(path.join(APP, 'vuln-entry.mjs'), `// Hazard-free sub-entry for the VEX check (see tools/vex-check.ts).
import { get } from 'fab-vuln-localized';
console.log(get('vuln-entry'));
`);

console.log(`generated server.mjs (${routeLines.length} fab routes + ${realPaths.length} real), __redteam.mjs (${forceTargets.length} force targets), vuln-entry.mjs, garden-map.json (${symbols.length} symbols, ${mustRemove.length} MUST_REMOVE, ${mutationTargets.length} mutation targets, validator ceiling ${validatorCeiling}).`);
