/**
 * Garden scorer: build the service through the reducer CLI, then score the
 * reduced tree against by-construction ground truth on the three axes:
 *
 *   false removal   — a MUST_RETAIN symbol was transformed        → CRITICAL
 *   unsafe optimism — a MUST_RETAIN_CONSERVATIVELY symbol (or any
 *                     hazard-control / opaque-boundary / wiring
 *                     symbol) was transformed                     → CRITICAL
 *   over-retention  — a MUST_REMOVE symbol was retained           → precision
 *   achieved/ceiling = removed(MUST_REMOVE) / |MUST_REMOVE|
 *
 * plus the behavioral oracle: replay every recorded contract against the
 * REDUCED service under stock node; ANY divergence = unsound removal. The
 * red-team __force endpoints must fail closed for every symbol actually
 * removed.
 *
 * Usage: bun benchmarks/garden/tools/score.ts
 * Emits results/garden-score.json + results/garden-score.md.
 * Exit: 0 clean, 2 critical soundness failures or contract divergences.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '@reducer/cli';
import { GARDEN, APP, bootServer, fetchEntry, replay, type ContractEntry, type Divergence } from './lib.ts';

const OUT = path.join(GARDEN, 'results', 'tmp', 'reduced');
const map = JSON.parse(readFileSync(path.join(GARDEN, 'garden-map.json'), 'utf8'));
const contracts: ContractEntry[] = JSON.parse(
  readFileSync(path.join(GARDEN, 'fixtures', 'contracts.json'), 'utf8'),
).entries;

// ---------------------------------------------------------------------------
// 1. Build through the reducer CLI
// ---------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.dirname(OUT), { recursive: true });
console.log('building the garden through the reducer…');
const { manifest } = await run({ entry: path.join(APP, 'server.mjs'), outDir: OUT, write: true });
console.log(`  traced ${manifest.modules.length} files, ${manifest.transformations.length} transformations, globalHazards: [${manifest.metrics.analyzer.globalHazards.join(', ')}]`);

// ---------------------------------------------------------------------------
// 2. Classify every transformation against ground truth
// ---------------------------------------------------------------------------
interface SymbolRecord { key: string; id: string; npmPkg: string; symbol: string; truth: string; sentinel?: string }
const symbolIndex = new Map<string, SymbolRecord>(); // `${npmPkg}::${symbol}`
for (const s of map.symbols as SymbolRecord[]) symbolIndex.set(`${s.npmPkg}::${s.symbol}`, s);
const fabOwned = new Set<string>(map.fabOwnedPackages as string[]); // fab-* plus nested targets
const starPkgs = new Set<string>((map.starPackages as { npmPkg: string }[]).map((p) => p.npmPkg));
const hazardControls = new Set<string>(['optional-require', 'require-at', 'depd', 'lodash', 'express', 'better-sqlite3', 'sql.js']);
const validatorUsed = new Set<string>(map.validatorUsed as string[]);

const falseRemovals: any[] = [];
const unsafeOptimism: any[] = [];
const outOfScope: any[] = [];
const validatorAchievedSyms = new Set<string>();
const transformedFabRemove = new Set<string>(); // manifest symbol keys `${id}:${symbol}`

const pkgOf = (label: string | null) => (label ? label.slice(0, label.lastIndexOf('@')) : '');
for (const t of manifest.transformations) {
  const pkgName = pkgOf(t.package);
  const rec = symbolIndex.get(`${pkgName}::${t.symbol}`);
  if (fabOwned.has(pkgName)) {
    if (rec?.truth === 'MUST_REMOVE') transformedFabRemove.add(`${rec.id}:${rec.symbol}`);
    else if (rec?.truth === 'MUST_RETAIN') falseRemovals.push({ ...t, why: 'MUST_RETAIN symbol transformed' });
    else if (rec?.truth === 'MUST_RETAIN_CONSERVATIVELY' || starPkgs.has(pkgName)) {
      unsafeOptimism.push({ ...t, why: 'MUST_RETAIN_CONSERVATIVELY symbol transformed' });
    } else {
      // wiring/carrier/passenger exports are reachable or mechanism-retained
      unsafeOptimism.push({ ...t, why: 'unlabeled garden symbol transformed (wiring or passenger — never removable)' });
    }
  } else if (pkgName === 'validator') {
    if (validatorUsed.has(t.symbol)) falseRemovals.push({ ...t, why: 'validator used export transformed' });
    else validatorAchievedSyms.add(t.symbol);
  } else if (hazardControls.has(pkgName)) {
    unsafeOptimism.push({ ...t, why: `hazard/boundary control ${pkgName} must never be stubbed` });
  } else {
    outOfScope.push(t); // transitive dep, unlabeled — judged by the contract suite
  }
}

// ---------------------------------------------------------------------------
// 3. Sentinel byte-scan over the reduced tree (pre-boot, pre-injection)
// ---------------------------------------------------------------------------
const sentinels: { key: string; sentinel: string }[] = map.mustRemove.map((s: any) => ({ key: `${s.id}:${s.symbol}`, sentinel: s.sentinel }));
const sentinelPresent = new Map<string, string[]>(); // key -> files containing it
for (const { key } of sentinels) sentinelPresent.set(key, []);
for (const e of readdirSync(OUT, { withFileTypes: true, recursive: true })) {
  if (!e.isFile()) continue;
  const abs = path.join(e.parentPath, e.name);
  if (statSync(abs).size > 5_000_000) continue;
  const content = readFileSync(abs, 'latin1');
  for (const { key, sentinel } of sentinels) {
    if (content.includes(sentinel)) sentinelPresent.get(key)!.push(path.relative(OUT, abs));
  }
}

const removedFab: string[] = []; // proven removal: transformation recorded AND sentinel bytes gone
const retainedFab: string[] = [];
const fileLevelRemoved: string[] = []; // sentinel gone but NO transformation: the tracer dropped the file — unsound, never counts as achieved
const anomalies: string[] = [];
for (const { key } of sentinels) {
  const present = sentinelPresent.get(key)!;
  if (present.length === 0 && transformedFabRemove.has(key)) {
    removedFab.push(key);
  } else if (present.length === 0) {
    fileLevelRemoved.push(key);
    anomalies.push(`${key}: sentinel absent WITHOUT a recorded transformation — its module was dropped at trace time (file-level unsound removal, not achieved reduction)`);
  } else {
    retainedFab.push(key);
    if (transformedFabRemove.has(key)) anomalies.push(`${key}: transformation recorded but sentinel still present in ${present.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Behavioral oracle: original sanity, then reduced replay
// ---------------------------------------------------------------------------
console.log('replaying contracts against the ORIGINAL service (sanity)…');
let originalDivergences: Divergence[] = [];
{
  const server = await bootServer(APP);
  try { originalDivergences = await replay(server.base, contracts); } finally { await server.kill(); }
}
if (originalDivergences.length) {
  console.error('ORIGINAL service diverges from its own fixtures — fixtures are stale, aborting scoring of the reduced tree.');
}

console.log('booting the REDUCED service under stock node…');
let reducedBootError: string | null = null;
let reducedReboots = 0;
const reducedDivergences: Divergence[] = [];
const forceResults: any[] = [];
try {
  // A dropped file can crash the whole process mid-suite (e.g. the emscripten
  // abort when sql-wasm.wasm is missing) — reboot and keep scoring so one
  // crash-worthy finding does not mask the rest.
  let server = await bootServer(OUT);
  const resilientFetch = async (p: string) => {
    try {
      return await fetchEntry(server.base, p);
    } catch {
      reducedReboots++;
      await server.kill();
      server = await bootServer(OUT);
      return await fetchEntry(server.base, p); // second failure propagates
    }
  };
  try {
    for (const f of map.forceTargets) {
      const p = `/fab/${f.id}/__force/${f.symbol}`;
      const got = await resilientFetch(p);
      const removed = removedFab.includes(`${f.id}:${f.symbol}`);
      const droppedAtTrace = fileLevelRemoved.includes(`${f.id}:${f.symbol}`);
      let parsed: any = {};
      try { parsed = JSON.parse(got.body); } catch { /* non-JSON = not our fail-closed shape */ }
      let verdict: string;
      if (removed || droppedAtTrace) {
        verdict = got.status !== 200 && parsed.failClosed
          ? `fail-closed (${parsed.mode})${droppedAtTrace ? ' — via file absence, not a stub' : ''}`
          : 'RED-TEAM BREACH: removed symbol did not fail closed';
      } else {
        verdict = got.status === 200 && got.body.includes(f.sentinel)
          ? 'retained (real body reachable, consistent with over-retention)'
          : `unexpected (${got.status}) ${got.body.slice(0, 120)}`;
      }
      forceResults.push({ path: p, removed, droppedAtTrace, status: got.status, verdict });
    }
    for (const e of contracts) {
      try {
        const got = await resilientFetch(e.path);
        if (got.status !== e.status) {
          reducedDivergences.push({ path: e.path, kind: 'status', expected: String(e.status), actual: `${got.status} body=${got.body.slice(0, 200)}` });
        } else if (got.body !== e.body) {
          reducedDivergences.push({ path: e.path, kind: 'body', expected: e.body.slice(0, 200), actual: got.body.slice(0, 200) });
        }
      } catch (err) {
        reducedDivergences.push({ path: e.path, kind: 'fetch-error', expected: String(e.status), actual: `server unreachable even after reboot: ${String(err).slice(0, 120)}` });
      }
    }
  } finally {
    await server.kill();
  }
} catch (err) {
  reducedBootError = String(err);
}

