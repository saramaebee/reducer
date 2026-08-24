/**
 * Analysis for the cost-aware traffic-warm experiment.
 *
 * Reuses experiment 4's analysis primitives verbatim — `trialMetrics`,
 * `windows`, `correctness`, `pct`, and the FROZEN steady-state band — so that
 * `T_steady`, the rolling-window p99 and the correctness gate mean exactly what
 * they meant there. What is new is only what this experiment adds: decoding the
 * substrate's chunk residency bitmap, pricing sets in physical units, and the
 * equal-MEASURED-time curves.
 *
 * Usage:
 *   bun benchmarks/costaware/analyze.ts metrics --app <name>
 *   bun benchmarks/costaware/analyze.ts summary
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  correctness,
  loadBand,
  pct,
  trialMetrics,
  windows,
  type Band,
  type Ev,
  type Trial,
  type TrialMetrics,
} from '../longtail/analyze.ts';
import { loadPlan } from '../longtail/plan.ts';
import { workloadFor } from '../longtail/workloads.ts';
import { LONGTAIL_WORK, loadPhysicalMap, rangesOf, type PhysicalMap } from './physical.ts';
import { buildUnits } from './select.ts';
import { APPS, ARMS, RUNGS_MS, loadCostModel, loadRanking, type LadderEntry } from './run.ts';
import { truncate } from '../longtail/strategies.ts';

const RUN = path.join(import.meta.dirname, 'run-1');

const median = (xs: number[]): number => (xs.length ? pct(xs, 50) : NaN);
const agg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? { n: v.length, median: median(v), min: Math.min(...v), max: Math.max(...v) } : null;
};

function loadTrials(app: string, tag = 'trials'): Trial[] {
  const dir = path.join(RUN, tag, app);
  if (!existsSync(dir)) return [];
  const out: Trial[] = [];
  for (const name of readdirSync(dir)) {
    const tj = path.join(dir, name, 'trial.json');
    const ej = path.join(dir, name, 'events.jsonl');
    const ejz = `${ej}.gz`;
    if (!existsSync(tj) || (!existsSync(ej) && !existsSync(ejz))) continue;
    const t = JSON.parse(readFileSync(tj, 'utf8'));
    const raw = existsSync(ej) ? readFileSync(ej, 'utf8') : gunzipSync(readFileSync(ejz)).toString('utf8');
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev);
    out.push({ name, arm: t.arm, budget: t.budget, family: t.family, order: t.order, exit: t.exit, milestones: t.milestones, events });
  }
  return out.sort((a, b) => a.order - b.order);
}

// ─────────────────────────────────────────────── the substrate's own residency

/**
 * Decode nydus's blobcache chunk bitmap: a 4096-byte header followed by one bit
 * per chunk, LSB first within each byte, set when that chunk's bytes are local.
 *
 * This is the measurement that makes "resident at T_traffic" a fact rather than
 * a claim about a manifest. `bitmapHeaderCheck` asserts the file is exactly the
 * size the chunk count implies, so a format change cannot pass silently.
 */
const BITMAP_HEADER = 4096;

export function residentChunks(file: string, chunkCount: number): Set<number> | null {
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  const need = BITMAP_HEADER + Math.ceil(chunkCount / 8);
  if (buf.length < need) throw new Error(`chunk map ${file}: ${buf.length} B, expected >= ${need} for ${chunkCount} chunks`);
  const out = new Set<number>();
  for (let i = 0; i < chunkCount; i++) {
    if ((buf[BITMAP_HEADER + (i >> 3)]! >> (i & 7)) & 1) out.add(i);
  }
  return out;
}

export interface Residency {
  chunks: number;
  compressedBytes: number;
  files: number;
  fileBytes: number;
  /** of the files the TEST workload actually needs, how many were resident */
  neededCovered: number;
  neededMiss: number;
  neededMissBytes: number;
  /** resident and never needed by TRAIN or TEST */
  wasteFiles: number;
  wasteBytes: number;
}

