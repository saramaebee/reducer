/**
 * ADR-0007 experiment 3 runner: semantic placement on a commodity lazy-OCI
 * substrate. Preregistered in DESIGN.md; this file executes that design and
 * must not silently deviate from it.
 *
 *   prep(app)   plan → base image → ino map → TRAIN observation →
 *               prefetch strategies → per-arm images → content-identity proof
 *   trials(app) the measured HELD-OUT TEST runs, arms rotated per repetition
 *   expA(app)   full eager / closed NFT-traced / lazy-complete-with-NFT-residency
 *
 * Usage:
 *   bun benchmarks/lazy-oci/run.ts prep   --app <name>
 *   bun benchmarks/lazy-oci/run.ts trials --app <name> [--reps 5]
 *   bun benchmarks/lazy-oci/run.ts expa   --app <name>
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { APPS, appByName, appRoot, appSha } from './apps.ts';
import { NET, RUNNER_IMAGE, buildAllImages, type BuiltImage } from './images.ts';
import { WORK_ROOT, buildPlan, type AppPlan } from './plan.ts';
import { b2Generic, b2dGenericDir, b3aStatic, b3bSemantic, nftOnly, type Strategy, type TrainAccess } from './prefetch.ts';
import { APP_MOUNT, linuxRecipe } from './recipes-linux.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const PREP = path.join(WORK_ROOT, 'prep');
const CONTAINER = path.join(import.meta.dirname, 'container');

/** Network profile. One profile for every arm of every app (DESIGN.md §2.2). */
export const NETEM = { delayMs: 25, rateMbit: 100 };

/**
 * Shape the REGISTRY's egress — the direction blob bytes actually travel.
 * `tc netem rate` limits only the direction it is attached to, so shaping the
 * app container instead would delay its (tiny) range requests while leaving
 * the response bandwidth unlimited: a lazy-loading benchmark in which
 * downloading is free. Applied once, identically for every arm and app.
 */
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

const sh = (args: string[], timeout = 3_600_000): string =>
  execFileSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout });

// --------------------------------------------------------------- arm table

export interface Arm {
  name: string;
  image: 'base' | 'B2' | 'B2d' | 'B3a' | 'B3b' | 'A3';
  prefetch: boolean;
  prefetchAll: boolean;
  waitAll: boolean;
}

export const ARMS: Arm[] = [
  // the docker-pull-then-run analogue: nothing starts until the image is local
  { name: 'B0', image: 'base', prefetch: true, prefetchAll: true, waitAll: true },
  { name: 'B1', image: 'base', prefetch: false, prefetchAll: false, waitAll: false },
  { name: 'B2', image: 'B2', prefetch: true, prefetchAll: false, waitAll: false },
  { name: 'B2d', image: 'B2d', prefetch: true, prefetchAll: false, waitAll: false },
  { name: 'B3a', image: 'B3a', prefetch: true, prefetchAll: false, waitAll: false },
  { name: 'B3b', image: 'B3b', prefetch: true, prefetchAll: false, waitAll: false },
];

// ------------------------------------------------------------------- spec

function specFor(app: string, mode: 'train' | 'test'): unknown {
  const r = linuxRecipe(app);
  const phases = (mode === 'train' ? r.train : r.test).map((p) => ({
    name: p.name,
    requests: p.requests,
    command: p.command,
    timeoutMs: p.timeoutMs,
  }));
  return {
    app,
    mode,
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup: r.setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    appLog: '/work/app.log',
    phases,
  };
}

/**
 * Per-trial external-service reset (cold-start discipline, DESIGN.md §9).
 * Runs on the host BEFORE t0, so no arm is charged for it and no arm inherits
 * another arm's database state. The recipe's own in-container setup then
 * migrates/seeds against the eager copy.
 */
