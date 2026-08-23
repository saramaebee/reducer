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
import {
  UNSUPPRESSIBLE_GATES,
  asGates,
  type AnalysisConfig,
  type GateTag,
  type LoadSink,
  type ModuleFacts,
  type RefinementName,
  type ResolvedTargetDomain,
  type SpecifierDomain,
} from './types.ts';
import {
  domainGates,
  hasImportConditionDivergence,
  packageDomain,
  resolveDomain,
  staticEdgeWiden,
  type ResolveOptions,
} from './resolve.ts';
import { unionDomains } from './specifier.ts';
import { fileFor, type Universe } from '@reducer/production-universe';

export interface FixpointInput {
  universe: Universe;
  facts: Map<string, ModuleFacts>;
  /** NFT-traced JS rels, or null when no positive evidence is available */
  nft: Set<string> | null;
  /** per-(sink,resolve-option) memo so rerun-per-config stays cheap */
  resolveCache: Map<string, ResolvedTargetDomain>;
  /**
   * RES-F9: package dir → native/wasm boundary gate. A reachable module inside
   * an opaque package is an Unbounded sink, exactly like a `vm` site.
   */
  opaque?: Map<string, GateTag>;
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
 * RES-F8 — metric integrity. Apply a config to a resolved domain by DEMOTING
 * it, never by deleting it. This function must never return null.
 *
 * A gate-off counterfactual answers "how much smaller could the artifact be if
 * this ONE approximation were exact?". Deleting the sink answers a different
 * and much more flattering question — "…if this sink did not exist" — and the
 * ADR-0006 headroom numbers are read off these runs, so the difference is the
 * difference between a measurement and a fantasy. Every suppression therefore
 * lands on the narrowest domain the analyzer actually computed:
 *
 *  - unbounded, all gates off  → the files that DID resolve at this sink;
 *  - package, all gates off    → the package's own exports-map target set,
 *                                falling back to the whole package;
 *  - exact/finite              → untouched.
 */
function applyConfig(u: Universe, d: ResolvedTargetDomain, suppressed: Set<GateTag>): ResolvedTargetDomain {
  if (suppressed.size === 0) return d;
  if (d.tier === 'unbounded') {
    const rest = d.gates.filter((g) => !suppressed.has(g));
    if (rest.length > 0) return { tier: 'unbounded', gates: rest, resolved: d.resolved };
    return { tier: 'finite', files: d.resolved ?? [], builtins: [], missing: [] };
  }
  if (d.tier === 'package') {
    const rest = ['package-domain-whole' as GateTag, ...(d.gates ?? [])].filter((g) => !suppressed.has(g));
    if (rest.length > 0) return d;
    const narrowed = packageDomain(u, d.pkg, { narrowPackageExports: true });
    return narrowed.files.length > 0 ? narrowed : d;
  }
  return d;
}

/**
 * SR-F6 — SR-vm-known-globals is WITHDRAWN as not-soundly-definable.
 *
 * Its premise was "an object-literal context with no loader-like key and
 * constant code cannot load a module". The standard cross-realm escape refutes
 * it with a context of `{ safe: 1 }`:
 *
 *   this.constructor.constructor('return process')().getBuiltinModule('module')
 *
 * `this` inside `vm.runInNewContext` IS the contextified sandbox — an object
 * created in the HOST realm — so its `.constructor` is the host `Object`, and
 * `Object.constructor` is the host `Function`. The same reaches the host realm
 * through any property of any context value, a thrown host error, a `Proxy`
 * trap, a `Symbol.toPrimitive` handler, `Error.prepareStackTrace`, or
 * `import.meta` when `importModuleDynamically` is set.
 *
 * Making the admission sound therefore requires a WHITELIST of the whole
 * language inside the vm code (host-taint tracking plus a blanket ban on
 * computed members, `constructor`/`prototype`, `Function`, `eval`), not a
 * blacklist of a few syntactic forms — and a whitelist strict enough to be
 * sound admits only vm code that computes over its own literals, which has no
 * measurable headroom by construction. CONTEXT.md's bar for a sound-refinement
 * counterfactual is "single, localized, soundly-definable, and plausibly
 * implementable"; this clears none of the four, so it is reported as a
 * not-soundly-definable ADR-0006 finding and admits NOTHING here.
 */
export const WITHDRAWN_REFINEMENTS: Partial<Record<RefinementName, string>> = {
  'SR-vm-known-globals':
    'WITHDRAWN as not-soundly-definable (SR-F6): a vm context object is a host-realm ' +
    'object, so `this.constructor.constructor` reaches the host Function even with an ' +
    'object-literal context holding no loader-like key and constant code. A sound ' +
    'admission needs host-taint tracking over the whole language, and the residue it ' +
    'would admit has no measurable headroom. This refinement admits nothing.',
};

/**
 * SR-F7. SR-cross-module-wrapper may substitute call-site argument domains for
 * an EXPORTED wrapper only against the UNIVERSE-WIDE reference set of that
 * exported binding — the exact complement of the strict model's "all callers
 * enumerable in this module". Every one of those references must be a direct
 * call in a module we actually parsed; anything else (an opaque module, a
 * whole-surface import, a name we have no use record for, a loader that could
 * hand the module value to code we cannot see) means the set is incomplete and
 * admission is REFUSED.
 *
 * ponytail: the "no unseen loader" test is `every load sink in the universe has
 * an exact specifier`, which is coarse — a precise version would ask which
 * sinks can reach this module, and that needs the fixpoint that is calling us.
 * Coarse in the refusing direction, so it only costs headroom.
 */
function universeWideCallDomains(
  u: Universe,
  facts: Map<string, ModuleFacts>,
  owner: ModuleFacts,
  exportName: string,
  paramIndex: number,
): SpecifierDomain[] | null {
  if (paramIndex < 0) return null;
  const domains: SpecifierDomain[] = [];
  for (const m of facts.values()) {
    // An opaque module, an escaped loader, or a mutated require cache each mean
    // a reference we cannot see.
    if (m.parseFailed || m.escapedLoader) return null;
    if (m.moduleGates.includes('require-cache-mutation')) return null;
    for (const sk of m.sinks) {
      if (sk.wrapperEvidence) continue; // the wrapper sinks themselves
      if (sk.specifier.tier !== 'exact' && sk.specifier.tier !== 'finite') return null;
    }
    for (const e of m.staticEdges) {
      if (!e.resolvedAbs) continue;
      if (fileFor(u, e.resolvedAbs)?.rel !== owner.rel) continue;
      if (e.all) return null;             // whole surface: the binding escapes
      if (!e.names.has(exportName)) continue;
      const use = e.nameUses?.get(exportName);
      if (!use || use.nonCall) return null;
      for (const args of use.callArgs) domains.push(args[paramIndex] ?? { tier: 'unbounded', gates: ['wrapper-unprovable'] });
    }
  }
  return domains;
}

/**
 * Sound-refinement admission. Each predicate admits ONLY the evidenced cases
 * its ADR-0006 proof obligation covers; every other site is untouched, which is
 * what separates a refinement from a relaxed approximation.
 */
function refineSink(
  sink: LoadSink,
  config: AnalysisConfig | undefined,
  u: Universe,
  facts: Map<string, ModuleFacts>,
  owner: ModuleFacts,
): LoadSink {
  const refinements = new Set(config?.refinements ?? []);
  if (refinements.size === 0) return sink;

  if (refinements.has('SR-cross-module-wrapper')) {
    const w = sink.wrapperEvidence;
    if (w && !w.resolved && w.crossModuleOnly) {
      const names = [...owner.exports]
        .filter(([, info]) => info.localName === w.fn)
        .map(([name]) => name);
      // No recognized export of the wrapper, or a surface we cannot close:
      // the binding may be reachable under a name we never saw.
      if (names.length > 0 && owner.surfaceOpen.length === 0) {
        const all: SpecifierDomain[] = [...w.callSiteDomains];
        let refused = false;
        for (const name of names) {
          const external = universeWideCallDomains(u, facts, owner, name, w.paramIndex);
          if (!external) {
            refused = true;
            break;
          }
          all.push(...external);
        }
        // Zero callers universe-wide is not a proof of an empty domain.
        if (!refused && all.length > 0) {
          const domain = unionDomains(all);
          if (domain.tier !== 'unbounded') return { ...sink, specifier: domain };
        }
      }
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

  // RES-F5: `resolveDomain` can `pullIn` a file mid-fixpoint, so this memo is
  // keyed on the universe size. A stale memo would leave a pulled-in file out
  // of the mass-mark — i.e. silently removable — which is the unsound direction.
  let allJsMemo: string[] | null = null;
  let allJsAt = -1;
  const allJs = (): string[] => {
    if (allJsMemo === null || allJsAt !== u.files.length) {
      allJsAt = u.files.length;
      allJsMemo = u.files.filter((f) => f.isJs).map((f) => f.rel);
    }
    return allJsMemo;
  };

  /**
   * An unbounded load sink proves every universe module MAY initialize.
   * The mass-mark short-circuits per universe size, but the gates of EVERY
   * later unbounded sink keep accumulating and are unioned back into the
   * mass-marked files below — a blocking-set that named only the first sink's
   * gates would make a gate-off counterfactual look rescuable when it is not.
   */
  const massMarked = new Set<string>();
  let massMarkedAt = -1;
  const goUnbounded = (gates: readonly GateTag[]): void => {
    for (const g of gates) unbounded.add(g);
    if (unboundedActive && massMarkedAt === u.files.length) return;
    unboundedActive = true;
    massMarkedAt = u.files.length;
    for (const rel of allJs()) {
      if (!reachable.has(rel)) massMarked.add(rel);
      mark(rel, gates);
    }
  };

  /**
   * CAP-F13. A module-level Unbounded sink is not merely "some module may
   * initialize". The code behind it — an escaped loader's unmodeled holder, an
   * unparseable/unreadable body, a cache substitution, an in-realm .node or
   * wasm addon — is CODE THIS ANALYSIS NEVER SAW *and* it holds a loader, so it
   * can require any module and then call any export on the value it gets back.
   * Its RESULT escapes. `goUnbounded` alone only reaches the reachability
   * mass-mark; the projection layer reads `activeLoadSinks` and nothing else,
   * so without a sink recorded here every file was retained while its unnamed
   * exports stayed predicted-stubbable. Ordinary unbounded *specifier* sinks
   * keep their own result flow (a discarded `require(x)` invokes no export).
   */
  const opaqueCodeSink = (rel: string, gates: GateTag[]): void => {
    goUnbounded(gates);
    activeLoadSinks.push({
      sink: {
        id: `${rel}#module-unbounded`,
        file: rel,
        capability: 'lexical-require',
        effect: 'load',
        specifier: { tier: 'unbounded', gates },
        result: { kind: 'escaped', gates },
        generatedDepth: 0,
        loc: { line: 0, column: 0 },
      },
      domain: { tier: 'unbounded', gates },
      gates,
    });
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
    // RES-F5. A reachable module with NO facts is a module whose load sinks we
    // never looked for — `pullIn` can add a file after prepare parsed the
    // universe. Treating it as inert would hide its `require(x)`; it is opaque.
    if (!m) {
      activeSinkCount++;
      widened.push({ where: rel, why: 'reachable module has no facts (pulled in mid-fixpoint): opaque' });
      opaqueCodeSink(rel, ['unsupported-syntax']);
      continue;
    }

    // Static edges: an initialized module initializes what it statically imports.
    for (const e of m.staticEdges) {
      const edgeGates: GateTag[] = ['static-import', ...asGates(e.reasons)];

      // RES-F3. A static edge that did not resolve is IGNORANCE, not proof:
      // dropping it hides a module the importer really does load.
      if (e.unresolved) {
        if (suppressed.has('unresolved-specifier')) continue;
        const w = staticEdgeWiden(u, e.source);
        widened.push({
          where: rel,
          why: `unresolved static edge ${JSON.stringify(e.source)} widened to ${w.unbounded ? 'the whole universe' : `package ${e.source}`}`,
        });
        activeSinkCount++;
        if (w.unbounded) goUnbounded(['unresolved-specifier', ...asGates(e.reasons)]);
        else for (const f of w.files) mark(f, [...edgeGates, 'unresolved-specifier', 'package-domain-whole']);
        continue;
      }

      if (!e.resolvedAbs) continue; // builtin, or the missing-package proof
      const target = fileFor(u, e.resolvedAbs);
      if (!target || !target.isJs) continue;
      mark(target.rel, edgeGates);

      // RES-F2. `resolvedAbs` came from createRequire().resolve (the REQUIRE
      // branch). For an edge Node resolves under IMPORT conditions into a
      // package whose exports map answers differently, the file we just marked
      // is not necessarily the file Node loads — the honest target is the
      // whole owning package.
      if (
        e.importCondition &&
        !resolveOpts.skipImportCondition &&
        target.pkg &&
        hasImportConditionDivergence(target.pkg.dir)
      ) {
        activeSinkCount++;
        widened.push({
          where: rel,
          why: `ESM static edge ${JSON.stringify(e.source)} resolves under import conditions into divergent package ${target.pkg.name}: widened to the whole package`,
        });
        const d = packageDomain(u, target.pkg.name, resolveOpts);
        for (const f of d.files) {
          mark(f, [...edgeGates, 'import-condition-divergence', 'package-domain-whole']);
        }
      }
    }

    // A module we cannot read, whose loader escaped, or which mutates the
    // require cache, is an Unbounded active sink the moment it can initialize.
    const moduleUnbounded: GateTag[] = [];
    if (m.parseFailed) moduleUnbounded.push('unsupported-syntax');
    if (m.escapedLoader) moduleUnbounded.push('escaped-loader');
    if (m.moduleGates.includes('require-cache-mutation')) moduleUnbounded.push('require-cache-mutation');
    // RES-F9 (loader symmetry). A `.node` addon runs IN-REALM: it can reach
    // `process`, rebuild `require`, and load anything. A wasm module reaches
    // whatever host imports it was given. Both are strictly stronger boundaries
    // than `vm`, which the strict model already treats as maximally
    // loader-capable — so an opaque package must contribute a module-level
    // Unbounded sink too, gated (and therefore measurable) on its own boundary.
    const opaqueGate = m.pkg ? input.opaque?.get(m.pkg.dir) : undefined;
    if (opaqueGate) moduleUnbounded.push(opaqueGate);
    if (moduleUnbounded.length > 0) {
      const rest = moduleUnbounded.filter((g) => !suppressed.has(g));
      if (rest.length > 0) {
        activeSinkCount++;
        widened.push({ where: rel, why: `module-level unbounded sink (${rest.join('+')})` });
        opaqueCodeSink(rel, rest);
      }
    }

    for (const raw of m.sinks) {
      const sink = refineSink(raw, config, u, facts, m);
      const key = cacheKey(sink.id + (sink === raw ? '' : '#refined'));
      let d = input.resolveCache.get(key);
      if (!d) {
        d = resolveDomain(sink, m.abs, u, resolveOpts);
        input.resolveCache.set(key, d);
      }
      const gates = domainGates(d);
      activeSinkCount++;
      if (sink.effect === 'resolve') {
        // RES-F8. `resolve-sink-retained` is UNSUPPRESSIBLE: a require.resolve
        // target's bytes must ship whatever else is switched off. Running a
        // resolve sink's domain through the suppression machinery could demote
        // it, so the config is skipped entirely here.
        applyDomain(d, ['resolve-sink-retained', ...gates], 'resolve');
        continue;
      }
      const applied = applyConfig(u, d, suppressed);
      const effectiveGates = applied.tier === 'unbounded' ? applied.gates : gates.filter((g) => !suppressed.has(g));
      activeLoadSinks.push({ sink, domain: applied, gates: effectiveGates });
      applyDomain(applied, effectiveGates, 'load');
    }
  }

  // RES-F5. A `pullIn` after the last `goUnbounded` would leave the newcomer
  // outside the mass-mark. One final sweep closes that window.
  if (unboundedActive && massMarkedAt !== u.files.length) goUnbounded([...unbounded]);

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
