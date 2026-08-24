/**
 * Experiment A analysis: does a COMPLETE immutable lazy artifact preserve
 * execution that a CLOSED static-traced artifact loses?
 *
 * A1 (full eager) is the correctness reference. A2 (only the @vercel/nft
 * trace, everything else physically absent) and A3 (the same NFT set as
 * initial residency, inside a complete lazy image) make the SAME placement
 * decision, so any divergence between them is caused by recoverability alone.
 *
 * The quantitative half comes from A3's substrate telemetry: the files the
 * held-out workload actually read that are NOT in the NFT trace are exactly
 * the files A2 does not have.
 *
 * Usage: bun benchmarks/lazy-oci/analyze-expa.ts --app <name> | --all
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { APPS } from './apps.ts';
import { WORK_ROOT, type AppPlan } from './plan.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const PREP = path.join(WORK_ROOT, 'prep');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const jsonl = (p: string): any[] =>
  existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];

/** Node mechanisms a closed trace can miss, in the vocabulary DESIGN.md §5 fixed. */
const MECHANISMS: [RegExp, string][] = [
  [/ERR_DLOPEN_FAILED|\.node['"]?\s*$|invalid ELF|dlopen/i, 'native/WASM path discovery'],
  [/createRequire/i, 'createRequire'],
  [/ERR_MODULE_NOT_FOUND|Cannot find package/i, 'ESM resolution'],
  [/Cannot find module '\.{1,2}\//i, 'dynamic relative path / plugin resolution'],
  [/Cannot find module '[^.']/i, 'computed or dynamic package require'],
  // Sequelize/knex-style dialect loading: `require(dialectName)` behind a
  // library's own try/catch, which reports its own message instead of Node's.
  [/Please install .{1,40} (package|module)/i, 'computed or dynamic package require (library dialect/driver loader)'],
  [/No configurations found in configuration directory/i, 'filesystem lookup of a non-module asset'],
  [/ENOENT[^\n]*\.(json|ya?ml|hbs|ejs|pug|html|css|svg|png|txt|sql|proto|wasm)/i, 'filesystem lookup of a non-module asset'],
  [/ENOENT/i, 'filesystem lookup'],
  // An application's own "file not found" wording, not Node's. json-server
  // reports its missing data file this way, and a classifier that only knows
  // Node's error strings would score that failure as "unclassified".
  [/\b(file|directory|config\w*|schema|database)\b[^\n]{0,60}\bnot found\b/i, 'application data or config file the trace did not reach'],
  [/Could not (find|load|resolve)/i, 'application data or config file the trace did not reach'],
  [/worker|child_process|fork\(/i, 'worker/secondary entrypoint'],
];

const classify = (text: string): string[] => {
  const hits = new Set<string>();
  for (const [re, name] of MECHANISMS) if (re.test(text)) hits.add(name);
  return [...hits];
};

function analyze(app: string): void {
  const plan = readJson<AppPlan>(path.join(WORK_ROOT, 'plans', `${app}.json`));
  const root = path.join(RUN, 'expA', app);
  if (!existsSync(root)) {
    console.log(`[${app}] no Experiment A run`);
    return;
  }
  const sizeOf = new Map(plan.files);
  const nft = new Set(plan.nft);
  const needed = readJson<{ rel: string }[]>(path.join(PREP, `${app}.needed-test.json`)).map((x) => x.rel);

  const armOf = (name: string, mode: string) => {
    const dir = path.join(root, `${name}.${mode}`);
    const ev = jsonl(path.join(dir, 'events.jsonl'));
    const ready = ev.find((e) => e.ev === 'ready');
    const reqs = ev.filter((e) => e.ev === 'request');
    const log = existsSync(path.join(dir, 'app.log')) ? readFileSync(path.join(dir, 'app.log'), 'utf8') : '';
    return {
      dir,
      ready: !!ready?.ok,
      done: ev.some((e) => e.ev === 'workload-done'),
      requests: reqs.map((r) => ({ method: r.method, path: r.path, status: r.status, bodyHash: r.bodyHash ?? null })),
      appLog: log,
      mechanisms: classify(log),
    };
  };

  const out: Record<string, unknown> = { app, sha: plan.sha };
  for (const mode of ['train', 'test'] as const) {
    const a1 = armOf('A1', mode);
    const a2 = armOf('A2', mode);
    const a3 = armOf('A3', mode);
    const cmp = (x: typeof a1) => {
      let status = 0;
      let body = 0;
      const detail: string[] = [];
      for (let i = 0; i < Math.min(a1.requests.length, x.requests.length); i++) {
        const r = a1.requests[i]!;
        const s = x.requests[i]!;
        if (r.status !== s.status) {
          status++;
          if (detail.length < 10) detail.push(`${s.method} ${s.path}: A1=${r.status} got=${s.status}`);
        } else if (r.bodyHash && s.bodyHash && r.bodyHash !== s.bodyHash) body++;
      }
      return { statusMismatch: status, bodyMismatch: body, missingRequests: a1.requests.length - x.requests.length, detail };
    };
    out[mode] = {
      A1: { ready: a1.ready, done: a1.done, requests: a1.requests.length },
      A2: { ready: a2.ready, done: a2.done, requests: a2.requests.length, ...cmp(a2), mechanisms: a2.mechanisms, appLogTail: a2.appLog.slice(-1500) },
      A3: { ready: a3.ready, done: a3.done, requests: a3.requests.length, ...cmp(a3), mechanisms: a3.mechanisms },
    };
  }

  // ---- what the held-out workload needed that the closed trace omits
  const missing = needed.filter((rel) => !nft.has(rel));
  const neededOutsideTrace = {
    files: missing.length,
    bytes: missing.reduce((a, rel) => a + (sizeOf.get(rel) ?? 0), 0),
    sample: missing.slice(0, 40),
  };
  out.neededOutsideTrace = neededOutsideTrace;
  out.artifact = {
    A1Files: plan.files.length,
    A1Bytes: plan.universeBytes,
    A2Files: nft.size,
    A2Bytes: [...nft].reduce((a, r) => a + (sizeOf.get(r) ?? 0), 0),
  };

  writeFileSync(path.join(RUN, `${app}.expA.json`), JSON.stringify(out, null, 1));
  const a = out.artifact as { A1Files: number; A1Bytes: number; A2Files: number; A2Bytes: number };
  console.log(
    `\n=== ${app} Experiment A\n` +
      `  A1 full universe : ${a.A1Files} files / ${(a.A1Bytes / 1e6).toFixed(1)} MB\n` +
      `  A2 closed trace  : ${a.A2Files} files / ${(a.A2Bytes / 1e6).toFixed(1)} MB ` +
      `(${((1 - a.A2Bytes / a.A1Bytes) * 100).toFixed(1)}% omitted)`,
  );
  for (const mode of ['train', 'test'] as const) {
    const m = out[mode] as any;
    console.log(
      `  ${mode.toUpperCase().padEnd(5)} A1 ready=${m.A1.ready} | A2 ready=${m.A2.ready} mismatch=${m.A2.statusMismatch}` +
        ` | A3 ready=${m.A3.ready} mismatch=${m.A3.statusMismatch}`,
    );
    if (m.A2.mechanisms.length) console.log(`        A2 mechanisms: ${m.A2.mechanisms.join(', ')}`);
    for (const d of (m.A2.detail ?? []).slice(0, 4)) console.log(`        ${d}`);
  }
  if (neededOutsideTrace) {
    console.log(
      `  held-out workload read ${neededOutsideTrace.files} files / ` +
        `${(neededOutsideTrace.bytes / 1e6).toFixed(2)} MB that the closed trace omits`,
    );
  }
}

const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } } });
for (const app of values.all ? APPS.map((a) => a.name) : [values.app!]) {
  try {
    analyze(app);
  } catch (err) {
    console.log(`[${app}] expA analyze failed: ${String(err).slice(0, 300)}`);
  }
}