function resetServices(app: string): void {
  const a = appByName(app);
  if (!a.services.includes('pg')) return;
  const url = linuxRecipe(app).env.DATABASE_URL ?? '';
  const db = /\/([^/?]+)(\?|$)/.exec(url)?.[1];
  if (!db) throw new Error(`[${app}] declares a pg service but no database name is derivable from DATABASE_URL`);
  sh(['docker', 'exec', 'reducer-pg', 'psql', '-U', 'reducer', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS "${db}"`], 120_000);
  sh(['docker', 'exec', 'reducer-pg', 'psql', '-U', 'reducer', '-d', 'postgres', '-c', `CREATE DATABASE "${db}"`], 120_000);
}

// ------------------------------------------------------------------ trial

export interface TrialResult {
  app: string;
  arm: string;
  mode: 'train' | 'test';
  rep: number;
  order: number;
  outDir: string;
  milestones: Record<string, number>;
  exit: number;
}

export function runTrial(opts: {
  app: string;
  armName: string;
  /** lazy arm: the image and its prefetch behaviour */
  arm?: Arm;
  image?: BuiltImage;
  /** eager arm (A1/A2): a plain directory bind-mounted instead of a lazy mount */
  eagerDir?: string;
  mode: 'train' | 'test';
  rep: number;
  order: number;
  outDir: string;
  observe?: boolean;
}): TrialResult {
  const { app, arm, image, mode, outDir } = opts;
  resetServices(app);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const specDir = path.join(outDir, 'spec');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(path.join(specDir, 'spec.json'), JSON.stringify(specFor(app, mode), null, 1));

  const stage = path.join(WORK_ROOT, 'stage', app);
  const lazy = !opts.eagerDir;
  if (lazy && (!arm || !image)) throw new Error('a lazy trial needs an arm and an image');
  const args = [
    'docker', 'run', '--rm', '--platform', 'linux/arm64', '--privileged', '--network', NET,
    '--tmpfs', '/scratch:size=6g',
    '-v', 'reducer-work:/work',
    '-v', `${stage}:/eager:ro`,
    '-v', `${specDir}:/spec:ro`,
    '-v', `${outDir}:/out`,
    '-e', `ARM=${opts.armName}`,
    '-e', `MODE=${mode}`,
    '-e', 'SPEC=/spec/spec.json',
    '-e', `OBSERVE=${opts.observe ? 1 : 0}`,
    ...(lazy
      ? [
          '-v', `${path.dirname(image!.bootstrap)}:/boot:ro`,
          '-e', `REPO=${image!.repo}`,
          '-e', `BLOB=${image!.blob}`,
          '-e', `PREFETCH=${arm!.prefetch}`,
          '-e', `PREFETCH_ALL=${arm!.prefetchAll}`,
          '-e', `WAIT_ALL=${arm!.waitAll ? 1 : 0}`,
          '-e', 'BOOTSTRAP=/boot/boot.img',
        ]
      : ['-v', `${opts.eagerDir}:/eagerapp:ro`, '-e', 'EAGER_APP=/eagerapp']),
    RUNNER_IMAGE, 'bash', '/opt/driver/runner.sh',
  ];
  const res = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1_800_000 });
  const stdout = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  writeFileSync(path.join(outDir, 'runner.log'), stdout);
  const milestones: Record<string, number> = {};
  for (const m of stdout.matchAll(/^#M (\S+) (\d+)/gm)) milestones[m[1]!] = Number(m[2]);
  return { app, arm: opts.armName, mode, rep: opts.rep, order: opts.order, outDir, milestones, exit: res.status ?? -1 };
}

// ------------------------------------------------------------------- prep

/**
 * One OBSERVATION run: the application on an EAGER mount with the experiment-2
 * observe-only tracer preloaded, driven by `mode`'s workload.
 *
 * Why not the substrate's own telemetry: nydusd truncates
 * `/api/v1/metrics/files` at ~290 KB, so for any real application the per-file
 * response is unparseable. The tracer records exactly the same class of
 * information — which file's CONTENT was read, and when — at the filesystem
 * layer, with no Node semantics exposed to whoever consumes it.
 *
 * Observation runs are never measured trials: they are eager, they carry
 * instrumentation, and no timing from them enters any result.
 */
function observe(app: string, mode: 'train' | 'test'): TrainAccess[] {
  const plan: AppPlan = JSON.parse(readFileSync(path.join(WORK_ROOT, 'plans', `${app}.json`), 'utf8'));
  const outDir = path.join(PREP, app, `observe-${mode}`);
  const r = runTrial({ app, armName: `OBS-${mode}`, eagerDir: plan.stage, mode, rep: 0, order: 0, outDir, observe: true });
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

  // Correct a KNOWN, MEASURED instrumentation blind spot: Node reads a
  // package's package.json during resolution through the C++ binding
  // `internalModuleReadJSON`, which no JS-level fs patch can observe. Against
  // nydus's own per-file telemetry on json-server the tracer saw 94 files and
  // the substrate 133 — and the 39 it missed were EXACTLY the package.json of
  // every package it resolved into. Adding the owning package's package.json
  // per touched file reproduces the substrate set exactly (133/133).
  // Leaving it out would understate what resolver-metadata prefetching is
  // worth, i.e. would bias the comparison AGAINST the Reducer arms.
  const pkgOf = new Map(plan.pkgOf);
  for (const [rel, ts] of [...first]) {
    const dir = pkgOf.get(rel);
    if (dir === undefined) continue;
    const pj = dir === '' ? 'package.json' : `${dir}/package.json`;
    if (!known.has(pj)) continue;
    const cur = first.get(pj);
    if (cur === undefined || ts < cur) first.set(pj, ts);
  }
  return [...first].map(([rel, firstMs]) => ({ rel, firstMs })).sort((a, b) => a.firstMs - b.firstMs);
}

async function prep(app: string): Promise<void> {
  mkdirSync(PREP, { recursive: true });
  mkdirSync(path.join(RUN, 'prefetch'), { recursive: true });
  const planFile = path.join(WORK_ROOT, 'plans', `${app}.json`);
  let plan: AppPlan;
  if (existsSync(planFile)) {
    plan = JSON.parse(readFileSync(planFile, 'utf8'));
    console.log(`[${app}] plan (cached): ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB`);
  } else {
    plan = await buildPlan(app);
    mkdirSync(path.join(WORK_ROOT, 'plans'), { recursive: true });
    writeFileSync(planFile, JSON.stringify(plan));
    console.log(`[${app}] plan: ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB`);
  }

  // ---- TRAIN evidence (what B2/B2d/B3b are allowed to see) and the held-out
  // ground truth (what the metrics in §8 are computed against). Both come from
  // eager, instrumented observation runs — never from a measured trial.
  const train = observe(app, 'train');
  const neededTest = observe(app, 'test');
  const sizeOf = new Map(plan.files);
  const trainBytes = train.reduce((a, x) => a + (sizeOf.get(x.rel) ?? 0), 0);
  const testBytes = neededTest.reduce((a, x) => a + (sizeOf.get(x.rel) ?? 0), 0);
  const trainSet = new Set(train.map((t) => t.rel));
  const heldOutOnly = neededTest.filter((t) => !trainSet.has(t.rel));
  console.log(
    `[${app}] TRAIN ${train.length} files / ${(trainBytes / 1e6).toFixed(1)} MB | ` +
      `TEST needs ${neededTest.length} files / ${(testBytes / 1e6).toFixed(1)} MB, of which ` +
      `${heldOutOnly.length} files / ${(heldOutOnly.reduce((a, x) => a + (sizeOf.get(x.rel) ?? 0), 0) / 1e6).toFixed(1)} MB are TEST-only`,
  );

  // ---- strategies, frozen before any TEST result is looked at
  const strategies: Strategy[] = [
    b2Generic(train),
    b2dGenericDir(plan, train),
    b3aStatic(plan),
    b3bSemantic(plan, train),
    nftOnly(plan),
  ];
  for (const s of strategies) {
    const bytes = s.files.reduce((a, r) => a + (sizeOf.get(r) ?? 0), 0);
    console.log(`[${app}] ${s.arm}: ${s.files.length} files / ${(bytes / 1e6).toFixed(1)} MB`);
    writeFileSync(
      path.join(RUN, 'prefetch', `${app}.${s.arm}.json`),
      JSON.stringify({ app, arm: s.arm, inputs: s.inputs, files: s.files.length, bytes, list: s.files }),
    );
  }
  // Every arm's image is built in ONE container pass from one local copy of
  // the staging tree, and each is proven content-identical before any trial.
  const armLists: Record<string, string[] | null> = { base: null };
  for (const st of strategies) armLists[st.arm === 'A' ? 'A3' : st.arm] = st.files;
  for (const [arm, list] of Object.entries(armLists)) {
    mkdirSync(path.join(WORK_ROOT, 'images', app, arm), { recursive: true });
    if (list) writeFileSync(path.join(WORK_ROOT, 'images', app, arm, 'prefetch.txt'), `${list.map((r) => `/${r}`).join('\n')}\n`);
  }
  const built = buildAllImages(app, plan.stage, armLists);
  const images = built.images;
  console.log(
    `[${app}] images: ${Object.entries(images).map(([k, v]) => `${k} ${(v.blobBytes / 1e6).toFixed(0)}MB`).join(' | ')}`,
  );
  console.log(`[${app}] content identity proven across ${Object.keys(images).length} arms: ${built.contentDigest}`);

  mkdirSync(path.join(RUN, 'prep'), { recursive: true });
  writeFileSync(
    path.join(RUN, 'prep', `${app}.json`),
    JSON.stringify(
      {
        app,
        sha: appSha(app),
        tree: appByName(app).tree,
        criterion: appByName(app).criterion,
        universe: { files: plan.files.length, bytes: plan.universeBytes },
        staged: plan.staged,
        nft: plan.nft.length,
        planBHot: plan.planBHot.length,
        train: { files: train.length, bytes: trainBytes },
        neededTest: { files: neededTest.length, bytes: testBytes, testOnlyFiles: heldOutOnly.length },
        images: Object.fromEntries(
          Object.entries(images).map(([k, v]) => [
            k,
            { blob: v.blob, blobBytes: v.blobBytes, bootstrapBytes: v.bootstrapBytes, prefetchFiles: v.prefetchFiles },
          ]),
        ),
        contentDigest: built.contentDigest,
        warnings: plan.warnings,
      },
      null,
      1,
    ),
  );
  writeFileSync(path.join(PREP, `${app}.train.json`), JSON.stringify(train));
  writeFileSync(path.join(PREP, `${app}.needed-test.json`), JSON.stringify(neededTest));
}

// ----------------------------------------------------------------- trials

function trials(app: string, reps: number): void {
  shapeNetwork();
  const prepFile = path.join(RUN, 'prep', `${app}.json`);
  const prepped = JSON.parse(readFileSync(prepFile, 'utf8'));
  const outRoot = path.join(RUN, 'trials', app);
  mkdirSync(outRoot, { recursive: true });
  const imageOf = (arm: Arm): BuiltImage => ({
    app,
    arm: arm.image,
    repo: `lazyoci/${app}`,
    blob: prepped.images[arm.image].blob,
    blobBytes: prepped.images[arm.image].blobBytes,
    bootstrap: path.join(WORK_ROOT, 'images', app, arm.image, 'boot.img'),
    bootstrapBytes: prepped.images[arm.image].bootstrapBytes,
    prefetchFiles: prepped.images[arm.image].prefetchFiles,
    prefetchBytes: 0,
  });
  const index: TrialResult[] = [];
  let order = 0;
  for (let rep = 1; rep <= reps; rep++) {
    // rotate so no arm systematically follows another (attack #14)
    const rot = ARMS.map((_, i) => ARMS[(i + rep - 1) % ARMS.length]!);
    for (const arm of rot) {
      const outDir = path.join(outRoot, `${arm.name}.rep${rep}`);
      const r = runTrial({ app, armName: arm.name, arm, image: imageOf(arm), mode: 'test', rep, order: order++, outDir });
      const ready = r.milestones.workloadDone ?? 0;
      console.log(
        `[${app}] ${arm.name} rep${rep} exit=${r.exit} ` +
          `t0→proc ${(r.milestones.proc ?? 0) - (r.milestones.t0 ?? 0)}ms ` +
          `t0→done ${(r.milestones['workload-done'] ?? ready) - (r.milestones.t0 ?? 0)}ms`,
      );
      index.push(r);
      writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 1));
    }
  }
}

// ------------------------------------------------------------ experiment A

function expA(app: string): void {
  shapeNetwork();
  const plan: AppPlan = JSON.parse(readFileSync(path.join(WORK_ROOT, 'plans', `${app}.json`), 'utf8'));
  const prepped = JSON.parse(readFileSync(path.join(RUN, 'prep', `${app}.json`), 'utf8'));
  const outRoot = path.join(RUN, 'expA', app);
  mkdirSync(outRoot, { recursive: true });
  const a2 = path.join(WORK_ROOT, 'a2', app);
  if (!existsSync(a2)) throw new Error(`A2 tree missing for ${app}; run: bun benchmarks/lazy-oci/a2.ts --app ${app}`);
  // A3: the SAME placement decision as A2 (the closed NFT trace), but expressed
  // as initial residency inside a COMPLETE immutable image. A2 vs A3 is
  // therefore a clean test of recoverability, not of prediction quality.
  const a3Arm: Arm = { name: 'A3', image: 'A3', prefetch: true, prefetchAll: false, waitAll: false };
  const a3Image: BuiltImage = {
    app,
    arm: 'A3',
    repo: `lazyoci/${app}`,
    blob: prepped.images.A3.blob,
    blobBytes: prepped.images.A3.blobBytes,
    bootstrap: path.join(WORK_ROOT, 'images', app, 'A3', 'boot.img'),
    bootstrapBytes: prepped.images.A3.bootstrapBytes,
    prefetchFiles: prepped.images.A3.prefetchFiles,
    prefetchBytes: 0,
  };
  const results: TrialResult[] = [];
  for (const mode of ['train', 'test'] as const) {
    for (const name of ['A1', 'A2', 'A3'] as const) {
      const outDir = path.join(outRoot, `${name}.${mode}`);
      const r =
        name === 'A3'
          ? runTrial({ app, armName: 'A3', arm: a3Arm, image: a3Image, mode, rep: 0, order: 0, outDir })
          : runTrial({
              app,
              armName: name,
              eagerDir: name === 'A1' ? plan.stage : a2,
              mode,
              rep: 0,
              order: 0,
              outDir,
            });
      results.push(r);
      console.log(`[${app}] ${name}/${mode} exit=${r.exit}`);
      writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(results, null, 1));
    }
  }
}

// ------------------------------------------------------------------- main

if (import.meta.main) {
    const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { app: { type: 'string' }, all: { type: 'boolean' }, reps: { type: 'string' } },
  });
  const cmd = positionals[0];
  const apps = values.all ? APPS.map((a) => a.name) : [values.app!];
  mkdirSync(RUN, { recursive: true });
  for (const app of apps) {
    if (cmd === 'prep') {
      shapeNetwork();
      await prep(app);
    }
    else if (cmd === 'trials') trials(app, Number(values.reps ?? 5));
    else if (cmd === 'expa') expA(app);
    else throw new Error(`unknown command '${cmd}' (prep | trials | expa)`);
  }
  }
