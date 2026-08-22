import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { trace, type TraceResult } from '@reducer/tracer';
import { analyzeTrace, type Analysis, type StubCandidate } from '@reducer/analyzer';
import { stubFunctions } from '@reducer/transformer';
import {
  REDUCER_VERSION,
  sha256,
  type ModuleRecord,
  type ReducerManifest,
  type SymbolVerdict,
  type Transformation,
} from '@reducer/manifest';

export interface RunOptions {
  entry: string;
  outDir?: string;
  additionalRoots?: string[];
  keepPackages?: string[];
  write: boolean;
}

export interface RunResult {
  manifest: ReducerManifest;
  trace: TraceResult;
  analysis: Analysis;
  outDir: string | null;
}

function findBase(entryAbs: string): string {
  let dir = path.dirname(entryAbs);
  while (true) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(entryAbs);
    dir = parent;
  }
}

function dirBytes(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  if (!existsSync(dir)) return { bytes, files };
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    files++;
    bytes += statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { bytes, files };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const entryAbs = path.resolve(opts.entry);
  if (!existsSync(entryAbs)) throw new Error(`entrypoint not found: ${entryAbs}`);
  const base = findBase(entryAbs);
  const roots = [entryAbs, ...(opts.additionalRoots ?? []).map((r) => path.resolve(r))];

  const traced = await trace(roots, base);
  const analysis = analyzeTrace(traced);

  // --keep-package: forced retention, recorded as such.
  const keep = new Set(opts.keepPackages ?? []);
  const kept: StubCandidate[] = [];
  const candidates = analysis.candidates.filter((c) => {
    if (c.file.pkg && keep.has(c.file.pkg.name)) {
      kept.push(c);
      return false;
    }
    return true;
  });
  for (const c of kept) {
    const v = analysis.verdicts.find(
      (v) => v.module === c.file.rel && v.symbol === c.symbol,
    );
    if (v) {
      v.state = 'possibly-reachable';
      v.reasons = ['user-keep'];
    }
  }

  // Group stub candidates per file and transform (in memory; written on build).
  const byFile = new Map<string, StubCandidate[]>();
  for (const c of candidates) {
    let list = byFile.get(c.file.rel);
    if (!list) byFile.set(c.file.rel, (list = []));
    list.push(c);
  }

  const transformations: Transformation[] = [];
  const transformedCode = new Map<string, { code: string; map: object | null }>();
  for (const [rel, list] of byFile) {
    const f = list[0].file;
    const input = readFileSync(f.abs, 'utf8');
    // Several export names may share one implementation; stub each local
    // function once (the analyzer guarantees all its export names are
    // proven unreachable before it reaches here).
    const uniqueSpecs = [
      ...new Map(list.map((c) => [c.localName, { symbol: c.symbol, localName: c.localName }])).values(),
    ];
    const result = stubFunctions(input, rel, uniqueSpecs);
    // Hash exactly the bytes that will exist on disk (audit trail must be
    // reproducible from the artifact).
    const mapName = `${path.basename(rel)}.map`;
    const emitted = `${result.code}\n//# sourceMappingURL=${mapName}\n`;
    transformedCode.set(rel, { code: emitted, map: result.map });
    const inputHash = sha256(input);
    const outputHash = sha256(emitted);
    const rangeByLocal = new Map(result.stubbed.map((s) => [s.localName, s.sourceRange]));
    for (const c of list) {
      transformations.push({
        package: f.pkg ? `${f.pkg.name}@${f.pkg.version}` : null,
        file: rel,
        symbol: c.symbol,
        sourceRange: rangeByLocal.get(c.localName)!,
        action: 'function-body-removed',
        reason: 'provably-unreachable',
        proof: ['not-imported-anywhere'],
        inputHash,
        outputHash,
        bytesBefore: Buffer.byteLength(input),
        bytesAfter: Buffer.byteLength(emitted),
      });
    }
  }

  // ---- metrics
  const nftBytes = traced.files.reduce((a, f) => a + f.bytes, 0);
  const jsTraced = traced.files.filter((f) => f.kind === 'js');
  const nftJsBytes = jsTraced.reduce((a, f) => a + f.bytes, 0);
  const bytesRemoved = [...byFile.keys()].reduce((a, rel) => {
    const f = traced.byRel.get(rel)!;
    return a + (f.bytes - Buffer.byteLength(transformedCode.get(rel)!.code));
  }, 0);
  const original = dirBytes(path.join(base, 'node_modules'));

  const verdictCount = (s: SymbolVerdict['state']) =>
    analysis.verdicts.filter((v) => v.state === s).length;

  const moduleRecords: ModuleRecord[] = traced.files.map((f) => {
    const m = f.kind === 'js' ? analysis.modules.get(f.abs) : undefined;
    return {
      file: f.rel,
      pkg: f.pkg ? `${f.pkg.name}@${f.pkg.version}` : null,
      kind: f.kind === 'other' ? 'other' : f.kind,
      format: f.kind === 'js' ? (m ? m.format : 'opaque') : null,
      bytes: f.bytes,
    };
  });

  const manifest: ReducerManifest = {
    reducerVersion: REDUCER_VERSION,
    entrypoints: traced.entrypoints,
    input: { base, node: process.version },
    modules: moduleRecords,
    transformations,
    unknowns: analysis.verdicts.filter((v) => v.state === 'unknown' || v.state === 'possibly-reachable'),
    verdicts: analysis.verdicts,
    warnings: [
      ...traced.warnings,
      ...traced.files
        .filter((f) => lstatSync(f.abs).isSymbolicLink())
        .map((f) => `symlink preserved verbatim; reduced tree may be incomplete or non-portable: ${f.rel}`),
    ],
    metrics: {
      original: { dependencyBytes: original.bytes, dependencyFiles: original.files },
      nft: { bytes: nftBytes, files: traced.files.length, jsBytes: nftJsBytes, jsFiles: jsTraced.length },
      reducer: {
        bytesRemoved,
        outputJsBytes: nftJsBytes - bytesRemoved,
        functionsStubbed: transformations.length,
        symbolsProvenUnreachable: verdictCount('proven-unreachable'),
        symbolsProvenReachable: verdictCount('proven-reachable'),
        symbolsRetainedUncertain: verdictCount('possibly-reachable') + verdictCount('unknown'),
        incrementalReductionVsNftJs: nftJsBytes > 0 ? bytesRemoved / nftJsBytes : 0,
      },
      analyzer: {
        jsFilesParsed: analysis.stats.jsFilesParsed,
        parseFailures: analysis.stats.parseFailures,
        exportsSeen: analysis.stats.exportsSeen,
        functionsSeen: analysis.stats.functionsSeen,
        globalHazards: analysis.globalHazards,
      },
    },
  };

  // ---- emit deployment tree
  let outDir: string | null = null;
  if (opts.write) {
    outDir = path.resolve(opts.outDir ?? 'dist-reduced');
    // Never allow the output dir to be (or contain) the source base:
    // the cleanup below would delete the sources being built.
    const baseFromOut = path.relative(outDir, base);
    if (baseFromOut === '' || (!baseFromOut.startsWith('..') && !path.isAbsolute(baseFromOut))) {
      throw new Error(`refusing to write to ${outDir}: it is or contains the project base ${base}`);
    }
    if (existsSync(outDir)) {
      const entries = readdirSync(outDir);
      if (entries.length > 0 && !entries.includes('reducer-manifest.json')) {
        throw new Error(
          `refusing to overwrite ${outDir}: it is non-empty and does not look like previous reducer output`,
        );
      }
      rmSync(outDir, { recursive: true, force: true });
    }
    mkdirSync(outDir, { recursive: true });

    for (const f of traced.files) {
      const dest = path.join(outDir, f.rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      const replaced = transformedCode.get(f.rel);
      if (replaced) {
        writeFileSync(dest, replaced.code, { mode: statSync(f.abs).mode });
        if (replaced.map) writeFileSync(`${dest}.map`, JSON.stringify(replaced.map));
      } else {
        cpSync(f.abs, dest);
      }
    }
    // Package-preserving: always include the app's own package.json.
    const basePkg = path.join(base, 'package.json');
    if (existsSync(basePkg) && !existsSync(path.join(outDir, 'package.json'))) {
      cpSync(basePkg, path.join(outDir, 'package.json'));
    }
    writeFileSync(path.join(outDir, 'reducer-manifest.json'), JSON.stringify(manifest, null, 2));
  }

  return { manifest, trace: traced, analysis, outDir };
}
