/** Shared harness helpers: boot a garden tree under stock node, replay contracts. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, cpSync } from 'node:fs';
import path from 'node:path';

export const GARDEN = path.resolve(import.meta.dirname, '..');
export const APP = path.join(GARDEN, 'app');

export interface BootedServer {
  base: string;
  kill: () => Promise<void>;
  stderr: () => string;
}

/**
 * Boot `server.mjs` in `dir` under stock node with the red-team module
 * injected via --import (the analyzed tree never references it; this is the
 * only way MUST_REMOVE symbols may be reached).
 */
export async function bootServer(dir: string, opts: { redteam?: boolean } = {}): Promise<BootedServer> {
  const redteam = opts.redteam ?? true;
  if (redteam && !existsSync(path.join(dir, '__redteam.mjs'))) {
    // reduced trees don't contain it (untraced by construction) — inject it.
    cpSync(path.join(APP, '__redteam.mjs'), path.join(dir, '__redteam.mjs'));
  }
  const args = redteam ? ['--import', './__redteam.mjs', 'server.mjs'] : ['server.mjs'];
  const child: ChildProcess = spawn('node', args, {
    cwd: dir,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrBuf = '';
  child.stderr!.on('data', (d) => { stderrBuf += String(d); });

  const base = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`server in ${dir} did not become ready in 20s\nstdout: ${out}\nstderr: ${stderrBuf}`));
    }, 20_000);
    child.stdout!.on('data', (d) => {
      out += String(d);
      const m = out.match(/garden-listening:(\d+)/);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server in ${dir} exited before ready (code ${code})\nstdout: ${out}\nstderr: ${stderrBuf}`));
    });
  });

  return {
    base,
    stderr: () => stderrBuf,
    kill: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref?.();
      }),
  };
}

export interface ContractEntry {
  path: string;
  status: number;
  contentType: string | null;
  body: string;
}

export interface Divergence {
  path: string;
  kind: 'status' | 'body' | 'fetch-error';
  expected: string;
  actual: string;
}

export async function fetchEntry(base: string, p: string): Promise<{ status: number; contentType: string | null; body: string }> {
  const res = await fetch(base + p);
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), body };
}

/** Replay recorded contracts; returns every divergence (byte-exact body compare). */
export async function replay(base: string, entries: ContractEntry[]): Promise<Divergence[]> {
  const out: Divergence[] = [];
  for (const e of entries) {
    try {
      const got = await fetchEntry(base, e.path);
      if (got.status !== e.status) {
        out.push({ path: e.path, kind: 'status', expected: String(e.status), actual: `${got.status} body=${got.body.slice(0, 200)}` });
      } else if (got.body !== e.body) {
        out.push({ path: e.path, kind: 'body', expected: e.body.slice(0, 200), actual: got.body.slice(0, 200) });
      }
    } catch (err) {
      out.push({ path: e.path, kind: 'fetch-error', expected: `${e.status}`, actual: String(err) });
    }
  }
  return out;
}
