/**
 * Calibrate the physical retrieval-cost model against real nydusd behaviour,
 * BEFORE it is allowed to select anything.
 *
 * Two things are unknown until measured and neither is guessed:
 *
 *   1. THE MERGE RULE. nydusd coalesces the requested chunks into backend range
 *      requests bounded by `merging_size`. Whether it bridges a gap of
 *      unrequested blob bytes, and how wide a single request may grow, decides
 *      what "marginal cost" even means. Measured by fitting (gapBridge,
 *      maxRange) to the backend's own `read_count` and `read_amount_total` over
 *      a set of manifests engineered to span the whole adjacency range.
 *
 *   2. THE TIME COEFFICIENTS. prewarm duration ≈ fixed + α·requests + β·bytes.
 *      Fitted by ordinary least squares on the same probes.
 *
 * Every probe manifest is NEUTRAL: contiguous spans over the blob, strided
 * selections, and seeded uniform samples of the universe. No TRAIN trace, no
 * TEST first-touch, no arm's ranking and no outcome of this experiment enters
 * the manifests, so the fitted model cannot have been shaped by the result it
 * is later used to produce.
 *
 * Usage:
 *   bun benchmarks/costaware/calibrate.ts probes --app <name>
 *   bun benchmarks/costaware/calibrate.ts fit    --all
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NET, RUNNER_IMAGE } from '../lazy-oci/images.ts';
import { loadPlan } from '../longtail/plan.ts';
import { LONGTAIL_WORK, WORK_ROOT, loadPhysicalMap, rangesOf, type PhysicalMap } from './physical.ts';

const RUN = path.join(import.meta.dirname, 'run-1');

/** A preserved probe manifest, gzipped or plain. */
function readFiles(dir: string, id: string): string[] {
  const gz = path.join(dir, `${id}.files.json.gz`);
  if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8'));
  return JSON.parse(readFileSync(path.join(dir, `${id}.files.json`), 'utf8'));
}
const CONTAINER = path.join(import.meta.dirname, 'container');

/** Deterministic 32-bit LCG. Seed is preregistered so every manifest is
 *  reproducible from this file alone. */
export const SEED = 20260824;
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ────────────────────────────────────────────────────────── probe manifests

export interface Probe {
  id: string;
  kind: 'span' | 'stride' | 'uniform' | 'runs' | 'allspan' | 'regions';
  files: string[];
}

/**
 * Build the neutral probe set for one app.
 *
 * `span` and `runs` manipulate blob adjacency directly (they are the ones that
 * identify the merge rule); `uniform` produces the maximally scattered case a
 * real semantic manifest looks most like; the sizes are chosen to bracket the
 * request counts experiment 4's arms actually produced.
 */
