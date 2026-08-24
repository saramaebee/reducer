/**
 * Cost-aware traffic-warm experiment runner (ADR-0007 experiment 5).
 * Preregistered in DESIGN.md; this file executes that design and must not
 * silently deviate from it.
 *
 *   prep(app)    frozen experiment-4 rankings + physical map + calibrated cost
 *                model → one prewarm manifest per (arm × prewarm-time budget)
 *   trials(app)  the measured cold trials, admitted on a wall-clock prewarm
 *                deadline, in a rotated order
 *
 * NOTHING about the application, the image, the workload, the traffic families
 * or the steady-state band is rebuilt here. The frozen tree, the frozen RAFS
 * bootstrap and blob, the frozen rankings, the frozen traffic and the frozen
 * band all come from `../longtail/run-1/`, unmodified. The only new inputs are
 * the physical retrieval-unit map (read out of that same bootstrap) and the
 * cost model (fitted on neutral probes against that same blob).
 *
 * Usage:
 *   bun benchmarks/costaware/run.ts prep   --app <name>
 *   bun benchmarks/costaware/run.ts trials --app <name> [--only G1C,R1C] [--budgets 4000,8000]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NET, RUNNER_IMAGE } from '../lazy-oci/images.ts';
import { loadPlan, type LongtailPlan } from '../longtail/plan.ts';
import type { Ranking } from '../longtail/strategies.ts';
import { FAMILIES, STREAM_LENGTH, buildTraffic, toWire } from '../longtail/traffic.ts';
import { workloadFor, type Workload } from '../longtail/workloads.ts';
import type { CostModel } from './calibrate.ts';
import { LONGTAIL_WORK, WORK_ROOT, loadPhysicalMap, rangesOf } from './physical.ts';
import { buildUnits, selectCostAware, truncateByCost, type Selection } from './select.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const CONTAINER = path.join(import.meta.dirname, 'container');
const LONGTAIL_RUN = path.join(import.meta.dirname, '..', 'longtail', 'run-1');
const BASE_CONTAINER = path.join(import.meta.dirname, '..', 'lazy-oci', 'container');

/** Preregistered network profile — identical to experiment 4's, so every
 *  number in this experiment is directly comparable to that record. */
export const NETEM = { delayMs: 25, rateMbit: 100 };
/** The one preregistered sensitivity profile (DESIGN §12). */
export const NETEM_FAST = { delayMs: 5, rateMbit: 1000 };

/**
 * Preregistered PREWARM-TIME budgets, in milliseconds, per app.
 *
 * Chosen from experiment 4's measured distributions and from nothing else
 * (`../longtail/run-1/<app>.metrics.json`): the ladder spans from far below the
 * eager arm's prewarm duration up to roughly it, and crosses that app's
 * measured application-ready time, so both regimes are represented — the one
 * where prewarm hides behind application startup and costs nothing, and the one
 * where it delays admission.
 *
 *   app           E0 prewarm    t_ready (median)   rungs
 *   strapi          22.7 s         13.4 s          2 / 4 / 8 / 14 / 22 s
 *   juice-shop       7.5 s          5.9 s          1 / 2 / 4 / 6 / 7.5 s
 *   uptime-kuma      5.6 s          6.5 s          1 / 2 / 3 / 4 / 5.6 s
 *
 * A rung is a MEASURED prewarm cost, not a model output. Nydus has no API to
 * abort an in-flight prefetch, so a wall-clock deadline gates admission but
 * cannot stop fetching, and an arm is held to a cost only if its manifest
 * genuinely costs that much. Each arm's manifest for a rung is therefore chosen
 * by *measuring* every candidate manifest with an application-free probe
 * (`calibrate.ts manifests`) and taking the one whose measured prefetch
 * duration is nearest the rung. Same procedure, same tolerance, same probe for
 * every arm — no per-arm coefficient anywhere.
 *
 * The candidate manifests come from one shared geometric ladder of internal
 * budget parameters. The parameter is only a knob: what is reported, plotted
 * and compared is always the measured cost.
 */
export const PARAMS_MS = [400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 51_200];

export const RUNGS_MS: Record<string, number[]> = {
  strapi: [2_000, 4_000, 8_000, 14_000, 22_000],
  'juice-shop': [1_000, 2_000, 4_000, 6_000, 7_500],
  'uptime-kuma': [1_000, 2_000, 3_000, 4_000, 5_600],
};

