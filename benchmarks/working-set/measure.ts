/**
 * Working-set MEASUREMENT (ADR-0007 experiment 1).
 *
 * Joins a `WorkingSetPlan` back against the production universe and reports
 * byte/file/package distributions. Nothing here plans, transforms, or removes:
 * the planner decides placement, this decides how to count it.
 *
 * Two properties are enforced at measurement time (not only in tests), because
 * a violation would silently inflate or deflate every reported percentage:
 *
 *  - the plan partitions the universe exactly — one placement per universe
 *    file, joined to the canonical record;
 *  - no physical file is counted twice — the universe is realpath-deduped, and
 *    `joinPlan` re-proves it on the plan (a pnpm alias path counted twice would
 *    inflate the denominator and deflate the cold fraction).
 *
 * `COLD` here means only "not selected for initial local placement". It never
 * means dead, unused, unreachable, or removable (ADR-0007).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Universe, UniverseFile } from '@reducer/production-universe';
import type { Placement, PlacementReason, WorkingSetPlan } from '@reducer/working-set-planner';

export const DENOMINATORS = ['universe', 'thirdParty', 'thirdPartyJs'] as const;
export type Denominator = (typeof DENOMINATORS)[number];

/**
 * Denominator membership. `thirdPartyJs` is deliberately the ADR-0006 `D`
 * predicate verbatim (third-party ∧ executable JS) so these numbers stay
 * comparable with the conservative-linker corpus results; `measurePlan`
 * asserts the total equals `universe.D`.
 */
const MEMBER: Record<Denominator, (f: UniverseFile) => boolean> = {
  universe: () => true,
  thirdParty: (f) => f.thirdParty,
  thirdPartyJs: (f) => f.thirdParty && f.isJs,
};

/**
 * Marginal attribution order. Every HOT byte is charged to exactly one reason:
 * the highest-priority reason its file carries. A reason's `attributed` total
 * is therefore the bytes it forces hot that no higher-priority reason already
 * would — which is the diagnostic this experiment needs ("what does the opaque
 * boundary actually cost, on top of the evidence we already had?"). `coverage`
 * reports the same bytes WITHOUT dedup, for the overlapping view.
 *
 * `opaque-boundary` is last on purpose: it is the only reason Plan B adds, so
 * its attributed bytes are exactly the Plan A → Plan B opportunity loss.
 */
export const REASON_PRIORITY: readonly PlacementReason[] = [
  'no-positive-evidence',
  'nft-positive',
  'entrypoint',
  'resolver-metadata',
  'opaque-boundary',
] as const;

export interface DenomMetrics {
  bytes: number;
  hotBytes: number;
  coldBytes: number;
  /** coldBytes / bytes (0 when the denominator is empty) */
  coldFraction: number;
  files: number;
  hotFiles: number;
  coldFiles: number;
}

export interface PackageStat {
  /** universe-relative package dir — the unique key (one name can be installed many times) */
  dir: string;
  name: string;
  version: string;
  thirdParty: boolean;
  files: number;
  hotFiles: number;
  coldFiles: number;
  bytes: number;
  hotBytes: number;
  coldBytes: number;
  /** hotBytes / bytes */
  hotByteFraction: number;
  class: 'all-hot' | 'mixed' | 'all-cold';
  /**
   * The same classification with `package.json` excluded. Resolver metadata is
   * forced hot in EVERY package, so the plan-faithful `class` is "mixed" for
   * essentially every package in every app and answers nothing. This field is
   * the one that actually distinguishes package-level from file-level
   * opportunity: `all-cold` here means a package-granularity virtualizer would
   * have caught this package too.
   */
  classNonMeta: 'all-hot' | 'mixed' | 'all-cold';
  nonMetaFiles: number;
  nonMetaHotFiles: number;
  nonMetaBytes: number;
  nonMetaHotBytes: number;
}

export interface PlanMetrics {
  label: string;
  /** false when the plan is the fail-safe all-HOT response to a missing trace */
  predictive: boolean;
  denominators: Record<Denominator, DenomMetrics>;
  reasons: {
    /** each byte charged to exactly one reason (REASON_PRIORITY) */
    attributed: Record<string, number>;
    /** bytes of every file carrying the reason — overlapping, sums to more than hot */
    coverage: Record<string, number>;
  };
  packages: {
    total: number;
    allHot: number;
    mixed: number;
    allCold: number;
    /** same counts with package.json excluded — see PackageStat.classNonMeta */
    allHotNonMeta: number;
    mixedNonMeta: number;
    allColdNonMeta: number;
    stats: PackageStat[];
  };
  warnings: string[];
}

