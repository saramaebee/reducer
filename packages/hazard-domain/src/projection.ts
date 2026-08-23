/**
 * Export reachability and property projection (design §10, CONTEXT.md
 * "property projection", "export-surface confidence", "module-identity
 * unification").
 *
 * MODULE-IDENTITY UNIFICATION is the invariant this file exists to enforce: a
 * narrow conclusion drawn at one load site is void if ANY other site resolving
 * to the same cached instance uses the module broadly. Usage is therefore
 * accumulated per PHYSICAL module (universe rels are canonical per realpath)
 * across every static edge and every active sink whose domain contains it —
 * and only then are symbols decided.
 *
 * PROJ-EXACT. A bounded property projection narrows a module's reachable
 * surface ONLY on an EXACT-tier resolved-target domain — a single, specific,
 * known module. On a FINITE, PACKAGE or UNBOUNDED domain the FULL observable
 * surface of every module in the domain is retained instead.
 *
 * The refutation is the garden's `require-pkgscoped`: `require('rps-scopedtarget/'
 * + name).describe(seed)` is a package-tier domain with a `.describe`
 * projection, and projecting `{describe}` onto every module of the package made
 * the co-located `spareOne`/`spareTwo` look removable while Node can reach them
 * — an unsound optimism. With more than one candidate module, `.foo` cannot be
 * attributed as the COMPLETE reachable surface of any particular physical
 * module: module-identity unification needs the exact instance.
 *
 * Consequence, accepted deliberately: `require-unbounded-bounded-projection`'s
 * `notFoo` is now over-retained (a precision miss, which MUST_REMOVE tolerates).
 * The open-domain projection rescue lever is therefore NOT part of the strict
 * model and NOT a qualifying sound refinement — it survives only as a gate-off
 * upper bound.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  asGates,
  type AnalysisConfig,
  type GateTag,
  type ModuleFacts,
} from './types.ts';
import type { FixpointResult } from './fixpoint.ts';
import { hasImportConditionDivergence, packageDomain, staticEdgeWiden } from './resolve.ts';
import { fileFor, type Universe } from './universe.ts';

export interface ProjectedUsage {
  names: Set<string>;
  /** the whole observable surface is reachable */
  all: boolean;
  gates: Set<GateTag>;
}

/** A per-symbol decision, before byte simulation. */
export interface SymbolDecision {
  symbol: string;
  localName: string | null;
  predicted: boolean;
  blockingSet: GateTag[];
  bodySpan?: { start: number; end: number };
}

/**
 * Packages whose behaviour crosses a boundary this analyzer cannot read.
 *
 * Two answers, because the two questions are different:
 *
 *  - `own`  — the package that SHIPS the artifact. `.node`/`.wasm`/`binding.gyp`
 *             found in the package's own tree, or an install/postinstall script
 *             saying it builds one. This is the loader-capability question
 *             (RES-F9): a native addon runs IN-REALM, so the package that
 *             carries it is an Unbounded load sink.
 *  - `all`  — `own` plus every ancestor package. This is the export-SURFACE
 *             question, kept exactly as `analyzer/src/index.ts:670` had it: a
 *             recursive scan from each package dir, so a dependency's `.node`
 *             also made the ancestor opaque. Over-broad, but it is an existing
 *             widening and stays.
 *
 * Separating them is not cosmetic. `f.pkg` is the NEAREST ancestor package, so
 * in a normal app EVERY first-party file is owned by the root package — and the
 * root package's recursive scan reaches `node_modules/<any native dep>`. Giving
 * `all` to the loader-capability rule would make one native dependency anywhere
 * turn the entrypoint itself into an Unbounded sink and mass-mark the universe.
 *
 * Ported detection (on-disk scan; an unscannable directory is opaque, never
 * assumed clean) WIDENED with the corpus-driven case the build-time detection
 * misses: a package whose install / postinstall script or `binding.gyp` says it
 * BUILDS a native artifact is native even when the pinned checkout never built it.
 */
export interface OpaqueScan {
  /** the package that ships the artifact — loader capability (RES-F9) */
  own: Map<string, GateTag>;
  /** own + every ancestor package — export-surface opacity (unchanged) */
  all: Map<string, GateTag>;
}

