/**
 * The four prewarm strategies, plus the analysis-only oracle.
 *
 * Every strategy returns a TOTAL RANKING of the production universe, not a set.
 * A budget is then a prefix of that ranking (`truncate`), which is what makes
 * the equal-cost comparison exact: at a given budget every arm prewarms the
 * same number of FILE BYTES and differs only in which files it chose.
 *
 * Frozen in DESIGN.md §7 before any TEST outcome was observed.
 *
 * ─── the information boundary ───────────────────────────────────────────────
 * GENERIC (G1, G2) may read: universe path strings, directory structure, file
 *   size, and the TRAIN access log (path + first-content-read timestamp).
 * SEMANTIC (R1, R2) may additionally read: package identity and boundaries, the
 *   `@vercel/nft` positive trace and its graph order, resolver metadata
 *   semantics (a package.json must be readable before anything in it resolves),
 *   opaque-boundary classification, and the declared package dependency graph.
 * NOBODY may read anything derived from the LONG-TAIL TEST workload. The oracle
 *   does, which is exactly why it is not a strategy.
 *
 * One tiebreak — ascending file size — is deliberately shared by every
 * strategy. A remote fault costs roughly one round trip regardless of the
 * file's size, so "more files per prewarmed byte" is a real advantage; giving
 * it to only one side would be a straw man in whichever direction it fell.
 */
import type { LongtailPlan } from './plan.ts';

/** One generic TRAIN observation: a file whose CONTENT was read, and when. */
export interface TrainAccess {
  rel: string;
  firstMs: number;
}

export type ArmName = 'G1' | 'G2' | 'R1' | 'R2' | 'O';

export interface Ranking {
  arm: ArmName;
  /** enumerated for the fairness table; every source this strategy consumed */
  inputs: string[];
  /** total ranking of the universe — index 0 is prewarmed first */
  order: string[];
  /** per-tier boundaries, for reporting what a budget actually bought */
  tiers: { name: string; upto: number }[];
}

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** Append the ranked members of one tier, skipping anything already ranked. */
function tier(out: string[], seen: Set<string>, tiers: Ranking['tiers'], name: string, members: string[]): void {
  for (const rel of members) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  tiers.push({ name, upto: out.length });
}

/**
 * The shared widening rule (DESIGN.md amendment A1).
 *
 *     key(f) = distance(f) + log2(size(f) + 1)          ascending
 *
 * which orders by `size × 2^distance`: prefer small files, and charge one
 * doubling of size for each unit of distance from what is already known. It is
 * used verbatim by G2, R1 and R2 — the ONLY difference between them is what
 * "distance" means, which is exactly the question this experiment asks. G2's
 * distance is measured in edges of the directory tree; R1's and R2's in Node
 * package-dependency hops.
 *
 * Why not a lexicographic (distance, size) order, which is what the first
 * implementation did: one enormous distance class starves every later one. On
 * the Next.js fixture the class "the rest of a package TRAIN touched" is 200 MB
 * — almost all of `next/` — so R2 spent every budget from 5 % to 40 % inside it
 * and never reached the dependency closure where the optional features live.
 * Its coverage was flat at 536 needed files from 5 % to 40 %. That ordering was
 * also package-major, i.e. the same-package clustering hypothesis experiment 3
 * REFUTED and DESIGN.md §1 says this experiment does not revive. Removing it
 * enforces the preregistration rather than evading it.
 */
const CAP = 16;

/** DESIGN.md amendment A2: the analysis must also report a DISTANCE-ONLY
 *  ranking, so the conclusion is shown not to be an artefact of the size term. */
export interface RankOpts {
  sizeTerm?: boolean;
}

