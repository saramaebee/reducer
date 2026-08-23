/**
 * Module-init reachability fixpoint (design §9, CONTEXT.md "module
 * reachability").
 *
 * The only question answered here is whether a module's INITIALIZATION can run.
 * Export reachability is a strictly narrower question decided later, and only
 * for modules whose surface is closed.
 *
 * Monotonicity: every rule in this file adds to `reachable`; nothing removes.
 * Seeds only ADD (NFT positive evidence widens retention, it never authorizes
 * an omission). A configuration can suppress a gate's widening — that is the
 * gate-off counterfactual mechanism, explicitly UNSOUND and diagnostic — but
 * UNSUPPRESSIBLE_GATES are refused so no config can ever suppress positive
 * evidence itself.
 */
import path from 'node:path';
import {
  UNSUPPRESSIBLE_GATES,
  asGates,
  type AnalysisConfig,
  type GateTag,
  type LoadSink,
  type ModuleFacts,
  type ResolvedTargetDomain,
} from './types.ts';
import { domainGates, resolveDomain, type ResolveOptions } from './resolve.ts';
import { unionDomains } from './specifier.ts';
import type { Universe } from './universe.ts';

export interface FixpointInput {
  universe: Universe;
  facts: Map<string, ModuleFacts>;
  /** NFT-traced JS rels, or null when no positive evidence is available */
  nft: Set<string> | null;
  /** per-(sink,resolve-option) memo so rerun-per-config stays cheap */
  resolveCache: Map<string, ResolvedTargetDomain>;
}

export interface ActiveSink {
  sink: LoadSink;
  domain: ResolvedTargetDomain;
  gates: GateTag[];
}

export interface FixpointResult {
  /** module-init reachable universe JS rels */
  reachable: Set<string>;
  /** retained by a resolve-effect sink: bytes stay, module never initializes */
  resolveRetained: Set<string>;
  attribution: Map<string, Set<GateTag>>;
  activeLoadSinks: ActiveSink[];
  activeSinkCount: number;
  /** union of EVERY active unbounded load sink's gates (complete blocking set) */
  unboundedGates: GateTag[];
  unboundedActive: boolean;
  widened: { where: string; why: string }[];
}

function suppressionSet(config: AnalysisConfig | undefined): Set<GateTag> {
  const out = new Set<GateTag>(config?.suppressGates ?? []);
  for (const g of UNSUPPRESSIBLE_GATES) out.delete(g);
  return out;
}

/**
 * Apply a config to a resolved domain. Returns null when the widening the
 * config suppressed was the ONLY thing this sink contributed.
 */
function applyConfig(d: ResolvedTargetDomain, suppressed: Set<GateTag>): ResolvedTargetDomain | null {
  if (suppressed.size === 0) return d;
  if (d.tier === 'unbounded') {
    const rest = d.gates.filter((g) => !suppressed.has(g));
    // Every gate that justified the widening was switched off: the sink
    // contributes nothing under this counterfactual.
    return rest.length === 0 ? null : { tier: 'unbounded', gates: rest };
  }
  if (d.tier === 'package') {
    const rest = ['package-domain-whole' as GateTag, ...(d.gates ?? [])].filter((g) => !suppressed.has(g));
    return rest.length === 0 ? null : d;
  }
  return d;
}

/**
 * Sound-refinement admission. Each predicate admits ONLY the evidenced cases
 * its ADR-0006 proof obligation covers; every other site is untouched, which is
 * what separates a refinement from a relaxed approximation.
 */
function refineSink(sink: LoadSink, config: AnalysisConfig | undefined): LoadSink | null {
  const refinements = new Set(config?.refinements ?? []);
  if (refinements.size === 0) return sink;

  if (refinements.has('SR-vm-known-globals') && sink.capability === 'vm-injected') {
    const ev = sink.vmEvidence;
    // Admitted only with ALL three proofs: the context is a literal we can read,
    // it injects no loader-like value, and the executed code is constant.
    if (ev && ev.contextArg === 'object-literal' && !ev.injectsLoaderLike && ev.codeConstant) return null;
    return sink;
  }

  if (refinements.has('SR-cross-module-wrapper')) {
    const w = sink.wrapperEvidence;
    // Only the sinks that failed the same-module-callers condition and NOTHING
    // else: their recorded in-module call-site domains become the union.
    if (w && !w.resolved && w.crossModuleOnly && w.callSiteDomains.length > 0) {
      const domain = unionDomains(w.callSiteDomains);
      if (domain.tier !== 'unbounded') return { ...sink, specifier: domain };
    }
  }
  return sink;
}