// ---------------------------------------------------------------------------
// 5. Axes + report
// ---------------------------------------------------------------------------
const fabCeiling = sentinels.length;
const validatorCeiling: number = map.validatorCeiling;
const breaches = forceResults.filter((f) => f.verdict.startsWith('RED-TEAM BREACH'));
const critical =
  falseRemovals.length + unsafeOptimism.length + breaches.length +
  reducedDivergences.length + fileLevelRemoved.length + (reducedBootError ? 1 : 0);

const score = {
  $schema: 'reducer-garden-score/1',
  reducer: { version: manifest.reducerVersion, node: manifest.input.node },
  globalHazards: manifest.metrics.analyzer.globalHazards,
  axes: {
    falseRemoval: { critical: falseRemovals.length > 0, entries: falseRemovals },
    unsafeOptimism: { critical: unsafeOptimism.length > 0, entries: unsafeOptimism },
    overRetention: { count: retainedFab.length, symbols: retainedFab },
    fileLevelRemoved: { critical: fileLevelRemoved.length > 0, symbols: fileLevelRemoved },
  },
  achievedVsCeiling: {
    fabricated: { removed: removedFab.length, ceiling: fabCeiling, ratio: fabCeiling ? removedFab.length / fabCeiling : 0, removedSymbols: removedFab },
    validator: { removed: validatorAchievedSyms.size, ceiling: validatorCeiling, ratio: validatorCeiling ? validatorAchievedSyms.size / validatorCeiling : 0 },
  },
  behavioralOracle: {
    originalDivergences,
    reducedBootError,
    reducedReboots,
    reducedDivergences,
    verdict: reducedBootError
      ? 'REDUCED SERVICE FAILED TO BOOT — unsound reduction at file level'
      : reducedDivergences.length
        ? `${reducedDivergences.length} contract divergences — unsound removals`
        : 'all contracts identical on the reduced service',
  },
  redTeam: { results: forceResults, breaches: breaches.length },
  anomalies,
  outOfScopeTransformations: outOfScope,
  criticalCount: critical,
};