function widen(
  rels: string[],
  size: Map<string, number>,
  distance: (rel: string) => number,
  opts: RankOpts = {},
): string[] {
  const withSize = opts.sizeTerm !== false;
  const key = new Map<string, number>();
  for (const r of rels) key.set(r, Math.min(distance(r), CAP) + (withSize ? Math.log2((size.get(r) ?? 0) + 1) : 0));
  return rels.sort((a, b) => key.get(a)! - key.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
}

// ───────────────────────────────────────────────────────────── G1 — literal

/**
 * G1 — the literal generic trace strategy.
 *
 * Prewarm exactly what the training run read, in the order it read it. Above
 * its own size G1 has, by construction, nothing further to say: the remainder
 * is ranked by path, a deterministic order carrying no signal. That is not a
 * weakened baseline, it is what "prefetch the trace" *is*; the strategy that
 * generalises beyond the trace using filesystem structure alone is G2, and the
 * headline comparison is against the better of the two.
 */
export function g1(plan: LongtailPlan, train: TrainAccess[]): Ranking {
  const out: string[] = [];
  const seen = new Set<string>();
  const tiers: Ranking['tiers'] = [];
  tier(out, seen, tiers, 'train-order', [...train].sort((a, b) => a.firstMs - b.firstMs).map((t) => t.rel));
  tier(out, seen, tiers, 'remainder-by-path', plan.files.map(([rel]) => rel).sort());
  return {
    arm: 'G1',
    inputs: ['TRAIN access log: path + first-content-read timestamp', 'universe path strings'],
    order: out,
    tiers,
  };
}

// ────────────────────────────────────────────────────── G2 — generic widening

/**
 * G2 — the strongest widening a strategy can do with no Node knowledge.
 *
 * After the trace itself, every remaining file is ranked by the shared widening
 * rule with distance = edges of the DIRECTORY TREE to the nearest directory the
 * training run touched. Distance 0 is experiment 3's one-level directory
 * expansion; distance 1 adds parents and siblings; and so on.
 *
 * This is a genuine generalisation, not a straw man: in a `node_modules` tree
 * files of one package are near each other, so directory-distance widening
 * approximates package widening without ever knowing what a package is. It is
 * strictly stronger than experiment 3's B2d, which stopped at distance 0, and
 * it is the same function R1/R2 use — only the definition of distance differs.
 */
export function g2(plan: LongtailPlan, train: TrainAccess[], opts: RankOpts = {}): Ranking {
  const size = new Map(plan.files);
  const touched = new Map(train.map((t) => [t.rel, t.firstMs]));

  // directory tree over every universe directory
  const dirs = new Set<string>();
  for (const [rel] of plan.files) {
    let d = dirOf(rel);
    for (;;) {
      if (dirs.has(d)) break;
      dirs.add(d);
      if (d === '') break;
      d = dirOf(d);
    }
  }
  const children = new Map<string, string[]>();
  for (const d of dirs) {
    if (d === '') continue;
    const p = dirOf(d);
    let l = children.get(p);
    if (!l) children.set(p, (l = []));
    l.push(d);
  }

  // multi-source BFS from every directory holding a TRAIN-touched file
  const dist = new Map<string, number>();
  const anchor = new Map<string, number>();
  let frontier: string[] = [];
  for (const [rel, ms] of touched) {
    const d = dirOf(rel);
    if (!dirs.has(d)) continue;
    const cur = anchor.get(d);
    if (cur === undefined || ms < cur) anchor.set(d, ms);
    if (!dist.has(d)) {
      dist.set(d, 0);
      frontier.push(d);
    }
  }
  for (let k = 1; frontier.length; k++) {
    const next: string[] = [];
    for (const d of frontier) {
      const a = anchor.get(d)!;
      const nb = [...(children.get(d) ?? [])];
      if (d !== '') nb.push(dirOf(d));
      for (const e of nb) {
        if (dist.has(e)) continue;
        dist.set(e, k);
        anchor.set(e, a);
        next.push(e);
      }
    }
    frontier = next;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const tiers: Ranking['tiers'] = [];
  tier(out, seen, tiers, 'train-order', [...train].sort((a, b) => a.firstMs - b.firstMs).map((t) => t.rel));

  const rest = plan.files.map(([rel]) => rel).filter((rel) => !touched.has(rel));
  void anchor;
  tier(out, seen, tiers, 'path-distance-widening', widen(rest, size, (r) => dist.get(dirOf(r)) ?? CAP, opts));
  return {
    arm: 'G2',
    inputs: [
      'TRAIN access log: path + first-content-read timestamp (identical to G1)',
      'directory structure of the universe (filesystem only)',
      'file size',
    ],
    order: out,
    tiers,
  };
}

// ─────────────────────────────────────────────────────── R1 — static semantic

/**
 * R1 — Node semantics with NO workload evidence whatsoever.
 *
 * The ADR-0007 Plan B HOT set first (positive evidence, entrypoint, resolver
 * metadata, opaque boundaries), then two semantic widenings the module graph
 * licenses: the rest of a package the graph has already proven live, and then
 * packages reachable over the DECLARED dependency graph, nearest first.
 */
export function r1(plan: LongtailPlan, opts: RankOpts = {}): Ranking {
  const size = new Map(plan.files);
  const pkgOf = new Map(plan.pkgOf);
  const depth = new Map(plan.pkgDepth);
  const nft = new Set(plan.nft);
  const nftRank = new Map(plan.nftOrder.map((r, i) => [r, i] as const));

  const livePkgFirstRank = new Map<string, number>();
  for (const [i, rel] of plan.nftOrder.entries()) {
    const p = pkgOf.get(rel);
    if (p === undefined) continue;
    if (!livePkgFirstRank.has(p)) livePkgFirstRank.set(p, i);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const tiers: Ranking['tiers'] = [];

  tier(out, seen, tiers, 'entrypoint', [plan.entryRel]);
  tier(
    out,
    seen,
    tiers,
    'resolver-metadata',
    [...plan.packageJsons].sort((a, b) => (depth.get(pkgOf.get(a) ?? '') ?? 1e9) - (depth.get(pkgOf.get(b) ?? '') ?? 1e9) || (a < b ? -1 : 1)),
  );

  // Everything else is PREDICTION and goes in the size-disciplined pool, at a
  // semantic distance that encodes ADR-0007 Plan B's own priority order:
  //   0    positive module-graph evidence
  //   0.5  a Plan B forced-hot file (opaque native/WASM/install-script boundary)
  //   1    any other file of a package the graph proved live
  //   1+h  a package h declared-dependency hops from the entrypoint's closure
  const planB = new Set(plan.planBHot);
  const livePkg = new Set<string>();
  for (const rel of plan.nft) livePkg.add(pkgOf.get(rel) ?? '');
  const pool = plan.files.map(([rel]) => rel).filter((rel) => !seen.has(rel));
  const distOf = (rel: string): number => {
    const p = pkgOf.get(rel) ?? '';
    const base = livePkg.has(p) ? 0 : (depth.get(p) ?? CAP);
    return base + (nft.has(rel) ? 0 : planB.has(rel) ? 0.5 : 1);
  };
  void nftRank;
  void livePkgFirstRank;
  tier(out, seen, tiers, 'semantic-distance-widening', widen(pool, size, distOf, opts));
  return {
    arm: 'R1',
    inputs: [
      'entrypoint identity',
      '@vercel/nft positive trace and its module-graph order',
      'package identity and boundaries',
      'resolver metadata semantics (package.json precedes resolution)',
      'opaque-boundary (native/WASM/install-script) package classification',
      'declared package dependency graph, Node-resolved',
      'file size',
    ],
    order: out,
    tiers,
  };
}

// ───────────────────────────────────────────── R2 — semantic + TRAIN evidence

/**
 * R2 — exactly G1/G2's workload evidence, widened by Node semantics.
 *
 * The headline arm. It sees the same TRAIN access log the generic arms see and
 * nothing else about the workload; every additional input is static Node
 * structure, enumerated in `inputs`.
 *
 * The widening order encodes the hypothesis under test: a package the workload
 * proved live is likely to have more of itself needed (the locale directory,
 * the sibling module, the error formatter), and a package that is one declared
 * dependency hop from a live package is the next most likely — which is how an
 * optional feature's library gets covered without the workload ever having
 * exercised that feature.
 */
export function r2(plan: LongtailPlan, train: TrainAccess[], opts: RankOpts = {}): Ranking {
  const size = new Map(plan.files);
  const pkgOf = new Map(plan.pkgOf);
  const deps = new Map(plan.pkgDeps);
  const nft = new Set(plan.nft);
  const nftRank = new Map(plan.nftOrder.map((r, i) => [r, i] as const));

  const trainSorted = [...train].sort((a, b) => a.firstMs - b.firstMs);
  const touched = new Set(trainSorted.map((t) => t.rel));
  const pkgFirstTouch = new Map<string, number>();
  for (const t of trainSorted) {
    const p = pkgOf.get(t.rel);
    if (p === undefined) continue;
    if (!pkgFirstTouch.has(p)) pkgFirstTouch.set(p, t.firstMs);
  }

  // hop distance over the declared dependency graph from the touched packages
  const hop = new Map<string, number>();
  let frontier = [...pkgFirstTouch.keys()];
  for (const p of frontier) hop.set(p, 0);
  for (let k = 1; frontier.length; k++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const q of deps.get(p) ?? []) {
        if (hop.has(q)) continue;
        hop.set(q, k);
        next.push(q);
      }
    }
    frontier = next;
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const tiers: Ranking['tiers'] = [];

  tier(out, seen, tiers, 'train-order', trainSorted.map((t) => t.rel));
  tier(out, seen, tiers, 'resolver-metadata', [...plan.packageJsons].sort((a, b) => (hop.get(pkgOf.get(a) ?? '') ?? 1e9) - (hop.get(pkgOf.get(b) ?? '') ?? 1e9) || (a < b ? -1 : 1)));

  // Everything after the trace and the resolver metadata is PREDICTION, and all
  // of it goes in the size-disciplined pool — symmetric with G2, whose
  // speculation is likewise all inside its pool. Semantic distance:
  //   0    positive module-graph evidence in a package the workload touched
  //   1    any other file of a package the workload touched, or graph evidence
  //        in a package it did not
  //   1+h  a package h declared-dependency hops from the touched set
  const pool = plan.files.map(([rel]) => rel).filter((rel) => !seen.has(rel));
  void nftRank;
  const distOf = (rel: string): number => {
    const p = pkgOf.get(rel) ?? '';
    const base = pkgFirstTouch.has(p) ? 0 : (hop.get(p) ?? CAP);
    return base + (nft.has(rel) ? 0 : 1);
  };
  tier(out, seen, tiers, 'semantic-distance-widening', widen(pool, size, distOf, opts));
  return {
    arm: 'R2',
    inputs: [
      'TRAIN access log: path + first-content-read timestamp (identical to G1/G2)',
      'package identity and boundaries (owning package directory per file)',
      '@vercel/nft positive trace and its module-graph order',
      'resolver metadata semantics (package.json precedes resolution)',
      'declared package dependency graph, Node-resolved',
      'file size',
    ],
    order: out,
    tiers,
  };
}

// ──────────────────────────────────────────────────────── O — oracle (analysis)

/**
 * The oracle: exactly the files the post-admission traffic reads, in the order
 * it first reads them. NOT a deployable strategy — it is derived from the TEST
 * workload — and it exists only to give the sweep a lower bound: the smallest
 * prewarm that perfect future knowledge would have needed.
 */
export function oracle(plan: LongtailPlan, needed: TrainAccess[]): Ranking {
  const out: string[] = [];
  const seen = new Set<string>();
  const tiers: Ranking['tiers'] = [];
  tier(out, seen, tiers, 'needed-in-first-touch-order', [...needed].sort((a, b) => a.firstMs - b.firstMs).map((t) => t.rel));
  tier(out, seen, tiers, 'remainder-by-path', plan.files.map(([rel]) => rel).sort());
  return {
    arm: 'O',
    inputs: ['THE TEST WORKLOAD ITSELF — analysis only, never deployable'],
    order: out,
    tiers,
  };
}

// ────────────────────────────────────────────────────────────────── budgeting

export interface Budgeted {
  arm: ArmName;
  /** normalized budget as a fraction of universe FILE bytes */
  budget: number;
  budgetBytes: number;
  files: string[];
  bytes: number;
  /** which ranking tier the budget ran out in */
  stoppedInTier: string;
}

/**
 * Fill the budget greedily in ranked order: walk the ranking, take each file
 * that still fits, skip one that does not, stop when nothing further fits.
 *
 * FILE bytes, not chunk bytes — the only currency every strategy controls
 * exactly and every arm is charged identically in, so "equal cost" is equal by
 * construction. What the substrate then actually moves is measured separately
 * and always reported next to it.
 *
 * Skip-and-continue rather than stop-at-first-overflow, because a hard prefix
 * would let one large file early in a ranking discard the entire remaining
 * budget — an artefact of the truncation rule, not a property of the strategy.
 * The rule is identical for all four arms and for the oracle.
 */
export function truncate(r: Ranking, plan: LongtailPlan, budget: number): Budgeted {
  const size = new Map(plan.files);
  const budgetBytes = Math.floor(plan.universeBytes * budget);
  const files: string[] = [];
  let bytes = 0;
  let reached = 0;
  let smallest = Infinity;
  for (const [, s] of plan.files) if (s < smallest) smallest = s;
  for (let idx = 0; idx < r.order.length; idx++) {
    const rel = r.order[idx]!;
    const s = size.get(rel) ?? 0;
    if (bytes + s > budgetBytes) {
      if (bytes + smallest > budgetBytes) break; // nothing left can fit
      continue;
    }
    files.push(rel);
    bytes += s;
    reached = idx + 1;
  }
  const stoppedInTier = r.tiers.find((t) => reached <= t.upto)?.name ?? r.tiers.at(-1)?.name ?? 'none';
  return { arm: r.arm, budget, budgetBytes, files, bytes, stoppedInTier };
}