/** back-compat alias used by the manifest-cost probe pass */
export const BUDGETS_MS: Record<string, number[]> = {
  strapi: PARAMS_MS,
  'juice-shop': PARAMS_MS,
  'uptime-kuma': PARAMS_MS,
};

/** The preregistered app set (DESIGN §3). */
export const APPS = ['strapi', 'juice-shop', 'uptime-kuma'];

/**
 * The four deployed arms.
 *
 * `value` names the FROZEN experiment-4 ranking used as behavioural value.
 * G2's ranking is the generic one: its head is literally the TRAIN trace in
 * first-access order (identical to G1's), and below the trace it is the
 * strongest generic widening the preserved harness contains. Using G1's
 * lexicographic remainder instead would be the weak-generic-baseline straw man
 * the adversarial list explicitly forbids.
 *
 * `costAware` is the ONLY axis that differs within a prediction source, and the
 * cost machinery is byte-for-byte the same function for both sources.
 */
export const ARMS = [
  { name: 'G1', value: 'G2', costAware: false, source: 'generic' },
  { name: 'G1C', value: 'G2', costAware: true, source: 'generic' },
  { name: 'R1', value: 'R1', costAware: false, source: 'semantic' },
  { name: 'R1C', value: 'R1', costAware: true, source: 'semantic' },
] as const;

const sh = (args: string[], timeout = 3_600_000): string =>
  execFileSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout });

export function shapeNetwork(profile = NETEM): void {
  sh([
    'docker', 'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
    '--platform', 'linux/arm64', RUNNER_IMAGE,
    'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem',
    'delay', `${profile.delayMs}ms`, 'rate', `${profile.rateMbit}mbit`,
  ]);
  const out = sh([
    'docker', 'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
    '--platform', 'linux/arm64', RUNNER_IMAGE, 'tc', 'qdisc', 'show', 'dev', 'eth0',
  ]);
  console.log(`network shaping: ${out.trim().split('\n')[0]}`);
}

export function loadRanking(app: string, arm: string): Ranking {
  const p = path.join(LONGTAIL_RUN, 'prefetch', app, `${arm}.ranking.json.gz`);
  const plain = path.join(LONGTAIL_RUN, 'prefetch', app, `${arm}.ranking.json`);
  if (existsSync(p)) return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
  return JSON.parse(readFileSync(plain, 'utf8'));
}

export const loadCostModel = (): CostModel => JSON.parse(readFileSync(path.join(RUN, 'cost-model.json'), 'utf8'));

// ------------------------------------------------------------------- trial

export interface TrialSpec {
  app: string;
  arm: string;
  budgetMs: number | null;
  /** the internal budget parameter whose manifest this trial deploys */
  param: number | null;
  family: number;
  order: number;
  outDir: string;
  prefetchFile: string | null;
  prefetchAll: boolean;
}

function specJson(app: string, w: Workload, t: TrialSpec, plan: LongtailPlan): unknown {
  return {
    app,
    arm: t.arm,
    budget: t.budgetMs,
    family: t.family,
    argv: w.argv,
    cwdRel: w.cwdRel,
    env: w.env,
    setup: w.setup,
    ready: w.ready,
    settleMs: w.settleMs,
    baseUrl: w.baseUrl,
    port: w.port,
    appLog: '/work/app.log',
    apiSock: '/work/api.sock',
    prewarmMarker: '/work/prewarm-done',
    prewarmTimeoutMs: 900_000,
    universeBytes: plan.universeBytes,
    passes: 2,
    traffic: toWire(buildTraffic(w, t.family)),
  };
}