export function opaquePackages(u: Universe, warnings: string[]): OpaqueScan {
  const own = new Map<string, GateTag>();
  const mark = (dir: string, gate: GateTag) => {
    if (!own.has(dir)) own.set(dir, gate);
  };
  const sep = path.sep;
  for (const [dir] of u.pkgDirs) {
    try {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const scripts = pj.scripts ?? {};
      if (typeof scripts.install === 'string' || typeof scripts.postinstall === 'string') {
        mark(dir, 'native-boundary');
      }
    } catch {
      /* the dirent scan below is the real detection */
    }
    try {
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (e.isDirectory()) continue; // files AND symlinks count
        // A nested install tree is a DIFFERENT package; it gets its own entry,
        // and `all` below re-attributes it to this ancestor anyway.
        const from = e.parentPath ?? (e as unknown as { path: string }).path ?? dir;
        if (path.relative(dir, from).split(sep).includes('node_modules')) continue;
        const ext = path.extname(e.name);
        if (ext === '.node') mark(dir, 'native-boundary');
        else if (ext === '.wasm') mark(dir, 'wasm-boundary');
        else if (e.name === 'binding.gyp') mark(dir, 'native-boundary');
      }
    } catch (err) {
      mark(dir, 'native-boundary');
      warnings.push(
        `could not scan package dir for native/wasm boundaries; treating as opaque: ${path.relative(u.root, dir)} (${String(err).slice(0, 80)})`,
      );
    }
  }
  // Propagate to ancestors: identical to the old recursive-scan-per-package
  // answer, without rescanning every nested tree once per ancestor.
  const all = new Map<string, GateTag>(own);
  const dirs = [...u.pkgDirs.keys()];
  for (const [artifactDir, gate] of own) {
    for (const dir of dirs) {
      if (dir === artifactDir) continue;
      if (!artifactDir.startsWith(dir + sep)) continue;
      if (!all.has(dir)) all.set(dir, gate);
    }
  }
  return { own, all };
}

/** Union usage across ALL load paths that resolve to each reachable module. */
export function projectUsage(
  u: Universe,
  facts: Map<string, ModuleFacts>,
  fx: FixpointResult,
): Map<string, ProjectedUsage> {
  const usage = new Map<string, ProjectedUsage>();
  const at = (rel: string): ProjectedUsage => {
    let x = usage.get(rel);
    if (!x) usage.set(rel, (x = { names: new Set(), all: false, gates: new Set() }));
    return x;
  };

  // Static importers — only from modules that can actually initialize.
  for (const rel of fx.reachable) {
    const m = facts.get(rel);
    if (!m) continue;
    for (const e of m.staticEdges) {
      if (!e.resolvedAbs || !path.isAbsolute(e.resolvedAbs)) continue;
      const target = fileFor(u, e.resolvedAbs);
      if (!target?.isJs) continue;

      // RES-F2. Node resolves this edge under IMPORT conditions but
      // `resolvedAbs` is the REQUIRE answer; in a divergent package we do not
      // know WHICH physical module runs, so no name can be attributed as any
      // one module's complete surface (PROJ-EXACT, package tier).
      if (e.importCondition && target.pkg && hasImportConditionDivergence(target.pkg.dir)) {
        for (const rel2 of packageDomain(u, target.pkg.name, {}).files) {
          const y = at(rel2);
          y.all = true;
          y.gates.add('import-condition-divergence');
          y.gates.add('package-domain-whole');
        }
        continue;
      }

      const x = at(target.rel);
      for (const n of e.names) x.names.add(n);
      if (e.all) {
        x.all = true;
        for (const g of asGates(e.reasons)) x.gates.add(g);
      }
    }
  }

  const allThirdPartyJs = (): string[] =>
    u.files.filter((f) => f.isJs && f.thirdParty).map((f) => f.rel);

  // RES-F3. An unresolved static edge names a module we could not identify;
  // its whole surface is reachable across the edge's widened domain.
  for (const rel of fx.reachable) {
    const m = facts.get(rel);
    if (!m) continue;
    for (const e of m.staticEdges) {
      if (!e.unresolved) continue;
      const w = staticEdgeWiden(u, e.source);
      for (const rel2 of w.unbounded ? allThirdPartyJs() : w.files) {
        const y = at(rel2);
        y.all = true;
        y.gates.add('unresolved-specifier');
        if (!w.unbounded) y.gates.add('package-domain-whole');
      }
    }
  }

  // Active sink result flows, projected onto every module of the sink's domain.
  for (const a of fx.activeLoadSinks) {
    if (a.sink.result.kind === 'unused') continue;
    const targets = a.domain.tier === 'unbounded' ? allThirdPartyJs() : a.domain.files;
    // PROJ-EXACT: only a single, specific, known module may have its surface
    // narrowed by a property projection.
    const exact = a.domain.tier === 'exact' && a.domain.files.length === 1;
    for (const rel of targets) {
      const x = at(rel);
      if (a.sink.result.kind === 'escaped') {
        x.all = true;
        for (const g of a.sink.result.gates) x.gates.add(g);
        for (const g of a.gates) x.gates.add(g);
      } else if (!exact) {
        x.all = true;
        for (const g of a.gates) x.gates.add(g);
        x.gates.add('module-identity-unresolved');
      } else {
        for (const n of a.sink.result.names) x.names.add(n);
      }
    }
  }
  return usage;
}