export function probesFor(app: string, m: PhysicalMap): Probe[] {
  // one representative FILE per chunk, preferring single-chunk files so a probe
  // asks for exactly the chunks it means to
  const owner = new Map<number, string>();
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length !== 1) continue;
    if (!owner.has(cs[0]!)) owner.set(cs[0]!, rel);
  }
  const chunks = [...owner.keys()].sort((a, b) => a - b);
  const N = chunks.length;
  const pick = (idxs: number[]): string[] => idxs.filter((i) => i >= 0 && i < N).map((i) => owner.get(chunks[i]!)!);
  const out: Probe[] = [];

  // contiguous spans, from three different places in the blob
  for (const n of [200, 1_000, 4_000, 16_000]) {
    if (n > N) continue;
    for (const [tag, base] of [['a', 0], ['b', Math.floor(N * 0.4)], ['c', Math.max(0, N - n - 1)]] as const) {
      out.push({ id: `span-${n}-${tag}`, kind: 'span', files: pick(Array.from({ length: n }, (_, i) => base + i)) });
    }
  }
  // strided selections: one chunk taken every k, over a fixed window
  for (const k of [2, 4, 8, 16, 64, 256]) {
    const n = Math.min(2_000, Math.floor(N / k));
    if (n < 50) continue;
    out.push({ id: `stride-${k}`, kind: 'stride', files: pick(Array.from({ length: n }, (_, i) => i * k)) });
  }
  // runs of R contiguous chunks separated by a gap of G unrequested chunks
  for (const [R, G] of [[4, 1], [4, 4], [4, 16], [4, 64], [16, 4], [16, 32], [32, 128]] as const) {
    const idxs: number[] = [];
    for (let base = 0; idxs.length < 2_000 && base + R < N; base += R + G) {
      for (let i = 0; i < R; i++) idxs.push(base + i);
    }
    out.push({ id: `runs-${R}x${G}`, kind: 'runs', files: pick(idxs) });
  }
  // ALL files inside a contiguous chunk window, and all files inside K evenly
  // spaced windows. These two families are the regime a cost-aware manifest
  // actually occupies — whole contiguous regions, several of them, scattered
  // over the blob — and the first probe set did not contain it: `span` and
  // `runs` take one representative file per chunk, so they never exercise the
  // many-files-per-chunk case that deduplication and small files produce. The
  // families are defined by blob geometry and a fixed stride alone; no strategy,
  // no trace and no outcome enters them.
  const NC = m.offset.length;
  const byStart: { rel: string; lo: number; hi: number }[][] = Array.from({ length: NC }, () => []);
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length === 0) continue;
    let lo = cs[0]!;
    let hi = cs[0]!;
    for (const c of cs) {
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    byStart[lo]!.push({ rel, lo, hi });
  }
  const filesIn = (lo: number, hi: number): string[] => {
    const out2: string[] = [];
    for (let i = Math.max(0, lo); i <= Math.min(NC - 1, hi); i++) {
      for (const f of byStart[i]!) if (f.hi <= hi) out2.push(f.rel);
    }
    return out2;
  };
  for (const n of [500, 2_000, 8_000]) {
    if (n >= NC) continue;
    for (const [tag, base] of [['a', 0], ['b', Math.floor(NC * 0.4)]] as const) {
      out.push({ id: `allspan-${n}-${tag}`, kind: 'allspan', files: filesIn(base, base + n - 1) });
    }
  }
  for (const [K, W] of [[16, 40], [64, 40], [256, 40], [64, 160]] as const) {
    const step = Math.floor(NC / K);
    if (step <= W) continue;
    const sel: string[] = [];
    const seen2 = new Set<string>();
    for (let k = 0; k < K; k++) {
      for (const f of filesIn(k * step, k * step + W - 1)) {
        if (!seen2.has(f)) {
          seen2.add(f);
          sel.push(f);
        }
      }
    }
    out.push({ id: `regions-${K}x${W}`, kind: 'regions', files: sel });
  }

  // seeded uniform samples of the WHOLE universe (every file, not just
  // single-chunk ones) — the scattered case
  const all = m.fileChunks.map(([rel]) => rel);
  for (const n of [500, 2_000, 8_000, 30_000, 60_000]) {
    if (n > all.length) continue;
    const rnd = lcg(SEED + n);
    const idx = new Set<number>();
    while (idx.size < n) idx.add(Math.floor(rnd() * all.length));
    out.push({ id: `uniform-${n}`, kind: 'uniform', files: [...idx].sort((a, b) => a - b).map((i) => all[i]!) });
  }
  return out;
}

// ──────────────────────────────────────────────────────────── running probes

export interface ProbeResult extends Probe {
  app: string;
  order: number;
  chunks: number;
  /** what the model predicts, at the DEFAULT parameters, for the record */
  predicted: { requests: number; bytes: number; chunkBytes: number };
  measured: {
    backendReadCount: number | null;
    backendReadBytes: number | null;
    prefetchDataAmount: number | null;
    prefetchRequests: number | null;
    /** last-progress − mount, the same prewarm duration definition experiment 4 used */
    prewarmMs: number | null;
    plateauMs: number | null;
  };
}

