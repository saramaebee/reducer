/**
 * In-container workload driver for the long-tail traffic-warm experiment.
 *
 * Runs entirely from the CONTAINER IMAGE (Node builtins only), never from the
 * lazy mount, so the driver's own module loads are never charged to the
 * application's remote-fetch account. One clock for everything: readiness,
 * admission, per-request latency and the milestone stream all come from this
 * process, so no host/VM clock offset can enter a measured number.
 *
 * The timeline it enforces — this is the whole point of the experiment:
 *
 *   t0                container start (stamped by runner.sh)
 *   t_proc            the application process is exec'd
 *   t_ready           the application's own readiness predicate passes
 *   t_prewarm         the substrate finishes the arm's permitted prewarm
 *   T_traffic         = max(t_ready, t_prewarm)  ← traffic is admitted HERE
 *   … pass 1 …        the measured post-admission stream
 *   … pass 2 …        the identical stream again, everything now resident:
 *                     this is the warmed reference for THIS arm
 *
 * Readiness alone is deliberately not the admission signal. A strategy that
 * reports Ready earlier by deferring work onto production requests has not won,
 * and admitting on Ready would reward exactly that.
 *
 * argv: driver.mjs <spec.json> <out.jsonl>
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , specPath, outPath] = process.argv;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const rec = (o) => appendFileSync(outPath, `${JSON.stringify({ ...o, at: Date.now() })}\n`);

// ─────────────────────────────────────────────────────── substrate telemetry

/** nydusd's admin API speaks HTTP over a unix socket; node's fetch cannot. */
function nydus(pathname) {
  if (!spec.apiSock || !existsSync(spec.apiSock)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.request({ socketPath: spec.apiSock, path: pathname, timeout: 5000 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve(null); // nydusd truncates large per-file responses
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function fetchState(label) {
  const [backend, blobcache] = await Promise.all([nydus('/api/v1/metrics/backend'), nydus('/api/v1/metrics/blobcache')]);
  rec({
    ev: 'fetch-state',
    label,
    remoteRequests: backend?.read_count ?? null,
    remoteBytes: backend?.read_amount_total ?? null,
    prefetchBytes: blobcache?.prefetch_data_amount ?? null,
    prefetchRequests: blobcache?.prefetch_requests_count ?? null,
  });
  return { remoteRequests: backend?.read_count ?? null, remoteBytes: backend?.read_amount_total ?? null };
}

// ─────────────────────────────────────────────────────────────── readiness

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
      await sleep(3000);
      return true;
    }
    await sleep(50);
  }
  return false;
}

/** runner.sh touches this the instant the substrate reports prewarm complete. */
async function waitPrewarm() {
  const deadline = Date.now() + (spec.prewarmTimeoutMs ?? 900_000);
  while (Date.now() < deadline) {
    if (existsSync(spec.prewarmMarker)) return true;
    await sleep(20);
  }
  return false;
}

// ──────────────────────────────────────────────────────────────── requests

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
    if (expr.startsWith('header:')) return res.headers.get(expr.slice(7));
    if (expr.startsWith('regex:')) return new RegExp(expr.slice(6)).exec(text)?.[1] ?? null;
  } catch {
    /* the app answered something else; the capture simply fails */
  }
  return null;
}

/** Cheap, order-insensitive body fingerprint; only ever compared arm-to-arm. */
const fingerprint = (text) => `${text.length}:${[...text.slice(0, 8192)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)}`;

async function issue(step, state, pass, index) {
  const url = spec.baseUrl + interpolate(step.path, state);
  const headers = {};
  for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = interpolate(v, state);
  let body;
  if (step.multipart) {
    const fd = new FormData();
    const bin = Buffer.from(step.multipart.base64, 'base64');
    fd.append(step.multipart.field, new Blob([bin], { type: step.multipart.contentType }), step.multipart.filename);
    body = fd; // fetch sets the boundary content-type itself
  } else if (step.body !== undefined) {
    body = interpolate(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), state);
    headers['content-type'] ??= 'application/json';
  }
  const t = Date.now();
  let status = 'error';
  let bodyHash = null;
  let headerValue = null;
  try {
    const res = await fetch(url, {
      method: step.method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(step.timeoutMs ?? 30_000),
    });
    status = res.status;
    if (step.compareHeader) headerValue = res.headers.get(step.compareHeader);
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf).toString('latin1');
    bodyHash = fingerprint(text);
    if (step.capture) {
      const utf8 = Buffer.from(buf).toString('utf8');
      for (const [name, expr] of Object.entries(step.capture)) {
        const v = extract(utf8, res, expr);
        if (v !== null) state.set(name, v);
      }
    }
  } catch (err) {
    status = `error:${String(err).slice(0, 140)}`;
  }
  const ms = Date.now() - t;
  rec({
    ev: 'request',
    pass,
    index,
    id: step.id,
    kind: step.kind,
    group: step.group,
    category: step.category,
    occurrence: step.occurrence,
    position: step.position,
    method: step.method,
    path: step.path,
    status,
    expect: step.expect,
    ok: Array.isArray(step.expect) ? step.expect.includes(status) : null,
    stableBody: step.stableBody !== false,
    bodyHash,
    headerValue,
    ms,
    startedAt: t,
  });
  return ms;
}

// ───────────────────────────────────────────────────────────────────── main

rec({ ev: 'driver-start', arm: spec.arm, budget: spec.budget, family: spec.family });

const readyAt = (async () => {
  const ok = await waitReady();
  rec({ ev: 'ready', ok });
  return ok;
})();
const prewarmAt = (async () => {
  const ok = await waitPrewarm();
  rec({ ev: 'prewarm', ok });
  return ok;
})();

const [readyOk, prewarmOk] = await Promise.all([readyAt, prewarmAt]);
if (!readyOk) {
  rec({ ev: 'abort', why: 'ready-timeout' });
  process.exit(3);
}
if (!prewarmOk) {
  rec({ ev: 'abort', why: 'prewarm-timeout' });
  process.exit(4);
}
if (spec.settleMs) await sleep(spec.settleMs);

await fetchState('at-admit');
rec({ ev: 'admit' });

const state = new Map();
let seq = 0;
for (const pass of [1, 2]) {
  rec({ ev: 'pass-start', pass });
  for (const [index, step] of spec.traffic.entries()) {
    // {{seq}} keeps repeatable write-path groups from colliding with themselves
    if (step.kind === 'longtail' && index > 0 && spec.traffic[index - 1]?.group !== step.group) seq++;
    state.set('seq', `${pass}${String(seq).padStart(4, '0')}`);
    await issue(step, state, pass, index);
  }
  rec({ ev: 'pass-end', pass });
  await fetchState(`after-pass-${pass}`);
}
rec({ ev: 'workload-done' });
process.exit(0);
