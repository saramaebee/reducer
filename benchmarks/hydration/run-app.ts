/**
 * Workload harness for the hydration experiment (ADR-0007 experiment 2).
 *
 * Starts ONE frozen corpus application from its pinned entry file under stock
 * Node with the observe-only tracer preloaded, drives whatever representative
 * workload that application already has, and records the phase boundaries as
 * absolute timestamps so first-touch events can be bucketed afterwards.
 *
 * It removes nothing, hides nothing and recovers nothing: the complete
 * production universe is on disk the whole time. The only thing the experiment
 * adds to the process is `--require tracer.cjs`.
 *
 * Phase boundaries are timestamps, not counters, and every one is written to
 * `run.json`, so alternative phase splits can be recomputed later from the same
 * event stream without re-running any application.
 *
 *   T0  process spawned
 *   T1  application reports ready (its own log line / its port / its health URL)
 *   T2  common workload complete
 *   T3  full available workload complete
 *
 * Usage:
 *   bun benchmarks/hydration/run-app.ts --app <name> [--out <dir>] [--keep-trace]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RECIPES, type HttpRequest, type Recipe } from './recipes.ts';
import { SNAPSHOT_ROOT, type SnapshotMeta } from './snapshot-plan.ts';

export const NODE_BIN = '/Users/sara/.asdf/installs/nodejs/24.19.0/bin/node';
export const TRACE_ROOT = '/Users/sara/.cache/reducer-hydration-v1/traces';
const TRACER = path.join(import.meta.dirname, 'tracer.cjs');

const nowMs = () => performance.timeOrigin + performance.now();

export interface PhaseRecord {
  name: string;
  startTs: number;
  endTs: number;
  /** what was actually exercised, for the workload-quality record */
  detail: string;
  requests?: { method: string; path: string; status: number | string; ms: number }[];
  command?: { cmd: string; exitCode: number | null; ms: number; stdoutTail: string };
  reachedGoal: boolean;
}

export interface RunRecord {
  app: string;
  recipeQuality: Recipe['quality'];
  recipeNotes: string;
  startedAt: string;
  nodeBin: string;
  nodeVersion: string;
  cloneRoot: string;
  universeRoot: string;
  argv: string[];
  cwd: string;
  envKeys: string[];
  traceDir: string;
  t0: number;
  ready: { ok: boolean; ts: number | null; how: string; waitedMs: number };
  phases: PhaseRecord[];
  shutdown: { signal: string; exitCode: number | null; exitSignal: string | null; ms: number };
  stdoutTail: string;
  stderrTail: string;
  failure: string | null;
  deviations: string[];
}

function tail(s: string, n = 4000): string {
  return s.length <= n ? s : `…(${s.length - n} bytes elided)…\n${s.slice(-n)}`;
}

async function waitForPort(port: number, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: '127.0.0.1' });
      s.setTimeout(500);
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.on('timeout', () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await Bun.sleep(150);
  }
  return false;
}

async function waitForHttp(url: string, timeoutMs: number, alive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive()) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) {
        await r.arrayBuffer();
        return true;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  return false;
}

async function runRequests(
  reqs: HttpRequest[],
  base: string,
  state: Map<string, string>,
): Promise<PhaseRecord['requests']> {
  const out: PhaseRecord['requests'] = [];
  for (const r of reqs) {
    const t = nowMs();
    const url = base + interpolate(r.path, state);
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    for (const k of Object.keys(headers)) headers[k] = interpolate(headers[k]!, state);
    let body: string | undefined;
    if (r.body !== undefined) {
      body = interpolate(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), state);
      headers['content-type'] ??= 'application/json';
    }
    let status: number | string = 'error';
    try {
      const res = await fetch(url, {
        method: r.method,
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(r.timeoutMs ?? 30_000),
      });
      status = res.status;
      const text = await res.text();
      // A capture lets a later request use a token/id the app just minted —
      // the difference between "hit /login" and "actually exercise the app".
      if (r.capture) {
        for (const [name, expr] of Object.entries(r.capture)) {
          const v = extract(text, res, expr);
          if (v !== null) state.set(name, v);
        }
      }
    } catch (err) {
      status = `error:${String(err).slice(0, 120)}`;
    }
    out.push({ method: r.method, path: r.path, status, ms: Math.round(nowMs() - t) });
    if (r.delayMs) await Bun.sleep(r.delayMs);
  }
  return out;
}

