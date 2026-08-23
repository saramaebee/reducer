/**
 * The frozen 19-app INITIAL WORKING-SET measurement (ADR-0007 experiment 1).
 *
 * Per app: walk the production universe, take NFT positive evidence once, then
 * plan placement twice and measure both.
 *
 *   Plan A — theoretical placement ceiling: NFT-positive + entrypoint +
 *            resolver metadata → HOT, everything else candidate COLD. No
 *            hazard widening: dynamic require, createRequire, escaped loaders,
 *            vm, generated source and unbounded load sinks do NOT expand the
 *            hot set here. "Ignoring recovery-implementation limits, how much
 *            initial-placement opportunity exists?"
 *
 *   Plan B — practical naive plan: Plan A plus every currently recognized
 *            whole-file virtualization boundary forced HOT, i.e. the keys of
 *            `opaquePackages(universe, …).own`. `.own`, never `.all`: the
 *            ancestor propagation is conservative export-surface semantics,
 *            not a virtualization constraint.
 *
 *   Universe → Plan A  = intrinsic working-set opportunity
 *   Plan A   → Plan B  = opportunity consumed by current implementation limits
 *
 * This script analyzes nothing, transforms nothing, and builds no recovery
 * runtime; it writes only its own JSON report. COLD means "not selected for
 * initial local placement" — never dead, unused, unreachable or removable.
 *
 * Usage:
 *   bun benchmarks/working-set/run-corpus.ts --app <name>
 *   bun benchmarks/working-set/run-corpus.ts --all [--timeout-ms 1800000]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { opaquePackages } from '@reducer/hazard-domain';
import { buildUniverse, pullIn } from '@reducer/production-universe';
import { trace } from '@reducer/tracer';
import { planWorkingSet } from '@reducer/working-set-planner';
import { classifyOpaque, measurePlan, opaqueCost, unscannableDirs, type PlanMetrics } from './measure.ts';
import { ENTRY_DEVIATIONS, cloneDir, loadCorpusApps, loadFrozenPackages, verifyHead } from '../hazard-domain/corpus-apps.ts';

const OUT_DIR = path.join(import.meta.dirname, 'first-run', 'corpus');
/**
 * Per-app wall-clock bound. The hazard-domain corpus run had no programmatic
 * bound and hand-stopped its three largest apps after a ~30x re-analysis sweep
 * blew up (see first-run/RUN-INFO.md). This measurement has no sweep — one
 * universe walk, one trace, two plans — so the bound exists to keep a single
 * pathological app from stalling the corpus, and a hit is recorded as a
 * deviation, never as a measured value.
 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface AppResult {
  app: string;
  category: 'target' | 'control';
  sha: string | null;
  entry: string;
  status: 'ok' | 'failed';
  /** the pinned checkout matched corpus.json resolvedSha */
  headVerified: boolean;
  universeOk: boolean;
  traceOk: boolean;
  /** a plan is VALID as a measurement only when it rests on positive evidence */
  planAValid: boolean;
  planBValid: boolean;
  failure: string | null;
  warnings: string[];
  deviations: string[];
  universe: {
    root: string;
    files: number;
    bytes: number;
    thirdPartyFiles: number;
    thirdPartyBytes: number;
    /** ADR-0006 D: third-party executable JS bytes, realpath-deduped */
    D: number;
    packages: number;
    /** NFT-reached files absent from the frozen population, pulled in as positive evidence */
    pulledIn: number;
  };
  nft: {
    available: boolean;
    tracedFiles: number;
    /** traced entries that are not regular files (NFT emits directory symlinks it backtracks through) */
    tracedNonFiles: number;
    /** traced files that map into the universe (the planner's positive-evidence set) */
    positiveInUniverse: number;
    warnings: number;
  };
  opaque: {
    /** every dir `opaquePackages().own` marked */
    packages: number;
    /**
     * …of which own at least one universe file. `universe.pkgDirs` keeps the
     * dirs of packages the frozen-population filter later dropped, so the scan
     * marks dirs that cannot force any byte hot. Only this count can.
     */
    packagesOwningUniverseFiles: number;
    byEvidence: Record<string, number>;
    /** evidence counts restricted to the dirs that own universe files */
    byEvidenceOwning: Record<string, number>;
  };
  planA: PlanMetrics;
  planB: PlanMetrics;
  comparison: {
    /** per denominator: Plan A cold bytes, Plan B cold bytes, absolute + relative loss */
    [denom: string]: { planAColdBytes: number; planBColdBytes: number; lostBytes: number; lostFraction: number };
  };
  opaqueCost: ReturnType<typeof opaqueCost>;
  timings: { universeMs: number; traceMs: number; opaqueMs: number; planMs: number; totalMs: number };
}

