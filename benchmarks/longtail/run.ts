/**
 * Long-tail traffic-warm experiment runner (ADR-0007 experiment 4).
 * Preregistered in DESIGN.md; this file executes that design and must not
 * silently deviate from it.
 *
 *   prep(app)    plan → ONE base image → TRAIN and TEST observation runs →
 *                strategy rankings → budgeted prewarm lists
 *   trials(app)  the measured cold trials: every (strategy × budget × family),
 *                plus the eager reference, in a rotated order
 *
 * Usage:
 *   bun benchmarks/longtail/run.ts prep   --app <name>
 *   bun benchmarks/longtail/run.ts trials --app <name> [--only G1,R2] [--budgets 0.05,0.4]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { NET, RUNNER_IMAGE, buildAllImages } from '../lazy-oci/images.ts';
import { APP_MOUNT } from '../lazy-oci/recipes-linux.ts';
import { APPS, WORK_ROOT, appByName, appSha } from './apps.ts';
import { buildLongtailPlan, loadPlan, planPath, type LongtailPlan } from './plan.ts';
import { g1, g2, oracle, r1, r2, truncate, type ArmName, type Ranking, type TrainAccess } from './strategies.ts';
import { FAMILIES, STREAM_LENGTH, buildTraffic, buildTrain, toWire } from './traffic.ts';
import { workloadFor, type Workload } from './workloads.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const CONTAINER = path.join(import.meta.dirname, 'container');
const BASE_CONTAINER = path.join(import.meta.dirname, '..', 'lazy-oci', 'container');
const REPO_PREFIX = 'longtail';

/** Preregistered network profile — one profile for every arm of every app. */
export const NETEM = { delayMs: 25, rateMbit: 100 };
/** Preregistered prewarm budget sweep, as a fraction of universe FILE bytes. */
export const BUDGETS = [0.05, 0.1, 0.2, 0.4];
/** The reference budget for the headline equal-cost table. */
export const REFERENCE_BUDGET = 0.1;
export const STRATEGIES: ArmName[] = ['G1', 'G2', 'R1', 'R2'];

const sh = (args: string[], timeout = 3_600_000): string =>
  execFileSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout });

export function shapeNetwork(): void {
  sh([
    'docker', 'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
    '--platform', 'linux/arm64', RUNNER_IMAGE,
    'tc', 'qdisc', 'replace', 'dev', 'eth0', 'root', 'netem',
    'delay', `${NETEM.delayMs}ms`, 'rate', `${NETEM.rateMbit}mbit`,
  ]);
  const out = sh([
    'docker', 'run', '--rm', '--net', 'container:reducer-registry', '--cap-add', 'NET_ADMIN',
    '--platform', 'linux/arm64', RUNNER_IMAGE, 'tc', 'qdisc', 'show', 'dev', 'eth0',
  ]);
  console.log(`network shaping: ${out.trim().split('\n')[0]}`);
}

// ------------------------------------------------------------------- trial

export interface TrialSpec {
  app: string;
  /** 'E0' (eager reference) or a strategy name */
  arm: string;
  budget: number | null;
  family: number;
  order: number;
  outDir: string;
  /** null = eager observation run against a plain directory */
  prefetchFile: string | null;
  prefetchAll: boolean;
  eagerDir?: string;
  observe?: boolean;
  /** TRAIN stream instead of the post-admission stream */
  train?: boolean;
}

function specJson(app: string, w: Workload, t: TrialSpec, plan: LongtailPlan): unknown {
  const traffic = t.train ? buildTrain(w) : toWire(buildTraffic(w, t.family));
  return {
    app,
    arm: t.arm,
    budget: t.budget,
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
    traffic,
  };
}

function resetServices(app: string): void {
  const a = appByName(app);
  if (!a.services.includes('pg')) return;
  throw new Error(`[${app}] declares a pg service; no long-tail app currently needs one`);
}

