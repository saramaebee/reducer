/**
 * Hydration tracer (ADR-0007 experiment 2) — OBSERVE ONLY.
 *
 * Loaded with `node --require` (via NODE_OPTIONS, so every child process and
 * worker thread inherits it). It records the FIRST touch of every file under
 * the app root and nothing else changes: no file is hidden, no read is served
 * from elsewhere, no missing file is recovered, no signal handler is installed.
 * The application runs against its complete, untouched production universe.
 *
 * The question each record answers is counterfactual:
 *
 *   "if this file had begun COLD, when would this access have forced hydration?"
 *
 * so a file is recorded once per ACCESS CLASS, not once per access:
 *
 *   content   read of the bytes            (module load, dlopen, readFile, open,
 *                                           createReadStream, copyFile source)
 *   metadata  existence/attributes only    (stat, lstat, access, existsSync,
 *                                           realpath, readlink)
 *   dir       a directory listing          (readdir, opendir) — recorded against
 *                                           the DIRECTORY, which is not a
 *                                           placeable file
 *   write     the process created/changed  (writeFile, appendFile, mkdir,
 *             it                            rename, unlink, rmdir) — lets the
 *                                           analysis separate generated files
 *                                           from production-universe files
 *
 * Only `content` forces bytes to be materialized; the split exists because a
 * whole-file virtualizer can serve `metadata` and `dir` from a local index
 * without moving any payload, and conflating the two would overstate hydration.
 *
 * Non-existent paths are never recorded: `realpathSync` throws and the access
 * is dropped. Resolution probing therefore cannot manufacture hydration.
 *
 * Env:
 *   HYDRATION_TRACE_DIR   required; NDJSON output directory. Unset ⇒ no-op.
 *   HYDRATION_APP_ROOT    required; only paths under it are recorded per-file.
 *   HYDRATION_RUN_LABEL   optional; copied into the process header record.
 *
 * Output: one `${pid}-${seq}.ndjson` per process. Records are appended through
 * an fd opened at startup with the ORIGINAL fs functions, so the tracer's own
 * I/O can never appear in its own trace.
 */
'use strict';

const TRACE_DIR = process.env.HYDRATION_TRACE_DIR;
const APP_ROOT_RAW = process.env.HYDRATION_APP_ROOT;
if (TRACE_DIR && APP_ROOT_RAW) install();