/**
 * Per-symbol prediction. The rule set is the analyzer's
 * (`analyzer/src/index.ts:855-913`) with gate tags instead of Reasons: a named
 * use is proven-reachable; a shared implementation whose other alias is
 * retained is possibly-reachable; everything not proven stubbable is retained.
 */
export function decideSymbols(
  u: Universe,
  facts: Map<string, ModuleFacts>,
  fx: FixpointResult,
  usage: Map<string, ProjectedUsage>,
  opaque: Map<string, GateTag>,
  _config?: AnalysisConfig,
): Map<string, SymbolDecision[]> {
  const out = new Map<string, SymbolDecision[]>();
  for (const f of u.files) {
    if (!f.isJs || !f.thirdParty) continue;
    if (!fx.reachable.has(f.rel)) continue; // not initialized: no symbol question
    const m = facts.get(f.rel);
    if (!m) continue;

    const blockAll = (gates: GateTag[]): void => {
      const names = m.exports.size > 0 ? [...m.exports.keys()] : ['*'];
      out.set(
        f.rel,
        names.map((symbol) => ({
          symbol,
          localName: m.exports.get(symbol)?.localName ?? null,
          predicted: false,
          blockingSet: [...new Set(gates)],
          bodySpan: m.exports.get(symbol)?.bodySpan,
        })),
      );
    };

    if (m.parseFailed) {
      blockAll(['unsupported-syntax']);
      continue;
    }
    const pkgGate = f.pkg ? opaque.get(f.pkg.dir) : undefined;
    if (pkgGate) {
      blockAll([pkgGate]);
      continue;
    }
    if (m.surfaceOpen.length > 0) {
      // Export-surface confidence failed: symbol granularity is not available.
      blockAll(['open-export-surface', ...asGates(m.surfaceOpen)]);
      continue;
    }
    const use = usage.get(f.rel);
    if (!use) {
      // Module-reachable with no recognized load path — the reachability came
      // from somewhere this projection cannot attribute. Unknown means keep.
      blockAll(['unbounded-loader-target', ...fx.unboundedGates]);
      continue;
    }
    if (use.all) {
      blockAll([...use.gates]);
      continue;
    }

    // One implementation may back several export names: its body survives
    // unless EVERY name pointing at it is itself predicted unreachable.
    const localBlocked = new Set<string>();
    for (const [symbol, info] of m.exports) {
      if (info.localName && (use.names.has(symbol) || !info.stubbable)) localBlocked.add(info.localName);
    }

    const decisions: SymbolDecision[] = [];
    for (const [symbol, info] of m.exports) {
      const base = { symbol, localName: info.localName, bodySpan: info.bodySpan };
      if (use.names.has(symbol)) {
        decisions.push({ ...base, predicted: false, blockingSet: ['static-import'] });
      } else if (info.stubbable && info.localName && localBlocked.has(info.localName)) {
        decisions.push({ ...base, predicted: false, blockingSet: ['shared-implementation'] });
      } else if (info.stubbable && info.localName) {
        decisions.push({ ...base, predicted: true, blockingSet: [] });
      } else {
        const gates = asGates(info.retainReasons);
        decisions.push({
          ...base,
          predicted: false,
          blockingSet: gates.length > 0 ? gates : ['unsupported-export-kind'],
        });
      }
    }
    out.set(f.rel, decisions);
  }
  return out;
}
