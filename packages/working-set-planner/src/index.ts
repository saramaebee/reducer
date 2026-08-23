/**
 * @reducer/working-set-planner — HOT/COLD placement planning for the
 * dependency-virtualization experiment (ADR-0007).
 *
 * THE INVARIANT THIS PACKAGE MUST NEVER VIOLATE: a placement plan decides
 * WHERE a production-universe file lives (locally materialized vs recoverable
 * from immutable storage), never WHETHER it is available. Every universe file
 * appears in the plan exactly once; nothing is removed. A wrong prediction is
 * a recoverable runtime miss plus latency — never semantic divergence. This is
 * the inverse of the retired conservative linker, where analysis decided
 * availability and therefore had to prove unreachability (ADR-0001/0006).
 *
 * The planner here is deliberately naive (experiment 1, ADR-0007): it answers
 * "if omitted files were perfectly recoverable, what is the theoretical
 * initial working-set reduction?" — it does NOT claim candidate-cold files are
 * unreachable, and it builds no recovery runtime.
 *
 *   NFT-positive            → HOT   (positive runtime evidence)
 *   entrypoint              → HOT
 *   package.json            → HOT   (resolver metadata: resolution must work
 *                                    before any hydration could)
 *   opaque-boundary package → HOT   (native/.node/.wasm/install-script
 *                                    packages: unsafe to virtualize naively)
 *   everything else         → candidate COLD
 *
 * Hazard signals (dynamic require, createRequire, escaped loaders, …) are
 * PLANNING inputs for later, better planners — widen a cluster, lower
 * confidence, force a package hot — never global blockers. The naive planner
 * ignores them by design; the miss rate they cause is exactly what the
 * hydration-curve experiment measures.
 */
import type { Universe, UniverseFile } from '@reducer/production-universe';

export type PlacementReason =
  | 'entrypoint'
  | 'nft-positive'
  | 'resolver-metadata'
  | 'opaque-boundary'
  | 'no-positive-evidence';

export interface Placement {
  /** universe-relative path (the universe is authoritative; see ADR-0005/0007) */
  file: string;
  bytes: number;
  placement: 'hot' | 'cold';
  /** why the file is forced hot; empty for candidate-cold */
  reasons: PlacementReason[];
}

export interface WorkingSetBytes {
  /** every file in the production universe */
  universe: number;
  /** third-party executable JS only (D, the ADR-0006 denominator) */
  universeThirdPartyJs: number;
  nftPositive: number;
  forcedHot: number;
  candidateCold: number;
  /** candidateCold / universe (0 when the universe is empty) */
  coldFraction: number;
  /** cold third-party JS / D (0 when D is 0) */
  coldThirdPartyJsFraction: number;
}

export interface WorkingSetPlan {
  app: string;
  placements: Placement[];
  bytes: WorkingSetBytes;
  warnings: string[];
}

export interface PlanInput {
  universe: Universe;
  /**
   * Universe rels with positive runtime-reachability evidence (an NFT trace
   * hit). null = no positive evidence exists; prediction is then pointless —
   * everything is forced hot — but never inadmissible, because in this model
   * a bad plan costs latency, not correctness.
   */
  nft: ReadonlySet<string> | null;
  /**
   * Package dirs that are unsafe to virtualize naively (native/.node/.wasm/
   * install-script packages — e.g. the keys of hazard-domain's
   * `opaquePackages(...).all`).
   */
  opaquePkgDirs?: ReadonlySet<string>;
  app?: string;
}

export function planWorkingSet(input: PlanInput): WorkingSetPlan {
  const { universe, nft } = input;
  const opaque = input.opaquePkgDirs ?? new Set<string>();
  const warnings: string[] = [];
  if (nft === null) {
    warnings.push(
      'no positive reachability evidence (NFT unavailable): every file forced hot; the plan predicts nothing',
    );
  }

  const reasonsFor = (f: UniverseFile): PlacementReason[] => {
    if (nft === null) return ['no-positive-evidence'];
    const reasons: PlacementReason[] = [];
    if (f.rel === universe.entryRel) reasons.push('entrypoint');
    if (nft.has(f.rel)) reasons.push('nft-positive');
    if (f.rel === 'package.json' || f.rel.endsWith('/package.json')) reasons.push('resolver-metadata');
    if (f.pkg && opaque.has(f.pkg.dir)) reasons.push('opaque-boundary');
    return reasons;
  };

  const bytes: WorkingSetBytes = {
    universe: 0,
    universeThirdPartyJs: universe.D,
    nftPositive: 0,
    forcedHot: 0,
    candidateCold: 0,
    coldFraction: 0,
    coldThirdPartyJsFraction: 0,
  };
  let coldThirdPartyJs = 0;

  const placements: Placement[] = universe.files.map((f) => {
    const reasons = reasonsFor(f);
    const hot = reasons.length > 0;
    bytes.universe += f.bytes;
    if (nft?.has(f.rel)) bytes.nftPositive += f.bytes;
    if (hot) bytes.forcedHot += f.bytes;
    else {
      bytes.candidateCold += f.bytes;
      if (f.isJs && f.thirdParty) coldThirdPartyJs += f.bytes;
    }
    return { file: f.rel, bytes: f.bytes, placement: hot ? 'hot' : 'cold', reasons };
  });

  bytes.coldFraction = bytes.universe > 0 ? bytes.candidateCold / bytes.universe : 0;
  bytes.coldThirdPartyJsFraction = bytes.universeThirdPartyJs > 0 ? coldThirdPartyJs / bytes.universeThirdPartyJs : 0;

  return {
    app: input.app ?? universe.root.split('/').pop() ?? universe.root,
    placements,
    bytes,
    warnings,
  };
}