interface Joined {
  f: UniverseFile;
  p: Placement;
}

/**
 * One placement ↔ one canonical universe file, proven 1:1 and physically
 * unique. Throws rather than reporting a number computed over a broken join.
 */
export function joinPlan(universe: Universe, plan: WorkingSetPlan): Joined[] {
  if (plan.placements.length !== universe.files.length) {
    throw new Error(`plan places ${plan.placements.length} files, universe has ${universe.files.length}`);
  }
  const seenReal = new Set<string>();
  const out: Joined[] = [];
  for (const p of plan.placements) {
    const f = universe.byRel.get(p.file);
    if (!f) throw new Error(`placement '${p.file}' has no universe record`);
    if (f.rel !== p.file) throw new Error(`placement '${p.file}' joined non-canonical universe record '${f.rel}'`);
    if (f.bytes !== p.bytes) throw new Error(`placement '${p.file}' bytes ${p.bytes} != universe ${f.bytes}`);
    if (seenReal.has(f.real)) throw new Error(`placement '${p.file}' double-counts physical file '${f.real}'`);
    seenReal.add(f.real);
    out.push({ f, p });
  }
  return out;
}

const emptyDenom = (): DenomMetrics => ({
  bytes: 0,
  hotBytes: 0,
  coldBytes: 0,
  coldFraction: 0,
  files: 0,
  hotFiles: 0,
  coldFiles: 0,
});

