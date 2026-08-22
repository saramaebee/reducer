/**
 * Real-world benchmark runner for one project. Compares:
 *   A. production dependency installation   (--prod-dir, else ./node_modules labeled accordingly)
 *   B. @vercel/nft traced deployment        (from the reducer manifest)
 *   C. strongest realistic passing esbuild bundle (esm then cjs, no semantic workarounds)
 *   D. reducer output
 * plus retention-reason buckets, timings, and validation results.
 *
 * Usage:
 *   bun benchmarks/real.ts --dir <project> --entry <rel-entry> [--name <label>]
 *     [--prod-dir <prod-only-node_modules-parent>]  measured as A when given
 *     [--test-cmd "npm test"]                       run in the ORIGINAL project dir
 *     [--start-probe "node server.js"]              started in the REDUCED dir
 *     [--ready-regex "listening"]                   stdout/stderr regex marking successful startup
 *     [--probe-cmd "curl -sf http://localhost:3000/health"]  integration check while started
 *     [--out results/<name>.json]
 *
 * The important metric is INCREMENTAL reduction beyond B and C, not reduction
 * versus untouched node_modules. Negative results are reported as-is.
 */
import { build as esbuild } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run } from '@reducer/cli';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    entry: { type: 'string' },
    name: { type: 'string' },
    'prod-dir': { type: 'string' },
    'test-cmd': { type: 'string' },
    'start-probe': { type: 'string' },
    'ready-regex': { type: 'string' },
    'probe-cmd': { type: 'string' },
    out: { type: 'string' },
  },
});
if (!values.dir || !values.entry) {
  console.error('required: --dir <project> --entry <rel-entry>');
  process.exit(1);
}

const projectDir = path.resolve(values.dir);
const entryAbs = path.join(projectDir, values.entry);
const name = values.name ?? path.basename(projectDir);

function dirBytes(d: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  if (!existsSync(d)) return { bytes, files };
  for (const e of readdirSync(d, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files++;
    try {
      bytes += statSync(path.join(e.parentPath, e.name)).size;
    } catch {
      /* dangling symlink */
    }
  }
  return { bytes, files };
}

function dirJsBytes(d: string): number {
  let bytes = 0;
  if (!existsSync(d)) return 0;
  for (const e of readdirSync(d, { withFileTypes: true, recursive: true })) {
    if (!e.isFile() || !/\.(js|mjs|cjs)$/.test(e.name)) continue;
    try {
      bytes += statSync(path.join(e.parentPath, e.name)).size;
    } catch {
      /* dangling symlink */
    }
  }
  return bytes;
}

const pkgJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
const deps: Record<string, string> = pkgJson.dependencies ?? {};
const FRAMEWORKS = ['express', 'fastify', '@nestjs/core', 'koa', '@hapi/hapi', 'restify', 'next', 'hono'];
const framework = FRAMEWORKS.find((f) => deps[f]) ?? null;

// ---- A: production dependency installation
const prodRoot = values['prod-dir'] ? path.resolve(values['prod-dir']) : projectDir;
const prodNm = path.join(prodRoot, 'node_modules');
const prodMeasure = dirBytes(prodNm);
const prodJsBytes = dirJsBytes(prodNm);

// ---- D (and B, from its manifest): reducer
const outDir = path.join(tmpdir(), `reducer-bench-${name}-${process.pid}`);
rmSync(outDir, { recursive: true, force: true });
const t0 = performance.now();
let reducerResult: Awaited<ReturnType<typeof run>> | null = null;
let reducerError: string | null = null;
try {
  reducerResult = await run({ entry: entryAbs, outDir, write: true });
} catch (e) {
  reducerError = e instanceof Error ? e.message : String(e);
}
const reducerMs = Math.round(performance.now() - t0);

// ---- C: strongest realistic passing esbuild bundle. Try esm, then cjs.
// No semantic workarounds (no externals, no shims); a failure is data.
let bundle: { format: string; bytes: number } | null = null;
const bundleErrors: string[] = [];
const t1 = performance.now();
for (const format of ['esm', 'cjs'] as const) {
  try {
    const r = await esbuild({
      entryPoints: [entryAbs],
      bundle: true,
      platform: 'node',
      format,
      minify: true,
      write: false,
      outdir: 'out',
      logLevel: 'silent',
    });
    bundle = { format, bytes: r.outputFiles.reduce((a, f) => a + f.contents.byteLength, 0) };
    break;
  } catch (e) {
    bundleErrors.push(`${format}: ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`);
  }
}
const bundleMs = Math.round(performance.now() - t1);

// ---- validation
function sh(cmd: string, cwd: string, timeoutMs = 600_000): { ok: boolean; output: string } {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout: timeoutMs });
  return { ok: r.status === 0, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-4000) };
}

let testsPassed: boolean | null = null;
let testsOutput: string | null = null;
if (values['test-cmd']) {
  const r = sh(values['test-cmd'], projectDir);
  testsPassed = r.ok;
  testsOutput = r.output;
}