function interpolate(s: string, state: Map<string, string>): string {
  return s.replace(/\{\{(\w+)\}\}/g, (m, k) => state.get(k) ?? m);
}

/** `json:a.b.c` | `header:set-cookie` | `cookie:<name>` | `regex:<pattern with one group>` */
function extract(text: string, res: Response, expr: string): string | null {
  try {
    if (expr.startsWith('json:')) {
      let v: any = JSON.parse(text);
      for (const seg of expr.slice(5).split('.')) {
        if (v == null) return null;
        v = v[seg];
      }
      return v == null ? null : String(v);
    }
    // One named cookie's value. Needed because some APIs accept the same token
    // as a Bearer header but apply CSRF protection to cookie transport, so
    // replaying the whole cookie jar fails writes that a Bearer would pass.
    if (expr.startsWith('cookie:')) {
      const want = expr.slice(7);
      const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      const list = all.length > 0 ? all : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
      for (const c of list) {
        const pair = c.split(';', 1)[0]!.trim();
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq) === want) return pair.slice(eq + 1);
      }
      return null;
    }
    if (expr.startsWith('header:')) {
      const name = expr.slice(7);
      // Set-Cookie is the one header that can legitimately repeat, and
      // `Headers.get` collapses or drops it depending on the runtime. Capturing
      // only one of several cookies (or none, on a 302) silently turns an
      // authenticated sweep into a wall of 401s, so build a proper Cookie
      // request header out of every cookie the response set.
      if (name.toLowerCase() === 'set-cookie') {
        const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        const list = all.length > 0 ? all : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
        const pairs = list.map((c) => c.split(';', 1)[0]!.trim()).filter(Boolean);
        return pairs.length > 0 ? pairs.join('; ') : null;
      }
      return res.headers.get(name);
    }
    if (expr.startsWith('regex:')) {
      const m = new RegExp(expr.slice(6)).exec(text);
      return m?.[1] ?? null;
    }
  } catch {
    /* the app answered something else; the capture simply fails */
  }
  return null;
}

