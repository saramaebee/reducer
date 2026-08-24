/**
 * Metrics for ADR-0007 experiment 3, computed exactly as DESIGN.md §8 fixed
 * them before any trial ran.
 *
 * Two byte currencies are kept apart on purpose and never added together:
 *   FILE bytes    — whole-file placement (the ADR-0007 model): precision,
 *                   recall, waste, prefetch size.
 *   CHUNK bytes   — what the substrate actually moved over the network:
 *                   backend read_amount_total, remote request counts.
 *
 * Usage: bun benchmarks/lazy-oci/analyze.ts --app <name> | --all
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { APPS } from './apps.ts';
import { WORK_ROOT, type AppPlan } from './plan.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const PREP = path.join(WORK_ROOT, 'prep');

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const jsonl = (p: string): any[] =>
  existsSync(p)
    ? readFileSync(p, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

const pct = (n: number, d: number): number => (d > 0 ? n / d : 0);
const median = (xs: number[]): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
};

export interface TrialMetrics {
  arm: string;
  rep: number;
  order: number;
  ok: boolean;
  failure?: string;
  /** milliseconds from t0 */
  tProc: number;
  tReady: number;
  tReq1: number;
  tWorkloadEnd: number;
  /** substrate cost */
  remoteRequests: number;
  remoteBytes: number;
  remoteLatencyMs: number;
  prefetchBytes: number;
  prefetchRequests: number;
  fsBytesRead: number;
  /** cumulative substrate state at each milestone */
  atProc: { req: number; bytes: number };
  atReady: { req: number; bytes: number };
  atReq1: { req: number; bytes: number };
  /** whole-file placement accounting */
  neededFiles: number;
  neededBytes: number;
  prefetchedFiles: number;
  prefetchedFileBytes: number;
  hitFiles: number;
  hitBytes: number;
  precision: number;
  recall: number;
  wasteBytes: number;
  unexpectedMissFiles: number;
  unexpectedMissBytes: number;
  faultAmplification: number;
  remoteOpsPerMB: number;
  /** per-request latency over the held-out workload */
  reqLatency: { n: number; p50: number; p95: number; p99: number; first: number };
  /** cumulative fetch curve: [ms from t0, remote requests, remote bytes] */
  curve: [number, number, number][];
  requests: { path: string; method: string; phase: string; status: number | string; ms: number; bodyHash: string | null }[];
}

