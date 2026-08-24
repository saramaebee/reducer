/**
 * Per-app inputs for the lazy-OCI experiment (ADR-0007 experiment 3).
 *
 * Produces, for ONE application tree:
 *   1. the production universe (ADR-0005) — the exact file set the immutable
 *      image will contain;
 *   2. a PRUNED STAGING TREE: a hardlink copy of the app tree with every
 *      non-universe file (dev-only packages, stray artifacts) removed. The
 *      real directory/symlink structure is preserved, because pnpm/workspace
 *      resolution depends on it and the universe walk realpath-dedups aliases;
 *   3. NFT positive evidence + the module-graph parent edges, used for
 *      prefetch ORDER only;
 *   4. the Plan B HOT set from packages/working-set-planner — B3a's prefetch
 *      set, recomputed over the tree actually measured (§3.2 of DESIGN.md).
 *
 * Nothing here is removed from the image: pruning drops files that were never
 * in the production universe in the first place. Placement never decides
 * availability (ADR-0007).
 *
 * Usage: bun benchmarks/lazy-oci/plan.ts --app <name>
 */
import { linkSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { opaquePackages } from '@reducer/hazard-domain';
import { buildUniverse, pullIn, realpath } from '@reducer/production-universe';
import { trace } from '@reducer/tracer';
import { planWorkingSet } from '@reducer/working-set-planner';
import { APPS, appRoot, appSha, entryRel, productionPackages } from './apps.ts';

export const WORK_ROOT = '/Users/sara/.cache/reducer-lazyoci-v1';

export interface AppPlan {
  app: string;
  sha: string;
  root: string;
  entryRel: string;
  /** every production-universe file, canonical rel path → bytes */
  files: [string, number][];
  universeBytes: number;
  /** rels with NFT positive evidence */
  nft: string[];
  /** NFT depth-first order from the entrypoint (prefetch ORDER for B3a/B3b) */
  nftOrder: string[];
  /** Plan B HOT rels (nft-positive ∪ entry ∪ resolver-metadata ∪ opaque-boundary) */
  planBHot: string[];
  /** rel → owning package DIRECTORY, rel to root ('' = first-party/no package).
   *  The directory, not the name: pnpm and workspaces install many physically
   *  distinct copies of one name, and a "same package" cluster that merged
   *  them would prefetch files the app can never resolve. */
  pkgOf: [string, string][];
  /** every package.json in the universe (resolver metadata) */
  packageJsons: string[];
  warnings: string[];
  stage: string;
  staged: { files: number; bytes: number; prunedFiles: number };
}

/** hardlink-copy `src` into `dst`, keeping only files whose realpath is in `keep`. */
function stageTree(src: string, dst: string, keep: Set<string>): { files: number; bytes: number; pruned: number } {
  rmSync(dst, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  let pruned = 0;
  // A directory symlink survives if ANY universe file lives beneath its target.
  // Precomputed ancestor set keeps that O(1) per link instead of a re-walk.
  const dirPrefixes = new Set<string>();
  for (const real of keep) {
    let d = path.dirname(real);
    while (d.length > 1 && !dirPrefixes.has(d)) {
      dirPrefixes.add(d);
      d = path.dirname(d);
    }
  }
  const keepsUnder = (dir: string): boolean => dirPrefixes.has(dir);
  const walk = (rel: string): boolean => {
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return false;
    }
    mkdirSync(to, { recursive: true });
    let kept = false;
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childFrom = path.join(src, childRel);
      if (e.isSymbolicLink()) {
        // Keep a symlink when its target survives. Directory symlinks (pnpm,
        // workspaces) are how resolution reaches the physical package, so a
        // dropped link is a broken app, not a smaller image.
        let target: string;
        let real: string;
        try {
          target = readlinkSync(childFrom);
          real = realpath(childFrom);
        } catch {
          pruned++;
          continue;
        }
        let survives = false;
        try {
          survives = statSync(real).isDirectory() ? keepsUnder(real) : keep.has(real);
        } catch {
          survives = false;
        }
        if (!survives) {
          pruned++;
          continue;
        }
        try {
          symlinkSync(target, path.join(dst, childRel));
          kept = true;
        } catch {
          pruned++;
        }
        continue;
      }
      if (e.isDirectory()) {
        if (walk(childRel)) kept = true;
        continue;
      }
      if (!e.isFile()) continue;
      let real: string;
      let st;
      try {
        real = realpath(childFrom);
        st = statSync(childFrom);
      } catch {
        pruned++;
        continue;
      }
      if (!keep.has(real)) {
        pruned++;
        continue;
      }
      try {
        linkSync(childFrom, path.join(dst, childRel));
        files++;
        bytes += st.size;
        kept = true;
      } catch {
        pruned++;
      }
    }
    if (!kept) {
      try {
        rmSync(to, { recursive: true, force: true });
      } catch {
        /* a parent already removed it */
      }
    }
    return kept;
  };
  walk('');
  return { files, bytes, pruned };
}