async function main() {
  const { values } = parseArgs({
    options: { app: { type: 'string' }, out: { type: 'string' }, 'keep-trace': { type: 'boolean', default: false } },
  });
  const app = values.app;
  if (!app || !RECIPES[app]) {
    console.error(`usage: --app <name>; known: ${Object.keys(RECIPES).join(', ')}`);
    process.exit(1);
  }
  const recipe = RECIPES[app]!;
  const snap: SnapshotMeta = JSON.parse(readFileSync(path.join(SNAPSHOT_ROOT, app, 'meta.json'), 'utf8'));
  if (!snap.matchesFirstRun) {
    console.error(`[${app}] placement snapshot does not match the preserved first run; refusing to measure`);
    process.exit(2);
  }

  const outDir = values.out ?? path.join(import.meta.dirname, 'run-1', 'corpus');
  mkdirSync(outDir, { recursive: true });
  const traceDir = path.join(TRACE_ROOT, app);
  rmSync(traceDir, { recursive: true, force: true });
  mkdirSync(traceDir, { recursive: true });

  // an absolute `cwd` escapes the clone on purpose (an app that insists on a
  // writable working directory); a relative one is inside it
  const cwd = recipe.cwd ? (recipe.cwd.startsWith('/') ? recipe.cwd : path.join(snap.cloneRoot, recipe.cwd)) : snap.cloneRoot;
  const argv = recipe.argv.map((a) => a.replaceAll('{{clone}}', snap.cloneRoot));
  const deviations: string[] = [...(recipe.deviations ?? [])];

  // An out-of-clone cwd may be the very thing setup creates, and spawnSync with
  // a missing cwd fails every command with ENOENT before it runs.
  mkdirSync(cwd, { recursive: true });

  // Setup runs BEFORE the trace exists and without the preload: database
  // creation, migrations and seeding are experiment scaffolding, not
  // application execution, and must not appear in the app's working set.
  for (const cmd of recipe.setup ?? []) {
    const r = spawnSync('/bin/sh', ['-c', cmd.replaceAll('{{clone}}', snap.cloneRoot)], {
      cwd,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, ...recipe.env, PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH}` },
    });
    if (r.error || r.status !== 0) {
      deviations.push(
        `setup FAILED (status=${r.status}${r.error ? ` error=${String(r.error).slice(0, 200)}` : ''}): ${cmd} :: ${tail(String(r.stderr ?? ''), 400)}`,
      );
    }
  }

  const env: Record<string, string> = {
    ...process.env,
    ...Object.fromEntries(Object.entries(recipe.env).map(([k, v]) => [k, v.replaceAll('{{clone}}', snap.cloneRoot)])),
    PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH}`,
    NODE_OPTIONS: `--require ${TRACER}${recipe.env.NODE_OPTIONS ? ` ${recipe.env.NODE_OPTIONS}` : ''}`,
    HYDRATION_TRACE_DIR: traceDir,
    // the CLONE dir, not the universe root: a file under the clone but outside
    // the frozen universe is exactly the divergence this experiment must
    // record rather than silently drop
    HYDRATION_APP_ROOT: snap.cloneRoot,
    HYDRATION_RUN_LABEL: `${app}:app`,
  };

  // The frozen clones are measurement INPUTS: a workload that writes into a
  // tracked file (json-server persisting a POST) changes the universe the next
  // app's snapshot would walk. Record the pre-existing dirty set — some clones
  // are legitimately dirty from materialization (nodebb's copied
  // package.json) — so only what THIS run dirtied gets reverted afterwards.
  const dirtyTracked = (): Set<string> => {
    const r = spawnSync('git', ['-C', snap.cloneRoot, 'status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    return new Set(
      String(r.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3).trim()),
    );
  };
  const dirtyBefore = dirtyTracked();

  const t0 = nowMs();
  const child = spawn(NODE_BIN, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.on('exit', (c, s) => {
    exited = true;
    exitCode = c;
    exitSignal = s;
  });
  const alive = () => !exited;

  // ---- T1: ready
  const readyStart = nowMs();
  let readyOk = false;
  let how: string = recipe.ready.kind;
  if (recipe.ready.kind === 'stdout') {
    const re = new RegExp(recipe.ready.value!);
    const deadline = Date.now() + recipe.ready.timeoutMs;
    while (Date.now() < deadline && !exited) {
      if (re.test(stdout) || re.test(stderr)) {
        readyOk = true;
        break;
      }
      await Bun.sleep(100);
    }
    how = `stdout=/${recipe.ready.value}/`;
  } else if (recipe.ready.kind === 'tcp') {
    readyOk = await waitForPort(recipe.ready.port!, recipe.ready.timeoutMs, alive);
    how = `tcp=${recipe.ready.port}`;
  } else if (recipe.ready.kind === 'http') {
    readyOk = await waitForHttp(recipe.ready.value!, recipe.ready.timeoutMs, alive);
    how = `http=${recipe.ready.value}`;
  } else {
    // a non-server workload (a CLI) is "ready" the moment it is running
    readyOk = true;
    how = 'none (non-server entry)';
  }
  const t1 = nowMs();
  if (recipe.settleMs) await Bun.sleep(recipe.settleMs);

  const phases: PhaseRecord[] = [];
  const state = new Map<string, string>();
  const base = recipe.baseUrl ?? '';

  for (const ph of recipe.phases) {
    const startTs = nowMs();
    let requests: PhaseRecord['requests'];
    let command: PhaseRecord['command'];
    let reached = false;
    if (!readyOk && ph.requiresReady !== false) {
      phases.push({
        name: ph.name,
        startTs,
        endTs: nowMs(),
        detail: `${ph.detail} — SKIPPED (app never reported ready)`,
        reachedGoal: false,
      });
      continue;
    }
    if (ph.requests) {
      requests = await runRequests(ph.requests, base, state);
      reached = (requests ?? []).some((r) => typeof r.status === 'number' && r.status < 500);
    }
    if (ph.command) {
      const t = nowMs();
      // A workload runner is a SEPARATE process tree. It is traced (so its
      // accesses are visible) but the analysis attributes it separately from
      // the application's own tree — a test runner's own reads are not the
      // application's working set.
      const r = spawnSync('/bin/sh', ['-c', ph.command.replaceAll('{{clone}}', snap.cloneRoot)], {
        cwd,
        encoding: 'utf8',
        timeout: ph.timeoutMs ?? 900_000,
        env: { ...env, HYDRATION_RUN_LABEL: `${app}:workload:${ph.name}` },
        maxBuffer: 64 * 1024 * 1024,
      });
      command = {
        cmd: ph.command,
        exitCode: r.status,
        ms: Math.round(nowMs() - t),
        stdoutTail: tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, 3000),
      };
      reached = reached || r.status === 0;
    }
    phases.push({ name: ph.name, startTs, endTs: nowMs(), detail: ph.detail, requests, command, reachedGoal: reached });
  }

  // ---- shutdown. SIGTERM first so the app's own teardown runs; the tracer
  // flushes on a 100ms timer, so a hard kill costs at most that window.
  const tShut = nowMs();
  if (!exited) {
    child.kill('SIGTERM');
    for (let i = 0; i < 100 && !exited; i++) await Bun.sleep(100);
    if (!exited) {
      child.kill('SIGKILL');
      for (let i = 0; i < 50 && !exited; i++) await Bun.sleep(100);
    }
  }
  await Bun.sleep(400); // let the final flush land

  const dirtied = [...dirtyTracked()].filter((p) => !dirtyBefore.has(p));
  if (dirtied.length > 0) {
    const r = spawnSync('git', ['-C', snap.cloneRoot, 'checkout', '--', ...dirtied], { encoding: 'utf8', timeout: 300_000 });
    deviations.push(
      `workload wrote ${dirtied.length} tracked file(s) in the frozen clone (${dirtied.slice(0, 5).join(', ')}); ` +
        `reverted with git checkout (status=${r.status})`,
    );
  }

  const rec: RunRecord = {
    app,
    recipeQuality: recipe.quality,
    recipeNotes: recipe.notes,
    startedAt: new Date().toISOString(),
    nodeBin: NODE_BIN,
    nodeVersion: spawnSync(NODE_BIN, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    cloneRoot: snap.cloneRoot,
    universeRoot: snap.universeRoot,
    argv,
    cwd,
    envKeys: Object.keys(recipe.env),
    traceDir,
    t0,
    ready: { ok: readyOk, ts: readyOk ? t1 : null, how, waitedMs: Math.round(t1 - readyStart) },
    phases,
    shutdown: { signal: 'SIGTERM', exitCode, exitSignal, ms: Math.round(nowMs() - tShut) },
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
    failure: readyOk ? null : 'application never reported ready',
    deviations,
  };
  writeFileSync(path.join(outDir, `${app}.run.json`), JSON.stringify(rec, null, 2));
  console.log(
    `[${app}] ready=${readyOk} (${rec.ready.waitedMs}ms) phases=${phases.map((p) => `${p.name}:${p.reachedGoal ? 'ok' : 'X'}`).join(',')} exit=${exitCode ?? exitSignal}`,
  );
  if (!readyOk) {
    console.error(`[${app}] stdout tail:\n${tail(stdout, 1500)}`);
    console.error(`[${app}] stderr tail:\n${tail(stderr, 1500)}`);
  }
  if (!existsSync(traceDir)) console.error(`[${app}] NO TRACE DIRECTORY`);
}

// CLI only when executed directly: analyze.ts imports TRACE_ROOT and the
// RunRecord type from here, and an unguarded body would LAUNCH AN APPLICATION
// as a side effect of the analysis importing a type.
if (import.meta.main) await main();
