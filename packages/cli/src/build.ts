import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { trace, type TraceResult } from '@reducer/tracer';
import { analyzeTrace, type Analysis, type StubCandidate } from '@reducer/analyzer';
import { stubFunctions } from '@reducer/transformer';
import {
  REDUCER_VERSION,
  sha256,
  type ArtifactFileRecord,
  type ArtifactReport,
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

interface UniverseFile {
  abs: string;
  /** POSIX-style path relative to base (same key format as the tracer). */
  rel: string;
  isSymlink: boolean;
}

/**
 * The production universe: every file that exists in the production
 * application filesystem. This — NOT the NFT trace — is the set of files
 * eligible to exist in the output. The only files excluded up front are
 * packages the lockfile explicitly marks dev-only (the standard
 * production-install boundary: `npm ci --omit=dev` would not install them).
 * Anything physically present but undeclared is UNKNOWN, and unknown means
 * keep. Within the universe, omission requires proof.
 */
function walkFiles(root: string, base: string, outDir: string | null, excludeRels?: Set<string>): UniverseFile[] {
  const files: UniverseFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (outDir && abs === outDir) continue;
      const rel = path.relative(base, abs).split(path.sep).join('/');
      if (excludeRels?.has(rel)) continue; // excluded package root (whole subtree)
      if (e.isSymbolicLink()) {
        files.push({ abs, rel, isSymlink: true }); // preserved verbatim, never followed
        continue;
      }
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) files.push({ abs, rel, isSymlink: false });
    }
  };
  walk(root);
  return files;
}

