/**
 * Specifier domain → resolved-target domain (CONTEXT.md "resolved-target
 * domain", design §8).
 *
 * Every branch either names concrete universe files or widens with a gate. The
 * one branch that contributes NOTHING — a bare specifier whose package is not
 * in the universe — is a real proof, not an optimism: Node cannot initialize a
 * module that does not exist on disk, so the sink's target set is genuinely
 * empty. It is deliberately restricted to bare specifiers (a relative path
 * could be produced by a build step we do not model) and it is the ONLY empty
 * answer this file can return.
 */
import { createRequire } from 'node:module';
import { isBuiltin } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GateTag, LoadSink, ResolvedTargetDomain, SpecifierDomain } from './types.ts';
import { fileFor, packageJsFiles, pullIn, type Universe, type UniverseFile } from '@reducer/production-universe';

const requireCache = new Map<string, NodeJS.Require>();
function requireFrom(importerAbs: string): NodeJS.Require {
  let r = requireCache.get(importerAbs);
  if (!r) requireCache.set(importerAbs, (r = createRequire(importerAbs)));
  return r;
}

/** The package a bare specifier names, or null when it is not bare. */
export function packageOfSpecifier(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  if (spec.includes('\\') || spec.includes('\0')) return null;
  if (isBuiltin(spec)) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0] || null;
}

// RES-F1. Node's own condition sets, in the order Node applies them. Matching
// is by KEY INSERTION ORDER in the exports object, not by this list's order —
// these are only membership tests.
const REQUIRE_CONDS: ReadonlySet<string> = new Set(['node-addons', 'node', 'require', 'default']);
const IMPORT_CONDS: ReadonlySet<string> = new Set(['node', 'import', 'default']);

/**
 * Evaluate one `exports` target under a condition set, exactly as Node does:
 * a string is the target, an array is a fallback list (first match wins), an
 * object is a conditions map walked in insertion order, and `null` is an
 * explicit block. `undefined` means "no branch matched".
 */
function evalConditions(node: unknown, conds: ReadonlySet<string>): string | null | undefined {
  if (node === null) return null;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = evalConditions(v, conds);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('.')) return undefined; // a subpath map, not a conditions map
    if (!conds.has(k)) continue;
    const r = evalConditions(v, conds);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** The two orders disagree, INCLUDING "only one of them resolves at all". */
function conditionDiverges(node: unknown): boolean {
  return evalConditions(node, REQUIRE_CONDS) !== evalConditions(node, IMPORT_CONDS);
}

/**
 * A package whose `exports` field answers DIFFERENTLY under the require and the
 * import condition orders. `createRequire().resolve()` only ever answers the
 * require branch, so for anything Node resolves under import conditions our
 * resolved file is not necessarily the one Node loads — the honest answer is
 * the whole package.
 *
 * RES-F1: the old test demanded a literal `import` AND a literal `require` key
 * in the same object, which misses `{import,default}`, `{import,node}`,
 * `{node,import}` and import-only maps (487 + 210 real corpus packages). The
 * two-order evaluation above subsumes all of them. The old key-pair walk is
 * kept as an OR-term so no previously-detected package stops being detected
 * (a divergent branch under a condition node never selects — `browser`, say —
 * still widens).
 *
 * APPROXIMATION (gate `import-condition-divergence`): every subpath is checked
 * rather than only the one the sink selects. That is strictly the widening
 * direction; exact per-subpath resolution is SR-import-condition-resolution.
 */
const divergenceCache = new Map<string, boolean>();
export function hasImportConditionDivergence(pkgDir: string): boolean {
  const hit = divergenceCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let diverges = false;
  try {
    const pj = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const exp = pj.exports;
    if (exp !== undefined && exp !== null) {
      const isSubpathMap =
        typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'));
      const branches: unknown[] = isSubpathMap ? Object.values(exp as Record<string, unknown>) : [exp];
      diverges = branches.some(conditionDiverges);
    }
    if (!diverges) {
      const walk = (node: unknown): void => {
        if (diverges || node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          for (const v of node) walk(v);
          return;
        }
        const obj = node as Record<string, unknown>;
        const imp = obj.import;
        const req = obj.require;
        if (imp !== undefined && req !== undefined && JSON.stringify(imp) !== JSON.stringify(req)) {
          diverges = true;
          return;
        }
        for (const v of Object.values(obj)) walk(v);
      };
      walk(exp);
    }
  } catch {
    /* unreadable manifest: no evidence of divergence, and the package-tier
       widening this function feeds is not the only conservative path here */
  }
  divergenceCache.set(pkgDir, diverges);
  return diverges;
}