export function measurePlan(universe: Universe, plan: WorkingSetPlan, label: string): PlanMetrics {
  const joined = joinPlan(universe, plan);

  const denominators = {
    universe: emptyDenom(),
    thirdParty: emptyDenom(),
    thirdPartyJs: emptyDenom(),
  } satisfies Record<Denominator, DenomMetrics>;

  const attributed: Record<string, number> = {};
  const coverage: Record<string, number> = {};
  for (const r of REASON_PRIORITY) {
    attributed[r] = 0;
    coverage[r] = 0;
  }

  const pkgs = new Map<string, PackageStat>();
  const UNOWNED = '(no package)';

  for (const { f, p } of joined) {
    const hot = p.placement === 'hot';

    for (const d of DENOMINATORS) {
      if (!MEMBER[d](f)) continue;
      const m = denominators[d];
      m.bytes += f.bytes;
      m.files += 1;
      if (hot) {
        m.hotBytes += f.bytes;
        m.hotFiles += 1;
      } else {
        m.coldBytes += f.bytes;
        m.coldFiles += 1;
      }
    }

    if (hot) {
      if (p.reasons.length === 0) throw new Error(`hot placement '${p.file}' carries no reason`);
      const primary = REASON_PRIORITY.find((r) => p.reasons.includes(r));
      if (!primary) throw new Error(`hot placement '${p.file}' carries unknown reasons: ${p.reasons.join(',')}`);
      attributed[primary]! += f.bytes;
      for (const r of p.reasons) coverage[r] = (coverage[r] ?? 0) + f.bytes;
    } else if (p.reasons.length > 0) {
      throw new Error(`cold placement '${p.file}' carries reasons: ${p.reasons.join(',')}`);
    }

    const key = f.pkg ? f.pkg.dir : UNOWNED;
    let s = pkgs.get(key);
    if (!s) {
      s = {
        dir: f.pkg ? relDir(universe.root, f.pkg.dir) : UNOWNED,
        name: f.pkg?.name ?? UNOWNED,
        version: f.pkg?.version ?? '',
        thirdParty: f.thirdParty,
        files: 0,
        hotFiles: 0,
        coldFiles: 0,
        bytes: 0,
        hotBytes: 0,
        coldBytes: 0,
        hotByteFraction: 0,
        class: 'all-cold',
        classNonMeta: 'all-cold',
        nonMetaFiles: 0,
        nonMetaHotFiles: 0,
        nonMetaBytes: 0,
        nonMetaHotBytes: 0,
      };
      pkgs.set(key, s);
    }
    // A package is third-party if any of its universe files is (frozen-mode
    // membership is per package, so this is uniform in practice).
    s.thirdParty ||= f.thirdParty;
    s.files += 1;
    s.bytes += f.bytes;
    if (hot) {
      s.hotFiles += 1;
      s.hotBytes += f.bytes;
    } else {
      s.coldFiles += 1;
      s.coldBytes += f.bytes;
    }
    // `endsWith('/package.json')` plus the bare root manifest — the planner's
    // resolver-metadata predicate verbatim, so the two never drift apart.
    if (!(f.rel === 'package.json' || f.rel.endsWith('/package.json'))) {
      s.nonMetaFiles += 1;
      s.nonMetaBytes += f.bytes;
      if (hot) {
        s.nonMetaHotFiles += 1;
        s.nonMetaHotBytes += f.bytes;
      }
    }
  }

  for (const d of DENOMINATORS) {
    const m = denominators[d];
    if (m.hotBytes + m.coldBytes !== m.bytes) throw new Error(`denominator '${d}': hot+cold != total`);
    m.coldFraction = m.bytes > 0 ? m.coldBytes / m.bytes : 0;
  }
  if (denominators.thirdPartyJs.bytes !== universe.D) {
    throw new Error(`third-party-JS denominator ${denominators.thirdPartyJs.bytes} != universe.D ${universe.D}`);
  }

  const stats = [...pkgs.values()];
  for (const s of stats) {
    s.hotByteFraction = s.bytes > 0 ? s.hotBytes / s.bytes : 0;
    s.class = s.coldFiles === 0 ? 'all-hot' : s.hotFiles === 0 ? 'all-cold' : 'mixed';
    const nonMetaCold = s.nonMetaFiles - s.nonMetaHotFiles;
    // A package that is nothing but its manifest has no non-metadata content to
    // place; it counts as all-hot, matching how the plan actually treats it.
    s.classNonMeta =
      s.nonMetaFiles === 0 || nonMetaCold === 0 ? 'all-hot' : s.nonMetaHotFiles === 0 ? 'all-cold' : 'mixed';
  }
  stats.sort((a, b) => b.bytes - a.bytes);

  return {
    label,
    predictive: !plan.placements.some((p) => p.reasons.includes('no-positive-evidence')),
    denominators,
    reasons: { attributed, coverage },
    packages: {
      total: stats.length,
      allHot: stats.filter((s) => s.class === 'all-hot').length,
      mixed: stats.filter((s) => s.class === 'mixed').length,
      allCold: stats.filter((s) => s.class === 'all-cold').length,
      allHotNonMeta: stats.filter((s) => s.classNonMeta === 'all-hot').length,
      mixedNonMeta: stats.filter((s) => s.classNonMeta === 'mixed').length,
      allColdNonMeta: stats.filter((s) => s.classNonMeta === 'all-cold').length,
      stats,
    },
    warnings: plan.warnings,
  };
}

function relDir(root: string, dir: string): string {
  const rel = path.relative(root, dir).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}

// ---------------------------------------------------------------------------
// Opaque-boundary diagnostics
//
// `opaquePackages().own` marks a package opaque on ANY of: a `.node`, a
// `.wasm`, a `binding.gyp`, an install/postinstall script, or an unscannable
// directory. Those are very different facts, and this experiment must be able
// to say WHICH of them is consuming Plan A's opportunity — without refining the
// heuristic during the run (explicitly out of scope). So: classify, never
// change.
//
// Artifact evidence is derived from the ALREADY-WALKED universe rather than a
// second recursive disk scan. One consequence is recorded honestly instead of
// papered over: an artifact reached only through a symlink (the universe walk
// records symlinks but never walks them) leaves its package `unclassified`.
// ---------------------------------------------------------------------------

export type OpaqueEvidence =
  | 'native-artifact'
  | 'wasm-artifact'
  | 'binding-gyp'
  | 'install-script'
  | 'unscannable'
  | 'unclassified';

/** Artifact evidence wins over the install-script proxy: the proxy only "costs" where it is the SOLE signal. */
const ARTIFACT_RANK: OpaqueEvidence[] = ['native-artifact', 'wasm-artifact', 'binding-gyp'];

/** The rels `opaquePackages` reported as unscannable, from the warnings it was handed. */
export function unscannableDirs(warnings: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const w of warnings) {
    const m = /treating as opaque: (.+?) \(/.exec(w);
    if (m?.[1]) out.add(m[1]);
  }
  return out;
}

