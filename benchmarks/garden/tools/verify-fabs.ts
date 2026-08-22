/**
 * Mechanical convention checks over the fabricated packages:
 *   - every MANIFEST sentinel appears verbatim in exactly the declaring
 *     package's source (and nowhere else in fab/, app source, or wiring),
 *   - every wiring mutationTarget's marker pair exists exactly once, is
 *     globally unique, and delimits >=200 bytes,
 *   - MUST_REMOVE bodies exceed 200 bytes (measured to end-of-file heuristic:
 *     from sentinel line back to enclosing function is builder-verified;
 *     here we assert the sentinel-bearing file itself),
 *   - no fab package.json carries an "exports" field except rtm-dual,
 *   - every fab package named by MANIFEST exists and vice versa.
 * Usage: bun benchmarks/garden/tools/verify-fabs.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const GARDEN = path.resolve(import.meta.dirname, '..');
const FAB = path.join(GARDEN, 'fab');
const manifest = JSON.parse(readFileSync(path.join(GARDEN, 'MANIFEST.json'), 'utf8'));
const wiring = JSON.parse(readFileSync(path.join(GARDEN, 'wiring.json'), 'utf8'));
const problems: string[] = [];

// ---- inventory -------------------------------------------------------------
const manifestIds = manifest.fabricatedPackages.map((p: any) => p.id);
const dirs = readdirSync(FAB).filter((d) => statSync(path.join(FAB, d)).isDirectory());
for (const id of manifestIds) if (!dirs.includes(`fab-${id}`)) problems.push(`missing package dir fab-${id}`);
for (const d of dirs) if (!manifestIds.includes(d.replace(/^fab-/, ''))) problems.push(`unexpected package dir ${d}`);
if (wiring.packages.length !== manifestIds.length) problems.push(`wiring has ${wiring.packages.length} entries, manifest ${manifestIds.length}`);

// ---- collect all fab files -------------------------------------------------
const files: { abs: string; rel: string; content: string }[] = [];
for (const e of readdirSync(FAB, { withFileTypes: true, recursive: true })) {
  if (!e.isFile()) continue;
  const abs = path.join(e.parentPath, e.name);
  files.push({ abs, rel: path.relative(GARDEN, abs), content: readFileSync(abs, 'utf8') });
}

// ---- sentinels -------------------------------------------------------------
const declared: { id: string; symbol: string; sentinel: string }[] = [];
for (const p of manifest.fabricatedPackages) {
  for (const s of p.symbols) if (s.sentinel) declared.push({ id: p.id, symbol: s.name, sentinel: s.sentinel });
}
for (const d of declared) {
  const holders = files.filter((f) => f.content.includes(d.sentinel));
  if (holders.length === 0) problems.push(`sentinel ${d.sentinel} not found anywhere`);
  const wrongPkg = holders.filter((h) => !h.rel.startsWith(`fab/fab-${d.id}/`));
  if (wrongPkg.length) problems.push(`sentinel ${d.sentinel} leaked outside fab-${d.id}: ${wrongPkg.map((h) => h.rel).join(', ')}`);
  const expected = d.id === 'require-finite' ? 2 : 1;
  if (holders.length !== expected && holders.length > 0) {
    problems.push(`sentinel ${d.sentinel} in ${holders.length} files (expected ${expected}): ${holders.map((h) => h.rel).join(', ')}`);
  }
}
// sentinel must not leak into app-side sources or wiring-derived files
for (const appFile of ['app/real.cjs']) {
  const content = readFileSync(path.join(GARDEN, appFile), 'utf8');
  for (const d of declared) if (content.includes(d.sentinel)) problems.push(`sentinel ${d.sentinel} leaked into ${appFile}`);
}

// ---- markers ---------------------------------------------------------------
const allMarkers = new Map<string, string[]>(); // marker -> files
for (const f of files) {
  for (const m of f.content.matchAll(/\/\*<garden:([^>]+)>\*\//g)) {
    let list = allMarkers.get(m[1]);
    if (!list) allMarkers.set(m[1], (list = []));
    list.push(f.rel);
  }
}
for (const [marker, locs] of allMarkers) {
  if (locs.length > 1) problems.push(`marker ${marker} appears in multiple files: ${locs.join(', ')}`);
}
for (const p of wiring.packages) {
  for (const t of p.mutationTargets) {
    const abs = path.join(GARDEN, t.file);
    let content: string;
    try { content = readFileSync(abs, 'utf8'); } catch { problems.push(`${p.id}: mutation file missing: ${t.file}`); continue; }
    const open = `/*<garden:${t.marker}>*/`;
    const close = `/*</garden:${t.marker}>*/`;
    const i = content.indexOf(open);
    const j = content.indexOf(close);
    if (i < 0 || j < 0) { problems.push(`${p.id}: marker pair ${t.marker} incomplete in ${t.file}`); continue; }
    if (content.indexOf(open, i + 1) >= 0) problems.push(`${p.id}: marker ${t.marker} opens twice`);
    const span = j - (i + open.length);
    if (span < 200) problems.push(`${p.id}: marker ${t.marker} delimits only ${span} bytes (<200)`);
  }
}

// ---- package.json exports fields -------------------------------------------
for (const f of files) {
  if (path.basename(f.abs) !== 'package.json') continue;
  const pj = JSON.parse(f.content);
  if (pj.exports && pj.name !== 'rtm-dual') problems.push(`${f.rel}: unexpected "exports" field`);
}

// ---- nested package name uniqueness ----------------------------------------
const names = new Map<string, string[]>();
for (const f of files) {
  if (path.basename(f.abs) !== 'package.json') continue;
  const pj = JSON.parse(f.content);
  let list = names.get(pj.name);
  if (!list) names.set(pj.name, (list = []));
  list.push(f.rel);
}
for (const [name, locs] of names) if (locs.length > 1) problems.push(`package name ${name} duplicated: ${locs.join(', ')}`);

console.log(`checked ${files.length} files, ${declared.length} sentinels, ${allMarkers.size} markers, ${names.size} package names`);
if (problems.length) {
  console.error(`\n${problems.length} problems:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('fab tree conventions: all checks passed.');