export function runTrial(t: TrialSpec, w: Workload, plan: LongtailPlan, repo: string): { milestones: Record<string, number>; cutoff: string | null; exit: number } {
  rmSync(t.outDir, { recursive: true, force: true });
  mkdirSync(t.outDir, { recursive: true });
  const specDir = path.join(t.outDir, 'spec');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.json'), JSON.stringify(specJson(t.app, w, t, plan)));
  if (t.prefetchFile) sh(['cp', t.prefetchFile, path.join(specDir, 'prefetch.txt')]);

  const stage = path.join(LONGTAIL_WORK, 'stage', t.app);
  const bootDir = path.join(LONGTAIL_WORK, 'images', t.app, 'base');
  const args = [
    'docker', 'run', '--rm', '--platform', 'linux/arm64', '--privileged', '--network', NET,
    '--tmpfs', '/scratch:size=6g',
    '-v', 'reducer-work:/work',
    '-v', `${stage}:/eager:ro`,
    '-v', `${specDir}:/spec:ro`,
    '-v', `${t.outDir}:/out`,
    '-v', `${CONTAINER}:/opt/driver:ro`,
    '-v', `${BASE_CONTAINER}:/opt/base:ro`,
    '-v', `${bootDir}:/boot:ro`,
    '-e', `ARM=${t.arm}`,
    '-e', 'SPEC=/spec/spec.json',
    '-e', 'OBSERVE=0',
    '-e', `REPO=${repo}`,
    '-e', 'BOOTSTRAP=/boot/boot.img',
    '-e', `PREFETCH_ALL=${t.prefetchAll}`,
    ...(t.prefetchFile ? ['-e', 'PREFETCH_FILES=/spec/prefetch.txt'] : []),
    ...(t.budgetMs !== null ? ['-e', `PREWARM_DEADLINE_MS=${t.budgetMs}`] : []),
    RUNNER_IMAGE, 'bash', '/opt/driver/runner.sh',
  ];
  const res = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 2_400_000 });
  const stdout = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(path.join(t.outDir, 'runner.log'), stdout);
  const milestones: Record<string, number> = {};
  for (const m of stdout.matchAll(/^#M (\S+) (\d+)/gm)) milestones[m[1]!] = Number(m[2]);
  const cutoff = /^#R prewarm-cutoff (\S+)/m.exec(stdout)?.[1] ?? null;
  writeFileSync(
    path.join(t.outDir, 'trial.json'),
    JSON.stringify({ ...t, budget: t.budgetMs, milestones, cutoff, exit: res.status ?? -1 }, null, 1),
  );
  return { milestones, cutoff, exit: res.status ?? -1 };
}

// ------------------------------------------------------------------- prep

function prep(app: string): void {
  const plan = loadPlan(app);
  const m = loadPhysicalMap(app);
  const model = loadCostModel();
  const units = buildUnits(m, model.maxRange, model.maxURange);
  const budgets = PARAMS_MS;
  mkdirSync(path.join(RUN, 'prep'), { recursive: true });
  const listDir = path.join(WORK_ROOT, 'prefetch', app);
  mkdirSync(listDir, { recursive: true });

  const rankings = new Map<string, Ranking>();
  for (const a of ARMS) if (!rankings.has(a.value)) rankings.set(a.value, loadRanking(app, a.value));
  const oracleRanking = loadRanking(app, 'O');

  const byFile = new Map(m.fileChunks);
  const record: Record<string, unknown> = {};
  for (const a of ARMS) {
    for (const b of budgets) {
      const r = rankings.get(a.value)!;
      const sel: Selection = a.costAware
        ? selectCostAware(r, plan, m, units, model, b)
        : truncateByCost(r, plan, m, model, b);
      const listPath = path.join(listDir, `${a.name}.${b}.txt`);
      writeFileSync(listPath, `${sel.files.map((x) => `/${x}`).join('\n')}\n`);
      record[`${a.name}@${b}`] = {
        arm: a.name,
        valueSource: a.value,
        costAware: a.costAware,
        budgetMs: b,
        manifestEntries: sel.files.length,
        residentFiles: sel.residentFiles,
        residentFileBytes: sel.residentFileBytes,
        rankedFileBytes: sel.fileBytes,
        units: sel.units.length,
        predictedMs: Math.round(sel.predictedMs),
        predictedRequests: sel.predicted.requests,
        predictedBackendBytes: sel.predicted.bytes,
        chunkBytes: sel.predicted.chunkBytes,
        valueTaken: sel.valueTaken,
        valueTotal: sel.valueTotal,
        listPath,
      };
      console.log(
        `[${app}] ${a.name.padEnd(4)} @${String(b).padStart(6)}ms  entries=${String(sel.files.length).padStart(7)} ` +
          `resident=${String(sel.residentFiles).padStart(7)}f/${(sel.residentFileBytes / 1e6).toFixed(0).padStart(4)}MB units=${String(sel.units.length).padStart(5)} ` +
          `req=${String(sel.predicted.requests).padStart(5)} backendMB=${(sel.predicted.bytes / 1e6).toFixed(1).padStart(6)} ` +
          `predicted=${Math.round(sel.predictedMs)}ms`,
      );
    }
  }

  // The physical oracle: the TEST first-touch set, priced in the same units.
  // Analysis only — never deployed, never mounted.
  const testNeeded = JSON.parse(readFileSync(path.join(LONGTAIL_WORK, 'observe', app, 'test.json'), 'utf8')) as {
    neededUnion: [string, number][];
  };
  const oracleChunks = new Set<number>();
  for (const [rel] of testNeeded.neededUnion) for (const c of byFile.get(rel) ?? []) oracleChunks.add(c);
  const oracleRange = rangesOf(oracleChunks, m, model.gapBridge, model.maxRange, model.maxURange);
  const oracleUnits = new Set<number>();
  for (const c of oracleChunks) oracleUnits.add(units.unitOf[c]!);
  let oracleUnitBytes = 0;
  for (const u of oracleUnits) oracleUnitBytes += units.bytes[u]!;

  writeFileSync(
    path.join(RUN, 'prep', `${app}.json`),
    JSON.stringify(
      {
        app,
        source: 'benchmarks/longtail/run-1 (frozen): tree, image, rankings, traffic, band',
        universe: { files: plan.files.length, bytes: plan.universeBytes },
        physical: m.totals,
        blobId: m.blobId,
        costModel: model,
        units: { count: units.span.length, maxRange: model.maxRange, medianBytes: units.bytes.slice().sort((x, y) => x - y)[Math.floor(units.bytes.length / 2)] },
        budgetsMs: budgets,
        arms: ARMS,
        rankingInputs: Object.fromEntries([...rankings].map(([k, v]) => [k, v.inputs])),
        oracleRankingInputs: oracleRanking.inputs,
        selections: record,
        physicalOracle: {
          neededFiles: testNeeded.neededUnion.length,
          chunks: oracleChunks.size,
          requests: oracleRange.requests,
          backendBytes: oracleRange.bytes,
          chunkBytes: oracleRange.chunkBytes,
          predictedMs: Math.round(model.fixedMs + model.perRequestMs * oracleRange.requests + model.perByteMs * oracleRange.bytes),
          unitsTouched: oracleUnits.size,
          unitBytes: oracleUnitBytes,
          unitPredictedMs: Math.round(model.fixedMs + (model.perRequestMs + 0) * oracleUnits.size + model.perByteMs * oracleUnitBytes),
        },
        stream: { length: STREAM_LENGTH, families: FAMILIES, passes: 2 },
      },
      null,
      1,
    ),
  );
}

// ----------------------------------------------------------------- trials

export interface LadderEntry {
  arm: string;
  rungMs: number;
  /** the internal budget parameter whose manifest measured nearest this rung */
  param: number;
  measuredMs: number;
  files: number;
  measuredRequests: number | null;
  measuredBackendBytes: number | null;
}

/**
 * Pick, for each arm and each preregistered rung, the candidate manifest whose
 * application-free MEASURED prefetch duration is nearest that rung.
 *
 * This is the step that makes "equal prewarm time" true rather than modelled.
 * The rule is one line and it is the same line for every arm: nearest measured
 * cost wins. The distance from the rung is recorded for every choice, so a rung
 * an arm cannot reach is visible rather than glossed.
 */
function ladder(app: string): LadderEntry[] {
  const measured = JSON.parse(
    readFileSync(path.join(RUN, 'manifest-cost', app, 'measured.json'), 'utf8'),
  ) as { arm: string; budgetMs: number; files: number; prewarmMs: number | null; backendReadCount: number | null; backendReadBytes: number | null }[];
  const out: LadderEntry[] = [];
  for (const rung of RUNGS_MS[app]!) {
    for (const a of ARMS) {
      const cands = measured.filter((x) => x.arm === a.name && x.prewarmMs != null);
      if (!cands.length) continue;
      const best = cands.reduce((p, c) => (Math.abs(c.prewarmMs! - rung) < Math.abs(p.prewarmMs! - rung) ? c : p));
      out.push({
        arm: a.name,
        rungMs: rung,
        param: best.budgetMs,
        measuredMs: best.prewarmMs!,
        files: best.files,
        measuredRequests: best.backendReadCount,
        measuredBackendBytes: best.backendReadBytes,
      });
    }
  }
  writeFileSync(path.join(RUN, 'prep', `${app}.ladder.json`), JSON.stringify(out, null, 1));
  for (const e of out) {
    console.log(
      `[${app}] rung ${String(e.rungMs).padStart(6)}ms  ${e.arm.padEnd(4)} param=${String(e.param).padStart(6)} ` +
        `measured=${String(e.measuredMs).padStart(6)}ms (${(((e.measuredMs - e.rungMs) / e.rungMs) * 100).toFixed(0)}%) files=${e.files}`,
    );
  }
  return out;
}

interface Cell {
  arm: string;
  budgetMs: number | null;
  /** the manifest parameter to deploy; null for E0 */
  param: number | null;
  family: number;
  prefetchAll: boolean;
}

/**
 * The measured cells, family-major with the arm order rotated per family, so no
 * arm systematically follows another and none occupies a contiguous block of
 * wall-clock time. Same rule as experiment 4.
 */
export function cells(entries: LadderEntry[], armNames: string[], rungs: number[], withE0: boolean): Cell[] {
  const out: Cell[] = [];
  for (let f = 0; f < FAMILIES; f++) {
    if (withE0) out.push({ arm: 'E0', budgetMs: null, param: null, family: f, prefetchAll: true });
    for (const rung of rungs) {
      const rot = armNames.map((_, i) => armNames[(i + f) % armNames.length]!);
      for (const arm of rot) {
        const e = entries.find((x) => x.arm === arm && x.rungMs === rung);
        if (!e) continue;
        out.push({ arm, budgetMs: rung, param: e.param, family: f, prefetchAll: false });
      }
    }
  }
  return out;
}

function trials(app: string, only: string[] | null, rungs: number[], withE0: boolean, tag: string, profile = NETEM): void {
  shapeNetwork(profile);
  const plan = loadPlan(app);
  const w = workloadFor(app, plan);
  const outRoot = path.join(RUN, tag, app);
  mkdirSync(outRoot, { recursive: true });
  const repo = `longtail/${app}`;
  const entries = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.ladder.json`), 'utf8')) as LadderEntry[];

  const grid = cells(entries, only ?? ARMS.map((a) => a.name), rungs, withE0);
  const indexPath = path.join(outRoot, 'index.json');
  const index: unknown[] = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
  let order = index.length;
  const t0 = Date.now();
  for (const c of grid) {
    const name = c.budgetMs === null ? `${c.arm}.f${c.family}` : `${c.arm}.r${c.budgetMs}.f${c.family}`;
    const outDir = path.join(outRoot, name);
    const prefetchFile = c.param === null ? null : path.join(WORK_ROOT, 'prefetch', app, `${c.arm}.${c.param}.txt`);
    const r = runTrial(
      { app, arm: c.arm, budgetMs: c.budgetMs, param: c.param, family: c.family, order: order++, outDir, prefetchFile, prefetchAll: c.prefetchAll },
      w,
      plan,
      repo,
    );
    const m = r.milestones;
    const rel = (k: string) => (m[k] && m.t0 ? m[k]! - m.t0! : null);
    console.log(
      `[${app}] ${name.padEnd(22)} exit=${r.exit} cutoff=${r.cutoff} t0→prewarm ${rel('prewarm')}ms t0→done ${rel('workload-done')}ms`,
    );
    index.push({ ...c, budget: c.budgetMs, name, order: order - 1, milestones: m, cutoff: r.cutoff, exit: r.exit });
    writeFileSync(indexPath, JSON.stringify(index, null, 1));
  }
  console.log(`[${app}] ${grid.length} trials in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

// ------------------------------------------------------------------- main

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      all: { type: 'boolean' },
      only: { type: 'string' },
      budgets: { type: 'string' },
      e0: { type: 'boolean' },
      tag: { type: 'string' },
      fast: { type: 'boolean' },
    },
  });
  const cmd = positionals[0];
  const apps = values.all ? APPS : [values.app!];
  mkdirSync(RUN, { recursive: true });
  for (const app of apps) {
    if (cmd === 'prep') prep(app);
    else if (cmd === 'ladder') ladder(app);
    else if (cmd === 'trials') {
      trials(
        app,
        values.only ? values.only.split(',') : null,
        values.budgets ? values.budgets.split(',').map(Number) : RUNGS_MS[app]!,
        values.e0 === true,
        values.tag ?? 'trials',
        values.fast ? NETEM_FAST : NETEM,
      );
    } else throw new Error(`unknown command '${cmd}' (prep | ladder | trials)`);
  }
}
