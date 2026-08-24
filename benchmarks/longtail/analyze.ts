/**
 * Analysis for the long-tail traffic-warm experiment.
 *
 * Implements the formulas frozen in DESIGN.md §8–§9 and nothing else. Every
 * constant it uses is either preregistered here in code (window size, step,
 * budgets) or derived from the E0 arm alone (the steady-state BAND), which is
 * why `band` is computed and printed as its own step: it must be fixed from the
 * eager reference before any strategy trial is interpreted.
 *
 * Usage:
 *   bun benchmarks/longtail/analyze.ts band    --app <name>   # E0 only
 *   bun benchmarks/longtail/analyze.ts metrics --app <name>
 *   bun benchmarks/longtail/analyze.ts summary
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { APPS, WORK_ROOT } from './apps.ts';
import { loadPlan } from './plan.ts';
import { g1, g2, truncate, type Ranking, type TrainAccess } from './strategies.ts';
import { BUDGETS, REFERENCE_BUDGET, STRATEGIES } from './run.ts';
import { CATEGORIES } from './workloads.ts';

const RUN = path.join(import.meta.dirname, 'run-1');

/** Preregistered rolling-window parameters (DESIGN.md §8.3). */
export const WINDOW = 100;
export const STEP = 20;

// ───────────────────────────────────────────────────────────────── helpers

/** Nearest-rank percentile — no interpolation, so a window's p99 is a real sample. */
export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i]!;
}
const median = (xs: number[]): number => (xs.length ? pct(xs, 50) : NaN);
function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export interface Ev {
  ev: string;
  at: number;
  [k: string]: unknown;
}

export interface Trial {
  name: string;
  arm: string;
  budget: number | null;
  family: number;
  order: number;
  exit: number;
  milestones: Record<string, number>;
  events: Ev[];
}

function loadTrials(app: string): Trial[] {
  const dir = path.join(RUN, 'trials', app);
  if (!existsSync(dir)) return [];
  const out: Trial[] = [];
  for (const name of readdirSync(dir)) {
    const tj = path.join(dir, name, 'trial.json');
    const ej = path.join(dir, name, 'events.jsonl');
    if (!existsSync(tj) || !existsSync(ej)) continue;
    const t = JSON.parse(readFileSync(tj, 'utf8'));
    const events = readFileSync(ej, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Ev);
    out.push({ name, arm: t.arm, budget: t.budget, family: t.family, order: t.order, exit: t.exit, milestones: t.milestones, events });
  }
  return out.sort((a, b) => a.order - b.order);
}

interface ReqEv {
  pass: number;
  index: number;
  id: string;
  kind: string;
  group: string | null;
  category: string | null;
  occurrence: number | null;
  position: number | null;
  status: number | string;
  ok: boolean | null;
  stableBody: boolean;
  bodyHash: string | null;
  headerValue: string | null;
  ms: number;
  startedAt: number;
  at: number;
}

const reqs = (t: Trial, pass: number): ReqEv[] => t.events.filter((e) => e.ev === 'request' && e.pass === pass) as unknown as ReqEv[];
const evAt = (t: Trial, ev: string): number | null => t.events.find((e) => e.ev === ev)?.at ?? null;
const fetchState = (t: Trial, label: string) =>
  (t.events.find((e) => e.ev === 'fetch-state' && e.label === label) ?? null) as
    | { remoteRequests: number | null; remoteBytes: number | null; prefetchBytes: number | null }
    | null;

/** Rolling windows of `WINDOW` requests stepped by `STEP`; p99 and end time each. */
export function windows(rs: ReqEv[]): { p99: number; endAt: number; startIdx: number }[] {
  const out: { p99: number; endAt: number; startIdx: number }[] = [];
  for (let i = 0; i + WINDOW <= rs.length; i += STEP) {
    const w = rs.slice(i, i + WINDOW);
    out.push({ p99: pct(w.map((r) => r.ms), 99), endAt: w.at(-1)!.at, startIdx: i });
  }
  // a stream shorter than one window still yields one window, so short apps are
  // measured rather than silently dropped
  if (out.length === 0 && rs.length > 0) out.push({ p99: pct(rs.map((r) => r.ms), 99), endAt: rs.at(-1)!.at, startIdx: 0 });
  return out;
}

// ────────────────────────────────────────────────────────────── the band

export interface Band {
  app: string;
  n: number;
  warmWindowP99s: number[];
  primary: number;
  sensitivity: number;
  warmMedian: number;
}