/**
 * RES-F4. Is the package on disk at all, as seen from `importerAbs`?
 *
 * The empty-contribution proof below is only valid when the package genuinely
 * does not exist. `ERR_PACKAGE_PATH_NOT_EXPORTED` / `ERR_PACKAGE_IMPORT_NOT_DEFINED`
 * mean the package IS installed and merely refuses this subpath under the
 * REQUIRE conditions — it may well answer under import conditions, so that is
 * ignorance, not absence.
 *
 * Presence is probed as a `node_modules/<pkg>` DIRECTORY up the importer's
 * ancestor chain — not against `jsByPkgName` (the universe indexes by the
 * manifest's `name` while a specifier names the INSTALL DIRECTORY, and an
 * aliased install `"aliasdir": "npm:realname@1"` makes those differ), and not
 * via `req.resolve(pkg + '/package.json')` (under bun that reaches bun's GLOBAL
 * install cache, so the answer would depend on which runtime the analyzer runs
 * under — exactly the runtime-dependence RES-F11 removes elsewhere). A
 * directory probe also answers "installed but refusing this subpath" correctly,
 * which is the case this rule exists for.
 */
function packagePresent(pkg: string, importerAbs: string): boolean {
  let dir = path.dirname(importerAbs);
  while (true) {
    if (existsSync(path.join(dir, 'node_modules', pkg))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export type SpecResolution =
  | { kind: 'file'; abs: string }
  | { kind: 'builtin'; name: string }
  /** proven absent from disk: contributes NOTHING (the one empty answer) */
  | { kind: 'missing' }
  /** ignorance: the caller must widen */
  | { kind: 'unresolved' };

/**
 * The single specifier→disk classification every caller shares (resolveDomain
 * for sinks, facts.ts for static edges). Keeping it in one place is what makes
 * the missing-package proof and the widening rule identical on both paths.
 */
export function resolveSpecifier(importerAbs: string, spec: string): SpecResolution {
  if (isBuiltin(spec) || spec.startsWith('node:')) return { kind: 'builtin', name: spec };
  const req = requireFrom(importerAbs);
  try {
    const r = req.resolve(spec);
    return path.isAbsolute(r) ? { kind: 'file', abs: r } : { kind: 'builtin', name: r };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const pkg = packageOfSpecifier(spec);
    if (
      pkg &&
      (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') &&
      !packagePresent(pkg, importerAbs)
    ) {
      return { kind: 'missing' };
    }
    return { kind: 'unresolved' };
  }
}

/**
 * The files an `exports` map can actually name (SR-subpath-exports-narrowing).
 * Returns null when nothing can be proven, in which case the package tier stays
 * whole. Patterns (`"./*": "./lib/*.js"`) are expanded against the package's own
 * universe JS files.
 */
export function exportsTargetFiles(u: Universe, pkgDir: string, pkgName: string): UniverseFile[] | null {
  let pj: any;
  try {
    pj = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (pj.exports === undefined || pj.exports === null) return null;
  const targets: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      targets.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) collect(v);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) collect(v);
  };
  collect(pj.exports);
  if (targets.length === 0) return null;

  const own = packageJsFiles(u, pkgName).filter((f) => f.abs === pkgDir || f.abs.startsWith(pkgDir + path.sep));
  const out = new Map<string, UniverseFile>();
  for (const target of targets) {
    if (!target.startsWith('.')) continue; // "./x" only; a bare re-target is not a file
    if (target.includes('*')) {
      const [head, ...restParts] = target.split('*');
      const tail = restParts.join('*');
      const prefix = path.join(pkgDir, head);
      for (const f of own) {
        if (f.abs.startsWith(prefix) && f.abs.endsWith(tail)) out.set(f.real, f);
      }
      continue;
    }
    const abs = path.join(pkgDir, target);
    const f = own.find((x) => x.abs === abs) ?? u.byReal.get(abs);
    if (f) out.set(f.real, f);
  }
  // An exports map that names no universe file proves nothing about the rest of
  // the package — refuse to narrow rather than narrow to nothing.
  return out.size > 0 ? [...out.values()] : null;
}

export interface ResolveOptions {
  /** SR-import-condition-resolution admitted: skip the divergence widening. */
  skipImportCondition?: boolean;
  /** SR-subpath-exports-narrowing admitted: narrow package tiers. */
  narrowPackageExports?: boolean;
}

type PackageDomain = Extract<ResolvedTargetDomain, { tier: 'package' }>;

export function packageDomain(u: Universe, pkg: string, opts: ResolveOptions): PackageDomain {
  let files = packageJsFiles(u, pkg);
  if (opts.narrowPackageExports) {
    const dirs = new Set(files.map((f) => f.pkg?.dir).filter((d): d is string => !!d));
    const narrowed: UniverseFile[] = [];
    let all = true;
    for (const dir of dirs) {
      const t = exportsTargetFiles(u, dir, pkg);
      if (!t) {
        all = false;
        break;
      }
      narrowed.push(...t);
    }
    if (all && dirs.size > 0) files = narrowed;
  }
  return { tier: 'package', pkg, files: files.map((f) => f.rel) };
}

/**
 * Resolve a sink's specifier domain against the universe.
 * `importerAbs` is the module holding the sink — resolution is importer-relative
 * (node_modules lookup order), so it can never be hoisted to the root.
 */
export function resolveDomain(
  sink: LoadSink,
  importerAbs: string,
  u: Universe,
  opts: ResolveOptions = {},
): ResolvedTargetDomain {
  const spec: SpecifierDomain = sink.specifier;
  if (spec.tier === 'unbounded') return { tier: 'unbounded', gates: spec.gates };
  if (spec.tier === 'package') return packageDomain(u, spec.pkg, opts);

  const files = new Set<string>();
  const builtins: string[] = [];
  const missing: string[] = [];
  const widenTo: GateTag[] = [];
  const packageWiden = new Set<string>();

  for (const s of spec.specifiers) {
    const r = resolveSpecifier(importerAbs, s);
    if (r.kind === 'builtin') {
      builtins.push(r.name);
      continue;
    }
    // Cannot load what does not exist: an empty contribution is a proof, and
    // only for a BARE specifier whose package is genuinely absent from disk.
    if (r.kind === 'missing') {
      missing.push(s);
      continue;
    }
    if (r.kind === 'unresolved') {
      widenTo.push('unresolved-specifier');
      continue;
    }
    const resolved = r.abs;
    let f = fileFor(u, resolved);
    if (!f) {
      // A static edge from a universe module resolving here IS positive evidence.
      f = pullIn(u, resolved, `a load sink in ${sink.file} resolves "${s}" into it`) ?? undefined;
    }
    if (!f) {
      widenTo.push('unresolved-specifier');
      continue;
    }
    if (!f.isJs) continue; // a JSON/.node target initializes no JS module
    files.add(f.rel);

    // Dynamic import + divergent conditions: our require-condition answer is
    // not necessarily Node's. Widen to the owning package.
    if (
      !opts.skipImportCondition &&
      sink.capability === 'dynamic-import' &&
      sink.effect === 'load' &&
      f.pkg &&
      hasImportConditionDivergence(f.pkg.dir)
    ) {
      packageWiden.add(f.pkg.name);
    }
  }

  // The files that DID resolve travel with the widening: they are the demotion
  // target a gate-off counterfactual falls back to (RES-F8), never a narrowing.
  if (widenTo.length > 0) {
    return { tier: 'unbounded', gates: [...new Set(widenTo)], resolved: [...files].sort() };
  }
  if (packageWiden.size > 0) {
    // One package: the package tier carries it. Several: their union is not a
    // package tier, so the honest join is unbounded.
    if (packageWiden.size === 1) {
      const d = packageDomain(u, [...packageWiden][0], opts);
      return {
        tier: 'package',
        pkg: d.pkg,
        files: [...new Set([...d.files, ...files])],
        gates: ['import-condition-divergence'],
      };
    }
    return { tier: 'unbounded', gates: ['import-condition-divergence'], resolved: [...files].sort() };
  }
  return {
    tier: spec.tier,
    files: [...files].sort(),
    builtins: [...new Set(builtins)].sort(),
    missing: [...new Set(missing)].sort(),
  };
}

/** Gates a resolved domain carries on its own (before config suppression). */
export function domainGates(d: ResolvedTargetDomain): GateTag[] {
  if (d.tier === 'unbounded') return d.gates;
  if (d.tier === 'package') return ['package-domain-whole', ...(d.gates ?? [])];
  return [];
}

/**
 * RES-F3. The domain a static edge widens to when its resolution was ignorance
 * (`unresolved`) or when Node would resolve it under import conditions into a
 * divergent package. A bare specifier naming a package we DO have narrows the
 * blast radius to that package; anything else is universe-wide.
 */
export function staticEdgeWiden(u: Universe, source: string): { files: string[]; unbounded: boolean } {
  const pkg = packageOfSpecifier(source);
  const files = pkg ? packageJsFiles(u, pkg).map((f) => f.rel) : [];
  return files.length > 0 ? { files, unbounded: false } : { files: [], unbounded: true };
}
