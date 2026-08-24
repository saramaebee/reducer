/**
 * The four prefetch strategies, frozen in DESIGN.md §7 before any TEST result
 * was viewed. Each returns an ORDERED list of universe-relative paths; nydus
 * compiles it into the RAFS prefetch table and fetches it natively at mount.
 *
 * Order matters twice: it decides blob layout (adjacent files become one
 * merged range request) and it decides what arrives first.
 */
import type { AppPlan } from './plan.ts';

/** One generic TRAIN observation: a file whose CONTENT was read, and when. */
export interface TrainAccess {
  rel: string;
  firstMs: number;
}

export interface Strategy {
  arm: string;
  /** everything this strategy was allowed to look at (fairness table, §6.1) */
  inputs: string[];
  files: string[];
}

/** B2 — generic trace prefetch. Paths are opaque strings; nothing is parsed. */
export function b2Generic(train: TrainAccess[]): Strategy {
  return {
    arm: 'B2',
    inputs: ['TRAIN filesystem access log (path + first-content-read timestamp)'],
    files: [...train].sort((a, b) => a.firstMs - b.firstMs).map((t) => t.rel),
  };
}

/**
 * B2d — generic trace prefetch WITH generic directory expansion.
 *
 * Added because the null hypothesis deserves its strongest form: B3b expands
 * around what TRAIN saw, so the generic arm must be allowed to expand too.
 * Directory membership is filesystem structure, not Node semantics — this
 * strategy still cannot tell `node_modules` from `views`, a package from a
 * folder, or an import edge from a coincidence.
 *
 * Expansion is one directory level, non-recursive: a recursive expansion is
 * just "ship everything" and stops being a prefetch strategy.
 */
export function b2dGenericDir(plan: AppPlan, train: TrainAccess[]): Strategy {
  const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  const touched = new Set(train.map((t) => t.rel));
  const dirs = new Set([...touched].map(dirOf));
  const byDir = new Map<string, string[]>();
  for (const [rel] of plan.files) {
    const d = dirOf(rel);
    if (!dirs.has(d)) continue;
    let l = byDir.get(d);
    if (!l) byDir.set(d, (l = []));
    l.push(rel);
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const t of [...train].sort((a, b) => a.firstMs - b.firstMs)) {
    for (const rel of byDir.get(dirOf(t.rel)) ?? [t.rel]) {
      if (!seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
    }
  }
  return {
    arm: 'B2d',
    inputs: [
      'TRAIN filesystem access log (identical to B2)',
      'directory membership (filesystem structure only)',
    ],
    files,
  };
}

/** B3a — static Reducer: the ADR-0007 Plan B HOT set, in NFT graph order. */
export function b3aStatic(plan: AppPlan): Strategy {
  const hot = new Set(plan.planBHot);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const rel of plan.nftOrder) {
    if (hot.has(rel) && !seen.has(rel)) {
      seen.add(rel);
      ordered.push(rel);
    }
  }
  // forced-hot files with no NFT edge (resolver metadata, opaque boundaries)
  // keep their universe order, grouped after the traced graph.
  for (const rel of plan.planBHot) {
    if (!seen.has(rel)) {
      seen.add(rel);
      ordered.push(rel);
    }
  }
  return {
    arm: 'B3a',
    inputs: ['NFT positive trace', 'entrypoint', 'resolver metadata (package.json)', 'opaque-boundary packages'],
    files: ordered,
  };
}

/**
 * B3b — Reducer given exactly B2's behavioural evidence, plus Node structure.
 *
 *   S0 = TRAIN-touched files                        (identical to B2)
 *   S1 = S0 ∪ every package.json                    (resolution precedes use)
 *   S2 = S1 ∪ NFT-positive files of packages S0 touched
 *
 * Deliberately NOT "the whole package": experiment 1 measured 57.8 % of cold
 * bytes inside partially-HOT packages, so whole-package widening would spend
 * exactly the sparsity this direction exists to exploit.
 */
export function b3bSemantic(plan: AppPlan, train: TrainAccess[]): Strategy {
  const pkgOf = new Map(plan.pkgOf);
  const nft = new Set(plan.nft);
  const order = new Map(plan.nftOrder.map((r, i) => [r, i]));

  const s0 = [...train].sort((a, b) => a.firstMs - b.firstMs).map((t) => t.rel);
  const livePkgs = new Set<string>();
  for (const rel of s0) {
    const p = pkgOf.get(rel);
    if (p) livePkgs.add(p);
  }

  const add = new Set<string>();
  for (const rel of plan.packageJsons) add.add(rel);
  for (const [rel] of plan.files) {
    if (!nft.has(rel)) continue;
    const p = pkgOf.get(rel);
    if (p && livePkgs.has(p)) add.add(rel);
  }

  // package-major ordering: one package's files form one contiguous blob run,
  // which is what turns "89.5 % of consecutive misses are in the same package"
  // into merged range requests instead of scattered ones.
  const seen = new Set<string>();
  const files: string[] = [];
  const push = (rel: string) => {
    if (!seen.has(rel)) {
      seen.add(rel);
      files.push(rel);
    }
  };
  const pkgSeq: string[] = [];
  const byPkg = new Map<string, string[]>();
  for (const rel of s0) {
    const p = pkgOf.get(rel) ?? '';
    if (!byPkg.has(p)) {
      byPkg.set(p, []);
      pkgSeq.push(p);
    }
    byPkg.get(p)!.push(rel);
  }
  for (const rel of add) {
    const p = pkgOf.get(rel) ?? '';
    if (!byPkg.has(p)) {
      byPkg.set(p, []);
      pkgSeq.push(p);
    }
    byPkg.get(p)!.push(rel);
  }
  for (const p of pkgSeq) {
    const list = byPkg.get(p)!;
    // within a package: NFT graph order first (import-adjacent files adjacent),
    // then anything the graph does not reach, by path.
    list.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
    for (const rel of list) push(rel);
  }
  return {
    arm: 'B3b',
    inputs: [
      'TRAIN filesystem access log (identical to B2)',
      'package boundaries (owning package directory per file)',
      'NFT positive trace',
      'resolver metadata semantics (every package.json)',
    ],
    files,
  };
}

/** A2/A3 initial residency: the closed static trace, in graph order. */
export function nftOnly(plan: AppPlan): Strategy {
  const nft = new Set(plan.nft);
  const files = plan.nftOrder.filter((r) => nft.has(r));
  const have = new Set(files);
  for (const r of plan.nft) if (!have.has(r)) files.push(r);
  return { arm: 'A', inputs: ['@vercel/nft trace of the pinned entrypoint'], files };
}