function runProbe(app: string, p: Probe, order: number, outRoot: string): ProbeResult['measured'] {
  const outDir = path.join(outRoot, p.id);
  mkdirSync(outDir, { recursive: true });
  const listDir = path.join(WORK_ROOT, 'probe', app);
  mkdirSync(listDir, { recursive: true });
  const listPath = path.join(listDir, `${p.id}.txt`);
  writeFileSync(listPath, `${p.files.map((r) => `/${r}`).join('\n')}\n`);

  const bootDir = path.join(LONGTAIL_WORK, 'images', app, 'base');
  const res = spawnSync(
    'docker',
    [
      'run', '--rm', '--platform', 'linux/arm64', '--privileged', '--network', NET,
      '-v', 'reducer-work:/work',
      '-v', `${bootDir}:/boot:ro`,
      '-v', `${listDir}:/lists:ro`,
      '-v', `${outDir}:/out`,
      '-v', `${CONTAINER}:/opt/probe:ro`,
      '-e', `REPO=longtail/${app}`,
      '-e', 'BOOTSTRAP=/boot/boot.img',
      '-e', `PREFETCH_FILES=/lists/${p.id}.txt`,
      RUNNER_IMAGE, 'bash', '/opt/probe/probe.sh',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1_800_000 },
  );
  const log = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(path.join(outDir, 'probe.log'), log);
  const M: Record<string, number> = {};
  for (const mm of log.matchAll(/^#M (\S+) (\d+)/gm)) M[mm[1]!] = Number(mm[2]);
  const readJson = (f: string): Record<string, number> | null => {
    const p2 = path.join(outDir, f);
    if (!existsSync(p2)) return null;
    try {
      return JSON.parse(readFileSync(p2, 'utf8'));
    } catch {
      return null;
    }
  };
  const backend = readJson('final.metrics.backend.json');
  const bc = readJson('final.metrics.blobcache.json');
  return {
    backendReadCount: backend?.read_count ?? null,
    backendReadBytes: backend?.read_amount_total ?? null,
    prefetchDataAmount: bc?.prefetch_data_amount ?? null,
    prefetchRequests: bc?.prefetch_requests_count ?? null,
    prewarmMs: M['last-progress'] && M.mount ? M['last-progress']! - M.mount! : null,
    plateauMs: M.plateau && M.mount ? M.plateau - M.mount : null,
  };
}

// ────────────────────────────────────────────────────────────────── fitting

/** Least squares for y = c0 + c1·x1 + c2·x2, by 3×3 Gaussian elimination. */
export function ols3(rows: { y: number; x1: number; x2: number }[]): { c0: number; c1: number; c2: number; r2: number } {
  const A = [
    [rows.length, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (const r of rows) {
    A[0]![1]! += r.x1;
    A[0]![2]! += r.x2;
    A[0]![3]! += r.y;
    A[1]![0]! += r.x1;
    A[1]![1]! += r.x1 * r.x1;
    A[1]![2]! += r.x1 * r.x2;
    A[1]![3]! += r.x1 * r.y;
    A[2]![0]! += r.x2;
    A[2]![1]! += r.x2 * r.x1;
    A[2]![2]! += r.x2 * r.x2;
    A[2]![3]! += r.x2 * r.y;
  }
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k]![i]!) > Math.abs(A[piv]![i]!)) piv = k;
    [A[i], A[piv]] = [A[piv]!, A[i]!];
    const d = A[i]![i]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let j = i; j < 4; j++) A[i]![j]! /= d;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = A[k]![i]!;
      for (let j = i; j < 4; j++) A[k]![j]! -= f * A[i]![j]!;
    }
  }
  const c = [A[0]![3]!, A[1]![3]!, A[2]![3]!];
  const ybar = rows.reduce((a, r) => a + r.y, 0) / rows.length;
  let ssr = 0;
  let sst = 0;
  for (const r of rows) {
    const yh = c[0]! + c[1]! * r.x1 + c[2]! * r.x2;
    ssr += (r.y - yh) ** 2;
    sst += (r.y - ybar) ** 2;
  }
  return { c0: c[0]!, c1: c[1]!, c2: c[2]!, r2: sst > 0 ? 1 - ssr / sst : NaN };
}

export interface CostModel {
  /** measured coalescing width in blob bytes */
  gapBridge: number;
  /** measured cap on a single backend range request, in COMPRESSED blob bytes */
  maxRange: number;
  /** measured cap on a single backend range request, in DECOMPRESSED bytes */
  maxURange: number;
  /** prewarm ms ≈ fixedMs + perRequestMs·requests + perByteMs·bytes */
  fixedMs: number;
  perRequestMs: number;
  perByteMs: number;
  r2: number;
  /** how well (gapBridge,maxRange) reproduce the backend's own counters */
  mergeFit: { requestMape: number; byteMape: number; n: number };
  probes: number;
  apps: string[];
}

const CANDIDATE_GAPS = [0, 512, 1_024, 2_048, 4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144];
const CANDIDATE_MAX = [131_072, 262_144, 524_288, 1_048_576, 2_097_152, 4_194_304, Number.MAX_SAFE_INTEGER];
const CANDIDATE_UMAX = [65_536, 131_072, 262_144, 524_288, 1_048_576, 2_097_152, Number.MAX_SAFE_INTEGER];