function analyzeTrial(
  dir: string,
  arm: string,
  rep: number,
  order: number,
  needed: Set<string>,
  sizeOf: Map<string, number>,
  prefetchSet: Set<string>,
): TrialMetrics {
  const ms = (o: Record<string, number>, k: string) => o[k] ?? Number.NaN;
  const milestones: Record<string, number> = {};
  const runnerLog = existsSync(path.join(dir, 'runner.log')) ? readFileSync(path.join(dir, 'runner.log'), 'utf8') : '';
  for (const m of runnerLog.matchAll(/^#M (\S+) (\d+)/gm)) milestones[m[1]!] = Number(m[2]);
  const t0 = ms(milestones, 't0');

  const events = jsonl(path.join(dir, 'events.jsonl'));
  const samples = jsonl(path.join(dir, 'samples.jsonl'));
  const readyEv = events.find((e) => e.ev === 'ready');
  const reqs = events.filter((e) => e.ev === 'request');
  const ok = !!readyEv?.ok && events.some((e) => e.ev === 'workload-done');

  const tReady = readyEv ? readyEv.at - t0 : Number.NaN;
  const tProc = ms(milestones, 'proc') - t0;
  const firstOk = reqs.find((r) => typeof r.status === 'number' && r.status < 500);
  const tReq1 = firstOk ? firstOk.at - t0 : Number.NaN;
  const tEnd = ms(milestones, 'workload-done') - t0;

  const at = (absMs: number) => {
    let last = { req: 0, bytes: 0 };
    for (const s of samples) {
      if (s.at > absMs) break;
      last = { req: s.rq ?? last.req, bytes: s.rb ?? last.bytes };
    }
    return last;
  };

  const be = existsSync(path.join(dir, 'final.metrics.backend.json'))
    ? readJson<any>(path.join(dir, 'final.metrics.backend.json'))
    : {};
  const bc = existsSync(path.join(dir, 'final.metrics.blobcache.json'))
    ? readJson<any>(path.join(dir, 'final.metrics.blobcache.json'))
    : {};
  const fs = existsSync(path.join(dir, 'final.metrics.json')) ? readJson<any>(path.join(dir, 'final.metrics.json')) : {};
  const bytesOf = (s: Iterable<string>) => {
    let b = 0;
    for (const r of s) b += sizeOf.get(r) ?? 0;
    return b;
  };
  const hit = [...needed].filter((r) => prefetchSet.has(r));
  const missed = [...needed].filter((r) => !prefetchSet.has(r));
  const neededBytes = bytesOf(needed);
  const prefetchedFileBytes = bytesOf(prefetchSet);
  const hitBytes = bytesOf(hit);

  const lat = reqs.map((r) => r.ms as number);
  const remoteRequests = be.read_count ?? 0;
  const remoteBytes = be.read_amount_total ?? 0;

  return {
    arm,
    rep,
    order,
    ok,
    failure: ok ? undefined : `ready=${readyEv?.ok} workloadDone=${events.some((e) => e.ev === 'workload-done')}`,
    tProc,
    tReady,
    tReq1,
    tWorkloadEnd: tEnd,
    remoteRequests,
    remoteBytes,
    remoteLatencyMs: be.read_cumulative_latency_millis_total ?? 0,
    prefetchBytes: bc.prefetch_data_amount ?? 0,
    prefetchRequests: bc.prefetch_requests_count ?? 0,
    fsBytesRead: fs.data_read ?? 0,
    atProc: at(t0 + tProc),
    atReady: at(t0 + tReady),
    atReq1: at(t0 + tReq1),
    neededFiles: needed.size,
    neededBytes,
    prefetchedFiles: prefetchSet.size,
    prefetchedFileBytes,
    hitFiles: hit.length,
    hitBytes,
    precision: pct(hitBytes, prefetchedFileBytes),
    recall: pct(hitBytes, neededBytes),
    wasteBytes: prefetchedFileBytes - hitBytes,
    unexpectedMissFiles: missed.length,
    unexpectedMissBytes: bytesOf(missed),
    faultAmplification: needed.size > 0 ? remoteRequests / needed.size : Number.NaN,
    remoteOpsPerMB: remoteBytes > 0 ? remoteRequests / (remoteBytes / 2 ** 20) : Number.NaN,
    // The temporal fetch curve, downsampled to one point per 100 ms sample and
    // capped so a long trial does not bloat the record. Milestones are stored
    // separately (tProc/tReady/tReq1) and are the marks on this curve.
    curve: samples
      .filter((s) => Number.isFinite(s.at))
      .map((s) => [s.at - t0, s.rq ?? 0, s.rb ?? 0] as [number, number, number])
      .filter((_, i, arr) => arr.length <= 400 || i % Math.ceil(arr.length / 400) === 0),
    reqLatency: {
      n: lat.length,
      p50: median(lat),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      first: lat[0] ?? Number.NaN,
    },
    requests: reqs.map((r) => ({
      path: r.path,
      method: r.method,
      phase: r.phase,
      status: r.status,
      ms: r.ms,
      bodyHash: r.bodyHash ?? null,
    })),
  };
}

function analyzeApp(app: string): void {
  const plan = readJson<AppPlan>(path.join(WORK_ROOT, 'plans', `${app}.json`));
  const sizeOf = new Map(plan.files);
  const prepped = readJson<any>(path.join(RUN, 'prep', `${app}.json`));
  const trialRoot = path.join(RUN, 'trials', app);
  if (!existsSync(trialRoot)) {
    console.log(`[${app}] no trials`);
    return;
  }
  // The held-out ground truth: which files the TEST workload's CONTENT reads
  // touched, observed once per app on an eager instrumented run. Shared by
  // every arm on purpose — precision/recall must be measured against ONE
  // definition of "needed", not against each arm's own behaviour.
  const needed = new Set(readJson<{ rel: string }[]>(path.join(PREP, `${app}.needed-test.json`)).map((x) => x.rel));
  const prefetchFor = (arm: string): Set<string> => {
    if (arm === 'B1') return new Set();
    if (arm === 'B0') return new Set(plan.files.map(([r]) => r)); // eager: everything is resident
    const f = path.join(RUN, 'prefetch', `${app}.${arm}.json`);
    return new Set(readJson<{ list: string[] }>(f).list);
  };

  // execution order comes from the run index, so the "benchmark ordering"
  // attack can actually be tested instead of asserted away.
  const orderOf = new Map<string, number>();
  const idx = path.join(trialRoot, 'index.json');
  if (existsSync(idx)) {
    for (const t of readJson<{ arm: string; rep: number; order: number }[]>(idx)) {
      orderOf.set(`${t.arm}.rep${t.rep}`, t.order);
    }
  }
  const trials: TrialMetrics[] = [];
  for (const d of readdirSync(trialRoot)) {
    const m = /^(B0|B1|B2|B2d|B3a|B3b)\.rep(\d+)$/.exec(d);
    if (!m) continue;
    const arm = m[1]!;
    trials.push(
      analyzeTrial(path.join(trialRoot, d), arm, Number(m[2]), orderOf.get(d) ?? -1, needed, sizeOf, prefetchFor(arm)),
    );
  }
  // Pearson r between execution order and ready time: if the machine drifted
  // over the run, this is where it shows up.
  const ok = trials.filter((t) => t.ok && t.order >= 0 && Number.isFinite(t.tReady));
  let orderDrift = Number.NaN;
  if (ok.length >= 4) {
    const mx = ok.reduce((a, t) => a + t.order, 0) / ok.length;
    const my = ok.reduce((a, t) => a + t.tReady, 0) / ok.length;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (const t of ok) {
      num += (t.order - mx) * (t.tReady - my);
      dx += (t.order - mx) ** 2;
      dy += (t.tReady - my) ** 2;
    }
    orderDrift = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : Number.NaN;
  }

  // ---- correctness: every arm must answer like B0, request slot by request slot
  const ref = trials.filter((t) => t.arm === 'B0' && t.ok)[0];
  const correctness: Record<string, { compared: number; statusMismatch: number; bodyMismatch: number; detail: string[] }> =
    {};
  for (const t of trials) {
    const c = { compared: 0, statusMismatch: 0, bodyMismatch: 0, detail: [] as string[] };
    if (ref && t.arm !== 'B0') {
      for (let i = 0; i < Math.min(ref.requests.length, t.requests.length); i++) {
        const a = ref.requests[i]!;
        const b = t.requests[i]!;
        c.compared++;
        if (a.status !== b.status) {
          c.statusMismatch++;
          if (c.detail.length < 8) c.detail.push(`${b.method} ${b.path}: B0=${a.status} ${t.arm}=${b.status}`);
        } else if (a.bodyHash && b.bodyHash && a.bodyHash !== b.bodyHash) c.bodyMismatch++;
      }
    }
    correctness[`${t.arm}.rep${t.rep}`] = c;
  }

  const byArm: Record<string, any> = {};
  for (const arm of ['B0', 'B1', 'B2', 'B2d', 'B3a', 'B3b']) {
    const ts = trials.filter((t) => t.arm === arm && t.ok);
    if (ts.length === 0) {
      byArm[arm] = { n: 0, failed: trials.filter((t) => t.arm === arm).length };
      continue;
    }
    const pick = (f: (t: TrialMetrics) => number) => ({
      median: median(ts.map(f)),
      min: Math.min(...ts.map(f)),
      max: Math.max(...ts.map(f)),
    });
    byArm[arm] = {
      n: ts.length,
      failed: trials.filter((t) => t.arm === arm && !t.ok).length,
      tProcMs: pick((t) => t.tProc),
      tReadyMs: pick((t) => t.tReady),
      tReq1Ms: pick((t) => t.tReq1),
      tEndMs: pick((t) => t.tWorkloadEnd),
      remoteRequests: pick((t) => t.remoteRequests),
      remoteBytes: pick((t) => t.remoteBytes),
      bytesAtProc: pick((t) => t.atProc.bytes),
      bytesAtReady: pick((t) => t.atReady.bytes),
      bytesAtReq1: pick((t) => t.atReq1.bytes),
      reqAtReady: pick((t) => t.atReady.req),
      prefetchBytes: pick((t) => t.prefetchBytes),
      prefetchRequests: pick((t) => t.prefetchRequests),
      neededFiles: pick((t) => t.neededFiles),
      neededBytes: pick((t) => t.neededBytes),
      prefetchedFiles: ts[0]!.prefetchedFiles,
      prefetchedFileBytes: ts[0]!.prefetchedFileBytes,
      precision: pick((t) => t.precision),
      recall: pick((t) => t.recall),
      wasteBytes: pick((t) => t.wasteBytes),
      unexpectedMissFiles: pick((t) => t.unexpectedMissFiles),
      unexpectedMissBytes: pick((t) => t.unexpectedMissBytes),
      faultAmplification: pick((t) => t.faultAmplification),
      remoteOpsPerMB: pick((t) => t.remoteOpsPerMB),
      latencyP50: pick((t) => t.reqLatency.p50),
      latencyP95: pick((t) => t.reqLatency.p95),
      latencyP99: pick((t) => t.reqLatency.p99),
      latencyFirst: pick((t) => t.reqLatency.first),
    };
  }

  const out = {
    app,
    sha: prepped.sha,
    tree: prepped.tree,
    criterion: prepped.criterion,
    universe: prepped.universe,
    images: prepped.images,
    contentDigest: prepped.contentDigest,
    train: prepped.train,
    byArm,
    orderDrift,
    correctness,
    // one representative curve per arm (the median-ready trial); the rest are
    // dropped so the metrics file stays readable, and every raw sample stream
    // remains on disk under trials/<app>/<arm>.rep<n>/samples.jsonl
    trials: trials.map((t) => {
      const sameArm = trials.filter((x) => x.arm === t.arm && x.ok).sort((a, b) => a.tReady - b.tReady);
      const rep = sameArm[Math.floor(sameArm.length / 2)];
      return { ...t, requests: undefined, curve: rep === t ? t.curve : undefined };
    }),
  };
  writeFileSync(path.join(RUN, `${app}.metrics.json`), JSON.stringify(out, null, 1));

  const f = (n: number, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
  const mb = (n: number) => (Number.isFinite(n) ? (n / 1e6).toFixed(1) : 'n/a');
  console.log(`\n=== ${app} (${prepped.universe.files} files / ${mb(prepped.universe.bytes)} MB)`);
  console.log('arm    n  ready(ms)  req1(ms)  remoteReq  remoteMB  B@ready   prec   recall  miss(files/MB)  p95(ms)');
  for (const arm of ['B0', 'B1', 'B2', 'B2d', 'B3a', 'B3b']) {
    const a = byArm[arm];
    if (!a || a.n === 0) {
      console.log(`${arm.padEnd(6)} 0  (all trials failed: ${a?.failed ?? 0})`);
      continue;
    }
    console.log(
      `${arm.padEnd(6)}${String(a.n).padStart(2)}  ${f(a.tReadyMs.median).padStart(8)}  ${f(a.tReq1Ms.median).padStart(8)}  ` +
        `${f(a.remoteRequests.median).padStart(9)}  ${mb(a.remoteBytes.median).padStart(8)}  ${mb(a.bytesAtReady.median).padStart(7)}  ` +
        `${(a.precision.median * 100).toFixed(1).padStart(5)}%  ${(a.recall.median * 100).toFixed(1).padStart(5)}%  ` +
        `${String(a.unexpectedMissFiles.median).padStart(6)}/${mb(a.unexpectedMissBytes.median).padStart(5)}  ${f(a.latencyP95.median).padStart(7)}`,
    );
  }
  const bad = Object.entries(correctness).filter(([, c]) => c.statusMismatch > 0);
  if (bad.length) {
    console.log(`  CORRECTNESS mismatches: ${bad.map(([k, c]) => `${k}:${c.statusMismatch}`).join(' ')}`);
    for (const [, c] of bad.slice(0, 2)) for (const d of c.detail.slice(0, 4)) console.log(`    ${d}`);
  }
}

const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } } });
for (const app of values.all ? APPS.map((a) => a.name) : [values.app!]) {
  try {
    analyzeApp(app);
  } catch (err) {
    console.log(`[${app}] analyze failed: ${String(err).slice(0, 300)}`);
  }
}