async function runApp(name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${name}.json`);
  const meta = loadCorpusApps().find((c) => c.app === name)!;
  const deviation = ENTRY_DEVIATIONS[name];

  const fail = (stage: string, error: string, partial: Partial<AppResult> = {}) => {
    const out = {
      app: name,
      category: meta.category,
      sha: null,
      entry: meta.entryRel,
      status: 'failed' as const,
      headVerified: false,
      universeOk: false,
      traceOk: false,
      planAValid: false,
      planBValid: false,
      failure: `${stage}: ${error}`.slice(0, 4000),
      deviations: deviation ? [deviation] : [],
      ...partial,
    };
    console.error(`[${name}] FAILED ${out.failure}`);
    writeFileSync(outFile, JSON.stringify(out, null, 2));
  };

  const head = verifyHead(name);
  if (!head.ok) return fail('head-verification', head.error);

  const root = cloneDir(name);
  const entry = path.join(root, meta.entryRel);
  const t0 = Date.now();

  let frozenPackages: { name: string; version: string }[];
  try {
    frozenPackages = loadFrozenPackages(name);
  } catch (err) {
    return fail('frozen-population', String(err), { sha: head.sha, headVerified: true });
  }

  // ---- production universe
  const tU = Date.now();
  let universe;
  try {
    universe = buildUniverse({ entry, root, frozenPackages });
  } catch (err) {
    return fail('universe', String(err).slice(0, 500), { sha: head.sha, headVerified: true });
  }
  const universeMs = Date.now() - tU;
  const filesBefore = universe.files.length;

  // ---- positive evidence (NFT). Failure is fail-safe, never fatal: the
  // planner then forces every file hot and the app is reported as a
  // non-predictive plan — distinguishable from a successful trace that found
  // no cold candidate.
  const tT = Date.now();
  let nft: Set<string> | null = null;
  let tracedFiles = 0;
  let tracedNonFiles = 0;
  let traceWarnings = 0;
  const warnings: string[] = [];
  try {
    const traced = await trace([universe.entryAbs], universe.root);
    tracedFiles = traced.files.length;
    traceWarnings = traced.warnings.length;
    nft = new Set<string>();
    for (const tf of traced.files) {
      // NFT emits the DIRECTORY symlinks it backtracks through (pnpm and
      // workspace `node_modules/<pkg>` links), and the tracer keeps them
      // because `statSync` on a directory succeeds. A directory is not a
      // placeable file: the universe walk never records one, so byRel/byReal
      // both miss and `pullIn` would fabricate a universe member with the
      // directory's inode size, mark it third-party, and force it HOT —
      // inflating the universe and biasing the cold fraction DOWNWARD. No
      // evidence is lost by skipping them: NFT emits the real files beneath.
      let isFile = false;
      try {
        isFile = statSync(tf.abs).isFile();
      } catch {
        /* vanished between trace and stat: not placeable either */
      }
      if (!isFile) {
        tracedNonFiles++;
        continue;
      }
      // Every traced KIND is positive placement evidence, not just JS: an
      // asset NFT proves is read must be resident too. (The hazard-domain
      // analyzer keeps only JS because it reasons about module graphs; this is
      // a placement question, so the wider set is the correct one.)
      const f =
        universe.byRel.get(tf.rel) ?? universe.byReal.get(tf.abs) ?? pullIn(universe, tf.abs, 'the NFT trace reached it');
      if (f) nft.add(f.rel);
    }
    if (traceWarnings > 0) warnings.push(`NFT reported ${traceWarnings} warning(s): ${traced.warnings.slice(0, 3).join('; ')}`);
  } catch (err) {
    nft = null;
    warnings.push(
      `NFT trace failed (${String(err).slice(0, 200)}); no positive evidence. Plan is fail-safe all-HOT and predicts nothing — ` +
        'this is an infrastructure failure, NOT a measured 0% cold result.',
    );
  }
  const traceMs = Date.now() - tT;

  // ---- currently recognized whole-file virtualization boundaries (plan B only)
  // Taken AFTER the trace so `pullIn`'s universe-divergence records — a file
  // the frozen population did not declare but positive evidence reached — are
  // in the report rather than lost to a pre-trace snapshot.
  warnings.unshift(...universe.warnings);

  const tO = Date.now();
  const opaqueWarnings: string[] = [];
  const opaque = opaquePackages(universe, opaqueWarnings);
  warnings.push(...opaqueWarnings);
  const evidence = classifyOpaque(universe, opaque.own.keys(), unscannableDirs(opaqueWarnings));
  const opaqueMs = Date.now() - tO;

  // ---- the two plans
  const tP = Date.now();
  const planA = planWorkingSet({ universe, nft, app: name });
  const planB = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()), app: name });
  const mA = measurePlan(universe, planA, 'A');
  const mB = measurePlan(universe, planB, 'B');
  const planMs = Date.now() - tP;

  // Plan B's hot set must be a superset of Plan A's — B only ADDS a reason.
  const hotA = new Set(planA.placements.filter((p) => p.placement === 'hot').map((p) => p.file));
  for (const p of planB.placements) {
    if (p.placement === 'cold' && hotA.has(p.file)) {
      return fail('invariant', `plan B placed '${p.file}' cold while plan A placed it hot (B must be a superset)`);
    }
  }

  const comparison: AppResult['comparison'] = {};
  for (const d of ['universe', 'thirdParty', 'thirdPartyJs'] as const) {
    const a = mA.denominators[d].coldBytes;
    const b = mB.denominators[d].coldBytes;
    comparison[d] = { planAColdBytes: a, planBColdBytes: b, lostBytes: a - b, lostFraction: a > 0 ? (a - b) / a : 0 };
  }

  const cost = opaqueCost(universe, planA, planB, evidence);
  // The three routes to "what plan B gave up" must agree exactly, or the
  // evidence breakdown is describing different bytes than the headline loss.
  // They can only agree because `opaque-boundary` is LAST in the attribution
  // order: a file cold in plan A carries no other reason, so in plan B its
  // sole reason is the opaque boundary.
  if (mB.reasons.attributed['opaque-boundary'] !== comparison.universe!.lostBytes) {
    return fail(
      'invariant',
      `opaque-attributed bytes ${mB.reasons.attributed['opaque-boundary']} != plan A→B loss ${comparison.universe!.lostBytes}`,
    );
  }
  if (cost.total.forcedHotBytes !== comparison.universe!.lostBytes) {
    return fail('invariant', `opaque evidence bytes ${cost.total.forcedHotBytes} != plan A→B loss ${comparison.universe!.lostBytes}`);
  }

  const owningDirs = new Set(universe.files.filter((f) => f.pkg).map((f) => f.pkg!.dir));
  const byEvidence: Record<string, number> = {};
  const byEvidenceOwning: Record<string, number> = {};
  let opaqueOwning = 0;
  for (const [dir, e] of evidence) {
    byEvidence[e] = (byEvidence[e] ?? 0) + 1;
    if (owningDirs.has(dir)) {
      byEvidenceOwning[e] = (byEvidenceOwning[e] ?? 0) + 1;
      opaqueOwning++;
    }
  }

  const thirdPartyFiles = universe.files.filter((f) => f.thirdParty);
  const out: AppResult = {
    app: name,
    category: meta.category,
    sha: head.sha,
    entry: meta.entryRel,
    status: 'ok',
    headVerified: true,
    universeOk: true,
    traceOk: nft !== null,
    planAValid: mA.predictive,
    planBValid: mB.predictive,
    failure: null,
    warnings,
    deviations: deviation ? [deviation] : [],
    universe: {
      root,
      files: universe.files.length,
      bytes: mA.denominators.universe.bytes,
      thirdPartyFiles: thirdPartyFiles.length,
      thirdPartyBytes: mA.denominators.thirdParty.bytes,
      D: universe.D,
      packages: universe.pkgDirs.size,
      pulledIn: universe.files.length - filesBefore,
    },
    nft: {
      available: nft !== null,
      tracedFiles,
      tracedNonFiles,
      positiveInUniverse: nft?.size ?? 0,
      warnings: traceWarnings,
    },
    opaque: {
      packages: opaque.own.size,
      packagesOwningUniverseFiles: opaqueOwning,
      byEvidence,
      byEvidenceOwning,
    },
    planA: mA,
    planB: mB,
    comparison,
    opaqueCost: opaqueCost(universe, planA, planB, evidence),
    timings: { universeMs, traceMs, opaqueMs, planMs, totalMs: Date.now() - t0 },
  };
  writeFileSync(outFile, JSON.stringify(out, null, 2));

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `[${name}] universe=${fmtBytes(out.universe.bytes)} (${out.universe.files} files) ` +
      `coldA=${pct(mA.denominators.universe.coldFraction)} coldB=${pct(mB.denominators.universe.coldFraction)} ` +
      `(3p-JS: ${pct(mA.denominators.thirdPartyJs.coldFraction)} / ${pct(mB.denominators.thirdPartyJs.coldFraction)}) ` +
      `${nft === null ? 'NFT-FAILED ' : ''}${out.timings.totalMs}ms`,
  );
}

function fmtBytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)}GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
}

/**
 * `--all` runs each app in its own process. Two reasons, both learned from the
 * hazard-domain run: a hung or memory-hungry app cannot take the corpus with
 * it, and the wall-clock bound is actually enforceable (an in-process
 * Promise.race would leave the trace running and holding memory).
 */
function runAllIsolated(apps: string[], timeoutMs: number): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const app of apps) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [import.meta.filename, '--app', app], {
      stdio: 'inherit',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (r.error || r.status !== 0 || r.signal) {
      const timedOut = r.signal === 'SIGKILL' && Date.now() - t >= timeoutMs - 1000;
      const failure = timedOut
        ? `timeout: exceeded ${timeoutMs}ms wall clock and was killed (recorded deviation, not a measured value)`
        : `child exited status=${r.status} signal=${r.signal ?? 'none'}${r.error ? ` error=${String(r.error).slice(0, 200)}` : ''}`;
      const meta = loadCorpusApps().find((c) => c.app === app)!;
      console.error(`[${app}] FAILED ${failure}`);
      writeFileSync(
        path.join(OUT_DIR, `${app}.json`),
        JSON.stringify(
          {
            app,
            category: meta.category,
            entry: meta.entryRel,
            status: 'failed',
            headVerified: false,
            universeOk: false,
            traceOk: false,
            planAValid: false,
            planBValid: false,
            failure,
            deviations: ENTRY_DEVIATIONS[app] ? [ENTRY_DEVIATIONS[app]] : [],
          },
          null,
          2,
        ),
      );
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      all: { type: 'boolean', default: false },
      'timeout-ms': { type: 'string' },
    },
  });

  const apps = loadCorpusApps().map((c) => c.app);
  if (values.all) {
    runAllIsolated(apps, values['timeout-ms'] ? Number(values['timeout-ms']) : DEFAULT_TIMEOUT_MS);
  } else if (values.app) {
    if (!apps.includes(values.app)) {
      console.error(`unknown app '${values.app}'. Known: ${apps.join(', ')}`);
      process.exit(1);
    }
    await runApp(values.app);
  } else {
    console.error('usage: bun benchmarks/working-set/run-corpus.ts --app <name> | --all');
    console.error(`known apps: ${apps.join(', ')}`);
    process.exit(1);
  }
}

await main();