function install() {
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');

  // Captured BEFORE any patching: every call the tracer itself makes goes
  // through these, so tracer I/O is structurally invisible to the trace.
  const O = {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    closeSync: fs.closeSync,
    realpathSync: fs.realpathSync.native ?? fs.realpathSync,
    statSync: fs.statSync,
    mkdirSync: fs.mkdirSync,
  };

  const APP_ROOT = (() => {
    try {
      return O.realpathSync(APP_ROOT_RAW);
    } catch {
      return path.resolve(APP_ROOT_RAW);
    }
  })();
  const APP_PREFIX = APP_ROOT.endsWith(path.sep) ? APP_ROOT : APP_ROOT + path.sep;

  O.mkdirSync(TRACE_DIR, { recursive: true });
  const outFile = path.join(TRACE_DIR, `${process.pid}-${Math.floor(now() * 1000) % 1e9}.ndjson`);
  const fd = O.openSync(outFile, 'a');

  /** high-resolution wall clock, comparable across processes on this machine */
  function now() {
    return performance.timeOrigin + performance.now();
  }

  // ---------------------------------------------------------------- output
  let buf = [];
  let bufBytes = 0;
  const FLUSH_BYTES = 64 * 1024;
  function emit(rec) {
    buf.push(JSON.stringify(rec));
    bufBytes += buf[buf.length - 1].length + 1;
    if (bufBytes >= FLUSH_BYTES) flush();
  }
  function flush() {
    if (buf.length === 0) return;
    const chunk = buf.join('\n') + '\n';
    buf = [];
    bufBytes = 0;
    try {
      O.writeSync(fd, chunk);
    } catch {
      /* a full disk must not change how the app behaves */
    }
  }
  // A periodic unref'd flush is what makes the trace survive SIGKILL/SIGTERM:
  // `process.on('exit')` does NOT run when a signal terminates the process, and
  // INSTALLING a signal handler would change the app's semantics (a process
  // with no SIGTERM listener dies by default; adding one stops that). So the
  // tracer never touches signals and accepts losing at most one flush window.
  const timer = setInterval(flush, 100);
  if (typeof timer.unref === 'function') timer.unref();
  process.on('exit', flush);
  process.on('beforeExit', flush);

  emit({
    t: 'proc',
    pid: process.pid,
    ppid: process.ppid,
    ts: now(),
    argv: process.argv,
    execArgv: process.execArgv,
    cwd: safeCwd(),
    label: process.env.HYDRATION_RUN_LABEL ?? null,
    isWorker: !isMainThread(),
    threadId: threadId(),
    nodeVersion: process.version,
    appRoot: APP_ROOT,
  });

  function safeCwd() {
    try {
      return process.cwd();
    } catch {
      return null;
    }
  }
  function isMainThread() {
    try {
      return require('node:worker_threads').isMainThread;
    } catch {
      return true;
    }
  }
  function threadId() {
    try {
      return require('node:worker_threads').threadId;
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------- recording
  /** realpath cache: input path string → real path, or null when unresolvable */
  const realCache = new Map();
  /** real path → per-class first-touch bookkeeping */
  const seen = new Map();
  let order = 0;
  /** paths outside the app root: counted, never recorded per-file */
  const outside = new Map();
  let reentrant = false;

  function toPathString(p) {
    if (typeof p === 'string') return p;
    if (p instanceof URL) {
      try {
        return require('node:url').fileURLToPath(p);
      } catch {
        return null;
      }
    }
    if (Buffer.isBuffer(p)) return p.toString('utf8');
    // file descriptors and FileHandles carry no path we can attribute
    return null;
  }

  /**
   * `open`/`openSync` is the one entry point that is a read OR a write
   * depending on its flags. Charging `openSync(logfile, 'a')` as a content
   * hydration would invent a miss the virtualizer would never take, so the
   * flags decide the class. Unknown/absent flags default to 'r' (read), which
   * is both Node's default and the conservative direction for this metric.
   */
  function openClass(flags) {
    if (flags == null) return 'content';
    if (typeof flags === 'number') {
      // O_WRONLY(1) / O_RDWR(2) with O_TRUNC or O_CREAT and no read intent
      const O_WRONLY = 1;
      return (flags & 3) === O_WRONLY ? 'write' : 'content';
    }
    const f = String(flags);
    if (f.includes('+')) return 'content';
    return f[0] === 'w' || f[0] === 'a' ? 'write' : 'content';
  }

  function resolveReal(p) {
    const hit = realCache.get(p);
    if (hit !== undefined) return hit;
    let real = null;
    try {
      real = O.realpathSync(p);
    } catch {
      real = null; // does not exist / unreadable: nothing could be hydrated
    }
    // Only cache negatives cheaply; a path that appears then exists later is
    // rare but real (generated files), so negatives expire on the next miss.
    if (real !== null) realCache.set(p, real);
    return real;
  }

  function caller() {
    const lim = Error.stackTraceLimit;
    // source-map-support and friends install Error.prepareStackTrace, which
    // READS .map FILES when a stack is formatted. Letting the tracer's own
    // capture run it would attribute the app's source maps to the app as
    // hydration the app never asked for.
    const prep = Error.prepareStackTrace;
    Error.prepareStackTrace = undefined;
    Error.stackTraceLimit = 8;
    const e = {};
    Error.captureStackTrace(e, caller);
    // V8 formats a stack LAZILY, when `.stack` is first read — not at capture.
    // So the string must be forced while the hook is still disabled; restoring
    // it first (the obvious-looking order) leaves the app's formatter running
    // after all, and because it runs inside the re-entrancy guard, any file it
    // reads is silently DROPPED rather than recorded.
    const raw = String(e.stack || '');
    Error.stackTraceLimit = lim;
    Error.prepareStackTrace = prep;
    const lines = raw
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => !l.includes('/benchmarks/hydration/tracer.cjs'));
    return lines.slice(0, 3).join(' | ').slice(0, 400) || null;
  }

  /**
   * A write that CREATES a file has no realpath at the moment it is observed,
   * so plain realpath resolution drops it — and with it the only signal that
   * distinguishes a runtime-generated file from a production-universe file the
   * run happened to touch. Resolving the parent directory instead keeps the
   * creation visible without ever inventing a path inside the universe.
   */
  function resolveForWrite(p) {
    const real = resolveReal(p);
    if (real !== null) return real;
    const sep = p.lastIndexOf('/');
    if (sep <= 0) return null;
    const dir = resolveReal(p.slice(0, sep));
    return dir === null ? null : dir + p.slice(sep);
  }

  function note(rawPath, cls, op) {
    const p = toPathString(rawPath);
    if (p === null) return;
    // Fast reject before the realpath syscall: an absolute path that cannot be
    // under the app root is the overwhelming majority of accesses.
    if (p.length > 0 && p[0] === '/' && !p.startsWith(APP_PREFIX) && p !== APP_ROOT) {
      bumpOutside(p, cls, op);
      return;
    }
    const real = cls === 'write' ? resolveForWrite(p) : resolveReal(p);
    if (real === null) return;
    if (!real.startsWith(APP_PREFIX) && real !== APP_ROOT) {
      bumpOutside(real, cls, op);
      return;
    }
    let rec = seen.get(real);
    if (rec === undefined) {
      rec = { n: 0, c: null };
      seen.set(real, rec);
    }
    rec.n++;
    if (rec.c === null) rec.c = {};
    if (rec.c[cls] === undefined) {
      rec.c[cls] = true;
      emit({
        t: 'touch',
        real,
        via: p === real ? null : p,
        cls,
        op,
        ord: order++,
        ts: now(),
        pid: process.pid,
        tid: threadId(),
        from: caller(),
      });
    }
  }

  function bumpOutside(p, cls, op) {
    // Bucketed by the first three path segments: enough to see WHAT kind of
    // out-of-universe access happened without a per-file log of /usr/lib.
    const key = p.split('/').slice(0, 4).join('/') + `|${cls}`;
    const cur = outside.get(key);
    if (cur === undefined) outside.set(key, { n: 1, sample: p, cls, op });
    else cur.n++;
  }

  /**
   * Access totals and out-of-root buckets are only ever produced here, and a
   * server workload ends with SIGTERM — where `process.on('exit')` does NOT
   * run. So the summary is emitted PERIODICALLY as well; the analysis takes
   * the last one in the file. Without this the totals silently read 0 for
   * every app that had to be signalled, which is most of them.
   */
  function summarize(kind) {
    const totals = {};
    let files = 0;
    let accesses = 0;
    for (const rec of seen.values()) {
      files++;
      accesses += rec.n;
      for (const c of Object.keys(rec.c)) totals[c] = (totals[c] ?? 0) + 1;
    }
    emit({
      t: kind,
      pid: process.pid,
      tid: threadId(),
      ts: now(),
      uniqueFiles: files,
      totalAccesses: accesses,
      firstTouchesByClass: totals,
      outside: [...outside.entries()].map(([k, v]) => ({ key: k, n: v.n, cls: v.cls, op: v.op, sample: v.sample })),
      exitCode: process.exitCode ?? 0,
    });
  }
  // 500ms, not seconds: a short-lived CLI workload can finish before a slower
  // tick, and a signalled process never reaches the exit handler at all.
  const summaryTimer = setInterval(() => summarize('summary'), 500);
  if (typeof summaryTimer.unref === 'function') summaryTimer.unref();
  process.on('exit', () => {
    summarize('end');
    flush();
  });

  // --------------------------------------------------------------- patches
  function wrap(obj, name, idx, cls, op) {
    const orig = obj?.[name];
    if (typeof orig !== 'function') return;
    const wrapped = function (...args) {
      if (!reentrant) {
        reentrant = true;
        try {
          note(args[idx], typeof cls === 'function' ? cls(args) : cls, op);
        } catch {
          /* observation must never break the app */
        } finally {
          reentrant = false;
        }
      }
      return orig.apply(this, args);
    };
    // Keep the wrapper indistinguishable to reflective consumers (graceful-fs
    // and friends read `.native`, `util.promisify.custom`, `.length`, `.name`).
    for (const k of Object.getOwnPropertyNames(orig)) {
      if (k === 'length' || k === 'name' || k === 'prototype' || k === 'arguments' || k === 'caller') continue;
      try {
        wrapped[k] = orig[k];
      } catch {
        /* non-writable */
      }
    }
    for (const s of Object.getOwnPropertySymbols(orig)) {
      try {
        wrapped[s] = orig[s];
      } catch {
        /* non-writable */
      }
    }
    try {
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      Object.defineProperty(wrapped, 'length', { value: orig.length, configurable: true });
    } catch {
      /* ignore */
    }
    try {
      obj[name] = wrapped;
    } catch {
      /* frozen namespace */
    }
  }

  const openCls = (args) => openClass(args[1]);
  const CONTENT = [
    ['readFile', 0, 'content'],
    ['readFileSync', 0, 'content'],
    ['open', 0, openCls],
    ['openSync', 0, openCls],
    ['createReadStream', 0, 'content'],
    ['copyFile', 0, 'content'],
    ['copyFileSync', 0, 'content'],
    ['openAsBlob', 0, 'content'],
  ];
  const META = [
    ['stat', 0],
    ['statSync', 0],
    ['lstat', 0],
    ['lstatSync', 0],
    ['access', 0],
    ['accessSync', 0],
    ['exists', 0],
    ['existsSync', 0],
    ['realpath', 0],
    ['realpathSync', 0],
    ['readlink', 0],
    ['readlinkSync', 0],
    ['statfs', 0],
    ['statfsSync', 0],
  ];
  const DIR = [
    ['readdir', 0],
    ['readdirSync', 0],
    ['opendir', 0],
    ['opendirSync', 0],
    ['glob', 0],
    ['globSync', 0],
  ];
  const WRITE = [
    ['writeFile', 0],
    ['writeFileSync', 0],
    ['appendFile', 0],
    ['appendFileSync', 0],
    ['mkdir', 0],
    ['mkdirSync', 0],
    ['rename', 0],
    ['renameSync', 0],
    ['unlink', 0],
    ['unlinkSync', 0],
    ['rm', 0],
    ['rmSync', 0],
    ['rmdir', 0],
    ['rmdirSync', 0],
    ['createWriteStream', 0],
    ['symlink', 1],
    ['symlinkSync', 1],
    ['link', 1],
    ['linkSync', 1],
    ['truncate', 0],
    ['truncateSync', 0],
    ['utimes', 0],
    ['utimesSync', 0],
    ['chmod', 0],
    ['chmodSync', 0],
  ];

  for (const target of [fs, fs.promises]) {
    for (const [n, i, c] of CONTENT) wrap(target, n, i, c, n);
    for (const [n, i] of META) wrap(target, n, i, 'metadata', n);
    for (const [n, i] of DIR) wrap(target, n, i, 'dir', n);
    for (const [n, i] of WRITE) wrap(target, n, i, 'write', n);
  }

  // `wrap` copies own properties onto the wrapper, so `fs.realpathSync.native`
  // and `fs.realpath.native` survive — but as the ORIGINAL, unobserved
  // functions. Anything calling through `.native` (graceful-fs does) would be
  // invisible, so wrap those too, in place, after the parent is wrapped.
  for (const parent of ['realpathSync', 'realpath']) {
    const fn = fs[parent];
    if (typeof fn === 'function' && typeof fn.native === 'function') {
      wrap(fn, 'native', 0, 'metadata', `${parent}.native`);
    }
  }

  // Native addon load: the bytes of a `.node` are mapped by the loader, not
  // read through `fs`, so this is the only place it is observable in-process.
  wrap(process, 'dlopen', 1, 'content', 'dlopen');

  // CJS compile: `Module._extensions[ext](module, filename)` is called exactly
  // once per file that is actually compiled/loaded (the require cache absorbs
  // repeats), and it reads through the internal binding rather than the public
  // `fs`, so patching `fs` alone would miss every CJS module body.
  for (const ext of Object.keys(Module._extensions)) {
    wrap(Module._extensions, ext, 1, 'content', `require${ext}`);
  }

  // ESM: `registerHooks` sees resolve+load for the ESM graph (and, in Node 24,
  // for `require(esm)` too). The load hook fires once per module URL.
  if (typeof Module.registerHooks === 'function') {
    try {
      Module.registerHooks({
        load(url, context, nextLoad) {
          if (!reentrant && typeof url === 'string' && url.startsWith('file:')) {
            reentrant = true;
            try {
              note(require('node:url').fileURLToPath(url), 'content', 'esm-load');
            } catch {
              /* ignore */
            } finally {
              reentrant = false;
            }
          }
          return nextLoad(url, context);
        },
      });
    } catch {
      /* older runtime: ESM bodies fall back to the fs patches */
    }
  }

  // Secondary processes are part of the answer ("what does normal execution
  // hydrate?"), so record the spawn itself. NODE_OPTIONS carries the tracer
  // into every node child; a non-node child is recorded here and nowhere else.
  const cp = require('node:child_process');
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[fn];
    if (typeof orig !== 'function') continue;
    cp[fn] = function (...args) {
      try {
        emit({ t: 'spawn', fn, cmd: String(args[0]).slice(0, 300), pid: process.pid, ts: now() });
      } catch {
        /* ignore */
      }
      return orig.apply(this, args);
    };
    try {
      Object.defineProperty(cp[fn], 'name', { value: fn, configurable: true });
    } catch {
      /* ignore */
    }
  }
}
