import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  // Nearest package.json owns the entry, but a workspace/monorepo root ABOVE
  // it owns the hoisted node_modules — the production universe must include
  // that, or every hoisted dependency is silently absent from the artifact.
  // The highest explicit workspace marker wins.
  let dir = path.dirname(entryAbs);
  let nearest: string | null = null;
  let workspaceRoot: string | null = null;
  while (true) {
    if (existsSync(path.join(dir, 'package.json'))) {
      nearest ??= dir;
      try {
        const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pj.workspaces) workspaceRoot = dir;
      } catch {
        /* unreadable manifest is not a root signal */
      }
    }
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) || existsSync(path.join(dir, 'lerna.json'))) {
      workspaceRoot = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return workspaceRoot ?? nearest ?? path.dirname(entryAbs);
}

interface UniverseFile {
  abs: string;
  /** POSIX-style path relative to base (same key format as the tracer). */
  rel: string;
  isSymlink: boolean;
  /** directories are part of the universe too — an empty uploads/ dir the app
   *  writes into must exist in the artifact */
  isDir?: boolean;
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
/**
 * Excluding the output dir by exact string compare misses case variants on
 * case-insensitive filesystems (macOS/Windows) — the stale output would enter
 * the universe and then be rmSync'd mid-emit. Device+inode identity is exact
 * on every platform.
 */
type IsOutDir = (abs: string, isDir: boolean) => boolean;
function outDirMatcher(outDir: string | null): IsOutDir {
  if (!outDir) return () => false;
  let id: string | null = null;
  try {
    const s = statSync(outDir);
    id = `${s.dev}:${s.ino}`;
  } catch {
    /* output dir not created yet — string compare suffices */
  }
  return (abs, isDir) => {
    if (abs === outDir) return true;
    if (!isDir || id === null) return false;
    try {
      const s = statSync(abs);
      return `${s.dev}:${s.ino}` === id;
    } catch {
      return false;
    }
  };
}

function walkFiles(root: string, base: string, isOutDir: IsOutDir, excludeRels?: Set<string>): UniverseFile[] {
  const files: UniverseFile[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (isOutDir(abs, e.isDirectory())) continue;
      const rel = path.relative(base, abs).split(path.sep).join('/');
      // Only the repo's own top-level .git is outside the universe; a nested
      // entry named .git is somebody's file — omission would need proof.
      if (rel === '.git') continue;
      if (excludeRels?.has(rel)) continue; // excluded package root (whole subtree)
      if (e.isSymbolicLink()) {
        files.push({ abs, rel, isSymlink: true }); // preserved verbatim, never followed
        continue;
      }
      if (e.isDirectory()) {
        files.push({ abs, rel, isSymlink: false, isDir: true }); // dir itself (may be empty)
        walk(abs);
      } else if (e.isFile()) {
        files.push({ abs, rel, isSymlink: false });
      }
    }
  };
  walk(root);
  return files;
}