export function classifyOpaque(
  universe: Universe,
  opaqueDirs: Iterable<string>,
  unscannable: ReadonlySet<string>,
): Map<string, OpaqueEvidence> {
  // Materialized once: `opaqueDirs` is routinely a Map.keys() iterator, and it
  // is walked twice below.
  const opaque = new Set(opaqueDirs);
  const artifact = new Map<string, OpaqueEvidence>();
  const credit = (dir: string, e: OpaqueEvidence) => {
    const cur = artifact.get(dir);
    if (!cur || ARTIFACT_RANK.indexOf(e) < ARTIFACT_RANK.indexOf(cur)) artifact.set(dir, e);
  };
  for (const f of universe.files) {
    const base = f.rel.slice(f.rel.lastIndexOf('/') + 1);
    const e: OpaqueEvidence | null = base.endsWith('.node')
      ? 'native-artifact'
      : base.endsWith('.wasm')
        ? 'wasm-artifact'
        : base === 'binding.gyp'
          ? 'binding-gyp'
          : null;
    if (!e) continue;
    // Mirror `opaquePackages`' own scan exactly: it marks a package dir when
    // the artifact is anywhere in that dir's own tree, crossing nested
    // manifests but never a nested install tree. Crediting only `f.pkg.dir`
    // (the NEAREST manifest) misattributes every package whose artifact sits
    // under a nested manifest — wasm-bindgen output dirs ship their own
    // `package.json`, so the enclosing package would look unexplained.
    let dir = path.dirname(f.abs);
    while (true) {
      if (opaque.has(dir)) credit(dir, e);
      if (path.basename(dir) === 'node_modules' || dir === universe.root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  const out = new Map<string, OpaqueEvidence>();
  for (const dir of opaque) {
    const a = artifact.get(dir);
    if (a) {
      out.set(dir, a);
      continue;
    }
    let script = false;
    try {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const s = pj.scripts ?? {};
      script = typeof s.install === 'string' || typeof s.postinstall === 'string';
    } catch {
      /* unreadable manifest is not evidence either way */
    }
    out.set(dir, script ? 'install-script' : unscannable.has(relDir(universe.root, dir)) ? 'unscannable' : 'unclassified');
  }
  return out;
}

export interface OpaqueCostBucket {
  packages: number;
  files: number;
  /** bytes that are COLD in plan A and HOT in plan B because of this evidence */
  forcedHotBytes: number;
}

/**
 * The Plan A → Plan B loss, attributed to what actually made each package
 * opaque. Sums to the total opportunity Plan B gives up.
 */
export function opaqueCost(
  universe: Universe,
  planA: WorkingSetPlan,
  planB: WorkingSetPlan,
  evidence: ReadonlyMap<string, OpaqueEvidence>,
): { total: OpaqueCostBucket; byEvidence: Record<string, OpaqueCostBucket>; topPackages: { dir: string; evidence: string; bytes: number }[] } {
  const aByFile = new Map(planA.placements.map((p) => [p.file, p] as const));
  const byEvidence: Record<string, OpaqueCostBucket> = {};
  const perPkg = new Map<string, { bytes: number; evidence: OpaqueEvidence }>();
  const total: OpaqueCostBucket = { packages: 0, files: 0, forcedHotBytes: 0 };

  for (const pb of planB.placements) {
    if (pb.placement !== 'hot') continue;
    if (aByFile.get(pb.file)?.placement !== 'cold') continue;
    const f = universe.byRel.get(pb.file);
    if (!f?.pkg) continue;
    const ev = evidence.get(f.pkg.dir) ?? 'unclassified';
    const b = (byEvidence[ev] ??= { packages: 0, files: 0, forcedHotBytes: 0 });
    b.files += 1;
    b.forcedHotBytes += f.bytes;
    total.files += 1;
    total.forcedHotBytes += f.bytes;
    const cur = perPkg.get(f.pkg.dir);
    if (cur) cur.bytes += f.bytes;
    else perPkg.set(f.pkg.dir, { bytes: f.bytes, evidence: ev });
  }

  for (const [dir, v] of perPkg) {
    byEvidence[v.evidence]!.packages += 1;
    total.packages += 1;
    void dir;
  }

  const topPackages = [...perPkg.entries()]
    .map(([dir, v]) => ({ dir: relDir(universe.root, dir), evidence: v.evidence, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 25);

  return { total, byEvidence, topPackages };
}
