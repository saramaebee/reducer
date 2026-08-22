/**
 * VEX / fail-closed check for the vuln-localized package.
 *
 * The full-garden tree is hazard-FULL by design, and hazards widen globally
 * (analyzer gate 1) — so this check reduces a dedicated hazard-free sub-entry
 * (app/vuln-entry.mjs importing only fab-vuln-localized), exactly as the
 * manifest note requires ("in a HAZARD-FREE local tree so removal actually
 * fires"). Asserts:
 *   1. mergeVuln is stubbed and its sentinel bytes are absent,
 *   2. the reduced entry still behaves identically under stock node,
 *   3. forced invocation throws ReducerReachabilityViolation (fail closed),
 *   4. benchmarks/vex.ts emits not_affected / vulnerable_code_not_present.
 *
 * Usage: bun benchmarks/garden/tools/vex-check.ts
 * Exit 0 = all assertions hold; 1 = a discrepancy (reported, never hidden).
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { run } from '@reducer/cli';
import { GARDEN, APP } from './lib.ts';

const SENTINEL = 'SENTINEL_vuln_merge_body';
const CVE = 'CVE-SIM-GARDEN-0001';
const REPO = path.resolve(GARDEN, '..', '..');
const OUT = path.join(GARDEN, 'results', 'tmp', 'vuln-reduced');

const problems: string[] = [];
const note = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) problems.push(msg);
};

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.dirname(OUT), { recursive: true });

const entry = path.join(APP, 'vuln-entry.mjs');
const nodeRun = (cwd: string) => spawnSync('node', ['vuln-entry.mjs'], { cwd, encoding: 'utf8' });
const originalRun = nodeRun(APP);
if (originalRun.status !== 0) {
  console.error(`original vuln-entry.mjs failed:\n${originalRun.stderr}`);
  process.exit(1);
}

const { manifest } = await run({ entry, outDir: OUT, write: true });

note(manifest.metrics.analyzer.globalHazards.length === 0,
  `sub-tree is hazard-free (globalHazards: [${manifest.metrics.analyzer.globalHazards.join(', ')}])`);

const tr = manifest.transformations.find(
  (t) => t.symbol === 'mergeVuln' && (t.package ?? '').startsWith('fab-vuln-localized@'),
);
note(!!tr, 'mergeVuln was stubbed in the hazard-free sub-tree');

const executableHits: string[] = [];
const sourcemapHits: string[] = [];
for (const e of readdirSync(OUT, { withFileTypes: true, recursive: true })) {
  if (!e.isFile()) continue;
  const abs = path.join(e.parentPath, e.name);
  if (statSync(abs).size > 5_000_000) continue;
  if (!readFileSync(abs, 'latin1').includes(SENTINEL)) continue;
  (abs.endsWith('.map') ? sourcemapHits : executableHits).push(path.relative(OUT, abs));
}
note(executableHits.length === 0, executableHits.length
  ? `sentinel bytes still present in EXECUTABLE artifact: ${executableHits.join(', ')}`
  : 'sentinel bytes absent from every executable file');
note(sourcemapHits.length === 0, sourcemapHits.length
  ? `REDUCER DEFECT: the emitted source map ships the original vulnerable body (sourcesContent) — ${sourcemapHits.join(', ')} — contradicting the VEX claim "vulnerable implementation bytes are physically absent from the deployment"`
  : 'sentinel bytes absent from emitted source maps');

const reducedRun = nodeRun(OUT);
note(reducedRun.status === 0 && reducedRun.stdout === originalRun.stdout,
  `reduced entry behaves identically under stock node (safe API intact)`);

writeFileSync(path.join(OUT, '__force-vuln.mjs'), `
import * as m from 'fab-vuln-localized';
try {
  m.mergeVuln({}, { polluted: true });
  console.log('force:NO-THROW');
} catch (e) {
  console.log('force:' + (e && e.name));
}
`);
const force = spawnSync('node', ['__force-vuln.mjs'], { cwd: OUT, encoding: 'utf8' });
note(force.stdout.trim() === 'force:ReducerReachabilityViolation',
  `forced invocation fails closed (got: ${force.stdout.trim() || force.stderr.slice(0, 200)})`);

// ---- VEX evidence ----------------------------------------------------------
const mappingPath = path.join(OUT, 'vex-mapping.json');
writeFileSync(mappingPath, JSON.stringify([{ id: CVE, package: 'fab-vuln-localized', symbol: 'mergeVuln' }]));
const vex = spawnSync('bun', [path.join(REPO, 'benchmarks', 'vex.ts'), path.join(OUT, 'reducer-manifest.json'), mappingPath], {
  encoding: 'utf8',
});
let record: any = null;
try { record = JSON.parse(vex.stdout).records[0]; } catch { /* reported below */ }
note(record?.status === 'not_affected' && record?.justification === 'vulnerable_code_not_present',
  `vex.ts emits not_affected/vulnerable_code_not_present for ${CVE} (got: ${record ? `${record.status}/${record.justification}` : vex.stderr.slice(0, 200)})`);

writeFileSync(path.join(GARDEN, 'results', 'vex-check.json'), JSON.stringify({
  cve: CVE,
  passed: problems.length === 0,
  problems,
  transformation: tr ?? null,
  vexRecord: record,
}, null, 2));

console.log(problems.length ? `\nVEX CHECK FAILED (${problems.length} problems)` : '\nVEX check passed.');
process.exit(problems.length ? 1 : 0);
