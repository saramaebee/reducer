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
 * A sink projection lands on EVERY module in the sink's domain: `require(x).foo`
 * with an unbounded `x` says "foo may be read on any module", which is exactly
 * the rescue lever ADR-0006 asks us to measure — the co-located `notFoo` can
 * still be predicted stubbable while `foo` is retained.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  asGates,
  type AnalysisConfig,
  type GateTag,
  type ModuleFacts,
} from './types.ts';
import type { ActiveSink, FixpointResult } from './fixpoint.ts';
import type { Universe } from './universe.ts';

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
 * Ported from `analyzer/src/index.ts:670` (on-disk `.node`/`.wasm` scan; an
 * unscannable directory is opaque, never assumed clean) and WIDENED with two
 * corpus-driven cases the build-time detection misses: a package whose install
 * / postinstall script or `binding.gyp` says it BUILDS a native artifact is
 * native even when the artifact was never built in the pinned checkout.
 */
export function opaquePackages(u: Universe, warnings: string[]): Map<string, GateTag> {
  const out = new Map<string, GateTag>();
  const mark = (dir: string, gate: GateTag) => {
    if (!out.has(dir)) out.set(dir, gate);
  };
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
  return out;
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
      const target =
        u.byReal.get(e.resolvedAbs) ??
        u.byRel.get(path.relative(u.root, e.resolvedAbs).split(path.sep).join('/'));
      if (!target?.isJs) continue;
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

  // Active sink result flows, projected onto every module of the sink's domain.
  for (const a of fx.activeLoadSinks) {
    if (a.sink.result.kind === 'unused') continue;
    const targets = a.domain.tier === 'unbounded' ? allThirdPartyJs() : a.domain.files;
    for (const rel of targets) {
      const x = at(rel);
      if (a.sink.result.kind === 'escaped') {
        x.all = true;
        for (const g of a.sink.result.gates) x.gates.add(g);
        for (const g of a.gates) x.gates.add(g);
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