function collectUniverse(base: string, outDir: string | null): { files: UniverseFile[]; devPkgRels: Set<string> } {
  const devPkgRels = new Set<string>(); // POSIX rels like "node_modules/foo"
  try {
    const lock = JSON.parse(readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    for (const [p, entry] of Object.entries<any>(lock.packages ?? {})) {
      if (p && entry?.dev === true) devPkgRels.add(p);
    }
  } catch {
    /* no lockfile — no production-install boundary, exclude nothing */
  }
  return { files: walkFiles(base, base, outDir, devPkgRels), devPkgRels };
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

  // Resolve the output dir up front: the universe walk must exclude it, and
  // it must never be (or contain) the source base — the cleanup below would
  // delete the sources being built.
  let outDir: string | null = null;
  if (opts.write) {
    outDir = path.resolve(opts.outDir ?? 'dist-reduced');
    const baseFromOut = path.relative(outDir, base);
    if (baseFromOut === '' || (!baseFromOut.startsWith('..') && !path.isAbsolute(baseFromOut))) {
      throw new Error(`refusing to write to ${outDir}: it is or contains the project base ${base}`);
    }
  }

  const traced = await trace(roots, base);
  const analysis = analyzeTrace(traced);

  // ---- artifact model: output = production universe ∪ NFT-traced files,
  // minus proven-unreachable files. NFT supplies POSITIVE reachability
  // evidence only. CRITICAL INVARIANT: `nftTrace.has(file) === false` does
  // NOT imply `fileState === "proven-unreachable"` — NFT omission must never
  // authorize deletion. No file-level unreachability proofs exist yet, so
  // nothing is removed at file granularity.
  const { files: universeFiles, devPkgRels } = collectUniverse(base, outDir);
  const universeRels = new Set(universeFiles.map((u) => u.rel));
  const emitByRel = new Map<string, UniverseFile>(universeFiles.map((u) => [u.rel, u]));
  // A dev-excluded package with positive NFT evidence is actually loaded in
  // production: positive evidence widens — retain the whole package.
  const tracedDevPkgs = new Set<string>();
  for (const f of traced.files) {
    for (const d of devPkgRels) {
      if (f.rel === d || f.rel.startsWith(`${d}/`)) tracedDevPkgs.add(d);
    }
  }
  for (const d of tracedDevPkgs) {
    for (const u of walkFiles(path.join(base, d), base, outDir)) {
      if (!emitByRel.has(u.rel)) emitByRel.set(u.rel, u);
    }
  }
  // Defensive union: any traced file still missing (should not happen) is
  // emitted rather than dropped.
  for (const f of traced.files) {
    if (!emitByRel.has(f.rel)) {
      emitByRel.set(f.rel, { abs: f.abs, rel: f.rel, isSymlink: lstatSync(f.abs).isSymbolicLink() });
    }
  }

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

  // Retention accounting: which reasons block how much surviving code.
  // Bytes are an estimate — a module's post-transform JS bytes split evenly
  // across its distinct retention reasons.
  const retainedReasonsByModule = new Map<string, Set<string>>();
  const symbolCountByReason = new Map<string, number>();
  for (const v of analysis.verdicts) {
    if (v.state !== 'possibly-reachable' && v.state !== 'unknown') continue;
    for (const r of v.reasons) {
      symbolCountByReason.set(r, (symbolCountByReason.get(r) ?? 0) + 1);
      let set = retainedReasonsByModule.get(v.module);
      if (!set) retainedReasonsByModule.set(v.module, (set = new Set()));
      set.add(r);
    }
  }
  const byReason: Record<string, { symbols: number; modules: number; estimatedJsBytes: number }> = {};
  for (const [reason, symbols] of symbolCountByReason) {
    byReason[reason] = { symbols, modules: 0, estimatedJsBytes: 0 };
  }
  for (const [rel, reasons] of retainedReasonsByModule) {
    const f = traced.byRel.get(rel);
    if (!f) continue;
    const emitted = transformedCode.get(rel);
    const moduleBytes = emitted ? Buffer.byteLength(emitted.code) : f.bytes;
    for (const r of reasons) {
      byReason[r].modules++;
      byReason[r].estimatedJsBytes += moduleBytes / reasons.size;
    }
  }
  for (const b of Object.values(byReason)) b.estimatedJsBytes = Math.round(b.estimatedJsBytes);

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

  // ---- artifact provenance: why does every emitted file exist?
  const tracedRels = new Set(traced.files.map((f) => f.rel));
  const artifactFiles: ArtifactFileRecord[] = [...emitByRel.keys()].sort().map((rel) => ({
    file: rel,
    state: 'retained',
    reasons: tracedRels.has(rel)
      ? universeRels.has(rel)
        ? ['nft-traced', 'production-universe']
        : ['nft-traced']
      : ['production-universe', 'unknown-dynamic-reachability'],
  }));
  const artifact: ArtifactReport = {
    universeFiles: emitByRel.size,
    nftTracedFiles: traced.files.length,
    devExcludedPackages: [...devPkgRels].filter((d) => !tracedDevPkgs.has(d)).sort(),
    files: artifactFiles,
    removed: [], // file removal requires an explicit proof; none exist yet
  };
  const universeSymlinks = [...emitByRel.values()].filter((u) => u.isSymlink).length;

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
      ...analysis.warnings,
      ...traced.files
        .filter((f) => lstatSync(f.abs).isSymbolicLink())
        .map((f) => `symlink preserved verbatim; reduced tree may be incomplete or non-portable: ${f.rel}`),
      ...(universeSymlinks > 0
        ? [`${universeSymlinks} symlink(s) in the production universe preserved verbatim; the tree may be non-portable if targets point outside it`]
        : []),
      ...[...tracedDevPkgs].map(
        (d) => `lockfile marks ${d} dev-only but NFT traced files inside it; retained in full (positive evidence widens)`,
      ),
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
      retention: { byReason },
    },
    artifact,
  };

  // ---- emit deployment tree: the full production universe, with transformed
  // files replaced. Iterating emitByRel (never traced.files) is the invariant
  // in action — a file NFT missed still ships.
  if (opts.write && outDir) {
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

    for (const [rel, u] of emitByRel) {
      // An original .map for a transformed file would leak the removed body
      // via sourcesContent — the transformed map written below supersedes it.
      if (rel.endsWith('.map') && transformedCode.has(rel.slice(0, -'.map'.length))) continue;
      const dest = path.join(outDir, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      const replaced = transformedCode.get(rel);
      if (replaced) {
        writeFileSync(dest, replaced.code, { mode: statSync(u.abs).mode });
        if (replaced.map) writeFileSync(`${dest}.map`, JSON.stringify(replaced.map));
      } else if (u.isSymlink) {
        symlinkSync(readlinkSync(u.abs), dest); // verbatim target, incl. relative links
      } else {
        cpSync(u.abs, dest);
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
