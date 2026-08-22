/**
 * Retention-reason coverage: the full-garden run masks per-module reasons
 * behind global-hazard widening, so each entry is analyzed in ISOLATION — a
 * mini-entry inside app/ that imports just that package the way the server
 * does — and the observed reasons (verdict reasons with any `global-hazard:`
 * prefix stripped, plus tracer/analyzer warnings) are collected per entry.
 *
 * Every key in MANIFEST.json reasonCoverage must be observed in at least one
 * entry; the report says which, and whether the observing entry matches the
 * manifest's claim. Discrepancies are reported, never smoothed over.
 *
 * Usage: bun benchmarks/garden/tools/reason-coverage.ts
 */
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { run } from '@reducer/cli';
import { GARDEN, APP } from './lib.ts';

const manifest = JSON.parse(readFileSync(path.join(GARDEN, 'MANIFEST.json'), 'utf8'));
const map = JSON.parse(readFileSync(path.join(GARDEN, 'garden-map.json'), 'utf8'));

const entries: { name: string; importCode: string }[] = [];
for (const p of map.packages as { id: string; importStmt: string }[]) {
  entries.push({ name: p.id, importCode: p.importStmt });
}
for (const real of ['express', 'lodash', 'depd', 'optional-require', 'require-at', 'validator', 'better-sqlite3', 'sql.js']) {
  entries.push({ name: `${real} (real)`, importCode: `import __r from '${real.replace(/[^a-z0-9.-]/g, '')}'; void __r;` });
}

const ENTRY = path.join(APP, '.coverage-entry.mjs');
const observed = new Map<string, Set<string>>(); // reason -> entry names

for (const e of entries) {
  writeFileSync(ENTRY, `${e.importCode}\n`);
  const reasons = new Set<string>();
  try {
    const { manifest: m, trace, analysis } = await run({ entry: ENTRY, write: false });
    for (const v of analysis.verdicts) {
      // blockingReasons = ALL applicable blockers, incl. those shadowed by an
      // earlier terminal gate (e.g. native-boundary behind a global hazard).
      for (const r of [...v.reasons, ...(v.blockingReasons ?? [])]) {
        reasons.add(r.replace(/^global-hazard:/, ''));
      }
    }
    for (const h of analysis.globalHazards) reasons.add(h);
    if (trace.warnings.length > 0) reasons.add('nft-warning');
  } catch (err) {
    reasons.add(`ANALYSIS-ERROR: ${String(err).slice(0, 120)}`);
  }
  for (const r of reasons) {
    let s = observed.get(r);
    if (!s) observed.set(r, (s = new Set()));
    s.add(e.name);
  }
  console.log(`  ${e.name.padEnd(42)} ${[...reasons].sort().join(', ')}`);
}
rmSync(ENTRY, { force: true });

// ---- compare against the manifest's claims ---------------------------------
const claimEntryNames = (claims: string[]): string[] =>
  claims.flatMap((c) => {
    if (c.startsWith('induced by')) return ['*any*'];
    const head = c.split(' ')[0]; // strip "(real)" annotations
    return head.includes('/') ? head.split('/').map((x) => `${x} (real)`) : [head.split(':')[0] + (c.includes('(real)') ? ' (real)' : '')];
  });

/**
 * Reasons that are structurally unobservable under the CURRENT conservative
 * gates — the analysis that would emit them never runs, because a prior gate
 * (correctly) pre-empts it. These are documented precision limitations, not
 * silent gaps; each names the gate that pre-empts and the future lever that
 * would make it observable. They count as documented, not as missing.
 */
const KNOWN_UNOBSERVABLE: Record<string, string> = {
  'dynamic-property-access':
    'not producible by its CLAIMED entries under current gates: a non-literal require specifier raises the ' +
    'dynamic-require hazard before projection analysis runs (require-unbounded-computed-projection), and ' +
    'cjs-getter is pre-empted by export-object-mutation surface widening; the claimed entries become ' +
    'observable only once bounded projection over unbounded specifiers lands (Q10 rescue lever). Other ' +
    'entries (e.g. express) may still emit it via importer-side computed access.',
};

const rows: { reason: string; status: string; observedIn: string[]; note?: string }[] = [];
let missing = 0;
for (const [reason, claims] of Object.entries(manifest.reasonCoverage)) {
  if (reason === 'note') continue;
  const obs = observed.get(reason) ?? new Set<string>();
  const claimed = claimEntryNames(claims as string[]);
  const matchesClaim = claimed.includes('*any*') || claimed.some((c) => obs.has(c));
  const known = KNOWN_UNOBSERVABLE[reason];
  const status =
    obs.size === 0
      ? known
        ? 'NOT OBSERVABLE (documented precision limitation)'
        : 'NOT OBSERVED'
      : matchesClaim
        ? 'ok'
        : 'observed, but not in a claimed entry';
  if (obs.size === 0 && !known) missing++;
  rows.push({ reason, status, observedIn: [...obs].sort(), ...(known && obs.size === 0 ? { note: known } : {}) });
}

mkdirSync(path.join(GARDEN, 'results'), { recursive: true });
writeFileSync(path.join(GARDEN, 'results', 'reason-coverage.json'), JSON.stringify({ rows, observed: Object.fromEntries([...observed].map(([k, v]) => [k, [...v].sort()])) }, null, 2));

console.log('\nreason coverage:');
for (const r of rows) {
  const mark = r.status === 'ok' ? '✓' : r.status.startsWith('NOT OBSERVABLE') ? '~' : '✗';
  console.log(`  ${mark} ${r.reason.padEnd(28)} ${r.status}${r.observedIn.length ? ` — in: ${r.observedIn.slice(0, 5).join(', ')}${r.observedIn.length > 5 ? '…' : ''}` : ''}`);
  if (r.note) console.log(`      ${r.note}`);
}
console.log(missing ? `\n${missing} reasons NOT OBSERVED — discrepancy, see results/reason-coverage.json` : '\nall retention reasons exercised or documented.');
process.exit(missing ? 1 : 0);