/** Grid-search the merge rule against the backend's own counters. */
export function fitMergeRule(
  results: { app: string; files: string[] }[],
  maps: Map<string, PhysicalMap>,
  measured: { requests: number; bytes: number }[],
): { gapBridge: number; maxRange: number; maxURange: number; requestMape: number; byteMape: number } {
  const chunkSets = results.map((r) => {
    const m = maps.get(r.app)!;
    const byFile = new Map(m.fileChunks);
    const s = new Set<number>();
    for (const f of r.files) for (const c of byFile.get(f) ?? []) s.add(c);
    return { app: r.app, chunks: s };
  });
  let best = { gapBridge: 0, maxRange: 0, maxURange: 0, requestMape: Infinity, byteMape: Infinity, score: Infinity };
  for (const g of CANDIDATE_GAPS) {
    for (const mx of CANDIDATE_MAX) {
      for (const umx of CANDIDATE_UMAX) {
        let rq = 0;
        let by = 0;
        let n = 0;
        for (let i = 0; i < chunkSets.length; i++) {
          const mm = maps.get(chunkSets[i]!.app)!;
          const pred = rangesOf(chunkSets[i]!.chunks, mm, g, mx, umx);
          const obs = measured[i]!;
          if (!obs.requests || !obs.bytes) continue;
          rq += Math.abs(pred.requests - obs.requests) / obs.requests;
          by += Math.abs(pred.bytes - obs.bytes) / obs.bytes;
          n++;
        }
        if (!n) continue;
        const requestMape = rq / n;
        const byteMape = by / n;
        const score = requestMape + byteMape;
        if (score < best.score) best = { gapBridge: g, maxRange: mx, maxURange: umx, requestMape, byteMape, score };
      }
    }
  }
  return best;
}