/**
 * The steady-state band, derived from the EAGER arm's warm pass only.
 * DESIGN.md §8.3: primary = the worst window a fully-warm eager pod actually
 * produced; sensitivity = median + 3·MAD of the same distribution.
 */
export function computeBand(app: string, trials: Trial[]): Band {
  const e0 = trials.filter((t) => t.arm === 'E0' && t.exit === 0);
  const all: number[] = [];
  for (const t of e0) for (const w of windows(reqs(t, 2))) all.push(w.p99);
  return {
    app,
    n: e0.length,
    warmWindowP99s: all,
    primary: all.length ? Math.max(...all) : NaN,
    sensitivity: all.length ? median(all) + 3 * mad(all) : NaN,
    warmMedian: median(all),
  };
}

const bandPath = (app: string): string => path.join(RUN, 'band', `${app}.json`);

export function loadBand(app: string): Band {
  const p = bandPath(app);
  if (!existsSync(p)) throw new Error(`[${app}] no frozen band — run: bun benchmarks/longtail/analyze.ts band --app ${app}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ───────────────────────────────────────────────────────────── per trial

export interface TrialMetrics {
  name: string;
  arm: string;
  budget: number | null;
  family: number;
  order: number;
  exit: number;
  /** milestones relative to T0 */
  tProcMs: number | null;
  tMountMs: number | null;
  tReadyMs: number | null;
  tPrewarmMs: number | null;
  tTrafficMs: number | null;
  prewarmDurationMs: number | null;
  /** T_steady − T0; null when steady state was not reached within the stream */
  tSteadyMs: number | null;
  steadyReached: boolean;
  /** warm on arrival: every pass-1 window already inside the band */
  trafficWarm: boolean;
  maxWindowP99: number;
  p99Regression: number;
  p50: number;
  p95: number;
  p99: number;
  warmP50: number;
  warmP99: number;
  postAdmissionRemoteRequests: number | null;
  postAdmissionRemoteBytes: number | null;
  prewarmChunkBytes: number | null;
  firstHit: { group: string; category: string; position: number; ms: number; warmMs: number | null }[];
  failedRequests: number;
}

export function trialMetrics(t: Trial, band: Band): TrialMetrics {
  const m = t.milestones;
  const t0 = m.t0 ?? 0;
  const p1 = reqs(t, 1);
  const p2 = reqs(t, 2);
  const wins = windows(p1);
  const admit = evAt(t, 'admit');
  const rel = (v: number | null | undefined) => (v == null || !t0 ? null : v - t0);

  // T_steady: earliest window after which EVERY window stays inside the band
  let steadyIdx = -1;
  for (let i = 0; i < wins.length; i++) {
    if (wins.slice(i).every((w) => w.p99 <= band.primary)) {
      steadyIdx = i;
      break;
    }
  }
  const at = fetchState(t, 'at-admit');
  const after = fetchState(t, 'after-pass-1');

  const warmById = new Map(p2.map((r) => [`${r.index}`, r.ms]));
  const firstHit = p1
    .filter((r) => r.kind === 'longtail' && r.occurrence === 1 && r.position && r.position > 0)
    .reduce<TrialMetrics['firstHit']>((acc, r) => {
      if (acc.some((x) => x.group === r.group)) return acc; // the group's FIRST request
      acc.push({ group: r.group!, category: r.category!, position: r.position!, ms: r.ms, warmMs: warmById.get(`${r.index}`) ?? null });
      return acc;
    }, []);

  return {
    name: t.name,
    arm: t.arm,
    budget: t.budget,
    family: t.family,
    order: t.order,
    exit: t.exit,
    tProcMs: rel(m.proc),
    tMountMs: rel(m.mount),
    tReadyMs: rel(evAt(t, 'ready')),
    tPrewarmMs: rel(m.prewarm),
    tTrafficMs: rel(admit),
    prewarmDurationMs: m.prewarm && m.mount ? m.prewarm - m.mount : null,
    tSteadyMs: steadyIdx >= 0 ? wins[steadyIdx]!.endAt - t0 : null,
    steadyReached: steadyIdx >= 0,
    trafficWarm: steadyIdx === 0,
    maxWindowP99: wins.length ? Math.max(...wins.map((w) => w.p99)) : NaN,
    p99Regression: (wins.length ? Math.max(...wins.map((w) => w.p99)) : NaN) - band.warmMedian,
    p50: pct(p1.map((r) => r.ms), 50),
    p95: pct(p1.map((r) => r.ms), 95),
    p99: pct(p1.map((r) => r.ms), 99),
    warmP50: pct(p2.map((r) => r.ms), 50),
    warmP99: pct(p2.map((r) => r.ms), 99),
    postAdmissionRemoteRequests: at?.remoteRequests != null && after?.remoteRequests != null ? after.remoteRequests - at.remoteRequests : null,
    postAdmissionRemoteBytes: at?.remoteBytes != null && after?.remoteBytes != null ? after.remoteBytes - at.remoteBytes : null,
    prewarmChunkBytes: at?.prefetchBytes ?? null,
    firstHit,
    failedRequests: p1.filter((r) => r.ok === false).length,
  };
}

// ──────────────────────────────────────────────────────────── correctness

export interface CorrectnessResult {
  comparedTrials: number;
  statusMismatches: { trial: string; index: number; id: string; expected: number | string; got: number | string }[];
  bodyMismatches: { trial: string; index: number; id: string }[];
  headerMismatches: { trial: string; index: number; id: string }[];
  unexpectedStatus: { trial: string; id: string; status: number | string; expect: number[] }[];
}

/** Every arm must match the E0 trial of the SAME family, request for request. */
export function correctness(trials: Trial[]): CorrectnessResult {
  const res: CorrectnessResult = { comparedTrials: 0, statusMismatches: [], bodyMismatches: [], headerMismatches: [], unexpectedStatus: [] };
  const baseline = new Map<number, ReqEv[]>();
  for (const t of trials) if (t.arm === 'E0' && t.exit === 0) baseline.set(t.family, reqs(t, 1));
  for (const t of trials) {
    for (const r of reqs(t, 1)) {
      if (r.ok === false) res.unexpectedStatus.push({ trial: t.name, id: r.id, status: r.status, expect: (r as unknown as { expect: number[] }).expect });
    }
    if (t.arm === 'E0') continue;
    const base = baseline.get(t.family);
    if (!base) continue;
    res.comparedTrials++;
    const mine = reqs(t, 1);
    for (let i = 0; i < Math.min(base.length, mine.length); i++) {
      const a = base[i]!;
      const b = mine[i]!;
      if (a.status !== b.status) res.statusMismatches.push({ trial: t.name, index: i, id: b.id, expected: a.status, got: b.status });
      if (a.stableBody && b.stableBody && a.bodyHash !== b.bodyHash) res.bodyMismatches.push({ trial: t.name, index: i, id: b.id });
      if (a.headerValue != null && a.headerValue !== b.headerValue) res.headerMismatches.push({ trial: t.name, index: i, id: b.id });
    }
  }
  return res;
}

// ──────────────────────────────────────────────── analytic coverage model

interface Prep {
  app: string;
  universe: { files: number; bytes: number };
  heldOut: { files: number; bytes: number };
  heldOutByCategory: Record<string, { files: number; bytes: number }>;
  budgeted: Record<string, { arm: string; budget: number; files: number; bytes: number; stoppedInTier: string; coveredNeededFiles: number; coveredNeededBytes: number; missNeededFiles: number; missNeededBytes: number; listPath: string }>;
}

/**
 * Per-category coverage at a budget: which of the category's held-out files the
 * ranked set already contains. Computed from set membership, so it is exact and
 * cannot be contaminated by execution order (DESIGN.md §8.2).
 */
export function coverage(app: string): Record<string, Record<string, { needFiles: number; needBytes: number; coveredFiles: number; coveredBytes: number; missFiles: number; missBytes: number }>> {
  const plan = loadPlan(app);
  const size = new Map(plan.files);
  const test = JSON.parse(readFileSync(path.join(WORK_ROOT, 'observe', app, 'test.json'), 'utf8')) as {
    byCategory: [string, string[]][];
  };
  const out: Record<string, Record<string, { needFiles: number; needBytes: number; coveredFiles: number; coveredBytes: number; missFiles: number; missBytes: number }>> = {};
  for (const arm of [...STRATEGIES, 'O']) {
    for (const b of BUDGETS) {
      const listPath = path.join(WORK_ROOT, 'prefetch', app, `${arm}.${b}.txt`);
      if (!existsSync(listPath)) continue;
      const chosen = new Set(
        readFileSync(listPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => l.slice(1)),
      );
      const key = `${arm}@${b}`;
      out[key] = {};
      for (const [cat, files] of test.byCategory) {
        const need = files;
        const cov = need.filter((f) => chosen.has(f));
        const miss = need.filter((f) => !chosen.has(f));
        const bytes = (xs: string[]) => xs.reduce((a, f) => a + (size.get(f) ?? 0), 0);
        out[key]![cat] = { needFiles: need.length, needBytes: bytes(need), coveredFiles: cov.length, coveredBytes: bytes(cov), missFiles: miss.length, missBytes: bytes(miss) };
      }
    }
  }
  return out;
}

/**
 * §9.3 training-matrix sensitivity, computed analytically: re-rank the GENERIC
 * strategies against a TRAIN augmented with one long-tail category's observed
 * first-touches, and report how much held-out coverage that buys. No extra
 * trials, and no semantic information enters the augmented generic ranking.
 */
export function trainingMatrix(app: string): Record<string, Record<string, { coveredNeededFiles: number; coveredNeededBytes: number }>> {
  const plan = loadPlan(app);
  const size = new Map(plan.files);
  const train = JSON.parse(readFileSync(path.join(WORK_ROOT, 'observe', app, 'train.json'), 'utf8')) as { access: TrainAccess[] };
  const test = JSON.parse(readFileSync(path.join(WORK_ROOT, 'observe', app, 'test.json'), 'utf8')) as {
    neededUnion: [string, number][];
    byCategory: [string, string[]][];
  };
  const needed = new Map(test.neededUnion);
  const baseMax = Math.max(0, ...train.access.map((t) => t.firstMs));
  const out: Record<string, Record<string, { coveredNeededFiles: number; coveredNeededBytes: number }>> = {};

  const cats = test.byCategory.map(([c]) => c).sort();
  const variants: { name: string; extra: string[] }[] = [{ name: 'TRAIN-1(common only)', extra: [] }];
  const byCat = new Map(test.byCategory);
  for (let k = 1; k <= cats.length; k++) {
    const chosen = cats.slice(0, k);
    variants.push({ name: `TRAIN-${k + 1}(+${chosen.join('+')})`, extra: chosen.flatMap((c) => byCat.get(c) ?? []) });
  }

  for (const v of variants) {
    const aug: TrainAccess[] = [
      ...train.access,
      ...[...new Set(v.extra)].map((rel, i) => ({ rel, firstMs: baseMax + 1 + i })),
    ];
    const seen = new Set<string>();
    const dedup = aug.filter((t) => (seen.has(t.rel) ? false : (seen.add(t.rel), true)));
    for (const [arm, rank] of [['G1', g1(plan, dedup)], ['G2', g2(plan, dedup)]] as [string, Ranking][]) {
      for (const b of BUDGETS) {
        const t = truncate(rank, plan, b);
        const chosen = new Set(t.files);
        const cov = [...needed.keys()].filter((f) => chosen.has(f));
        const key = `${arm}@${b}`;
        out[key] ??= {};
        out[key]![v.name] = { coveredNeededFiles: cov.length, coveredNeededBytes: cov.reduce((a, f) => a + (size.get(f) ?? 0), 0) };
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────── per app

export function analyzeApp(app: string): unknown {
  const trials = loadTrials(app);
  if (trials.length === 0) throw new Error(`[${app}] no trials`);
  const band = loadBand(app);
  const prep = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.json`), 'utf8')) as Prep;
  const per = trials.map((t) => trialMetrics(t, band));

  const key = (m: TrialMetrics) => (m.budget === null ? m.arm : `${m.arm}@${m.budget}`);
  const groups = new Map<string, TrialMetrics[]>();
  for (const m of per) {
    if (m.exit !== 0) continue;
    const k = key(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(m);
  }
  const agg = (ms: TrialMetrics[], f: (m: TrialMetrics) => number | null) => {
    const xs = ms.map(f).filter((x): x is number => x != null && Number.isFinite(x));
    return xs.length ? { median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length } : null;
  };

  const byCell: Record<string, unknown> = {};
  for (const [k, ms] of groups) {
    const b = prep.budgeted[k];
    byCell[k] = {
      n: ms.length,
      arm: ms[0]!.arm,
      budget: ms[0]!.budget,
      prewarmFileBytes: b?.bytes ?? null,
      prewarmFiles: b?.files ?? null,
      stoppedInTier: b?.stoppedInTier ?? null,
      timeToTrafficWarmMs: agg(ms, (m) => m.tSteadyMs),
      steadyReachedTrials: ms.filter((m) => m.steadyReached).length,
      trafficWarmTrials: ms.filter((m) => m.trafficWarm).length,
      maxWindowP99: agg(ms, (m) => m.maxWindowP99),
      p99Regression: agg(ms, (m) => m.p99Regression),
      postAdmissionRemoteRequests: agg(ms, (m) => m.postAdmissionRemoteRequests),
      postAdmissionRemoteBytes: agg(ms, (m) => m.postAdmissionRemoteBytes),
      prewarmDurationMs: agg(ms, (m) => m.prewarmDurationMs),
      prewarmChunkBytes: agg(ms, (m) => m.prewarmChunkBytes),
      tReadyMs: agg(ms, (m) => m.tReadyMs),
      tTrafficMs: agg(ms, (m) => m.tTrafficMs),
      p50: agg(ms, (m) => m.p50),
      p95: agg(ms, (m) => m.p95),
      p99: agg(ms, (m) => m.p99),
      warmP99: agg(ms, (m) => m.warmP99),
      analyticMissNeededFiles: b?.missNeededFiles ?? null,
      analyticMissNeededBytes: b?.missNeededBytes ?? null,
      failedRequests: ms.reduce((a, m) => a + m.failedRequests, 0),
    };
  }

  // first-hit latency by category, restricted to arrival position 1 (the only
  // contamination-free measurement) and reported with the contaminated rest
  const firstHit: Record<string, Record<string, { pos1: number[]; any: number[] }>> = {};
  for (const m of per) {
    if (m.exit !== 0) continue;
    const k = key(m);
    firstHit[k] ??= {};
    for (const h of m.firstHit) {
      firstHit[k]![h.category] ??= { pos1: [], any: [] };
      if (h.position === 1) firstHit[k]![h.category]!.pos1.push(h.ms);
      firstHit[k]![h.category]!.any.push(h.ms);
    }
  }

  // equal-outcome: the smallest tested budget at which every family is warm on
  // arrival, reported as a bracket because the sweep is discrete
  const equalOutcome: Record<string, { warmAt: number | null; bracket: [number | null, number | null] }> = {};
  for (const arm of STRATEGIES) {
    let warmAt: number | null = null;
    let below: number | null = null;
    for (const b of BUDGETS) {
      const cell = byCell[`${arm}@${b}`] as { n: number; trafficWarmTrials: number } | undefined;
      if (!cell) continue;
      if (cell.trafficWarmTrials === cell.n && cell.n > 0) {
        warmAt = b;
        break;
      }
      below = b;
    }
    equalOutcome[arm] = { warmAt, bracket: [below, warmAt] };
  }

  return {
    app,
    kind: APPS.find((a) => a.name === app)!.kind,
    universe: prep.universe,
    heldOut: prep.heldOut,
    heldOutByCategory: prep.heldOutByCategory,
    band,
    window: { size: WINDOW, step: STEP },
    referenceBudget: REFERENCE_BUDGET,
    byCell,
    firstHitByCategory: firstHit,
    equalOutcome,
    coverage: coverage(app),
    trainingMatrix: trainingMatrix(app),
    correctness: correctness(trials),
    trials: per,
  };
}

