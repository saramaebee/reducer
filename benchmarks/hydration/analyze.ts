/**
 * Hydration analysis (ADR-0007 experiment 2).
 *
 * Joins the observed first-touch stream against the FROZEN Plan B placement and
 * answers one counterfactual: if the candidate-COLD files had not been resident,
 * which ones would execution have forced us to hydrate, and when.
 *
 * Definitions used throughout, kept deliberately separate because collapsing
 * them is the classic way to make this measurement lie:
 *
 *   hydration miss    the FIRST content-class touch of a candidate-COLD file.
 *                     Every later touch of that file is a resident hit, because
 *                     a recovery runtime caches what it recovered.
 *   unique files      distinct candidate-COLD files with ≥1 content touch.
 *   unique bytes      Σ bytes of those files. Never Σ over accesses.
 *   total accesses    every access the tracer saw, reported but never used as
 *                     a miss count.
 *
 * Content vs metadata. Only a content touch moves bytes. `stat`/`access`/
 * `existsSync`/`readdir` need the file's existence and attributes, which a
 * whole-file virtualizer serves from a local index without materializing
 * anything — so they are reported as a SEPARATE, explicitly-labelled upper
 * bound rather than folded into the headline.
 *
 * Process roles. HYDRATION_RUN_LABEL is inherited by every child, so the
 * application's own process tree (`<app>:app`) is distinguishable from a
 * workload runner the harness started (`<app>:workload:<phase>`). Only the
 * application's tree contributes to its resident set; a test runner reading its
 * own dependencies is not the application working set, and merging the two
 * would be the single largest available way to inflate this result.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { SNAPSHOT_ROOT, type PlanRow, type SnapshotMeta } from './snapshot-plan.ts';
import { TRACE_ROOT, type RunRecord } from './run-app.ts';

export type TouchClass = 'content' | 'metadata' | 'dir' | 'write';
export type Bucket = 'planB-hot' | 'planB-cold' | 'outside-universe' | 'generated' | 'directory';

interface FileRec {
  rel: string;
  bytes: number;
  hotA: boolean;
  hotB: boolean;
  pkgDir: string;
  thirdParty: boolean;
  isJs: boolean;
}

export interface PhaseCurvePoint {
  phase: string;
  /** boundary this cumulative point is measured at */
  endTs: number;
  offsetMs: number;
  reachedGoal: boolean;
  detail: string;
  /** cumulative unique cold files/bytes hydrated by content touches up to here */
  hydratedFiles: number;
  hydratedBytes: number;
  /** the same including metadata-only touches — the upper bound */
  touchedAnyFiles: number;
  touchedAnyBytes: number;
  missEvents: number;
  resident: Record<string, { hotBytes: number; residentBytes: number; totalBytes: number; residentFraction: number }>;
}

export interface PkgRow {
  dir: string;
  name: string;
  version: string;
  thirdParty: boolean;
  files: number;
  bytes: number;
  hotFiles: number;
  hotBytes: number;
  coldFiles: number;
  coldBytes: number;
  hydratedFiles: number;
  hydratedBytes: number;
  /** cold bytes never content-touched */
  stillColdBytes: number;
  initialHotFraction: number;
  finalResidentFraction: number;
  klass: 'all-hot-initially' | 'mixed-stays-mixed' | 'mixed-becomes-hot' | 'cold-stays-cold' | 'cold-becomes-resident';
}