// ───────────────────────────────────────────────────────────────────── main

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { app: { type: 'string' }, all: { type: 'boolean' } },
  });
  const cmd = positionals[0];
  const APPS_DEFAULT = ['strapi', 'juice-shop', 'uptime-kuma'];
  const apps = values.all ? APPS_DEFAULT : [values.app!];

  if (cmd === 'probes') {
    // netem must be attached exactly as every measured trial has it
    execFileSync('docker', [
      'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
      '--platform', 'linux/arm64', RUNNER_IMAGE,
      'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', 'delay', '25ms', 'rate', '100mbit',
    ]);
    for (const app of apps) {
      const m = loadPhysicalMap(app);
      const probes = probesFor(app, m);
      const outRoot = path.join(RUN, 'calibration', app);
      mkdirSync(outRoot, { recursive: true });
      const byFile = new Map(m.fileChunks);
      // resume: a probe whose result is already preserved is not re-run, so
      // adding a probe family costs only the new probes
      const prior = new Map<string, ProbeResult>(
        (existsSync(path.join(outRoot, 'probes.json'))
          ? (JSON.parse(readFileSync(path.join(outRoot, 'probes.json'), 'utf8')) as ProbeResult[])
          : []
        ).map((r) => [r.id, r]),
      );
      const out: ProbeResult[] = [];
      let order = 0;
      for (const p of probes) {
        const s = new Set<number>();
        for (const f of p.files) for (const c of byFile.get(f) ?? []) s.add(c);
        const cached = prior.get(p.id);
        const measured = cached?.measured?.prewarmMs != null ? cached.measured : runProbe(app, p, order, outRoot);
        out.push({
          ...p,
          files: p.files,
          app,
          order: order++,
          chunks: s.size,
          predicted: rangesOf(s, m, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
          measured,
        });
        console.log(
          `[${app}] ${p.id.padEnd(16)} files=${String(p.files.length).padStart(6)} chunks=${String(s.size).padStart(6)} ` +
            `backendReq=${measured.backendReadCount} backendMB=${((measured.backendReadBytes ?? 0) / 1e6).toFixed(1)} ` +
            `prewarm=${measured.prewarmMs}ms`,
        );
        writeFileSync(
          path.join(outRoot, 'probes.json'),
          JSON.stringify(out.map((r) => ({ ...r, files: r.files.length })), null, 1),
        );
        writeFileSync(path.join(outRoot, `${p.id}.files.json`), JSON.stringify(p.files));
      }
    }
  } else if (cmd === 'fit') {
    const maps = new Map<string, PhysicalMap>();
    const rows: { app: string; files: string[] }[] = [];
    const measured: { requests: number; bytes: number }[] = [];
    const timing: { y: number; x1: number; x2: number }[] = [];
    const raw: ProbeResult[] = [];
    for (const app of apps) {
      const f = path.join(RUN, 'calibration', app, 'probes.json');
      if (!existsSync(f)) continue;
      maps.set(app, loadPhysicalMap(app));
      for (const r of JSON.parse(readFileSync(f, 'utf8')) as ProbeResult[]) {
        const files = readFiles(path.join(RUN, 'calibration', app), r.id);
        raw.push({ ...r, files });
        rows.push({ app, files });
        measured.push({ requests: r.measured.backendReadCount ?? 0, bytes: r.measured.backendReadBytes ?? 0 });
      }
    }
    const merge = fitMergeRule(rows, maps, measured);
    // timing fit uses the MEASURED backend counters, so a merge-rule error
    // cannot leak into the time coefficients
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]!;
      if (r.measured.prewarmMs == null || !measured[i]!.requests) continue;
      timing.push({ y: r.measured.prewarmMs, x1: measured[i]!.requests, x2: measured[i]!.bytes });
    }
    const fit = ols3(timing);
    const model: CostModel = {
      gapBridge: merge.gapBridge,
      maxRange: merge.maxRange,
      maxURange: merge.maxURange,
      fixedMs: fit.c0,
      perRequestMs: fit.c1,
      perByteMs: fit.c2,
      r2: fit.r2,
      mergeFit: { requestMape: merge.requestMape, byteMape: merge.byteMape, n: rows.length },
      probes: raw.length,
      apps,
    };
    mkdirSync(RUN, { recursive: true });
    writeFileSync(path.join(RUN, 'cost-model.json'), JSON.stringify(model, null, 1));
    console.log(JSON.stringify(model, null, 1));
  } else if (cmd === 'manifests') {
    // What each DEPLOYED manifest actually costs the substrate, measured with
    // no application running so that prefetch is isolated from demand faults.
    //
    // This is what makes "equal prewarm time" a measurement rather than a
    // model output. Nydus has no API to abort an in-flight prefetch, so a
    // wall-clock deadline gates ADMISSION but does not stop fetching; the only
    // way an arm can be held to a cost is for its manifest to genuinely cost
    // that much. The measured value here — not the nominal budget parameter —
    // is the x-axis of every equal-time result.
    execFileSync('docker', [
      'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
      '--platform', 'linux/arm64', RUNNER_IMAGE,
      'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem', 'delay', '25ms', 'rate', '100mbit',
    ]);
    const { ARMS, BUDGETS_MS } = await import('./run.ts');
    for (const app of apps) {
      const outRoot = path.join(RUN, 'manifest-cost', app);
      mkdirSync(outRoot, { recursive: true });
      const listDir = path.join(WORK_ROOT, 'prefetch', app);
      const rows: Record<string, unknown>[] = [];
      let order = 0;
      for (const b of BUDGETS_MS[app]!) {
        for (const a of ARMS) {
          const id = `${a.name}.${b}`;
          const files = readFileSync(path.join(listDir, `${id}.txt`), 'utf8').split('\n').filter(Boolean).map((l) => l.slice(1));
          const measured = runProbe(app, { id, kind: 'uniform', files }, order++, outRoot);
          rows.push({ app, arm: a.name, budgetMs: b, files: files.length, ...measured });
          console.log(
            `[${app}] ${id.padEnd(12)} files=${String(files.length).padStart(7)} ` +
              `MEASURED prewarm=${measured.prewarmMs}ms backendReq=${measured.backendReadCount} ` +
              `backendMB=${((measured.backendReadBytes ?? 0) / 1e6).toFixed(1)}`,
          );
          writeFileSync(path.join(outRoot, 'measured.json'), JSON.stringify(rows, null, 1));
        }
      }
    }
  } else if (cmd === 'validate') {
    // End-to-end accuracy of the estimator AS IT WILL BE USED: predict prewarm
    // milliseconds from the physical map alone — no measured counter anywhere in
    // the prediction — and compare against the probe's real prewarm duration.
    // Plus an out-of-sample check the fit never saw: experiment 4's eager arm,
    // which fetches the whole blob.
    const model: CostModel = JSON.parse(readFileSync(path.join(RUN, 'cost-model.json'), 'utf8'));
    const rows: Record<string, unknown>[] = [];
    let ae = 0;
    let n = 0;
    for (const app of apps) {
      const m = loadPhysicalMap(app);
      const byFile = new Map(m.fileChunks);
      const probes = JSON.parse(readFileSync(path.join(RUN, 'calibration', app, 'probes.json'), 'utf8')) as ProbeResult[];
      for (const p of probes) {
        const files = readFiles(path.join(RUN, 'calibration', app), p.id);
        const s = new Set<number>();
        for (const f of files) for (const c of byFile.get(f) ?? []) s.add(c);
        const r = rangesOf(s, m, model.gapBridge, model.maxRange, model.maxURange);
        const pred = model.fixedMs + model.perRequestMs * r.requests + model.perByteMs * r.bytes;
        const meas = p.measured.prewarmMs ?? 0;
        if (!meas) continue;
        ae += Math.abs((pred - meas) / meas);
        n++;
        rows.push({
          app,
          id: p.id,
          kind: p.kind as string,
          chunks: s.size,
          measuredRequests: p.measured.backendReadCount,
          predictedRequests: r.requests,
          measuredBackendBytes: p.measured.backendReadBytes,
          predictedBackendBytes: r.bytes,
          measuredMs: meas,
          predictedMs: Math.round(pred),
          errorPct: Number((((pred - meas) / meas) * 100).toFixed(1)),
        });
      }
    }
    // out-of-sample: the whole blob, against experiment 4's measured eager arm
    const eager: Record<string, unknown>[] = [];
    const E0_MEASURED: Record<string, number> = { strapi: 22_715, 'juice-shop': 7_535, 'uptime-kuma': 5_604 };
    for (const app of apps) {
      const m = loadPhysicalMap(app);
      const all = new Set<number>();
      for (let i = 0; i < m.offset.length; i++) all.add(i);
      const r = rangesOf(all, m, model.gapBridge, model.maxRange, model.maxURange);
      const pred = model.fixedMs + model.perRequestMs * r.requests + model.perByteMs * r.bytes;
      const meas = E0_MEASURED[app]!;
      eager.push({ app, predictedMs: Math.round(pred), measuredMsExperiment4: meas, errorPct: Number((((pred - meas) / meas) * 100).toFixed(1)) });
    }
    // Split by regime. The cover-manifest regime — one descriptor per distinct
    // chunk — is the only one any deployed manifest occupies (DESIGN §7.3); the
    // `allspan`/`regions` families are deliberately the OTHER regime, listed
    // file-by-file, and they are what identified the descriptor-stream effect in
    // the first place. Both numbers are reported; neither is hidden.
    const coverRegime = rows.filter((r) => r.kind !== 'allspan' && r.kind !== 'regions');
    const mape = (xs: Record<string, unknown>[]) =>
      xs.length ? Number(((xs.reduce((a, r) => a + Math.abs(Number(r.errorPct)), 0) / xs.length)).toFixed(1)) : null;

    // and the number that actually matters: the DEPLOYED manifests
    const deployed: Record<string, unknown>[] = [];
    for (const app of apps) {
      const mc = path.join(RUN, 'manifest-cost', app, 'measured.json');
      const pp = path.join(RUN, 'prep', `${app}.json`);
      if (!existsSync(mc) || !existsSync(pp)) continue;
      const meas = JSON.parse(readFileSync(mc, 'utf8')) as { arm: string; budgetMs: number; prewarmMs: number | null }[];
      const prep = JSON.parse(readFileSync(pp, 'utf8')) as { selections: Record<string, { predictedMs: number }> };
      for (const x of meas) {
        const sel = prep.selections[`${x.arm}@${x.budgetMs}`];
        if (!sel || x.prewarmMs == null) continue;
        deployed.push({
          app,
          arm: x.arm,
          param: x.budgetMs,
          predictedMs: sel.predictedMs,
          measuredMs: x.prewarmMs,
          errorPct: Number((((sel.predictedMs - x.prewarmMs) / x.prewarmMs) * 100).toFixed(1)),
        });
      }
    }

    const out = {
      model,
      mapePct: Number(((ae / n) * 100).toFixed(1)),
      mapePctCoverRegime: mape(coverRegime),
      mapePctDeployedManifests: mape(deployed),
      n,
      probes: rows,
      deployed,
      eagerOutOfSample: eager,
    };
    writeFileSync(path.join(RUN, 'calibration', 'validation.json'), JSON.stringify(out, null, 1));
    console.log(`MAPE predicting prewarm ms from the physical map alone: ${out.mapePct}% (n=${n})`);
    console.log(`  cover-manifest regime only (the deployed one): ${out.mapePctCoverRegime}% (n=${coverRegime.length})`);
    console.log(`  the DEPLOYED manifests themselves:             ${out.mapePctDeployedManifests}% (n=${deployed.length})`);
    for (const e of eager) console.log(`  out-of-sample whole blob ${JSON.stringify(e)}`);
  } else {
    throw new Error(`unknown command '${cmd}' (probes | fit | validate)`);
  }
}