function residency(
  set: Set<number>,
  m: PhysicalMap,
  size: Map<string, number>,
  needed: Set<string>,
  touchedEver: Set<string>,
): Residency {
  let compressedBytes = 0;
  for (const c of set) compressedBytes += m.size[c]!;
  let files = 0;
  let fileBytes = 0;
  let neededCovered = 0;
  let wasteFiles = 0;
  let wasteBytes = 0;
  const residentFiles = new Set<string>();
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length === 0) continue;
    let all = true;
    for (const c of cs) {
      if (!set.has(c)) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    residentFiles.add(rel);
    files++;
    const b = size.get(rel) ?? 0;
    fileBytes += b;
    if (needed.has(rel)) neededCovered++;
    if (!touchedEver.has(rel)) {
      wasteFiles++;
      wasteBytes += b;
    }
  }
  let neededMiss = 0;
  let neededMissBytes = 0;
  for (const rel of needed) {
    if (!residentFiles.has(rel)) {
      neededMiss++;
      neededMissBytes += size.get(rel) ?? 0;
    }
  }
  return { chunks: set.size, compressedBytes, files, fileBytes, neededCovered, neededMiss, neededMissBytes, wasteFiles, wasteBytes };
}

// ──────────────────────────────────────────────────────────────── per app

function declarations(app: string): Map<string, { stableBody: boolean; stableLength: boolean }> {
  const w = workloadFor(app, loadPlan(app));
  const out = new Map<string, { stableBody: boolean; stableLength: boolean }>();
  for (const r of [...w.prelude, ...w.common, ...w.longTail.flatMap((g) => g.requests)]) {
    out.set(r.id, { stableBody: r.stableBody !== false, stableLength: r.stableLength !== false });
  }
  return out;
}