mkdirSync(path.join(GARDEN, 'results'), { recursive: true });
writeFileSync(path.join(GARDEN, 'results', 'garden-score.json'), JSON.stringify(score, null, 2));

const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const md = `# Garden score

Reducer ${manifest.reducerVersion} under node ${manifest.input.node}.
Global hazards (widen ALL retention): ${score.globalHazards.length ? score.globalHazards.join(', ') : 'none'}

| axis | result | severity |
|---|---|---|
| false removal | ${falseRemovals.length} MUST_RETAIN symbols transformed | ${falseRemovals.length ? '**CRITICAL**' : 'clean'} |
| unsafe optimism | ${unsafeOptimism.length} conservative/control symbols transformed | ${unsafeOptimism.length ? '**CRITICAL**' : 'clean'} |
| over-retention | ${retainedFab.length}/${fabCeiling} MUST_REMOVE symbols retained | precision (non-fatal) |
| file-level unsound removal | ${fileLevelRemoved.length} MUST_REMOVE modules dropped at trace time (${fileLevelRemoved.join(', ') || '—'}) | ${fileLevelRemoved.length ? '**CRITICAL** (whole module vanished, incl. its conservative siblings)' : 'clean'} |
| achieved/ceiling (fabricated) | ${removedFab.length}/${fabCeiling} = ${pct(removedFab.length, fabCeiling)} | product metric |
| achieved/ceiling (validator positive control) | ${validatorAchievedSyms.size}/${validatorCeiling} = ${pct(validatorAchievedSyms.size, validatorCeiling)} | product metric |

## Behavioral oracle

- original replay: ${originalDivergences.length === 0 ? 'clean' : `**${originalDivergences.length} divergences (stale fixtures?)**`}
- reduced service: ${score.behavioralOracle.verdict}${reducedReboots ? ` (crashed and was rebooted ${reducedReboots}× mid-suite)` : ''}
${reducedDivergences.map((d) => `  - \`${d.path}\` ${d.kind}: expected ${d.expected} — got ${d.actual}`).join('\n')}

## Red team (__force)

${forceResults.length} forced invocations, ${breaches.length} breaches.
${breaches.map((b) => `- **${b.path}**: ${b.verdict}`).join('\n')}

${anomalies.length ? `## Anomalies\n\n${anomalies.map((a) => `- ${a}`).join('\n')}\n` : ''}
${outOfScope.length ? `## Out-of-scope transformations (unlabeled transitive deps, judged by the contract suite)\n\n${outOfScope.map((t: any) => `- ${t.package} ${t.file} :: ${t.symbol}`).join('\n')}\n` : ''}
**Critical findings: ${critical}** — ${critical === 0 ? 'the reduction is sound on this oracle.' : 'soundness violations detected; see JSON for full detail.'}
`;
writeFileSync(path.join(GARDEN, 'results', 'garden-score.md'), md);
console.log(md);
process.exit(critical || originalDivergences.length ? 2 : 0);