export interface AppAnalysis {
  app: string;
  category: string;
  sha: string;
  ok: boolean;
  failure: string | null;
  workloadQuality: string;
  /** per phase: the fraction of its requests that actually succeeded (<400) */
  phaseSuccessRatio: Record<string, number>;
  workloadNotes: string;
  deviations: string[];
  ready: RunRecord['ready'];
  processes: { pid: number; tid: number; ppid: number; role: string; argv: string; isWorker: boolean; touches: number }[];
  spawnedNonNode: string[];
  /** spawns observed vs child processes actually traced — the env-replacement blind spot, measured */
  untracedChildren: { spawnEvents: number; tracedChildProcesses: number; untracedSpawns: number };
  universe: { files: number; bytes: number; thirdPartyBytes: number; D: number };
  initial: {
    hotFiles: number;
    hotBytes: number;
    coldFiles: number;
    coldBytes: number;
    coldFraction: number;
    coldThirdPartyBytes: number;
    coldThirdPartyJsBytes: number;
  };
  totals: {
    tracedEvents: number;
    totalAccesses: number;
    appTouchedFiles: number;
    /** directory paths the run touched — reported apart, never as files */
    appTouchedDirectories: number;
    /** accesses observed in a workload-runner tree (NOT the application's) */
    workloadTreeAccessEvents: number;
    /**
     * Candidate-COLD files content-read ONLY by a workload-runner tree, and
     * therefore deliberately excluded from this app's hydration. Published so
     * the exclusion can be checked rather than trusted.
     */
    excludedWorkloadTreeColdFiles: number;
    excludedWorkloadTreeColdBytes: number;
    /**
     * Identical to `uniqueMissFiles` BY CONSTRUCTION: a recovery runtime caches
     * what it recovered, so the second access to a hydrated file is a resident
     * hit, not a second miss. Kept as a named field so that identity is
     * explicit rather than an unstated coincidence.
     */
    missEvents: number;
    uniqueMissFiles: number;
    uniqueMissBytes: number;
    uniqueMissThirdPartyBytes: number;
    uniqueMissThirdPartyJsBytes: number;
    metadataOnlyColdFiles: number;
    metadataOnlyColdBytes: number;
    /** Plan B HOT files the run never touched at all — over-provisioning */
    hotNeverTouchedFiles: number;
    hotNeverTouchedBytes: number;
    hotTouchedFiles: number;
    hotTouchedBytes: number;
  };
  survival: {
    initialColdBytes: number;
    hydratedBytes: number;
    stillColdBytes: number;
    hydratedFractionOfCold: number;
    stillColdFractionOfCold: number;
    /** the same on the metadata-inclusive upper bound */
    upperBoundHydratedBytes: number;
    upperBoundStillColdFractionOfCold: number;
  };
  curve: PhaseCurvePoint[];
  /** cold bytes hydrated within N ms of PROCESS SPAWN (run.t0) */
  timing: { windowMs: number; files: number; bytes: number }[];
  misses: {
    /** size histogram of hydrated cold files */
    sizeBuckets: { label: string; files: number; bytes: number }[];
    topFiles: { rel: string; bytes: number; phase: string; offsetMs: number; op: string }[];
    topPackages: { name: string; version: string; hydratedBytes: number; hydratedFiles: number; coldBytes: number }[];
    /** how concentrated: packages needed to cover 50/80/95% of hydrated bytes */
    concentration: { p50: number; p80: number; p95: number; totalPackagesHydrated: number };
  };
  packages: { total: number; byClass: Record<string, number>; rows: PkgRow[] };
  outside: {
    /** touched files under the clone root that are NOT in the frozen universe */
    files: number;
    bytes: number;
    contentFiles: number;
    contentBytes: number;
    writtenDuringRun: number;
    /** of contentBytes: files this run created before reading (generated state) */
    generatedContentBytes: number;
    /** of contentBytes: files that already existed — the real universe-model gap */
    preexistingContentFiles: number;
    preexistingContentBytes: number;
    /** directory paths the run stat'd that the plan does not contain — NOT files */
    directoriesTouched: number;
    topDirs: { dir: string; files: number; bytes: number }[];
    sample: string[];
  };
  /** aggregated buckets for paths the tracer saw outside the clone root */
  outsideCloneRoot: { key: string; n: number; cls: string; sample: string }[];
  dirListings: { dirs: number; insidePackages: number; sample: string[] };
  firstTouchFile: string;
  firstTouchSha256: string;
}

const WINDOWS = [100, 250, 500, 1000, 2000, 5000, 15_000, 60_000];
const SIZE_BUCKETS: [string, number, number][] = [
  ['<1 KB', 0, 1024],
  ['1–4 KB', 1024, 4096],
  ['4–16 KB', 4096, 16384],
  ['16–64 KB', 16384, 65536],
  ['64–256 KB', 65536, 262144],
  ['256 KB–1 MB', 262144, 1048576],
  ['≥1 MB', 1048576, Infinity],
];

function loadPlan(
  app: string,
  snapshotRoot: string,
): { meta: SnapshotMeta; byReal: Map<string, FileRec>; pkgs: Map<string, { name: string; version: string }> } {
  const dir = path.join(snapshotRoot, app);
  const meta: SnapshotMeta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const byReal = new Map<string, FileRec>();
  for (const line of readFileSync(path.join(dir, 'plan.ndjson'), 'utf8').split('\n')) {
    if (!line) continue;
    const [real, rel, bytes, hotA, hotB, pkgDir, tp, js] = JSON.parse(line) as PlanRow;
    byReal.set(real, { rel, bytes, hotA: hotA === 1, hotB: hotB === 1, pkgDir, thirdParty: tp === 1, isJs: js === 1 });
  }
  const pkgs = new Map<string, { name: string; version: string }>();
  for (const line of readFileSync(path.join(dir, 'packages.ndjson'), 'utf8').split('\n')) {
    if (!line) continue;
    const [d, n, v] = JSON.parse(line) as [string, string, string];
    pkgs.set(d, { name: n, version: v });
  }
  return { meta, byReal, pkgs };
}

interface Touch {
  real: string;
  cls: TouchClass;
  op: string;
  ts: number;
  pid: number;
  tid: number;
  role: string;
  from: string | null;
}