export function analyzeApp(app: string, tag = 'trials'): unknown {
  const trials = loadTrials(app, tag);
  if (trials.length === 0) throw new Error(`[${app}] no trials in ${tag}`);
  const band: Band = loadBand(app);
  const plan = loadPlan(app);
  const size = new Map(plan.files);
  const m = loadPhysicalMap(app);
  const model = loadCostModel();
  const ladder = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.ladder.json`), 'utf8')) as LadderEntry[];
  const prep = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.json`), 'utf8'));

  const observe = JSON.parse(readFileSync(path.join(LONGTAIL_WORK, 'observe', app, 'test.json'), 'utf8')) as {
    neededUnion: [string, number][];
    byCategory: [string, string[]][];
  };
  const train = JSON.parse(readFileSync(path.join(LONGTAIL_WORK, 'observe', app, 'train.json'), 'utf8')) as {
    access: { rel: string; firstMs: number }[];
  };
  const needed = new Set(observe.neededUnion.map(([r]) => r));
  const touchedEver = new Set([...needed, ...train.access.map((t) => t.rel)]);

  const per = trials.map((t) => {
    const base = trialMetrics(t, band);
    const dir = path.join(RUN, tag, app, t.name);
    const admitSet = residentChunks(path.join(dir, 'chunkmap.at-admit.bin'), m.totals.chunks);
    const endSet = residentChunks(path.join(dir, 'chunkmap.after-pass-1.bin'), m.totals.chunks);
    const tj = JSON.parse(readFileSync(path.join(dir, 'trial.json'), 'utf8'));
    const fs = (label: string) =>
      t.events.find((e) => e.ev === 'fetch-state' && e.label === label) as
        | { remoteRequests: number | null; remoteBytes: number | null; prefetchBytes: number | null; prefetchRequests: number | null }
        | undefined;
    const admitState = fs('at-admit');
    const endState = fs('after-pass-1');
    // the deliverables ask for max post-admission p95 as well as p99; the same
    // rolling window (100 requests, step 20, nearest rank) with p = 95
    const p1 = t.events.filter((e) => e.ev === 'request' && (e as unknown as { pass: number }).pass === 1) as unknown as { ms: number }[];
    const winP = (p: number): number => {
      const xs: number[] = [];
      for (let i = 0; i + 100 <= p1.length; i += 20) xs.push(pct(p1.slice(i, i + 100).map((r) => r.ms), p));
      if (!xs.length && p1.length) xs.push(pct(p1.map((r) => r.ms), p));
      return xs.length ? Math.max(...xs) : NaN;
    };
    // ATTACK 7: proactive prefetch does not stop at the admission gate — nydus
    // has no abort — so the raw backend delta over pass 1 mixes demand faults
    // with residual prefetch. The blobcache counts prefetch requests separately,
    // so both are reported and never conflated. The demand figure is a lower
    // bound: one prefetch request can become several backend reads.
    const dPrefetchReq =
      admitState?.prefetchRequests != null && endState?.prefetchRequests != null
        ? endState.prefetchRequests - admitState.prefetchRequests
        : null;
    const dPrefetchBytes =
      admitState?.prefetchBytes != null && endState?.prefetchBytes != null
        ? endState.prefetchBytes - admitState.prefetchBytes
        : null;
    const dRemoteReq =
      admitState?.remoteRequests != null && endState?.remoteRequests != null
        ? endState.remoteRequests - admitState.remoteRequests
        : null;
    return {
      ...base,
      rungMs: base.budget,
      maxWindowP95: winP(95),
      param: tj.param ?? null,
      cutoff: tj.cutoff ?? null,
      residentAtAdmit: admitSet ? residency(admitSet, m, size, needed, touchedEver) : null,
      residentAfterPass1: endSet ? residency(endSet, m, size, needed, touchedEver) : null,
      /** proactive prefetch that arrived AFTER the admission gate */
      postAdmitPrefetchChunks: admitSet && endSet ? [...endSet].filter((c) => !admitSet.has(c)).length : null,
      postAdmissionPrefetchRequests: dPrefetchReq,
      postAdmissionPrefetchBytes: dPrefetchBytes,
      /** lower bound on genuine demand faults after admission */
      postAdmissionDemandRequests: dRemoteReq != null && dPrefetchReq != null ? Math.max(0, dRemoteReq - dPrefetchReq) : dRemoteReq,
      backendRequestsAtAdmit: admitState?.remoteRequests ?? null,
      backendBytesAtAdmit: admitState?.remoteBytes ?? null,
      prefetchRequestsAtAdmit: admitState?.prefetchRequests ?? null,
    };
  });

  const key = (x: (typeof per)[number]) => (x.rungMs === null ? x.arm : `${x.arm}@${x.rungMs}`);
  const groups = new Map<string, typeof per>();
  for (const x of per) {
    if (!groups.has(key(x))) groups.set(key(x), []);
    groups.get(key(x))!.push(x);
  }

  const byCell: Record<string, unknown> = {};
  for (const [k, xs] of groups) {
    const e = ladder.find((l) => `${l.arm}@${l.rungMs}` === k) ?? null;
    byCell[k] = {
      arm: xs[0]!.arm,
      rungMs: xs[0]!.rungMs,
      param: xs[0]!.param,
      trials: xs.length,
      plannedMeasuredMs: e?.measuredMs ?? null,
      plannedFiles: e?.files ?? null,
      cutoffReasons: [...new Set(xs.map((x) => x.cutoff))],
      tSteady: agg(xs.map((x) => x.tSteadyMs)),
      steadyReached: xs.filter((x) => x.steadyReached).length,
      tTraffic: agg(xs.map((x) => x.tTrafficMs)),
      tReady: agg(xs.map((x) => x.tReadyMs)),
      postAdmissionWarm: agg(xs.map((x) => (x.tSteadyMs != null && x.tTrafficMs != null ? x.tSteadyMs - x.tTrafficMs : null))),
      prewarmDuration: agg(xs.map((x) => x.prewarmDurationMs)),
      maxWindowP99: agg(xs.map((x) => x.maxWindowP99)),
      maxWindowP95: agg(xs.map((x) => x.maxWindowP95)),
      p95: agg(xs.map((x) => x.p95)),
      p99: agg(xs.map((x) => x.p99)),
      postAdmissionFaults: agg(xs.map((x) => x.postAdmissionRemoteRequests)),
      postAdmissionBytes: agg(xs.map((x) => x.postAdmissionRemoteBytes)),
      postAdmissionPrefetchRequests: agg(xs.map((x) => x.postAdmissionPrefetchRequests)),
      postAdmissionPrefetchBytes: agg(xs.map((x) => x.postAdmissionPrefetchBytes)),
      postAdmissionDemandRequests: agg(xs.map((x) => x.postAdmissionDemandRequests)),
      backendRequestsAtAdmit: agg(xs.map((x) => x.backendRequestsAtAdmit)),
      backendBytesAtAdmit: agg(xs.map((x) => x.backendBytesAtAdmit)),
      residentChunks: agg(xs.map((x) => x.residentAtAdmit?.chunks ?? null)),
      residentCompressedBytes: agg(xs.map((x) => x.residentAtAdmit?.compressedBytes ?? null)),
      residentFiles: agg(xs.map((x) => x.residentAtAdmit?.files ?? null)),
      residentFileBytes: agg(xs.map((x) => x.residentAtAdmit?.fileBytes ?? null)),
      neededCovered: agg(xs.map((x) => x.residentAtAdmit?.neededCovered ?? null)),
      neededMiss: agg(xs.map((x) => x.residentAtAdmit?.neededMiss ?? null)),
      wasteFiles: agg(xs.map((x) => x.residentAtAdmit?.wasteFiles ?? null)),
      wasteBytes: agg(xs.map((x) => x.residentAtAdmit?.wasteBytes ?? null)),
      postAdmitPrefetchChunks: agg(xs.map((x) => x.postAdmitPrefetchChunks)),
      firstHitByCategory: (() => {
        const out: Record<string, { position1: number[]; all: number[] }> = {};
        for (const x of xs) {
          for (const f of x.firstHit) {
            out[f.category] ??= { position1: [], all: [] };
            out[f.category]!.all.push(f.ms);
            if (f.position === 1) out[f.category]!.position1.push(f.ms);
          }
        }
        return Object.fromEntries(
          Object.entries(out).map(([c, v]) => [c, { position1: agg(v.position1), all: agg(v.all) }]),
        );
      })(),
    };
  }

  // ── eager-matched (experiment 4 amendment A4, reused verbatim)
  const e0 = per.filter((x) => x.arm === 'E0');
  const eagerWorst = e0.length ? Math.max(...e0.map((x) => x.maxWindowP99)) : NaN;

  // T_steady against a REACHABLE threshold. The preregistered band comes from
  // the eager arm's WARM pass, and experiment 4's amendment A4 already recorded
  // that no cold first pass can meet it — every cold pass carries an application
  // warm-up tail the warm pass does not contain. Measured again here: strapi's
  // band is 80 ms and the eager arm's own cold pass peaks at ~132 ms, so
  // `T_steady` is UNDEFINED in most trials and its median would be taken over a
  // self-selected subset. The same construction against the eager arm's own
  // worst cold window is defined almost everywhere and is what the equal-time
  // table reports; the preregistered figure is computed and printed beside it,
  // never replaced.
  for (const x of per) {
    const t = trials.find((tt) => tt.name === x.name)!;
    const p1 = t.events.filter((e) => e.ev === 'request' && (e as unknown as { pass: number }).pass === 1) as unknown as { ms: number; at: number }[];
    const wins: { p99: number; endAt: number }[] = [];
    for (let i = 0; i + 100 <= p1.length; i += 20) {
      const w = p1.slice(i, i + 100);
      wins.push({ p99: pct(w.map((r) => r.ms), 99), endAt: w.at(-1)!.at });
    }
    let idx = -1;
    for (let i = 0; i < wins.length; i++) {
      if (wins.slice(i).every((w) => w.p99 <= eagerWorst)) {
        idx = i;
        break;
      }
    }
    const t0 = t.milestones.t0 ?? 0;
    (x as { tSteadyEagerMs?: number | null }).tSteadyEagerMs = idx >= 0 && t0 ? wins[idx]!.endAt - t0 : null;
    (x as { steadyEagerReached?: boolean }).steadyEagerReached = idx >= 0;
  }
  // fold the reachable-threshold figures into the cells built above
  for (const [k, xs] of groups) {
    const c = byCell[k] as Record<string, unknown>;
    const ys = xs as unknown as { tSteadyEagerMs: number | null; steadyEagerReached: boolean; tTrafficMs: number | null }[];
    c.tSteadyEager = agg(ys.map((x) => x.tSteadyEagerMs));
    c.steadyEagerReached = ys.filter((x) => x.steadyEagerReached).length;
    c.postAdmissionWarmEager = agg(
      ys.map((x) => (x.tSteadyEagerMs != null && x.tTrafficMs != null ? x.tSteadyEagerMs - x.tTrafficMs : null)),
    );
  }
  const equalOutcome: Record<string, { rungMs: number | null; measuredMs: number | null }> = {};
  for (const a of ARMS) {
    let hit: { rungMs: number; measuredMs: number } | null = null;
    for (const rung of RUNGS_MS[app]!) {
      const c = byCell[`${a.name}@${rung}`] as { maxWindowP99: { median: number } | null; plannedMeasuredMs: number | null } | undefined;
      if (!c?.maxWindowP99) continue;
      if (c.maxWindowP99.median <= eagerWorst) {
        hit = { rungMs: rung, measuredMs: c.plannedMeasuredMs ?? rung };
        break;
      }
    }
    equalOutcome[a.name] = hit ?? { rungMs: null, measuredMs: null };
  }

  // ── cost-model accuracy on the deployed manifests
  const costAccuracy = ladder.map((l) => {
    const c = byCell[`${l.arm}@${l.rungMs}`] as { prewarmDuration: { median: number } | null } | undefined;
    const sel = prep.selections[`${l.arm}@${l.param}`] as { predictedMs: number } | undefined;
    return {
      arm: l.arm,
      rungMs: l.rungMs,
      param: l.param,
      predictedMs: sel?.predictedMs ?? null,
      probeMeasuredMs: l.measuredMs,
      inTrialPrewarmMs: c?.prewarmDuration?.median ?? null,
    };
  });

  // ── why experiment 4's R1 lost, in physical units
  const decomposition = decomposeExperiment4(app, m, model);

  // ── how much the two prediction sources actually still disagree once each is
  //    paying real retrieval costs. Computed from the frozen manifests alone —
  //    no trial, no latency, no timing — so it is the cleanest statement of the
  //    mechanism either way the headline falls.
  const selectionOverlap = overlap(app, m, ladder);

  // ── ATTACK 14: trial-order drift. If the machine got slower (or faster) as the
  //    grid ran, later cells would be biased. Pearson correlation between a
  //    trial's position in the executed order and its worst post-admission
  //    window p99, computed WITHIN each cell so the cell's own difficulty
  //    cannot masquerade as drift.
  const orderDrift = (() => {
    const rs: number[] = [];
    for (const xs of groups.values()) {
      if (xs.length < 3) continue;
      const o = xs.map((x) => x.order);
      const y = xs.map((x) => x.maxWindowP99);
      const mo = o.reduce((a, b) => a + b, 0) / o.length;
      const my = y.reduce((a, b) => a + b, 0) / y.length;
      let num = 0;
      let d1 = 0;
      let d2 = 0;
      for (let i = 0; i < o.length; i++) {
        num += (o[i]! - mo) * (y[i]! - my);
        d1 += (o[i]! - mo) ** 2;
        d2 += (y[i]! - my) ** 2;
      }
      if (d1 > 0 && d2 > 0) rs.push(num / Math.sqrt(d1 * d2));
    }
    return {
      cells: rs.length,
      meanPearson: rs.length ? Number((rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) ) : null,
      maxAbs: rs.length ? Number(Math.max(...rs.map(Math.abs)).toFixed(3)) : null,
    };
  })();

  return {
    app,
    universe: { files: plan.files.length, bytes: plan.universeBytes },
    physical: m.totals,
    costModel: model,
    band,
    rungs: RUNGS_MS[app],
    ladder,
    eagerWorstWindowP99: eagerWorst,
    byCell,
    equalOutcome,
    costAccuracy,
    decomposition,
    selectionOverlap,
    orderDrift,
    physicalOracle: prep.physicalOracle,
    heldOut: { needed: needed.size, byCategory: observe.byCategory.map(([c, f]) => [c, f.length]) },
    correctness: correctness(trials, declarations(app)),
    trials: per,
  };
}