export function runTrial(t: TrialSpec, w: Workload, plan: LongtailPlan, image: { repo: string; bootstrap: string }): {
  milestones: Record<string, number>;
  exit: number;
} {
  resetServices(t.app);
  rmSync(t.outDir, { recursive: true, force: true });
  mkdirSync(t.outDir, { recursive: true });
  const specDir = path.join(t.outDir, 'spec');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.json'), JSON.stringify(specJson(t.app, w, t, plan)));
  if (t.prefetchFile) sh(['cp', t.prefetchFile, path.join(specDir, 'prefetch.txt')]);

  const stage = path.join(WORK_ROOT, 'stage', t.app);
  const lazy = !t.eagerDir;
  const args = [
    'docker', 'run', '--rm', '--platform', 'linux/arm64', '--privileged', '--network', NET,
    '--tmpfs', '/scratch:size=6g',
    '-v', 'reducer-work:/work',
    '-v', `${stage}:/eager:ro`,
    '-v', `${specDir}:/spec:ro`,
    '-v', `${t.outDir}:/out`,
    '-v', `${CONTAINER}:/opt/driver:ro`,
    '-v', `${BASE_CONTAINER}:/opt/base:ro`,
    '-e', `ARM=${t.arm}`,
    '-e', 'SPEC=/spec/spec.json',
    '-e', `OBSERVE=${t.observe ? 1 : 0}`,
    ...(lazy
      ? [
          '-v', `${path.dirname(image.bootstrap)}:/boot:ro`,
          '-e', `REPO=${image.repo}`,
          '-e', 'BOOTSTRAP=/boot/boot.img',
          '-e', `PREFETCH_ALL=${t.prefetchAll}`,
          ...(t.prefetchFile ? ['-e', 'PREFETCH_FILES=/spec/prefetch.txt'] : []),
        ]
      : ['-v', `${t.eagerDir}:/eagerapp:ro`, '-e', 'EAGER_APP=/eagerapp']),
    RUNNER_IMAGE, 'bash', '/opt/driver/runner.sh',
  ];
  const res = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 2_400_000 });
  const stdout = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(path.join(t.outDir, 'runner.log'), stdout);
  const milestones: Record<string, number> = {};
  for (const m of stdout.matchAll(/^#M (\S+) (\d+)/gm)) milestones[m[1]!] = Number(m[2]);
  writeFileSync(
    path.join(t.outDir, 'trial.json'),
    JSON.stringify({ ...t, milestones, exit: res.status ?? -1 }, null, 1),
  );
  return { milestones, exit: res.status ?? -1 };
}

// --------------------------------------------------------------- observation

/**
 * One OBSERVATION run: the application on an EAGER mount with the experiment-2
 * observe-only tracer preloaded, driven by either the TRAIN stream or the
 * post-admission traffic stream.
 *
 * Observation runs are never measured trials: they are eager, they carry
 * instrumentation, and no timing from them enters any result. They exist to
 * produce (a) the TRAIN access log that G1/G2/R2 are allowed to see and (b) the
 * per-request first-touch ground truth the oracle and the per-category coverage
 * metrics are computed against.
 */
function observe(app: string, w: Workload, plan: LongtailPlan, mode: 'train' | 'test', family: number): {
  access: TrainAccess[];
  perRequest: { id: string; group: string | null; category: string | null; files: string[] }[];
} {
  const outDir = path.join(WORK_ROOT, 'observe', app, `${mode}-f${family}`);
  const r = runTrial(
    { app, arm: `OBS-${mode}`, budget: null, family, order: 0, outDir, prefetchFile: null, prefetchAll: false, eagerDir: path.join(WORK_ROOT, 'stage', app), observe: true, train: mode === 'train' },
    w,
    plan,
    { repo: '', bootstrap: '' },
  );
  const traceDir = path.join(outDir, 'trace');
  if (!existsSync(traceDir)) throw new Error(`[${app}] observation ${mode} produced no trace (exit ${r.exit})`);

  const first = new Map<string, number>();
  for (const f of readdirSync(traceDir)) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of readFileSync(path.join(traceDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let rec: { t?: string; real?: string; cls?: string; ts?: number };
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a process killed mid-write leaves one partial record
      }
      if (rec.t !== 'touch' || rec.cls !== 'content' || !rec.real) continue;
      const rel = rec.real.startsWith(`${APP_MOUNT}/`) ? rec.real.slice(APP_MOUNT.length + 1) : null;
      if (!rel) continue;
      const ts = rec.ts ?? 0;
      if (!first.has(rel) || ts < first.get(rel)!) first.set(rel, ts);
    }
  }
  const known = new Set(plan.files.map(([rel]) => rel));
  for (const rel of [...first.keys()]) if (!known.has(rel)) first.delete(rel);

  // Correct the tracer's one KNOWN, MEASURED blind spot (experiment 3 §8.1):
  // Node reads a package's package.json during resolution through the C++
  // binding `internalModuleReadJSON`, which no JS-level fs patch observes.
  // Omitting it would charge the arms that deliberately prefetch resolver
  // metadata for it as pure waste — a bias AGAINST the semantic arms.
  const pkgOf = new Map(plan.pkgOf);
  for (const [rel, ts] of [...first]) {
    const dir = pkgOf.get(rel);
    if (dir === undefined) continue;
    const pj = dir === '' ? 'package.json' : `${dir}/package.json`;
    if (!known.has(pj)) continue;
    const cur = first.get(pj);
    if (cur === undefined || ts < cur) first.set(pj, ts);
  }

  // Attribute first-touches to the request that caused them, by interleaving the
  // trace timeline with the driver's own per-request start timestamps.
  const events = existsSync(path.join(outDir, 'events.jsonl'))
    ? readFileSync(path.join(outDir, 'events.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  const reqs = events.filter((e) => e.ev === 'request' && e.pass === 1) as unknown as {
    id: string;
    group: string | null;
    category: string | null;
    startedAt: number;
    at: number;
  }[];
  const perRequest = reqs.map((q) => ({ id: q.id, group: q.group, category: q.category, files: [] as string[] }));
  const sorted = [...first].sort((a, b) => a[1] - b[1]);
  for (const [rel, ts] of sorted) {
    const i = reqs.findIndex((q) => ts >= q.startedAt && ts <= q.at);
    if (i >= 0) perRequest[i]!.files.push(rel);
  }
  return {
    access: sorted.map(([rel, firstMs]) => ({ rel, firstMs })),
    perRequest,
  };
}

// ------------------------------------------------------------------- prep

async function prep(app: string): Promise<void> {
  mkdirSync(path.join(WORK_ROOT, 'plans'), { recursive: true });
  mkdirSync(path.join(RUN, 'prefetch', app), { recursive: true });
  mkdirSync(path.join(RUN, 'prep'), { recursive: true });

  let plan: LongtailPlan;
  if (existsSync(planPath(app))) {
    plan = loadPlan(app);
    console.log(`[${app}] plan (cached): ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB`);
  } else {
    plan = await buildLongtailPlan(app);
    writeFileSync(planPath(app), JSON.stringify(plan));
    console.log(`[${app}] plan: ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB`);
  }
  const w = workloadFor(app, plan);

  // ---- ONE image for every arm. Nothing about a strategy reaches the image.
  const built = buildAllImages(app, plan.stage, { base: null }, { buildRoot: path.join(WORK_ROOT, 'images'), repoPrefix: REPO_PREFIX });
  const image = built.images.base!;
  console.log(`[${app}] image: blob ${(image.blobBytes / 1e6).toFixed(1)} MB, content ${built.contentDigest}`);

  // ---- TRAIN evidence (what G1/G2/R2 may see) and the held-out ground truth.
  const train = observe(app, w, plan, 'train', 0);
  const testByFamily: Record<number, ReturnType<typeof observe>> = {};
  for (let f = 0; f < FAMILIES; f++) testByFamily[f] = observe(app, w, plan, 'test', f);

  const size = new Map(plan.files);
  const bytesOf = (rels: Iterable<string>) => [...rels].reduce((a, r) => a + (size.get(r) ?? 0), 0);
  const trainSet = new Set(train.access.map((t) => t.rel));
  const neededUnion = new Map<string, number>();
  for (const f of Object.keys(testByFamily)) {
    for (const t of testByFamily[Number(f)]!.access) {
      const cur = neededUnion.get(t.rel);
      if (cur === undefined || t.firstMs < cur) neededUnion.set(t.rel, t.firstMs);
    }
  }
  const heldOut = [...neededUnion.keys()].filter((r) => !trainSet.has(r));
  console.log(
    `[${app}] TRAIN ${train.access.length} files / ${(bytesOf(trainSet) / 1e6).toFixed(1)} MB | ` +
      `TEST needs ${neededUnion.size} files / ${(bytesOf(neededUnion.keys()) / 1e6).toFixed(1)} MB, of which ` +
      `HELD-OUT ${heldOut.length} files / ${(bytesOf(heldOut) / 1e6).toFixed(1)} MB`,
  );

  // per-category held-out need sets, unioned over families (exact, order-free)
  const byCategory = new Map<string, Set<string>>();
  const byGroup = new Map<string, Set<string>>();
  for (let f = 0; f < FAMILIES; f++) {
    for (const q of testByFamily[f]!.perRequest) {
      if (!q.category || !q.group) continue;
      for (const rel of q.files) {
        if (trainSet.has(rel)) continue;
        if (!byCategory.has(q.category)) byCategory.set(q.category, new Set());
        byCategory.get(q.category)!.add(rel);
        if (!byGroup.has(q.group)) byGroup.set(q.group, new Set());
        byGroup.get(q.group)!.add(rel);
      }
    }
  }
  for (const [c, s] of [...byCategory].sort()) {
    console.log(`[${app}]   held-out ${c}: ${s.size} files / ${(bytesOf(s) / 1e6).toFixed(2)} MB`);
  }

  // ---- rankings, frozen here, before any measured trial of this app runs
  const rankings: Record<string, Ranking> = {
    G1: g1(plan, train.access),
    G2: g2(plan, train.access),
    R1: r1(plan),
    R2: r2(plan, train.access),
    O: oracle(plan, [...neededUnion].map(([rel, firstMs]) => ({ rel, firstMs }))),
  };
  for (const [arm, r] of Object.entries(rankings)) {
    writeFileSync(
      path.join(RUN, 'prefetch', app, `${arm}.ranking.json`),
      JSON.stringify({ app, arm, inputs: r.inputs, tiers: r.tiers, order: r.order }),
    );
  }

  const budgeted: Record<string, unknown> = {};
  for (const arm of [...STRATEGIES, 'O' as ArmName]) {
    for (const b of BUDGETS) {
      const t = truncate(rankings[arm]!, plan, b);
      const key = `${arm}@${b}`;
      const listPath = path.join(WORK_ROOT, 'prefetch', app, `${arm}.${b}.txt`);
      mkdirSync(path.dirname(listPath), { recursive: true });
      writeFileSync(listPath, `${t.files.map((r) => `/${r}`).join('\n')}\n`);
      const chosen = new Set(t.files);
      const covered = t.files.filter((r) => neededUnion.has(r));
      const missed = [...neededUnion.keys()].filter((r) => !chosen.has(r));
      budgeted[key] = {
        arm,
        budget: b,
        budgetBytes: t.budgetBytes,
        files: t.files.length,
        bytes: t.bytes,
        stoppedInTier: t.stoppedInTier,
        coveredNeededFiles: covered.length,
        coveredNeededBytes: bytesOf(covered),
        missNeededFiles: missed.length,
        missNeededBytes: bytesOf(missed),
        listPath,
      };
    }
  }
  console.log(
    `[${app}] budgeted lists written for ${STRATEGIES.length + 1} rankings × ${BUDGETS.length} budgets`,
  );

  writeFileSync(
    path.join(RUN, 'prep', `${app}.json`),
    JSON.stringify(
      {
        app,
        sha: appSha(app),
        criterion: appByName(app).criterion,
        mechanisms: appByName(app).mechanisms,
        kind: appByName(app).kind,
        universe: { files: plan.files.length, bytes: plan.universeBytes },
        staged: plan.staged,
        nft: plan.nft.length,
        planBHot: plan.planBHot.length,
        packages: new Set(plan.pkgOf.map(([, d]) => d)).size,
        depReachablePackages: plan.pkgDepth.length,
        image: { repo: image.repo, blob: image.blob, blobBytes: image.blobBytes, bootstrapBytes: image.bootstrapBytes },
        contentDigest: built.contentDigest,
        train: { files: train.access.length, bytes: bytesOf(trainSet) },
        neededTest: { files: neededUnion.size, bytes: bytesOf(neededUnion.keys()) },
        heldOut: { files: heldOut.length, bytes: bytesOf(heldOut) },
        heldOutByCategory: Object.fromEntries(
          [...byCategory].map(([c, s]) => [c, { files: s.size, bytes: bytesOf(s) }]),
        ),
        heldOutByGroup: Object.fromEntries([...byGroup].map(([g, s]) => [g, { files: s.size, bytes: bytesOf(s) }])),
        rankingInputs: Object.fromEntries(Object.entries(rankings).map(([a, r]) => [a, r.inputs])),
        budgeted,
        stream: { length: STREAM_LENGTH, families: FAMILIES, passes: 2 },
        warnings: plan.warnings.slice(0, 20),
        workloadNotes: w.notes,
        longTail: w.longTail.map((g) => ({ id: g.id, category: g.category, why: g.why, mechanism: g.mechanism, requests: g.requests.map((q) => `${q.method} ${q.path}`) })),
      },
      null,
      1,
    ),
  );
  writeFileSync(path.join(WORK_ROOT, 'observe', app, 'train.json'), JSON.stringify(train));
  writeFileSync(
    path.join(WORK_ROOT, 'observe', app, 'test.json'),
    JSON.stringify({ neededUnion: [...neededUnion], byCategory: [...byCategory].map(([c, s]) => [c, [...s]]), byGroup: [...byGroup].map(([g, s]) => [g, [...s]]), families: testByFamily }),
  );
}

// ----------------------------------------------------------------- trials

interface Cell {
  arm: string;
  budget: number | null;
  family: number;
  prefetchAll: boolean;
}

/**
 * The measured cells, in a deterministic but INTERLEAVED order: the whole
 * (arm × budget × family) grid is walked family-major with the arm order
 * rotated per family, so no arm systematically follows another and no arm
 * occupies a contiguous block of wall-clock time.
 */
export function cells(strategies: ArmName[], budgets: number[]): Cell[] {
  const out: Cell[] = [];
  for (let f = 0; f < FAMILIES; f++) {
    out.push({ arm: 'E0', budget: null, family: f, prefetchAll: true });
    for (const b of budgets) {
      const rot = strategies.map((_, i) => strategies[(i + f) % strategies.length]!);
      for (const arm of rot) out.push({ arm, budget: b, family: f, prefetchAll: false });
    }
  }
  return out;
}

function trials(app: string, only: ArmName[] | null, budgets: number[]): void {
  shapeNetwork();
  const plan = loadPlan(app);
  const w = workloadFor(app, plan);
  const prepped = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.json`), 'utf8'));
  const image = { repo: prepped.image.repo as string, bootstrap: path.join(WORK_ROOT, 'images', app, 'base', 'boot.img') };
  const outRoot = path.join(RUN, 'trials', app);
  mkdirSync(outRoot, { recursive: true });

  const grid = cells(only ?? STRATEGIES, budgets);
  const index: unknown[] = [];
  let order = 0;
  const t0 = Date.now();
  for (const c of grid) {
    const name = c.budget === null ? `${c.arm}.f${c.family}` : `${c.arm}.b${c.budget}.f${c.family}`;
    const outDir = path.join(outRoot, name);
    const prefetchFile =
      c.budget === null ? null : path.join(WORK_ROOT, 'prefetch', app, `${c.arm}.${c.budget}.txt`);
    const r = runTrial(
      { app, arm: c.arm, budget: c.budget, family: c.family, order: order++, outDir, prefetchFile, prefetchAll: c.prefetchAll },
      w,
      plan,
      image,
    );
    const m = r.milestones;
    const rel = (k: string) => (m[k] && m.t0 ? m[k]! - m.t0! : null);
    console.log(
      `[${app}] ${name.padEnd(20)} exit=${r.exit} t0→proc ${rel('proc')}ms t0→prewarm ${rel('prewarm')}ms t0→done ${rel('workload-done')}ms`,
    );
    index.push({ ...c, name, order: order - 1, milestones: m, exit: r.exit });
    writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 1));
  }
  console.log(`[${app}] ${grid.length} trials in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

// ------------------------------------------------------------------- main

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { app: { type: 'string' }, all: { type: 'boolean' }, only: { type: 'string' }, budgets: { type: 'string' } },
  });
  const cmd = positionals[0];
  const apps = values.all ? APPS.map((a) => a.name) : [values.app!];
  const only = values.only ? (values.only.split(',') as ArmName[]) : null;
  const budgets = values.budgets ? values.budgets.split(',').map(Number) : BUDGETS;
  mkdirSync(RUN, { recursive: true });
  for (const app of apps) {
    if (cmd === 'prep') {
      shapeNetwork();
      await prep(app);
    } else if (cmd === 'trials') trials(app, only, budgets);
    else throw new Error(`unknown command '${cmd}' (prep | trials)`);
  }
}
