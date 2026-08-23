/**
 * @reducer/hazard-domain — the non-transforming hazard-domain analyzer
 * (ADR-0006). It TRANSFORMS NOTHING and grants no deletion authority: it
 * predicts what a transform could remove under explicit, named proof models.
 *
 * The two-phase API exists because counterfactuals are measured by RERUNNING
 * the analysis, never by speculating inside one run: `prepareHazardDomain`
 * parses the universe once (the expensive half), and `analyzePrepared` runs the
 * fixpoint, projection and byte prediction per configuration (the cheap half).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { trace } from '@reducer/tracer';
import { extractModuleFacts } from './facts.ts';
import { runFixpoint, type FixpointInput } from './fixpoint.ts';
import { decideSymbols, opaquePackages, projectUsage } from './projection.ts';
import { predictBytes } from './bytes.ts';
import { assembleReport } from './report.ts';
import { buildUniverse, findBase, pullIn, type Universe } from './universe.ts';
import type { AnalysisConfig, GateTag, HazardDomainReport, ModuleFacts, ResolvedTargetDomain } from './types.ts';

export * from './types.ts';
export { buildUniverse, findBase, pullIn, packageJsFiles } from './universe.ts';
export type { Universe, UniverseFile, PkgId } from './universe.ts';
export { resolveDomain, domainGates } from './resolve.ts';
export { runFixpoint } from './fixpoint.ts';
export type { FixpointResult, ActiveSink } from './fixpoint.ts';
export { projectUsage, decideSymbols, opaquePackages } from './projection.ts';
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
  opaque: Map<string, GateTag>;
  resolveCache: Map<string, ResolvedTargetDomain>;
  warnings: string[];
  prepareMs: number;
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
  for (const f of universe.files) {
    if (!f.isJs) continue;
    let code: string;
    try {
      code = readFileSync(f.abs, 'utf8');
    } catch {
      warnings.push(`unreadable universe JS file, treated as opaque: ${f.rel}`);
      continue;
    }
    facts.set(f.rel, extractModuleFacts(code, f.abs, f.rel, f.thirdParty, f.pkg));
  }

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
  };
  const fx = runFixpoint(input, config);
  const usage = projectUsage(prep.universe, prep.facts, fx);
  const decisions = decideSymbols(prep.universe, prep.facts, fx, usage, prep.opaque, config);
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
    warnings: prep.warnings,
    analysisMs: Date.now() - t0,
  });
}

export async function analyzeHazardDomain(
  opts: HazardDomainOptions & { config?: AnalysisConfig },
): Promise<HazardDomainReport> {
  return analyzePrepared(await prepareHazardDomain(opts), opts.config);
}