/**
 * How much do the generic and the semantic prediction sources still disagree
 * about what to make resident, once each is paying real retrieval costs?
 *
 * Read off the frozen manifests: no trial, no latency, no timing is involved,
 * so this is the mechanism statement the headline cannot argue with. Reported
 * for the cost-aware pair (G1C vs R1C) and, as the control, for the cost-unaware
 * pair (G1 vs R1) at the same rung.
 */
function overlap(
  app: string,
  m: PhysicalMap,
  ladder: LadderEntry[],
): Record<string, Record<string, { unitJaccard: number; residentJaccard: number; onlyA: number; onlyB: number }>> {
  const byFile = new Map(m.fileChunks);
  const listDir = path.join('/Users/sara/.cache/reducer-costaware-v1', 'prefetch', app);
  const resident = (arm: string, rung: number): { chunks: Set<number>; files: Set<string> } | null => {
    const e = ladder.find((l) => l.arm === arm && l.rungMs === rung);
    if (!e) return null;
    const f = path.join(listDir, `${arm}.${e.param}.txt`);
    if (!existsSync(f)) return null;
    const chunks = new Set<number>();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      for (const c of byFile.get(line.slice(1)) ?? []) chunks.add(c);
    }
    const files = new Set<string>();
    for (const [rel, cs] of m.fileChunks) {
      if (cs.length === 0) continue;
      let all = true;
      for (const c of cs) {
        if (!chunks.has(c)) {
          all = false;
          break;
        }
      }
      if (all) files.add(rel);
    }
    return { chunks, files };
  };
  const jac = <T>(a: Set<T>, b: Set<T>): number => {
    let i = 0;
    for (const v of a) if (b.has(v)) i++;
    const u = a.size + b.size - i;
    return u ? Number((i / u).toFixed(4)) : 1;
  };
  const out: Record<string, Record<string, { unitJaccard: number; residentJaccard: number; onlyA: number; onlyB: number }>> = {};
  for (const rung of RUNGS_MS[app] ?? []) {
    out[rung] = {};
    for (const [A, B] of [
      ['G1C', 'R1C'],
      ['G1', 'R1'],
    ] as const) {
      const a = resident(A, rung);
      const b = resident(B, rung);
      if (!a || !b) continue;
      let onlyA = 0;
      for (const f of a.files) if (!b.files.has(f)) onlyA++;
      let onlyB = 0;
      for (const f of b.files) if (!a.files.has(f)) onlyB++;
      out[rung]![`${A}-vs-${B}`] = {
        unitJaccard: jac(a.chunks, b.chunks),
        residentJaccard: jac(a.files, b.files),
        onlyA,
        onlyB,
      };
    }
  }
  return out;
}