function collectUniverse(
  base: string,
  isOutDir: IsOutDir,
): { files: UniverseFile[]; devPkgRels: Set<string>; warnings: string[] } {
  const devPkgRels = new Set<string>(); // POSIX rels like "node_modules/foo"
  const warnings: string[] = [];
  try {
    const lock = JSON.parse(readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    for (const [p, entry] of Object.entries<any>(lock.packages ?? {})) {
      // Only install-tree entries are excludable: `npm ci --omit=dev` prunes
      // node_modules and nothing else. A dev-flagged key OUTSIDE node_modules
      // (a file:/workspace SOURCE directory like "tools/gen") is a repo
      // directory npm would never delete — excluding it deletes source.
      if (p && entry?.dev === true && p.startsWith('node_modules/')) devPkgRels.add(p);
    }
    // Stale-lockfile guard: if any dev-flagged top-level package is declared
    // as a PRODUCTION dependency in package.json, the lockfile disagrees with
    // the manifest — its dev flags are not trustworthy proof. Exclude nothing.
    try {
      const pj = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8'));
      const prodDeps = new Set([
        ...Object.keys(pj.dependencies ?? {}),
        ...Object.keys(pj.optionalDependencies ?? {}),
        ...Object.keys(pj.peerDependencies ?? {}),
      ]);
      const stale = [...devPkgRels].filter((p) => {
        const name = p.slice('node_modules/'.length);
        return !name.includes('/node_modules/') && prodDeps.has(name);
      });
      if (stale.length > 0) {
        warnings.push(
          `lockfile dev flags disagree with package.json production dependencies (${stale.join(', ')}); ` +
            'lockfile is stale — excluding nothing from the production universe',
        );
        devPkgRels.clear();
      }
    } catch {
      /* no readable package.json — keep the lockfile boundary as-is */
    }
  } catch {
    /* no lockfile — no production-install boundary, exclude nothing */
  }
  return { files: walkFiles(base, base, isOutDir, devPkgRels), devPkgRels, warnings };
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
  const isOutDir = outDirMatcher(outDir);
  const { files: universeFiles, devPkgRels, warnings: universeWarnings } = collectUniverse(base, isOutDir);
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
    const abs = path.join(base, d);
    // A workspace/file: dev package is installed as a symlink — re-adding it
    // as a walked directory AND a symlink would collide at emit. Preserve the
    // link verbatim; its target directory is part of the universe already
    // (source dirs are never dev-excludable).
    if (lstatSync(abs).isSymbolicLink()) {
      emitByRel.set(d, { abs, rel: d, isSymlink: true });
      continue;
    }
    for (const u of walkFiles(abs, base, isOutDir)) {
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

  // ---- fail-stop backstop: a dependency that resolves OUTSIDE the
  // production universe cannot be emitted, so a written artifact would be
  // missing runtime files with no proof authorizing their absence (hoisting
  // above a base findBase could not identify). Exception: a target reached
  // through an in-base symlink is materialized at emit and is therefore
  // covered. Failing loudly beats shipping a silently broken tree.
  // require.resolve returns realpaths; compare in realpath space (macOS /var
  // vs /private/var, symlinked checkouts).
  const realOf = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const baseReal = realOf(base);
  const inBase = (p: string) =>
    p === base || p.startsWith(base + path.sep) || p === baseReal || p.startsWith(baseReal + path.sep);
  const symlinkTargets = [...emitByRel.values()]
    .filter((u) => u.isSymlink)
    .map((u) => {
      try {
        return realOf(path.resolve(path.dirname(u.abs), readlinkSync(u.abs)));
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null && !inBase(t));
  const coveredExternally = (p: string) => symlinkTargets.some((t) => p === t || p.startsWith(t + path.sep));
  const outOfUniverse = new Set<string>();
  for (const m of analysis.modules.values()) {
    if (!m) continue;
    for (const dep of m.deps) {
      if (!dep.resolvedAbs || !path.isAbsolute(dep.resolvedAbs)) continue;
      if (inBase(dep.resolvedAbs) || coveredExternally(dep.resolvedAbs)) continue;
      outOfUniverse.add(`"${dep.source}" -> ${dep.resolvedAbs}`);
    }
  }
  if (outOfUniverse.size > 0) {
    const detail = [...outOfUniverse].join('; ');
    if (opts.write) {
      throw new Error(
        `refusing to emit: dependencies resolve outside the production universe (base ${base}): ${detail}. ` +
          'The artifact would be missing runtime files. Build from the workspace root, or restructure so the base contains them.',
      );
    }
    universeWarnings.push(
      `dependencies resolve outside the production universe (a written build would refuse to emit): ${detail}`,
    );
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

  let transformations: Transformation[] = [];
  const transformedCode = new Map<string, { code: string; map: object | null }>();
  const originalInput = new Map<string, string>(); // rel -> pre-transform source
  const removedRanges = new Map<string, { start: number; end: number }[]>();
  for (const [rel, list] of byFile) {
    const f = list[0].file;
    const input = readFileSync(f.abs, 'utf8');
    originalInput.set(rel, input);
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
    removedRanges.set(rel, result.stubbed.map((s) => s.sourceRange));
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

  // ---- physical-absence audit: a removed implementation must not survive
  // anywhere else in the emitted artifact. Scan EVERY other emitted file for
  // each removed body — raw and JSON-escaped (the escaped form catches a
  // pre-existing map's sourcesContent). A leaking `.map` is superseded
  // metadata and is suppressed from the artifact; a leak in ANY other file
  // (dual CJS/ESM builds, bundled/vendored copies, src/) REVERTS the whole
  // file's transformations: retention over a false physical-absence claim.
  const suppressedRels = new Set<string>();
  const revertedFiles = new Set<string>();
  const absenceWarnings: string[] = [];
  for (const [rel, ranges] of removedRanges) {
    const input = originalInput.get(rel)!;
    const bodies = ranges
      .map((r) => input.slice(r.start, r.end).trim())
      .filter((b) => b.length > 0);
    for (const [urel, u] of emitByRel) {
      if (urel === rel || u.isDir || u.isSymlink) continue;
      let content: string;
      try {
        content = transformedCode.get(urel)?.code ?? readFileSync(u.abs, 'utf8');
      } catch {
        continue; // unreadable/binary sibling: raw-text bodies cannot match it
      }
      const leaked = bodies.some(
        (b) => content.includes(b) || content.includes(JSON.stringify(b).slice(1, -1)),
      );
      if (!leaked) continue;
      if (urel.endsWith('.map')) {
        suppressedRels.add(urel);
        absenceWarnings.push(
          `suppressed ${urel}: pre-existing source map retains an implementation removed from ${rel}`,
        );
      } else {
        revertedFiles.add(rel);
        absenceWarnings.push(
          `transformation of ${rel} REVERTED: the removed implementation also ships in ${urel}; ` +
            'stubbing one copy would make the physical-absence claim false — both retained',
        );
        break;
      }
    }
  }
  for (const rel of revertedFiles) {
    transformedCode.delete(rel);
    removedRanges.delete(rel);
  }
  transformations = transformations.filter((t) => !revertedFiles.has(t.file));

  // ---- metrics
  const nftBytes = traced.files.reduce((a, f) => a + f.bytes, 0);
  const jsTraced = traced.files.filter((f) => f.kind === 'js');
  const nftJsBytes = jsTraced.reduce((a, f) => a + f.bytes, 0);
  const bytesRemoved = [...transformedCode.keys()].reduce((a, rel) => {
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
  const emitFileRels = [...emitByRel.entries()]
    .filter(([rel, u]) => !u.isDir && !suppressedRels.has(rel))
    .map(([rel]) => rel);
  const artifactFiles: ArtifactFileRecord[] = emitFileRels.sort().map((rel) => ({
    file: rel,
    state: 'retained',
    reasons: tracedRels.has(rel)
      ? universeRels.has(rel)
        ? ['nft-traced', 'production-universe']
        : ['nft-traced']
      : ['production-universe', 'unknown-dynamic-reachability'],
  }));
  const artifact: ArtifactReport = {
    universeFiles: emitFileRels.length,
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
      ...universeWarnings,
      ...absenceWarnings,
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
    const dirModes: [string, number][] = [];

    for (const [rel, u] of emitByRel) {
      // An original .map describing a transformed file would leak the removed
      // body via sourcesContent — the transformed map supersedes the
      // conventional name, and the absence audit suppresses nonstandard ones.
      if (rel.endsWith('.map') && transformedCode.has(rel.slice(0, -'.map'.length))) continue;
      if (suppressedRels.has(rel)) continue;
      const dest = path.join(outDir, rel);
      if (u.isDir) {
        mkdirSync(dest, { recursive: true });
        dirModes.push([dest, statSync(u.abs).mode]); // chmod after children land (a read-only dir must fill first)
        continue;
      }
      mkdirSync(path.dirname(dest), { recursive: true });
      const replaced = transformedCode.get(rel);
      if (replaced) {
        writeFileSync(dest, replaced.code);
        chmodSync(dest, statSync(u.abs).mode); // exact bits — writeFileSync mode is umask-masked
        if (replaced.map) writeFileSync(`${dest}.map`, JSON.stringify(replaced.map));
      } else if (u.isSymlink) {
        const rawTarget = readlinkSync(u.abs);
        const targetAbs = path.resolve(path.dirname(u.abs), rawTarget);
        const targetRel = ((p: string): string | null => {
          for (const b of [base, baseReal]) {
            if (p === b) return '';
            if (p.startsWith(b + path.sep)) return path.relative(b, p);
          }
          return null;
        })(inBase(targetAbs) ? targetAbs : realOf(targetAbs));
        if (targetRel !== null) {
          // Retarget into the artifact: an absolute (or escaping-and-
          // returning) target would resolve back into the ORIGINAL tree —
          // resurrecting implementations the transformer removed there. For
          // ordinary relative intra-tree links this emits the same target.
          symlinkSync(path.relative(path.dirname(dest), path.join(outDir, targetRel)), dest);
        } else if (existsSync(u.abs)) {
          // Target lives OUTSIDE the universe (npm link / file:../sibling):
          // a verbatim link would ship an artifact missing the code. The
          // content is production surface — materialize it.
          cpSync(u.abs, dest, { dereference: true, recursive: true });
          manifest.warnings.push(
            `symlink ${rel} targets outside the production universe (${rawTarget}); target content materialized into the artifact`,
          );
        } else {
          symlinkSync(rawTarget, dest); // dangling in the original too — verbatim
        }
      } else {
        cpSync(u.abs, dest);
      }
    }
    // Deepest-first so a parent's restrictive mode never blocks a child chmod.
    for (const [dest, mode] of dirModes.sort((a, b) => b[0].length - a[0].length)) chmodSync(dest, mode);
    // Package-preserving: always include the app's own package.json.
    const basePkg = path.join(base, 'package.json');
    if (existsSync(basePkg) && !existsSync(path.join(outDir, 'package.json'))) {
      cpSync(basePkg, path.join(outDir, 'package.json'));
    }
    writeFileSync(path.join(outDir, 'reducer-manifest.json'), JSON.stringify(manifest, null, 2));
  }

  return { manifest, trace: traced, analysis, outDir };
}