export async function buildPlan(app: string): Promise<AppPlan> {
  const root = appRoot(app);
  const entry = path.join(root, entryRel(app));
  const frozenPackages = productionPackages(app, root);
  const universe = buildUniverse({ entry, root, frozenPackages });
  const warnings = [...universe.warnings];

  // ---- NFT positive evidence (same handling as working-set/run-corpus.ts:
  // directories NFT backtracks through are not placeable files)
  const nft = new Set<string>();
  const parents = new Map<string, string[]>();
  try {
    const traced = await trace([universe.entryAbs], universe.root);
    for (const tf of traced.files) {
      let isFile = false;
      try {
        isFile = statSync(tf.abs).isFile();
      } catch {
        /* vanished between trace and stat */
      }
      if (!isFile) continue;
      const f =
        universe.byRel.get(tf.rel) ?? universe.byReal.get(tf.abs) ?? pullIn(universe, tf.abs, 'the NFT trace reached it');
      if (!f) continue;
      nft.add(f.rel);
      if (tf.nftParents?.length) parents.set(f.rel, tf.nftParents);
    }
    if (traced.warnings.length) warnings.push(`NFT reported ${traced.warnings.length} warning(s)`);
  } catch (err) {
    warnings.push(`NFT trace FAILED: ${String(err).slice(0, 300)} — B3a degrades to all-hot`);
  }

  // ---- Plan B (the naive ADR-0007 planner, unchanged)
  const opaqueWarnings: string[] = [];
  const opaque = opaquePackages(universe, opaqueWarnings);
  warnings.push(...opaqueWarnings);
  const planB = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()), app });
  const planBHot = planB.placements.filter((p) => p.placement === 'hot').map((p) => p.file);

  // ---- NFT depth-first order from the entrypoint: import-adjacent files land
  // adjacent in the prefetch stream. Order only; membership is unchanged.
  const children = new Map<string, string[]>();
  for (const [child, ps] of parents) {
    for (const p of ps) {
      const prel = universe.byRel.has(p) ? p : (universe.byReal.get(p)?.rel ?? p);
      let l = children.get(prel);
      if (!l) children.set(prel, (l = []));
      l.push(child);
    }
  }
  const nftOrder: string[] = [];
  const seen = new Set<string>();
  const dfs = (rel: string) => {
    if (seen.has(rel) || !nft.has(rel)) return;
    seen.add(rel);
    nftOrder.push(rel);
    for (const c of (children.get(rel) ?? []).sort()) dfs(c);
  };
  dfs(universe.entryRel);
  for (const r of [...nft].sort()) dfs(r);

  const keep = new Set(universe.files.map((f) => f.real));
  const stage = path.join(WORK_ROOT, 'stage', app);
  const staged = stageTree(root, stage, keep);

  return {
    app,
    sha: appSha(app),
    root,
    entryRel: universe.entryRel,
    files: universe.files.map((f) => [f.rel, f.bytes] as [string, number]),
    universeBytes: universe.files.reduce((a, f) => a + f.bytes, 0),
    nft: [...nft],
    nftOrder,
    planBHot,
    pkgOf: universe.files.map(
      (f) => [f.rel, f.pkg ? path.relative(universe.root, f.pkg.dir).split(path.sep).join('/') : ''] as [string, string],
    ),
    packageJsons: universe.files.filter((f) => path.basename(f.rel) === 'package.json').map((f) => f.rel),
    warnings,
    stage,
    staged: { files: staged.files, bytes: staged.bytes, prunedFiles: staged.pruned },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } }, strict: true });
  const apps = values.all ? APPS.map((a) => a.name) : [values.app!];
  mkdirSync(path.join(WORK_ROOT, 'plans'), { recursive: true });
  for (const app of apps) {
    const t0 = Date.now();
    const plan = await buildPlan(app);
    const out = path.join(WORK_ROOT, 'plans', `${app}.json`);
    writeFileSync(out, JSON.stringify(plan));
    console.log(
      `[${app}] universe ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB | ` +
        `nft ${plan.nft.length} | planB hot ${plan.planBHot.length} | staged ${plan.staged.files} ` +
        `(pruned ${plan.staged.prunedFiles}) | ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    for (const w of plan.warnings.slice(0, 3)) console.log(`  ! ${w.slice(0, 160)}`);
  }
}