export function runFixpoint(input: FixpointInput, config?: AnalysisConfig): FixpointResult {
  const { universe: u, facts, nft } = input;
  const refinements = new Set(config?.refinements ?? []);
  const suppressed = suppressionSet(config);
  const resolveOpts: ResolveOptions = {
    skipImportCondition:
      refinements.has('SR-import-condition-resolution') || suppressed.has('import-condition-divergence'),
    narrowPackageExports: refinements.has('SR-subpath-exports-narrowing'),
  };
  const cacheKey = (id: string) =>
    `${id}|${resolveOpts.skipImportCondition ? 1 : 0}${resolveOpts.narrowPackageExports ? 1 : 0}`;

  const reachable = new Set<string>();
  const resolveRetained = new Set<string>();
  const attribution = new Map<string, Set<GateTag>>();
  const activeLoadSinks: ActiveSink[] = [];
  const widened: { where: string; why: string }[] = [];
  const unbounded = new Set<GateTag>();
  let unboundedActive = false;
  let activeSinkCount = 0;
  const queue: string[] = [];

  const attribute = (rel: string, gates: readonly GateTag[]): void => {
    let s = attribution.get(rel);
    if (!s) attribution.set(rel, (s = new Set()));
    for (const g of gates) s.add(g);
  };
  const mark = (rel: string, gates: readonly GateTag[]): void => {
    attribute(rel, gates);
    if (reachable.has(rel)) return;
    reachable.add(rel);
    queue.push(rel);
  };

  // -- seeds ----------------------------------------------------------------
  if (u.byRel.has(u.entryRel)) mark(u.entryRel, ['entrypoint']);
  if (nft) {
    for (const rel of nft) {
      const f = u.byRel.get(rel);
      if (f?.isJs) mark(f.rel, ['nft-positive-evidence']);
    }
  }

  let allJsMemo: string[] | null = null;
  const allJs = (): string[] => (allJsMemo ??= u.files.filter((f) => f.isJs).map((f) => f.rel));

  /**
   * An unbounded load sink proves every universe module MAY initialize.
   * The mass-mark runs once (short-circuit), but the gates of EVERY later
   * unbounded sink keep accumulating and are unioned back into the mass-marked
   * files below — a blocking-set that named only the first sink's gates would
   * make a gate-off counterfactual look rescuable when it is not.
   */
  const massMarked = new Set<string>();
  const goUnbounded = (gates: readonly GateTag[]): void => {
    for (const g of gates) unbounded.add(g);
    if (unboundedActive) return;
    unboundedActive = true;
    for (const rel of allJs()) {
      if (!reachable.has(rel)) massMarked.add(rel);
      mark(rel, gates);
    }
  };

  const applyDomain = (d: ResolvedTargetDomain, gates: GateTag[], effect: 'load' | 'resolve'): void => {
    if (d.tier === 'unbounded') {
      if (effect === 'load') return goUnbounded(gates);
      // A resolve sink with an unbounded domain retains every file's bytes
      // without initializing anything.
      for (const rel of allJs()) {
        resolveRetained.add(rel);
        attribute(rel, gates);
      }
      return;
    }
    for (const rel of d.files) {
      if (effect === 'load') mark(rel, gates);
      else {
        resolveRetained.add(rel);
        attribute(rel, gates);
      }
    }
  };

  // -- propagation ----------------------------------------------------------
  while (queue.length > 0) {
    const rel = queue.pop()!;
    const m = facts.get(rel);
    if (!m) continue;

    // Static edges: an initialized module initializes what it statically imports.
    for (const e of m.staticEdges) {
      if (!e.resolvedAbs || !path.isAbsolute(e.resolvedAbs)) continue;
      const target =
        u.byReal.get(e.resolvedAbs) ??
        u.byRel.get(path.relative(u.root, e.resolvedAbs).split(path.sep).join('/'));
      if (!target || !target.isJs) continue;
      mark(target.rel, ['static-import', ...asGates(e.reasons)]);
    }

    // A module we cannot read, whose loader escaped, or which mutates the
    // require cache, is an Unbounded active sink the moment it can initialize.
    const moduleUnbounded: GateTag[] = [];
    if (m.parseFailed) moduleUnbounded.push('unsupported-syntax');
    if (m.escapedLoader) moduleUnbounded.push('escaped-loader');
    if (m.moduleGates.includes('require-cache-mutation')) moduleUnbounded.push('require-cache-mutation');
    if (moduleUnbounded.length > 0) {
      const rest = moduleUnbounded.filter((g) => !suppressed.has(g));
      if (rest.length > 0) {
        activeSinkCount++;
        widened.push({ where: rel, why: `module-level unbounded sink (${rest.join('+')})` });
        goUnbounded(rest);
      }
    }

    for (const raw of m.sinks) {
      const sink = refineSink(raw, config);
      if (!sink) continue; // refinement admitted it: contributes nothing
      const key = cacheKey(sink.id + (sink === raw ? '' : '#refined'));
      let d = input.resolveCache.get(key);
      if (!d) {
        d = resolveDomain(sink, m.abs, u, resolveOpts);
        input.resolveCache.set(key, d);
      }
      const gates = domainGates(d);
      const applied = applyConfig(d, suppressed);
      if (!applied) continue;
      const effectiveGates = applied.tier === 'unbounded' ? applied.gates : gates.filter((g) => !suppressed.has(g));
      activeSinkCount++;
      if (sink.effect === 'load') activeLoadSinks.push({ sink, domain: applied, gates: effectiveGates });
      applyDomain(
        applied,
        sink.effect === 'load' ? effectiveGates : ['resolve-sink-retained', ...effectiveGates],
        sink.effect,
      );
    }
  }

  // Complete attribution: every mass-marked file carries the gates of every
  // unbounded sink that (independently) forces its retention.
  if (unboundedActive) for (const rel of massMarked) attribute(rel, [...unbounded]);

  return {
    reachable,
    resolveRetained,
    attribution,
    activeLoadSinks,
    activeSinkCount,
    unboundedGates: [...unbounded],
    unboundedActive,
    widened,
  };
}