async function readTraces(traceDir: string): Promise<{
  touches: Touch[];
  procs: Map<string, { pid: number; tid: number; ppid: number; role: string; argv: string; isWorker: boolean; touches: number }>;
  spawns: string[];
  outsideCloneRoot: Map<string, { n: number; cls: string; sample: string }>;
  totalAccesses: number;
  events: number;
}> {
  const touches: Touch[] = [];
  const procs = new Map<string, any>();
  const spawns: string[] = [];
  const outsideCloneRoot = new Map<string, { n: number; cls: string; sample: string }>();
  const lastSummary = new Map<string, any>();
  let totalAccesses = 0;
  let events = 0;
  if (!existsSync(traceDir)) return { touches, procs, spawns, outsideCloneRoot, totalAccesses, events };

  for (const f of readdirSync(traceDir).filter((f) => f.endsWith('.ndjson'))) {
    const rl = readline.createInterface({ input: createReadStream(path.join(traceDir, f)), crlfDelay: Infinity });
    let key = f;
    for await (const line of rl) {
      if (!line) continue;
      events++;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a torn last line from a hard kill is data loss, not corruption to propagate
      }
      if (r.t === 'proc') {
        key = `${r.pid}:${r.threadId}`;
        procs.set(key, {
          pid: r.pid,
          tid: r.threadId,
          ppid: r.ppid,
          role: r.label ?? 'unknown',
          argv: (r.argv ?? []).slice(0, 6).join(' ').slice(0, 300),
          isWorker: !!r.isWorker,
          touches: 0,
        });
      } else if (r.t === 'touch') {
        const p = procs.get(`${r.pid}:${r.tid}`);
        if (p) p.touches++;
        touches.push({ real: r.real, cls: r.cls, op: r.op, ts: r.ts, pid: r.pid, tid: r.tid, role: p?.role ?? 'unknown', from: r.from ?? null });
      } else if (r.t === 'spawn') {
        spawns.push(`${r.fn}: ${r.cmd}`);
      } else if (r.t === 'end' || r.t === 'summary') {
        // Summaries are CUMULATIVE per process, so only the last one from each
        // file may be counted — adding them all would multiply the totals by
        // the number of ticks the process lived through. Each trace file holds
        // exactly one `proc` header, so the file's role is known here; a
        // workload runner's accesses must not be folded into a total labelled
        // as the application's.
        lastSummary.set(f, { rec: r, role: procs.get(key)?.role ?? 'unknown' });
      }
    }
  }
  for (const { rec: s, role } of lastSummary.values()) {
    if (!role.endsWith(':app')) continue;
    totalAccesses += s.totalAccesses ?? 0;
    for (const o of s.outside ?? []) {
      const cur = outsideCloneRoot.get(o.key);
      if (cur) cur.n += o.n;
      else outsideCloneRoot.set(o.key, { n: o.n, cls: o.cls, sample: o.sample });
    }
  }
  touches.sort((a, b) => a.ts - b.ts);
  return { touches, procs, spawns, outsideCloneRoot, totalAccesses, events };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export async function analyze(app: string, runDir: string, snapshotRoot: string = SNAPSHOT_ROOT): Promise<AppAnalysis | null> {
  const runFile = path.join(runDir, `${app}.run.json`);
  if (!existsSync(runFile)) {
    console.error(`[${app}] no run record at ${runFile}`);
    return null;
  }
  const run: RunRecord = JSON.parse(readFileSync(runFile, 'utf8'));
  const { meta, byReal, pkgs } = loadPlan(app, snapshotRoot);
  // The whole join is against this placement. `run-app.ts` checks the gate too,
  // but a result file can be re-analyzed later from a re-snapshotted plan, and
  // a silent mismatch would move every number below without a trace.
  if (meta.matchesFirstRun === false) {
    throw new Error(
      `[${app}] placement snapshot does not match the preserved first run (${(meta.mismatches ?? []).length} mismatches); refusing to analyze`,
    );
  }
  const { touches, procs, spawns, outsideCloneRoot, totalAccesses, events } = await readTraces(run.traceDir ?? path.join(TRACE_ROOT, app));

  // ---- only the application's own process tree counts toward its working set
  const isApp = (role: string) => role === `${app}:app`;

  // First touch per (file, class) already holds PER PROCESS; a file recovered
  // once is resident for the machine, so collapse across processes taking the
  // earliest content touch and the earliest any-class touch.
  const firstContent = new Map<string, Touch>();
  const firstAny = new Map<string, Touch>();
  const firstWrite = new Map<string, Touch>();
  const dirTouched = new Map<string, Touch>();
  const nonAppContent = new Map<string, Touch>();
  /** accesses seen in a workload-runner tree, kept apart from the app's own */
  let workloadAccessEvents = 0;
  for (const t of touches) {
    if (t.cls === 'dir') {
      if (!dirTouched.has(t.real)) dirTouched.set(t.real, t);
      continue;
    }
    if (!isApp(t.role)) {
      workloadAccessEvents++;
      if (t.cls === 'content' && !nonAppContent.has(t.real)) nonAppContent.set(t.real, t);
      continue;
    }
    if (t.cls === 'write') {
      if (!firstWrite.has(t.real)) firstWrite.set(t.real, t);
    }
    if (!firstAny.has(t.real)) firstAny.set(t.real, t);
    if (t.cls === 'content' && !firstContent.has(t.real)) firstContent.set(t.real, t);
  }

  // ---- initial Plan B state
  let hotFiles = 0;
  let hotBytes = 0;
  let coldFiles = 0;
  let coldBytes = 0;
  let coldTpBytes = 0;
  let coldTpJsBytes = 0;
  let uniBytes = 0;
  let tpBytes = 0;
  let dBytes = 0;
  for (const f of byReal.values()) {
    uniBytes += f.bytes;
    if (f.thirdParty) tpBytes += f.bytes;
    if (f.thirdParty && f.isJs) dBytes += f.bytes;
    if (f.hotB) {
      hotFiles++;
      hotBytes += f.bytes;
    } else {
      coldFiles++;
      coldBytes += f.bytes;
      if (f.thirdParty) coldTpBytes += f.bytes;
      if (f.thirdParty && f.isJs) coldTpJsBytes += f.bytes;
    }
  }

  // ---- classify every app-tree first touch
  interface MissEvent {
    real: string;
    rel: string;
    bytes: number;
    ts: number;
    op: string;
    pkgDir: string;
    thirdParty: boolean;
    isJs: boolean;
    from: string | null;
    pid: number;
  }
  const misses: MissEvent[] = [];
  const hotTouched = new Set<string>();
  const outsideFiles = new Map<string, { bytes: number; content: boolean; written: boolean }>();

  /**
   * A path the plan does not know may be a runtime-generated FILE (interesting:
   * it is a real out-of-universe dependency) or merely a DIRECTORY that
   * something stat'd (not interesting: a directory is not a placeable file, and
   * counting one inflates the out-of-universe report with inode sizes). This is
   * the same trap the first run documented for NFT's directory entries.
   */
  const statUnknown = (real: string): { isFile: boolean; bytes: number } => {
    try {
      const st = require('node:fs').statSync(real);
      return { isFile: st.isFile(), bytes: st.isFile() ? st.size : 0 };
    } catch {
      // vanished (a generated temp file): still a real out-of-universe file
      return { isFile: true, bytes: 0 };
    }
  };
  let outsideDirs = 0;

  for (const [real, t] of firstAny) {
    const f = byReal.get(real);
    if (f === undefined) {
      const prev = outsideFiles.get(real);
      const st = prev ? { isFile: true, bytes: prev.bytes } : statUnknown(real);
      if (!st.isFile) {
        outsideDirs++;
        continue;
      }
      outsideFiles.set(real, {
        bytes: st.bytes,
        content: firstContent.has(real) || !!prev?.content,
        written: firstWrite.has(real) || !!prev?.written,
      });
      continue;
    }
    if (f.hotB) {
      hotTouched.add(real);
      continue;
    }
    const c = firstContent.get(real);
    if (c) {
      misses.push({
        real,
        rel: f.rel,
        bytes: f.bytes,
        ts: c.ts,
        op: c.op,
        pkgDir: f.pkgDir,
        thirdParty: f.thirdParty,
        isJs: f.isJs,
        from: c.from,
        pid: c.pid,
      });
    }
  }
  misses.sort((a, b) => a.ts - b.ts);

  // What excluding the workload-runner tree actually cost. Excluding it is
  // correct — a socket client or test runner reading its own dependencies is
  // not the application's working set — but the amount dropped must be visible
  // rather than implicit, or the exclusion is unfalsifiable.
  let excludedColdFiles = 0;
  let excludedColdBytes = 0;
  for (const real of nonAppContent.keys()) {
    const f = byReal.get(real);
    if (f && !f.hotB && !firstContent.has(real)) {
      excludedColdFiles++;
      excludedColdBytes += f.bytes;
    }
  }

  // metadata-only cold: touched, but never content-touched
  let metaOnlyFiles = 0;
  let metaOnlyBytes = 0;
  for (const [real] of firstAny) {
    const f = byReal.get(real);
    if (!f || f.hotB) continue;
    if (!firstContent.has(real)) {
      metaOnlyFiles++;
      metaOnlyBytes += f.bytes;
    }
  }

  // ---- phase curve
  const boundaries: { name: string; endTs: number; reachedGoal: boolean; detail: string }[] = [];
  if (run.ready.ts) {
    // The startup boundary ends where the WORKLOAD begins, not at the ready
    // signal: `settleMs` exists precisely so late startup work (lazy service
    // init, background warmup) is charged to startup, and ending the boundary
    // at ready would push all of it into the first workload phase instead.
    const workloadStart = run.phases[0]?.startTs;
    boundaries.push({
      name: 'startup',
      endTs: workloadStart && workloadStart > run.ready.ts ? workloadStart : run.ready.ts,
      reachedGoal: run.ready.ok,
      detail: `ready via ${run.ready.how}${workloadStart && workloadStart > run.ready.ts ? ' (+ settle)' : ''}`,
    });
  } else if (touches.length > 0) {
    // A run that never reached ready still produced first touches. Without a
    // boundary they would all fall through to the first workload phase's label
    // — describing them as workload hydration when they are pre-crash startup.
    boundaries.push({
      name: 'startup-incomplete',
      endTs: touches[touches.length - 1]!.ts,
      reachedGoal: false,
      detail: 'the application never reported ready; every touch is pre-ready startup',
    });
  }
  // `reachedGoal` as recorded by the harness passes on ANY single response
  // below 500 — which let outline's entire authenticated sweep return 401 and
  // still be reported as a completed workload. Recompute it here from the
  // stored per-request statuses, so a phase counts only when most of what it
  // asked for actually worked, and publish the ratio rather than a bare flag.
  const phaseQuality = (ph: RunRecord['phases'][number]): { ok: boolean; ratio: number; detail: string } => {
    const reqs = ph.requests ?? [];
    if (reqs.length > 0) {
      // Two different questions. "Did the phase run?" is answered by the app
      // responding at all — a 401 or 404 is a real answer that executes real
      // code, and several phases probe exactly those paths on purpose. "Was the
      // workload any good?" is the 2xx/3xx ratio, which is published rather
      // than folded into a flag, because that is the number that exposed
      // outline's whole authenticated sweep silently degrading to 401s.
      const answered = reqs.filter((r) => typeof r.status === 'number').length;
      const good = reqs.filter((r) => typeof r.status === 'number' && r.status < 400).length;
      return {
        ok: answered / reqs.length >= 0.6,
        ratio: good / reqs.length,
        detail: `${ph.detail} — ${good}/${reqs.length} succeeded, ${answered}/${reqs.length} answered`,
      };
    }
    if (ph.command) return { ok: ph.command.exitCode === 0, ratio: ph.command.exitCode === 0 ? 1 : 0, detail: `${ph.detail} — runner exit ${ph.command.exitCode}` };
    return { ok: ph.reachedGoal, ratio: ph.reachedGoal ? 1 : 0, detail: ph.detail };
  };
  const phaseSuccess: Record<string, number> = {};
  for (const ph of run.phases) {
    const q = phaseQuality(ph);
    phaseSuccess[ph.name] = q.ratio;
    boundaries.push({ name: ph.name, endTs: ph.endTs, reachedGoal: q.ok, detail: q.detail });
  }

  const curve: PhaseCurvePoint[] = [];
  {
    let i = 0;
    let cumFiles = 0;
    let cumBytes = 0;
    let cumTp = 0;
    let cumD = 0;
    let missEvents = 0;
    const anyOrdered = [...firstAny.values()].filter((t) => {
      const f = byReal.get(t.real);
      return f !== undefined && !f.hotB;
    }).sort((a, b) => a.ts - b.ts);
    let j = 0;
    let cumAnyFiles = 0;
    let cumAnyBytes = 0;
    for (const b of boundaries) {
      while (i < misses.length && misses[i]!.ts <= b.endTs) {
        const m = misses[i]!;
        cumFiles++;
        cumBytes += m.bytes;
        if (m.thirdParty) cumTp += m.bytes;
        if (m.thirdParty && m.isJs) cumD += m.bytes;
        missEvents++;
        i++;
      }
      while (j < anyOrdered.length && anyOrdered[j]!.ts <= b.endTs) {
        const f = byReal.get(anyOrdered[j]!.real)!;
        cumAnyFiles++;
        cumAnyBytes += f.bytes;
        j++;
      }
      curve.push({
        phase: b.name,
        endTs: b.endTs,
        offsetMs: Math.round(b.endTs - run.t0),
        reachedGoal: b.reachedGoal,
        detail: b.detail,
        hydratedFiles: cumFiles,
        hydratedBytes: cumBytes,
        touchedAnyFiles: cumAnyFiles,
        touchedAnyBytes: cumAnyBytes,
        missEvents,
        resident: {
          universe: { hotBytes, residentBytes: hotBytes + cumBytes, totalBytes: uniBytes, residentFraction: uniBytes ? (hotBytes + cumBytes) / uniBytes : 0 },
          thirdParty: {
            hotBytes: tpBytes - coldTpBytes,
            residentBytes: tpBytes - coldTpBytes + cumTp,
            totalBytes: tpBytes,
            residentFraction: tpBytes ? (tpBytes - coldTpBytes + cumTp) / tpBytes : 0,
          },
          thirdPartyJs: {
            hotBytes: dBytes - coldTpJsBytes,
            residentBytes: dBytes - coldTpJsBytes + cumD,
            totalBytes: dBytes,
            residentFraction: dBytes ? (dBytes - coldTpJsBytes + cumD) / dBytes : 0,
          },
        },
      });
    }
  }

  // ---- timing windows, measured from the first observed touch of the run
  const t0Touch = touches.length > 0 ? touches[0]!.ts : run.t0;
  const timing = WINDOWS.map((w) => {
    let files = 0;
    let bytes = 0;
    for (const m of misses) {
      if (m.ts - t0Touch <= w) {
        files++;
        bytes += m.bytes;
      }
    }
    return { windowMs: w, files, bytes };
  });

  // ---- package rollup
  const pkgAgg = new Map<string, PkgRow>();
  for (const f of byReal.values()) {
    const dir = f.pkgDir || '(no package)';
    let row = pkgAgg.get(dir);
    if (!row) {
      const id = pkgs.get(dir);
      row = {
        dir,
        name: id?.name ?? '(none)',
        version: id?.version ?? '',
        thirdParty: f.thirdParty,
        files: 0,
        bytes: 0,
        hotFiles: 0,
        hotBytes: 0,
        coldFiles: 0,
        coldBytes: 0,
        hydratedFiles: 0,
        hydratedBytes: 0,
        stillColdBytes: 0,
        initialHotFraction: 0,
        finalResidentFraction: 0,
        klass: 'cold-stays-cold',
      };
      pkgAgg.set(dir, row);
    }
    row.files++;
    row.bytes += f.bytes;
    if (f.hotB) {
      row.hotFiles++;
      row.hotBytes += f.bytes;
    } else {
      row.coldFiles++;
      row.coldBytes += f.bytes;
    }
  }
  for (const m of misses) {
    const row = pkgAgg.get(m.pkgDir || '(no package)');
    if (row) {
      row.hydratedFiles++;
      row.hydratedBytes += m.bytes;
    }
  }
  for (const row of pkgAgg.values()) {
    row.stillColdBytes = row.coldBytes - row.hydratedBytes;
    row.initialHotFraction = row.bytes ? row.hotBytes / row.bytes : 0;
    row.finalResidentFraction = row.bytes ? (row.hotBytes + row.hydratedBytes) / row.bytes : 0;
    if (row.coldBytes === 0) row.klass = 'all-hot-initially';
    else if (row.hotBytes === 0 || row.initialHotFraction < 0.02) {
      row.klass = row.finalResidentFraction >= 0.5 ? 'cold-becomes-resident' : 'cold-stays-cold';
    } else if (row.finalResidentFraction >= 0.95) row.klass = 'mixed-becomes-hot';
    else row.klass = 'mixed-stays-mixed';
  }
  const byClass: Record<string, number> = {};
  for (const r of pkgAgg.values()) byClass[r.klass] = (byClass[r.klass] ?? 0) + 1;

  // ---- concentration of hydrated bytes across packages
  const pkgHydrated = [...pkgAgg.values()].filter((r) => r.hydratedBytes > 0).sort((a, b) => b.hydratedBytes - a.hydratedBytes);
  const totalHydrated = misses.reduce((s, m) => s + m.bytes, 0);
  const cover = (frac: number) => {
    let acc = 0;
    let n = 0;
    for (const r of pkgHydrated) {
      if (acc >= totalHydrated * frac) break;
      acc += r.hydratedBytes;
      n++;
    }
    return n;
  };

  // ---- outside the frozen universe
  //
  // "Generated" cannot be decided from writes observed during THIS run alone:
  // juice-shop builds i18n/*.json from data/static/i18n at first start, so a
  // second run reads files it did not create and they would look like a gap in
  // the universe model. The repository's own .gitignore is the authority on
  // what is build/runtime output, so ask git.
  const ignored = new Set<string>();
  if (outsideFiles.size > 0) {
    const rels = [...outsideFiles.keys()]
      .filter((p) => p.startsWith(meta.cloneRoot))
      .map((p) => p.slice(meta.cloneRoot.length + 1));
    const r = spawnSync('git', ['-C', meta.cloneRoot, 'check-ignore', '--stdin'], {
      input: rels.join('\n'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    for (const line of String(r.stdout ?? '').split('\n')) {
      if (line) ignored.add(path.join(meta.cloneRoot, line));
    }
  }

  let outBytes = 0;
  let outContentFiles = 0;
  let outContentBytes = 0;
  let outWritten = 0;
  // A file this run CREATED and then read is generated state, not a production
  // dependency the universe model missed. Collapsing the two would make the
  // out-of-universe number look like a model defect when it is mostly output.
  let outGeneratedContentBytes = 0;
  let outPreexistingContentBytes = 0;
  let outPreexistingContentFiles = 0;
  const outDirs = new Map<string, { files: number; bytes: number }>();
  for (const [real, o] of outsideFiles) {
    outBytes += o.bytes;
    if (o.content) {
      outContentFiles++;
      outContentBytes += o.bytes;
      if (o.written || ignored.has(real)) outGeneratedContentBytes += o.bytes;
      else {
        outPreexistingContentBytes += o.bytes;
        outPreexistingContentFiles++;
      }
    }
    if (o.written) outWritten++;
    const d = path.dirname(real).replace(meta.cloneRoot, '');
    const cur = outDirs.get(d) ?? { files: 0, bytes: 0 };
    cur.files++;
    cur.bytes += o.bytes;
    outDirs.set(d, cur);
  }

  // ---- persist the compact first-touch record
  const ftDir = path.join(runDir, 'first-touch');
  mkdirSync(ftDir, { recursive: true });
  const ftFile = path.join(ftDir, `${app}.ndjson`);
  const phaseOf = (ts: number): string => {
    for (const b of boundaries) if (ts <= b.endTs) return b.name;
    return 'after-workload';
  };
  const ftLines = misses.map((m, idx) =>
    JSON.stringify({
      app,
      rel: m.rel,
      real: m.real,
      bytes: m.bytes,
      order: idx,
      offsetMs: Math.round(m.ts - run.t0),
      ts: m.ts,
      phase: phaseOf(m.ts),
      op: m.op,
      pkg: pkgs.get(m.pkgDir)?.name ?? null,
      pkgVersion: pkgs.get(m.pkgDir)?.version ?? null,
      thirdParty: m.thirdParty,
      isJs: m.isJs,
      pid: m.pid,
      from: m.from,
    }),
  );
  const ftBody = ftLines.join('\n') + (ftLines.length ? '\n' : '');
  writeFileSync(ftFile, ftBody);

  const hotNeverFiles = hotFiles - hotTouched.size;
  let hotTouchedBytes = 0;
  for (const r of hotTouched) hotTouchedBytes += byReal.get(r)!.bytes;

  const out: AppAnalysis = {
    app,
    category: meta.category,
    sha: meta.sha,
    ok: run.ready.ok && touches.length > 0,
    failure: run.failure ?? (touches.length === 0 ? 'no touches observed' : null),
    workloadQuality: run.recipeQuality,
    phaseSuccessRatio: phaseSuccess,
    workloadNotes: run.recipeNotes,
    deviations: run.deviations,
    ready: run.ready,
    processes: [...procs.values()].sort((a, b) => b.touches - a.touches),
    spawnedNonNode: [...new Set(spawns)].slice(0, 40),
    untracedChildren: (() => {
      // The tracer travels in NODE_OPTIONS, so a child spawned with a REPLACED
      // env never loads it (NodeBB's minifier does exactly this:
      // `fork(__filename, [], {env:{minifier_child:true}})`). Re-injecting the
      // preload would mean mutating the application's spawn options, which this
      // experiment must not do — so instead the gap is measured: every spawn is
      // recorded, every traced process announces itself, and the difference is
      // published. A non-zero count is a bounded blind spot, not a silent one.
      const tracedChildren = [...procs.values()].filter((p) => !p.isWorker).length - 1;
      return { spawnEvents: spawns.length, tracedChildProcesses: Math.max(0, tracedChildren), untracedSpawns: Math.max(0, spawns.length - Math.max(0, tracedChildren)) };
    })(),
    universe: { files: byReal.size, bytes: uniBytes, thirdPartyBytes: tpBytes, D: dBytes },
    initial: {
      hotFiles,
      hotBytes,
      coldFiles,
      coldBytes,
      coldFraction: uniBytes ? coldBytes / uniBytes : 0,
      coldThirdPartyBytes: coldTpBytes,
      coldThirdPartyJsBytes: coldTpJsBytes,
    },
    totals: {
      tracedEvents: events,
      totalAccesses,
      // directories are not placeable files; counting them here would make
      // "unique files touched" 1.1% too large (the same trap as the
      // out-of-universe count)
      appTouchedFiles: firstAny.size - outsideDirs,
      appTouchedDirectories: outsideDirs,
      workloadTreeAccessEvents: workloadAccessEvents,
      excludedWorkloadTreeColdFiles: excludedColdFiles,
      excludedWorkloadTreeColdBytes: excludedColdBytes,
      missEvents: misses.length,
      uniqueMissFiles: misses.length,
      uniqueMissBytes: totalHydrated,
      uniqueMissThirdPartyBytes: misses.filter((m) => m.thirdParty).reduce((s, m) => s + m.bytes, 0),
      uniqueMissThirdPartyJsBytes: misses.filter((m) => m.thirdParty && m.isJs).reduce((s, m) => s + m.bytes, 0),
      metadataOnlyColdFiles: metaOnlyFiles,
      metadataOnlyColdBytes: metaOnlyBytes,
      hotNeverTouchedFiles: hotNeverFiles,
      hotNeverTouchedBytes: hotBytes - hotTouchedBytes,
      hotTouchedFiles: hotTouched.size,
      hotTouchedBytes,
    },
    survival: {
      initialColdBytes: coldBytes,
      hydratedBytes: totalHydrated,
      stillColdBytes: coldBytes - totalHydrated,
      hydratedFractionOfCold: coldBytes ? totalHydrated / coldBytes : 0,
      stillColdFractionOfCold: coldBytes ? (coldBytes - totalHydrated) / coldBytes : 0,
      upperBoundHydratedBytes: totalHydrated + metaOnlyBytes,
      upperBoundStillColdFractionOfCold: coldBytes ? (coldBytes - totalHydrated - metaOnlyBytes) / coldBytes : 0,
    },
    curve,
    timing,
    misses: {
      sizeBuckets: SIZE_BUCKETS.map(([label, lo, hi]) => {
        const sel = misses.filter((m) => m.bytes >= lo && m.bytes < hi);
        return { label, files: sel.length, bytes: sel.reduce((s, m) => s + m.bytes, 0) };
      }),
      topFiles: [...misses]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 25)
        .map((m) => ({ rel: m.rel, bytes: m.bytes, phase: phaseOf(m.ts), offsetMs: Math.round(m.ts - run.t0), op: m.op })),
      topPackages: pkgHydrated.slice(0, 25).map((r) => ({
        name: r.name,
        version: r.version,
        hydratedBytes: r.hydratedBytes,
        hydratedFiles: r.hydratedFiles,
        coldBytes: r.coldBytes,
      })),
      concentration: { p50: cover(0.5), p80: cover(0.8), p95: cover(0.95), totalPackagesHydrated: pkgHydrated.length },
    },
    packages: {
      total: pkgAgg.size,
      byClass,
      rows: [...pkgAgg.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 120),
    },
    outside: {
      files: outsideFiles.size,
      bytes: outBytes,
      contentFiles: outContentFiles,
      contentBytes: outContentBytes,
      writtenDuringRun: outWritten,
      generatedContentBytes: outGeneratedContentBytes,
      preexistingContentFiles: outPreexistingContentFiles,
      preexistingContentBytes: outPreexistingContentBytes,
      directoriesTouched: outsideDirs,
      topDirs: [...outDirs.entries()]
        .map(([dir, v]) => ({ dir, ...v }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 20),
      sample: [...outsideFiles.keys()].slice(0, 25).map((p) => p.replace(meta.cloneRoot, '')),
    },
    outsideCloneRoot: [...outsideCloneRoot.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 30),
    dirListings: {
      dirs: dirTouched.size,
      insidePackages: [...dirTouched.keys()].filter((d) => d.includes('/node_modules/')).length,
      sample: [...dirTouched.keys()].slice(0, 15).map((p) => p.replace(meta.cloneRoot, '')),
    },
    firstTouchFile: path.relative(path.join(import.meta.dirname), ftFile),
    firstTouchSha256: createHash('sha256').update(ftBody).digest('hex'),
  };

  // Enforced, not assumed: a double count anywhere upstream would otherwise
  // silently produce a too-small stillCold and a too-good headline.
  if (out.survival.hydratedBytes + out.survival.stillColdBytes !== out.initial.coldBytes) {
    throw new Error(
      `[${app}] survival identity broken: hydrated ${out.survival.hydratedBytes} + stillCold ${out.survival.stillColdBytes} != initial cold ${out.initial.coldBytes}`,
    );
  }
  if (out.totals.uniqueMissBytes > out.initial.coldBytes) {
    throw new Error(`[${app}] hydrated more cold bytes than exist (${out.totals.uniqueMissBytes} > ${out.initial.coldBytes})`);
  }
  writeFileSync(path.join(runDir, `${app}.json`), JSON.stringify(out, null, 2));
  const last = curve[curve.length - 1];
  console.log(
    `[${app}] q=${out.workloadQuality} coldB=${fmtPct(out.initial.coldFraction)} → resident ${fmtPct(last?.resident.universe.residentFraction ?? 0)} | ` +
      `misses ${out.totals.uniqueMissFiles} files / ${(out.totals.uniqueMissBytes / 1e6).toFixed(1)}MB | ` +
      `cold surviving ${fmtPct(out.survival.stillColdFractionOfCold)}`,
  );
  return out;
}

// CLI only when executed directly — the tests import `analyze` against a
// synthetic snapshot root.
if (import.meta.main) {
  const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean', default: false }, run: { type: 'string' } } });
  const runDir = values.run ?? path.join(import.meta.dirname, 'run-1', 'corpus');
  if (values.all) {
    const apps = readdirSync(runDir)
      .filter((f) => f.endsWith('.run.json'))
      .map((f) => f.replace('.run.json', ''));
    for (const a of apps) await analyze(a, runDir);
  } else if (values.app) {
    await analyze(values.app, runDir);
  } else {
    console.error('usage: bun benchmarks/hydration/analyze.ts --app <name> | --all');
    process.exit(1);
  }
}