// ───────────────────────────────────────────────────────────────── main

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { app: { type: 'string' }, all: { type: 'boolean' } } });
  const cmd = positionals[0];
  const apps = values.all ? APPS.map((a) => a.name) : [values.app!];
  if (cmd === 'band') {
    mkdirSync(path.join(RUN, 'band'), { recursive: true });
    for (const app of apps) {
      const b = computeBand(app, loadTrials(app));
      writeFileSync(bandPath(app), JSON.stringify(b, null, 1));
      console.log(
        `[${app}] band from ${b.n} E0 trials, ${b.warmWindowP99s.length} warm windows: ` +
          `primary=${b.primary}ms sensitivity=${b.sensitivity.toFixed(1)}ms warmMedian=${b.warmMedian}ms`,
      );
    }
  } else if (cmd === 'metrics') {
    for (const app of apps) {
      const r = analyzeApp(app);
      writeFileSync(path.join(RUN, `${app}.metrics.json`), JSON.stringify(r, null, 1));
      const c = (r as { correctness: CorrectnessResult }).correctness;
      console.log(
        `[${app}] metrics written | correctness: ${c.comparedTrials} trials compared, ` +
          `${c.statusMismatches.length} status / ${c.bodyMismatches.length} body / ${c.headerMismatches.length} header mismatches, ` +
          `${c.unexpectedStatus.length} unexpected statuses`,
      );
    }
  } else {
    throw new Error(`unknown command '${cmd}' (band | metrics)`);
  }
  void CATEGORIES;
}
