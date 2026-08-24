/**
 * In-container workload driver for the lazy-OCI experiment.
 *
 * Runs entirely from the CONTAINER IMAGE (Node builtins + a pinned
 * socket.io-client), never from the lazy mount, so the driver's own module
 * loads are never charged to the application's remote-fetch account.
 *
 * One clock for everything: readiness, per-request latency and the milestone
 * stream all come from this process, so no host/VM clock offset can enter a
 * measured number.
 *
 * argv: driver.mjs <spec.json> <mode: train|test> <out.jsonl>
 */
import { appendFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , specPath, mode, outPath] = process.argv;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const rec = (o) => appendFileSync(outPath, `${JSON.stringify({ ...o, at: Date.now() })}\n`);

const interpolate = (s, state) => String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => state.get(k) ?? m);

function extract(text, res, expr) {
  try {
    if (expr.startsWith('json:')) {
      let v = JSON.parse(text);
      for (const seg of expr.slice(5).split('.')) {
        if (v == null) return null;
        v = v[seg];
      }
      return v == null ? null : String(v);
    }
    if (expr.startsWith('cookie:')) {
      const want = expr.slice(7);
      const list = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''].filter(Boolean);
      for (const c of list) {
        const pair = c.split(';', 1)[0].trim();
        const eq = pair.indexOf('=');
        if (eq > 0 && pair.slice(0, eq) === want) return pair.slice(eq + 1);
      }
      return null;
    }
    if (expr.startsWith('header:')) {
      const name = expr.slice(7);
      if (name.toLowerCase() === 'set-cookie') {
        const list = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''].filter(Boolean);
        const pairs = list.map((c) => c.split(';', 1)[0].trim()).filter(Boolean);
        return pairs.length > 0 ? pairs.join('; ') : null;
      }
      return res.headers.get(name);
    }
    if (expr.startsWith('regex:')) return new RegExp(expr.slice(6)).exec(text)?.[1] ?? null;
  } catch {
    /* the app answered something else; the capture simply fails */
  }
  return null;
}

const tcpOpen = (port) =>
  new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v) => {
      s.destroy();
      res(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });

async function waitReady() {
  const r = spec.ready;
  const deadline = Date.now() + r.timeoutMs;
  while (Date.now() < deadline) {
    if (r.kind === 'http') {
      try {
        const res = await fetch(r.value, { signal: AbortSignal.timeout(3000) });
        if (res.status < 500) {
          await res.arrayBuffer();
          return true;
        }
      } catch {
        /* not up yet */
      }
    } else if (r.kind === 'stdout') {
      let log = '';
      try {
        log = readFileSync(spec.appLog, 'utf8');
      } catch {
        /* not created yet */
      }
      if (new RegExp(r.value).test(log)) return true;
    } else if (r.kind === 'tcp') {
      if (await tcpOpen(r.port)) return true;
    } else {
      await sleep(5000);
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function runRequests(reqs, base, state, phase) {
  for (const r of reqs) {
    const t = Date.now();
    const url = base + interpolate(r.path, state);
    const headers = { ...(r.headers ?? {}) };
    for (const k of Object.keys(headers)) headers[k] = interpolate(headers[k], state);
    let body;
    if (r.body !== undefined) {
      body = interpolate(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), state);
      headers['content-type'] ??= 'application/json';
    }
    let status = 'error';
    let bodyHash = null;
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
      bodyHash = `${text.length}:${[...text.slice(0, 4096)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
      if (r.capture) {
        for (const [name, expr] of Object.entries(r.capture)) {
          const v = extract(text, res, expr);
          if (v !== null) state.set(name, v);
        }
      }
    } catch (err) {
      status = `error:${String(err).slice(0, 120)}`;
    }
    rec({ ev: 'request', phase, method: r.method, path: r.path, status, ms: Date.now() - t, bodyHash });
    if (r.delayMs) await sleep(r.delayMs);
  }
}

/** socket.io phases are shipped as a node -e command; run it with the DRIVER's
 *  module path so it resolves socket.io-client from the container image. */
async function runCommand(cmd, phase, timeoutMs) {
  const { spawn } = await import('node:child_process');
  const t = Date.now();
  const code = await new Promise((res) => {
    const p = spawn('bash', ['-lc', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: '/opt/driver/node_modules' },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => p.kill('SIGKILL'), timeoutMs ?? 120_000);
    p.on('close', (c) => {
      clearTimeout(kill);
      rec({ ev: 'command', phase, code: c, ms: Date.now() - t, out: out.slice(-2000) });
      res(c);
    });
  });
  return code;
}

const state = new Map();
rec({ ev: 'driver-start', mode });
const ready = await waitReady();
rec({ ev: 'ready', ok: ready });
if (!ready) {
  rec({ ev: 'abort', why: 'ready-timeout' });
  process.exit(3);
}
if (spec.settleMs) await sleep(spec.settleMs);
rec({ ev: 'settled' });

for (const phase of spec.phases) {
  rec({ ev: 'phase-start', phase: phase.name });
  if (phase.command) await runCommand(phase.command, phase.name, phase.timeoutMs);
  else await runRequests(phase.requests ?? [], spec.baseUrl, state, phase.name);
  rec({ ev: 'phase-end', phase: phase.name });
}
rec({ ev: 'workload-done' });
process.exit(0);