/**
 * Re-price experiment 4's own manifests in this experiment's physical units.
 *
 * Experiment 4 reported that R1 "prefetches many small scattered files"; this
 * turns that sentence into numbers — unique chunks, backend requests, backend
 * bytes and predicted duration — for the exact frozen rankings and the exact
 * byte budgets it ran, so the mechanism it blamed can be checked rather than
 * believed.
 */
export function decomposeExperiment4(app: string, m: PhysicalMap, model: ReturnType<typeof loadCostModel>): unknown[] {
  const plan = loadPlan(app);
  const byFile = new Map(m.fileChunks);
  const units = buildUnits(m, model.maxRange, model.maxURange);
  const out: unknown[] = [];
  for (const arm of ['G1', 'G2', 'R1', 'R2']) {
    let ranking;
    try {
      ranking = loadRanking(app, arm);
    } catch {
      continue;
    }
    for (const b of [0.05, 0.1, 0.2, 0.4]) {
      const t = truncate(ranking, plan, b);
      const chunks = new Set<number>();
      const us = new Set<number>();
      for (const rel of t.files) {
        for (const c of byFile.get(rel) ?? []) {
          chunks.add(c);
          us.add(units.unitOf[c]!);
        }
      }
      const r = rangesOf(chunks, m, model.gapBridge, model.maxRange, model.maxURange);
      let unitBytes = 0;
      for (const u of us) unitBytes += units.bytes[u]!;
      out.push({
        experiment: 4,
        arm,
        byteBudget: b,
        files: t.files.length,
        fileBytes: t.bytes,
        uniqueChunks: chunks.size,
        chunkCompressedBytes: r.chunkBytes,
        backendRequests: r.requests,
        backendBytes: r.bytes,
        predictedMs: Math.round(model.fixedMs + model.perRequestMs * r.requests + model.perByteMs * r.bytes),
        /** how much of the blob those files are smeared across */
        unitsTouched: us.size,
        unitBytes,
        /** the smear ratio: bytes that must move per byte actually wanted */
        overfetchRatio: r.chunkBytes ? Number((r.bytes / r.chunkBytes).toFixed(2)) : null,
      });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────── main

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { app: { type: 'string' }, all: { type: 'boolean' }, tag: { type: 'string' } },
  });
  const cmd = positionals[0];
  const apps = values.all ? APPS : [values.app!];
  const tag = values.tag ?? 'trials';
  if (cmd === 'metrics') {
    for (const app of apps) {
      const r = analyzeApp(app, tag);
      writeFileSync(path.join(RUN, `${app}${tag === 'trials' ? '' : `.${tag}`}.metrics.json`), JSON.stringify(r, null, 1));
      console.log(`[${app}] metrics written`);
    }
  } else if (cmd === 'summary') {
    const { summarize } = await import('./summary.ts');
    writeFileSync(path.join(RUN, 'SUMMARY.md'), summarize(apps));
    console.log('SUMMARY.md written');
  } else throw new Error(`unknown command '${cmd}' (metrics | summary)`);
  void windows;
}
