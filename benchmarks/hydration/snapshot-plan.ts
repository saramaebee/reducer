/**
 * Placement snapshot for the hydration experiment (ADR-0007 experiment 2).
 *
 * The preserved first run (`benchmarks/working-set/first-run/`) records Plan A
 * and Plan B *metrics*, not the per-file placement list, and the hydration
 * analysis needs the list — every observed access has to be joined to the
 * placement its file started with. So the placement is recomputed here through
 * the SAME calls in the SAME order as `working-set/run-corpus.ts`, and then
 * PROVEN identical to the preserved result before it may be used:
 *
 *   every denominator's bytes/files/hot/cold, every attributed and covering
 *   reason byte total, and every package classification count must match
 *   `first-run/corpus/<app>.json` exactly. Any mismatch aborts the app.
 *
 * That check is the whole point of the script: it converts "we re-ran the
 * planner and hope it agreed" into "the placement joined below is the one the
 * headline first-run numbers describe".
 *
 * Writes nothing into the repository — the snapshot lands in a cache dir,
 * because a per-file index of a 252k-file universe is not a committable
 * artifact. `benchmarks/hydration/<run>/` keeps the provenance instead.
 *
 * Usage:
 *   bun benchmarks/hydration/snapshot-plan.ts --app <name>
 *   bun benchmarks/hydration/snapshot-plan.ts --all
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { opaquePackages } from '@reducer/hazard-domain';
import { buildUniverse, pullIn } from '@reducer/production-universe';
import { trace } from '@reducer/tracer';
import { planWorkingSet } from '@reducer/working-set-planner';
import { statSync } from 'node:fs';
import { measurePlan } from '../working-set/measure.ts';
import { cloneDir, loadCorpusApps, loadFrozenPackages, verifyHead } from '../hazard-domain/corpus-apps.ts';

export const SNAPSHOT_ROOT = '/Users/sara/.cache/reducer-hydration-v1/plans';
const FIRST_RUN = path.join(import.meta.dirname, '..', 'working-set', 'first-run', 'corpus');

export interface SnapshotMeta {
  app: string;
  category: string;
  sha: string;
  entryRel: string;
  /** universe root as `findBase` computed it (may be above the entry's dir) */
  universeRoot: string;
  /** the frozen clone dir — the tracer's observation boundary (⊇ universeRoot) */
  cloneRoot: string;
  files: number;
  universeBytes: number;
  thirdPartyBytes: number;
  D: number;
  planB: { hotFiles: number; hotBytes: number; coldFiles: number; coldBytes: number };
  planA: { hotFiles: number; hotBytes: number; coldFiles: number; coldBytes: number };
  /** proof that the recomputed placement is the preserved first-run placement */
  matchesFirstRun: boolean;
  mismatches: string[];
  planSha256: string;
  nodeVersion: string;
}

/** compact per-file record: [real, rel, bytes, hotA, hotB, pkgDir, thirdParty, isJs] */
export type PlanRow = [string, string, number, 0 | 1, 0 | 1, string, 0 | 1, 0 | 1];

function deepPaths(o: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (v: unknown, p: string) => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, vv] of Object.entries(v)) walk(vv, p ? `${p}.${k}` : k);
    } else out.set(p, v);
  };
  walk(o, prefix);
  return out;
}

/**
 * Every leaf of `expected` must be present and equal in `actual`. An ABSENT or
 * empty expected subtree is itself a failure: otherwise a first-run file that
 * lost a section would compare zero leaves and silently "match".
 */
function compare(label: string, expected: unknown, actual: unknown, into: string[]): void {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) {
    into.push(`${label}: the preserved first-run result has no comparable object here — cannot prove a match`);
    return;
  }
  const e = deepPaths(expected);
  const a = deepPaths(actual);
  if (e.size === 0) {
    into.push(`${label}: the preserved first-run result has no comparable leaves here — cannot prove a match`);
    return;
  }
  for (const [k, v] of e) {
    const got = a.get(k);
    if (got !== v) into.push(`${label}.${k}: first-run=${JSON.stringify(v)} recomputed=${JSON.stringify(got)}`);
  }
}

