/**
 * The measurement semantics the hydration headline rests on. Each test exists
 * because its violation moves a reported number rather than crashing:
 *
 *  1. repeated access to one file is ONE hydration, not N (misses ≠ accesses);
 *  2. a metadata-only touch never counts as content hydration;
 *  3. a symlink alias and its target are ONE physical file, counted once;
 *  4. `open(…, 'w')` is a write, not a content read;
 *  5. a probe at a path that does not exist hydrates nothing;
 *  6. child processes and worker threads are traced, and stay attributable;
 *  7. the tracer's own I/O never appears in its own trace;
 *  8. total accesses survive SIGTERM (the summary is periodic, not exit-only).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realpath } from '@reducer/production-universe';

const TRACER = path.join(import.meta.dirname, '..', 'benchmarks', 'hydration', 'tracer.cjs');
const NODE = '/Users/sara/.asdf/installs/nodejs/24.19.0/bin/node';

interface Touch {
  t: string;
  real: string;
  via: string | null;
  cls: string;
  op: string;
  ord: number;
  ts: number;
  pid: number;
  tid: number;
}

function buildApp(): string {
  const root = realpath(mkdtempSync(path.join(tmpdir(), 'hyd-')));
  mkdirSync(path.join(root, 'node_modules', 'used'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'unused'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'target'), { recursive: true });
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  const pkg = (n: string) => JSON.stringify({ name: n, version: '1.0.0', main: 'index.js' });
  writeFileSync(path.join(root, 'node_modules', 'used', 'package.json'), pkg('used'));
  writeFileSync(path.join(root, 'node_modules', 'used', 'index.js'), 'module.exports = 1;');
  writeFileSync(path.join(root, 'node_modules', 'unused', 'package.json'), pkg('unused'));
  writeFileSync(path.join(root, 'node_modules', 'unused', 'index.js'), 'module.exports = 2;');
  writeFileSync(path.join(root, 'node_modules', 'target', 'package.json'), pkg('target'));
  writeFileSync(path.join(root, 'node_modules', 'target', 'index.js'), 'module.exports = 3;');
  symlinkSync(path.join(root, 'node_modules', 'target'), path.join(root, 'node_modules', 'alias'));
  writeFileSync(path.join(root, 'assets', 'data.txt'), 'x'.repeat(100));
  writeFileSync(
    path.join(root, 'child.cjs'),
    `require('${path.join(root, 'node_modules', 'used', 'index.js')}');\n`,
  );
  writeFileSync(
    path.join(root, 'worker.cjs'),
    `require('fs').readFileSync('${path.join(root, 'assets', 'data.txt')}');\n`,
  );
  writeFileSync(
    path.join(root, 'app.cjs'),
    `
const fs = require('fs');
const p = require('path');
const R = ${JSON.stringify(root)};
require('used'); require('used');                       // one hydration, two accesses
fs.readFileSync(p.join(R, 'assets/data.txt'));
fs.readFileSync(p.join(R, 'assets/data.txt'));           // repeat access
fs.statSync(p.join(R, 'assets/data.txt'));               // metadata on an already-content file
fs.existsSync(p.join(R, 'node_modules/unused/index.js'));// metadata ONLY — never read
fs.statSync(p.join(R, 'node_modules/unused/index.js'));
require(p.join(R, 'node_modules/alias/index.js'));       // symlinked alias of target
fs.openSync(p.join(R, 'assets/generated.bin'), 'w');     // a write, not a content read
try { fs.readFileSync(p.join(R, 'assets/absent.txt')); } catch {}
fs.readdirSync(p.join(R, 'assets'));
const { Worker } = require('worker_threads');
const w = new Worker(p.join(R, 'worker.cjs'));
w.on('exit', () => {
  require('child_process').execFileSync(process.execPath, [p.join(R, 'child.cjs')]);
  // stay alive so the harness's SIGTERM path (not a clean exit) is exercised
  setTimeout(() => {}, 3000);
});
`,
  );
  return root;
}

function runTraced(root: string, kill: boolean): { touches: Touch[]; procs: any[]; summaries: any[] } {
  const traceDir = path.join(root, '..', `trace-${path.basename(root)}`);
  mkdirSync(traceDir, { recursive: true });
  spawnSync(NODE, [path.join(root, 'app.cjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: kill ? 2500 : 20_000,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${TRACER}`,
      HYDRATION_TRACE_DIR: traceDir,
      HYDRATION_APP_ROOT: root,
      HYDRATION_RUN_LABEL: 'test:app',
    },
  });
  const touches: Touch[] = [];
  const procs: any[] = [];
  const summaries: any[] = [];
  for (const f of readdirSync(traceDir).filter((f) => f.endsWith('.ndjson'))) {
    for (const line of readFileSync(path.join(traceDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let r: any;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.t === 'touch') touches.push(r);
      else if (r.t === 'proc') procs.push(r);
      else if (r.t === 'summary' || r.t === 'end') summaries.push(r);
    }
  }
  return { touches, procs, summaries };
}

const ROOT = buildApp();
const RUN = runTraced(ROOT, true);
const contentOf = (rel: string) =>
  RUN.touches.filter((t) => t.real === path.join(ROOT, rel) && t.cls === 'content');
const anyOf = (rel: string) => RUN.touches.filter((t) => t.real === path.join(ROOT, rel));

describe('hydration tracer', () => {
  test('1: repeated access to one file is ONE content first-touch, not N', () => {
    // `used` is required twice and data.txt read twice; per process the tracer
    // may only ever record the FIRST content touch of each.
    const perProcess = new Map<string, number>();
    for (const t of contentOf('assets/data.txt')) {
      const k = `${t.pid}:${t.tid}`;
      perProcess.set(k, (perProcess.get(k) ?? 0) + 1);
    }
    expect([...perProcess.values()].every((n) => n === 1)).toBe(true);
    const mainPid = RUN.procs.find((p) => p.argv.some((a: string) => a.endsWith('app.cjs')))!.pid;
    expect(contentOf('node_modules/used/index.js').filter((t) => t.pid === mainPid && t.tid === 0)).toHaveLength(1);
  });

  test('2: a metadata-only file never gets a content touch', () => {
    const unused = anyOf('node_modules/unused/index.js');
    expect(unused.length).toBeGreaterThan(0);
    expect(unused.every((t) => t.cls === 'metadata')).toBe(true);
    expect(contentOf('node_modules/unused/index.js')).toHaveLength(0);
  });

  test('3: a symlinked alias resolves to the physical file — counted once, alias preserved', () => {
    const target = contentOf('node_modules/target/index.js');
    expect(target.length).toBeGreaterThan(0);
    // nothing is ever recorded under the alias path itself
    expect(RUN.touches.some((t) => t.real.includes('node_modules/alias/'))).toBe(false);
    // …but the path the app actually used is retained for diagnosis
    expect(RUN.touches.some((t) => (t.via ?? '').includes('node_modules/alias/'))).toBe(true);
  });

  test("4: open(…, 'w') is a write, never content hydration", () => {
    const gen = anyOf('assets/generated.bin');
    expect(gen.length).toBeGreaterThan(0);
    expect(gen.every((t) => t.cls === 'write')).toBe(true);
  });

  test('5: a read of a path that does not exist hydrates nothing', () => {
    expect(anyOf('assets/absent.txt')).toHaveLength(0);
  });

  test('6: worker threads and child processes are traced and stay attributable', () => {
    expect(RUN.procs.some((p) => p.isWorker === true)).toBe(true);
    const child = RUN.procs.find((p) => p.argv.some((a: string) => a.endsWith('child.cjs')));
    expect(child).toBeDefined();
    expect(child!.pid).not.toBe(RUN.procs.find((p) => p.argv.some((a: string) => a.endsWith('app.cjs')))!.pid);
    // the label is inherited through the environment, so role attribution holds
    expect(RUN.procs.every((p) => p.label === 'test:app')).toBe(true);
  });

  test('7: the tracer never records its own output file', () => {
    expect(RUN.touches.some((t) => t.real.includes('.ndjson'))).toBe(false);
  });

  test('8: total accesses survive SIGTERM — the summary is periodic, not exit-only', () => {
    // the app deliberately outlives its work and is killed; an exit-only
    // summary would leave every access total at 0 for exactly the apps that
    // matter (long-running servers).
    const main = RUN.procs.find((p) => p.argv.some((a: string) => a.endsWith('app.cjs')))!;
    const mine = RUN.summaries.filter((s) => s.pid === main.pid && s.tid === 0);
    expect(mine.length).toBeGreaterThan(0);
    const last = mine[mine.length - 1]!;
    expect(last.totalAccesses).toBeGreaterThan(last.uniqueFiles);
  });

  test('9: a directory listing is recorded against the directory, not its files', () => {
    const d = RUN.touches.filter((t) => t.real === path.join(ROOT, 'assets') && t.cls === 'dir');
    expect(d.length).toBeGreaterThan(0);
  });
});
