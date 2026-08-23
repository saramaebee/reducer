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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GateTag, LoadSink, ResolvedTargetDomain, SpecifierDomain } from './types.ts';
import { packageJsFiles, pullIn, type Universe, type UniverseFile } from './universe.ts';

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

/**
 * A package whose `exports` field maps some subpath to DIFFERENT files under
 * the `import` and `require` conditions. `createRequire().resolve()` only ever
 * answers the require branch, so for a dynamic-import sink our resolved file is
 * not necessarily the one Node loads — the honest answer is the whole package.
 *
 * APPROXIMATION (gate `import-condition-divergence`): the whole `exports` tree
 * is scanned rather than only the subtree the resolved subpath selects. That is
 * strictly the widening direction (a package with divergence anywhere widens
 * everywhere in it); exact per-subpath condition resolution is
 * SR-import-condition-resolution.
 */
const divergenceCache = new Map<string, boolean>();
export function hasImportConditionDivergence(pkgDir: string): boolean {
  const hit = divergenceCache.get(pkgDir);
  if (hit !== undefined) return hit;
  let diverges = false;
  try {
    const pj = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
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
    walk(pj.exports);
  } catch {
    /* unreadable manifest: no evidence of divergence, and the package-tier
       widening this function feeds is not the only conservative path here */
  }
  divergenceCache.set(pkgDir, diverges);
  return diverges;
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

function packageDomain(u: Universe, pkg: string, opts: ResolveOptions): PackageDomain {
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
  const req = requireFrom(importerAbs);
  const widenTo: GateTag[] = [];
  const packageWiden = new Set<string>();

  for (const s of spec.specifiers) {
    if (isBuiltin(s) || s.startsWith('node:')) {
      builtins.push(s);
      continue;
    }
    let resolved: string;
    try {
      resolved = req.resolve(s);
    } catch {
      const pkg = packageOfSpecifier(s);
      // Cannot load what does not exist: an empty contribution is a proof, and
      // only for a BARE specifier whose package is absent from the universe.
      if (pkg && !u.jsByPkgName.has(pkg)) {
        missing.push(s);
        continue;
      }
      widenTo.push('unresolved-specifier');
      continue;
    }
    if (!path.isAbsolute(resolved)) {
      builtins.push(resolved); // builtin alias form
      continue;
    }
    let f = u.byReal.get(resolved) ?? u.byRel.get(path.relative(u.root, resolved).split(path.sep).join('/'));
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

  if (widenTo.length > 0) return { tier: 'unbounded', gates: [...new Set(widenTo)] };
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
    return { tier: 'unbounded', gates: ['import-condition-divergence'] };
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