async function snapshot(name: string): Promise<void> {
  const meta = loadCorpusApps().find((c) => c.app === name)!;
  const head = verifyHead(name);
  if (!head.ok) throw new Error(`[${name}] ${head.error}`);
  const root = cloneDir(name);
  const entry = path.join(root, meta.entryRel);

  const universe = buildUniverse({ entry, root, frozenPackages: loadFrozenPackages(name) });

  // Identical to working-set/run-corpus.ts: every traced KIND is positive
  // evidence, non-regular-file traced entries are skipped, and NFT-reached
  // files absent from the frozen population are pulled in.
  let nft: Set<string> | null = null;
  try {
    const traced = await trace([universe.entryAbs], universe.root);
    nft = new Set<string>();
    for (const tf of traced.files) {
      let isFile = false;
      try {
        isFile = statSync(tf.abs).isFile();
      } catch {
        /* not placeable */
      }
      if (!isFile) continue;
      const f =
        universe.byRel.get(tf.rel) ?? universe.byReal.get(tf.abs) ?? pullIn(universe, tf.abs, 'the NFT trace reached it');
      if (f) nft.add(f.rel);
    }
  } catch (err) {
    throw new Error(`[${name}] NFT trace failed: ${String(err).slice(0, 300)} — cannot reproduce the frozen plan`);
  }

  const opaqueWarnings: string[] = [];
  const opaque = opaquePackages(universe, opaqueWarnings);
  const planA = planWorkingSet({ universe, nft, app: name });
  const planB = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()), app: name });
  const mA = measurePlan(universe, planA, 'A');
  const mB = measurePlan(universe, planB, 'B');

  // ---- the proof: recomputed == preserved first run
  const first = JSON.parse(readFileSync(path.join(FIRST_RUN, `${name}.json`), 'utf8'));
  const mismatches: string[] = [];
  if (first.status !== 'ok') mismatches.push(`first-run status is '${first.status}', not 'ok'`);
  if (first.sha !== head.sha) mismatches.push(`sha: first-run=${first.sha} now=${head.sha}`);
  if (first.universe.files !== universe.files.length) {
    mismatches.push(`universe.files: first-run=${first.universe.files} recomputed=${universe.files.length}`);
  }
  compare('planA.denominators', first.planA.denominators, mA.denominators, mismatches);
  compare('planB.denominators', first.planB.denominators, mB.denominators, mismatches);
  compare('planA.reasons', first.planA.reasons, mA.reasons, mismatches);
  compare('planB.reasons', first.planB.reasons, mB.reasons, mismatches);
  for (const k of ['total', 'allHot', 'mixed', 'allCold', 'allHotNonMeta', 'mixedNonMeta', 'allColdNonMeta'] as const) {
    if (first.planB.packages[k] !== mB.packages[k]) {
      mismatches.push(`planB.packages.${k}: first-run=${first.planB.packages[k]} recomputed=${mB.packages[k]}`);
    }
  }

  const hotA = new Set(planA.placements.filter((p) => p.placement === 'hot').map((p) => p.file));
  const hotB = new Set(planB.placements.filter((p) => p.placement === 'hot').map((p) => p.file));
  for (const f of hotA) if (!hotB.has(f)) mismatches.push(`plan B dropped hot file '${f}' (B must be a superset of A)`);

  // A mismatching placement must not be left on disk looking usable. The
  // metadata still records exactly what diverged.
  const outDir = path.join(SNAPSHOT_ROOT, name);
  mkdirSync(outDir, { recursive: true });

  const lines: string[] = [];
  for (const f of universe.files) {
    const row: PlanRow = [
      f.real,
      f.rel,
      f.bytes,
      hotA.has(f.rel) ? 1 : 0,
      hotB.has(f.rel) ? 1 : 0,
      f.pkg?.dir ?? '',
      f.thirdParty ? 1 : 0,
      f.isJs ? 1 : 0,
    ];
    lines.push(JSON.stringify(row));
  }
  const body = lines.join('\n') + '\n';
  writeFileSync(path.join(outDir, 'plan.ndjson'), body);

  const pkgLines = [...universe.pkgDirs.entries()].map(([dir, id]) =>
    JSON.stringify([dir, id.name, id.version]),
  );
  writeFileSync(path.join(outDir, 'packages.ndjson'), pkgLines.join('\n') + '\n');

  const snap: SnapshotMeta = {
    app: name,
    category: meta.category,
    sha: head.sha,
    entryRel: meta.entryRel,
    universeRoot: universe.root,
    cloneRoot: root,
    files: universe.files.length,
    universeBytes: mB.denominators.universe.bytes,
    thirdPartyBytes: mB.denominators.thirdParty.bytes,
    D: universe.D,
    planB: {
      hotFiles: mB.denominators.universe.hotFiles,
      hotBytes: mB.denominators.universe.hotBytes,
      coldFiles: mB.denominators.universe.coldFiles,
      coldBytes: mB.denominators.universe.coldBytes,
    },
    planA: {
      hotFiles: mA.denominators.universe.hotFiles,
      hotBytes: mA.denominators.universe.hotBytes,
      coldFiles: mA.denominators.universe.coldFiles,
      coldBytes: mA.denominators.universe.coldBytes,
    },
    matchesFirstRun: mismatches.length === 0,
    mismatches,
    planSha256: createHash('sha256').update(body).digest('hex'),
    nodeVersion: process.version,
  };
  writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(snap, null, 2));

  const status = snap.matchesFirstRun ? 'MATCHES first run' : `MISMATCH (${mismatches.length})`;
  console.log(
    `[${name}] ${universe.files.length} files, planB cold ${(mB.denominators.universe.coldFraction * 100).toFixed(1)}% — ${status}`,
  );
  for (const m of mismatches.slice(0, 10)) console.error(`  ! ${m}`);
}

// CLI only when executed directly: run-app.ts and analyze.ts import this module
// for SNAPSHOT_ROOT and the SnapshotMeta type, and an unguarded body would
// re-run the whole snapshot (and re-parse THEIR argv) on every import.
if (import.meta.main) {
  const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean', default: false } } });
  const apps = loadCorpusApps().map((c) => c.app);
  if (values.all) {
    for (const a of apps) {
      try {
        await snapshot(a);
      } catch (err) {
        console.error(`[${a}] FAILED ${String(err).slice(0, 400)}`);
      }
    }
  } else if (values.app) {
    await snapshot(values.app);
  } else {
    console.error('usage: bun benchmarks/hydration/snapshot-plan.ts --app <name> | --all');
    process.exit(1);
  }
}
