/**
 * @reducer/hazard-domain — the non-transforming hazard-domain analyzer
 * (ADR-0006). It TRANSFORMS NOTHING and grants no deletion authority: it
 * predicts what a transform could remove under explicit, named proof models.
 *
 * The two-phase API exists because counterfactuals are measured by RERUNNING
 * the analysis, never by speculating inside one run: `prepareHazardDomain`
 * parses the universe once (the expensive half), and `analyzePrepared` runs the
 * fixpoint, projection and byte prediction per configuration (the cheap half).
 *
 * TWO ROLES after the ADR-0007 pivot: (a) shared analysis primitives — module
 * facts, load-sink classification, exact/finite/unbounded target domains,
 * capability flow, escape and export-surface analysis — which feed working-set
 * planning signals and the dormant sound-island probe (FE-1); (b) the frozen
 * ADR-0006 whole-app measurement policy (fixpoint widening to the universe,
 * kill-metric byte prediction), preserved for reproducibility of the first-run
 * evidence. Universe discovery now lives in @reducer/production-universe and
 * is re-exported here for existing consumers.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { trace } from '@reducer/tracer';
import { extractModuleFacts, opaqueModuleFacts } from './facts.ts';
import { WITHDRAWN_REFINEMENTS, runFixpoint, type FixpointInput } from './fixpoint.ts';
import { decideSymbols, opaquePackages, projectUsage, type OpaqueScan } from './projection.ts';
import { predictBytes } from './bytes.ts';
import { assembleReport } from './report.ts';
import { buildUniverse, findBase, pullIn, type Universe } from '@reducer/production-universe';
import type { AnalysisConfig, GateTag, HazardDomainReport, ModuleFacts, ResolvedTargetDomain } from './types.ts';

export * from './types.ts';
export { buildUniverse, findBase, pullIn, packageJsFiles } from '@reducer/production-universe';
export type { Universe, UniverseFile, PkgId } from '@reducer/production-universe';
export { resolveDomain, domainGates } from './resolve.ts';
export { runFixpoint, WITHDRAWN_REFINEMENTS } from './fixpoint.ts';
export type { FixpointResult, ActiveSink } from './fixpoint.ts';
export { projectUsage, decideSymbols, opaquePackages } from './projection.ts';
export type { OpaqueScan } from './projection.ts';
export { extractModuleFacts } from './facts.ts';
export { analyzerSourceHash } from './report.ts';

export interface HazardDomainOptions {
  /** app label for the report; defaults to the universe root's basename */
  app?: string;
  /** absolute (or cwd-relative) entrypoint */
  entry: string;
  /** universe root; defaults to cli/build.ts findBase semantics */
  root?: string;
  /** the frozen production package population; absent ⇒ lockfile fallback mode */
  frozenPackages?: { name: string; version: string }[];
  /** run NFT for positive reachability evidence (default true) */
  nft?: boolean;
}

export interface PreparedApp {
  app: string;
  universe: Universe;
  facts: Map<string, ModuleFacts>;
  /** NFT-traced universe JS rels, or null when no positive evidence exists */
  nft: Set<string> | null;
  /**
   * False when NFT produced no positive evidence. NFT seeds only ADD
   * reachability, so their ABSENCE would make files look removable that the
   * trace would have retained — the missing-evidence direction is exactly the
   * unsound one. So without a trace no file-level removal prediction is
   * admissible at all, and every file is retained-uncertain.
   */
  fileRemovalAdmissible: boolean;
  opaque: OpaqueScan;
  resolveCache: Map<string, ResolvedTargetDomain>;
  warnings: string[];
  prepareMs: number;
}

/**
 * Give every universe JS file that does not have them yet its ModuleFacts, and
 * return how many were added.
 *
 * "…that does not have them yet" is load-bearing: `resolveDomain` can `pullIn` a
 * file DURING the fixpoint (positive evidence for a package the frozen
 * population did not declare), i.e. after prepare has finished parsing. Such a
 * file is reachable-by-construction — something resolved into it — so leaving it
 * factless would hide its own load sinks from the fixpoint entirely, and hiding
 * a `require(x)` is the one direction this analyzer may never take.
 */
function parseUniverseFacts(u: Universe, facts: Map<string, ModuleFacts>, warnings: string[]): number {
  let added = 0;
  for (const f of u.files) {
    if (!f.isJs || facts.has(f.rel)) continue;
    let code: string | null = null;
    try {
      code = readFileSync(f.abs, 'utf8');
    } catch {
      warnings.push(`unreadable universe JS file, treated as opaque: ${f.rel}`);
    }
    facts.set(
      f.rel,
      code === null
        ? opaqueModuleFacts(f.abs, f.rel, f.thirdParty, f.pkg, 'unreadable on disk: module is opaque', f.bytes)
        : extractModuleFacts(code, f.abs, f.rel, f.thirdParty, f.pkg),
    );
    added++;
  }
  return added;
}