async function startupProbe(): Promise<{ startup: boolean | null; integration: boolean | null; detail: string }> {
  if (!values['start-probe'] || !reducerResult) return { startup: null, integration: null, detail: 'no start probe configured' };
  const ready = new RegExp(values['ready-regex'] ?? 'listen|ready|started', 'i');
  return await new Promise((resolve) => {
    const child = spawn('sh', ['-c', values['start-probe']!], { cwd: outDir, env: process.env });
    let out = '';
    let settled = false;
    const finish = (startup: boolean, integration: boolean | null, detail: string) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ startup, integration, detail });
    };
    const timer = setTimeout(() => finish(false, null, `no ready signal in 30s; output: ${out.slice(-2000)}`), 30_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      if (ready.test(out)) {
        clearTimeout(timer);
        let integration: boolean | null = null;
        let detail = 'started';
        if (values['probe-cmd']) {
          const r = sh(values['probe-cmd'], outDir, 30_000);
          integration = r.ok;
          detail = `started; probe ${r.ok ? 'ok' : `failed: ${r.output.slice(-1000)}`}`;
        }
        finish(true, integration, detail);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(false, null, `exited ${code} before ready; output: ${out.slice(-2000)}`));
  });
}
const probe = await startupProbe();

// ---- assemble
const m = reducerResult?.manifest ?? null;
const mm = m?.metrics ?? null;
const formats = { esm: 0, cjs: 0, opaque: 0 };
if (m) for (const mod of m.modules) if (mod.format) formats[mod.format]++;
const tracedPkgs = m ? new Set(m.modules.map((x) => x.pkg).filter(Boolean)).size : null;

const result = {
  project: name,
  dir: projectDir,
  entry: values.entry,
  node: process.versions.node,
  framework,
  moduleSystem: formats.esm && formats.cjs ? 'mixed' : formats.esm ? 'esm' : 'cjs',
  formats,
  productionDependencyCount: Object.keys(deps).length,
  tracedPackageCount: tracedPkgs,

  A_prod: {
    bytes: prodMeasure.bytes,
    files: prodMeasure.files,
    jsBytes: prodJsBytes,
    prodOnlyInstall: !!values['prod-dir'],
  },
  B_nft: mm ? { bytes: mm.nft.bytes, files: mm.nft.files, jsBytes: mm.nft.jsBytes, jsFiles: mm.nft.jsFiles } : null,
  C_bundle: {
    ok: !!bundle,
    format: bundle?.format ?? null,
    bytes: bundle?.bytes ?? null,
    errors: bundleErrors,
    semanticWorkaroundsNeeded: null as boolean | null, // set by hand if a workaround config was required
    durationMs: bundleMs,
  },
  D_reducer: mm
    ? {
        outputJsBytes: mm.reducer.outputJsBytes,
        bytesRemoved: mm.reducer.bytesRemoved,
        functionsStubbed: mm.reducer.functionsStubbed,
        durationMs: reducerMs,
        error: null as string | null,
      }
    : { outputJsBytes: null, bytesRemoved: null, functionsStubbed: null, durationMs: reducerMs, error: reducerError },

  incremental: mm
    ? {
        vsNftJs: mm.reducer.incrementalReductionVsNftJs,
        vsBundle: bundle ? (bundle.bytes - (mm.nft.jsBytes - mm.reducer.bytesRemoved)) / bundle.bytes : null,
        vsBundleNote:
          'positive = reducer output JS smaller than bundle; shapes differ (package-preserving tree vs single minified file)',
      }
    : null,

  analysis: mm
    ? {
        functionsDiscovered: mm.analyzer.functionsSeen,
        exportsSeen: mm.analyzer.exportsSeen,
        symbolsProvenReachable: mm.reducer.symbolsProvenReachable,
        symbolsProvenUnreachable: mm.reducer.symbolsProvenUnreachable,
        symbolsRetainedUncertain: mm.reducer.symbolsRetainedUncertain,
        parseFailures: mm.analyzer.parseFailures,
        globalHazards: mm.analyzer.globalHazards,
        nftWarnings: m!.warnings.length,
        retentionByReason: mm.retention.byReason,
      }
    : null,

  validation: {
    testsPassed,
    startupPassed: probe.startup,
    integrationPassed: probe.integration,
    probeDetail: probe.detail,
    testsOutputTail: testsPassed === false ? testsOutput : null,
  },
};

const outPath = path.resolve(values.out ?? path.join('benchmarks', 'results', `${name}.json`));
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.log(`\n${name}: A=${prodMeasure.bytes}b${values['prod-dir'] ? ' (prod-only)' : ' (as-installed)'}  B=${result.B_nft?.jsBytes ?? 'n/a'} JS b  C=${bundle ? `${bundle.bytes}b (${bundle.format})` : 'FAILED'}  D=${result.D_reducer.outputJsBytes ?? 'n/a'} JS b`);
console.log(`  incremental vs NFT: ${pct(result.incremental?.vsNftJs)}   hazards: ${result.analysis?.globalHazards.join(',') || 'none'}   stubbed: ${result.D_reducer.functionsStubbed ?? 'n/a'}`);
console.log(`  wrote ${outPath}`);
if (reducerError) console.error(`  REDUCER ERROR: ${reducerError}`);