export async function prepareHazardDomain(opts: HazardDomainOptions): Promise<PreparedApp> {
  const t0 = Date.now();
  const entryAbs = path.resolve(opts.entry);
  const root = path.resolve(opts.root ?? findBase(entryAbs));
  const universe = buildUniverse({ entry: entryAbs, root, frozenPackages: opts.frozenPackages });
  const warnings: string[] = [];

  // ---- positive evidence (never a removal authority)
  let nft: Set<string> | null = null;
  let fileRemovalAdmissible = false;
  if (opts.nft !== false) {
    try {
      const traced = await trace([universe.entryAbs], universe.root);
      nft = new Set<string>();
      for (const tf of traced.files) {
        if (tf.kind !== 'js') continue;
        const f =
          universe.byRel.get(tf.rel) ??
          universe.byReal.get(tf.abs) ??
          // NFT reached a file the frozen population did not declare: positive
          // evidence, so it joins the universe and is counted.
          pullIn(universe, tf.abs, 'the NFT trace reached it');
        if (f?.isJs) nft.add(f.rel);
      }
      fileRemovalAdmissible = true;
      if (traced.warnings.length > 0) {
        warnings.push(`NFT reported ${traced.warnings.length} warning(s): ${traced.warnings.slice(0, 3).join('; ')}`);
      }
    } catch (err) {
      nft = null;
      warnings.push(
        `NFT trace failed (${String(err).slice(0, 200)}); positive reachability evidence is unavailable. ` +
          'Treated as a WIDENING event: no file-level removal prediction is admissible for this app ' +
          '(gate nft-positive-evidence, absent evidence).',
      );
    }
  } else {
    warnings.push(
      'NFT disabled: no positive reachability evidence. Treated as a widening event — ' +
        'no file-level removal prediction is admissible (gate nft-positive-evidence, absent evidence).',
    );
  }

  // ---- parse every universe JS file exactly once
  const facts = new Map<string, ModuleFacts>();
  parseUniverseFacts(universe, facts, warnings);

  const opaque = opaquePackages(universe, warnings);

  return {
    app: opts.app ?? path.basename(universe.root),
    universe,
    facts,
    nft,
    fileRemovalAdmissible,
    opaque,
    resolveCache: new Map(),
    warnings,
    prepareMs: Date.now() - t0,
  };
}

export function analyzePrepared(prep: PreparedApp, config?: AnalysisConfig): HazardDomainReport {
  const t0 = Date.now();
  const input: FixpointInput = {
    universe: prep.universe,
    facts: prep.facts,
    nft: prep.nft,
    resolveCache: prep.resolveCache,
    opaque: prep.opaque.own,
  };
  // SR-F6: a withdrawn refinement admits nothing, and the run must say so —
  // silently answering a withdrawn counterfactual with the strict number would
  // read as "the refinement buys nothing", not "the refinement is not sound".
  const warnings = [...prep.warnings];
  for (const r of config?.refinements ?? []) {
    const why = WITHDRAWN_REFINEMENTS[r];
    if (why) warnings.push(`refinement ${r}: ${why}`);
  }
  // Resolution can grow the universe mid-fixpoint (`pullIn`). Parse whatever it
  // discovered and re-run until it discovers nothing new, so the report is
  // computed over ONE universe whose every JS file has facts. `pullIn` only ever
  // adds, and there are finitely many files, so this terminates — in the common
  // case after a single extra pass, and with zero extra passes when nothing was
  // pulled in. (Cross-CONFIG drift is still possible: a later, more permissive
  // config can reach files this one did not, so its D may exceed this one's.
  // That is monotone and recorded as a universe-divergence warning.)
  let fx = runFixpoint(input, config);
  while (parseUniverseFacts(prep.universe, prep.facts, prep.warnings) > 0) {
    fx = runFixpoint(input, config);
  }
  const usage = projectUsage(prep.universe, prep.facts, fx);
  const decisions = decideSymbols(prep.universe, prep.facts, fx, usage, prep.opaque.all, config);
  const bytes = predictBytes(
    prep.universe,
    prep.facts,
    fx,
    decisions,
    prep.nft,
    prep.fileRemovalAdmissible,
  );
  return assembleReport({
    app: prep.app,
    universe: prep.universe,
    facts: prep.facts,
    fx,
    decisions,
    bytes,
    nft: prep.nft,
    fileRemovalAdmissible: prep.fileRemovalAdmissible,
    config,
    warnings,
    analysisMs: Date.now() - t0,
  });
}

export async function analyzeHazardDomain(
  opts: HazardDomainOptions & { config?: AnalysisConfig },
): Promise<HazardDomainReport> {
  return analyzePrepared(await prepareHazardDomain(opts), opts.config);
}
