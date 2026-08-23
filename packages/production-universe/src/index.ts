/**
 * @reducer/production-universe — production-universe discovery, shared by
 * both research branches (extracted from the hazard-domain analyzer; ADR-0007).
 * The universe is the authoritative set of files eligible to exist in any
 * artifact: the conservative branch subtracted proofs from it, the
 * virtualization branch partitions it into HOT/COLD placements.
 *
 * The production universe (ADR-0005/0006, CONTEXT.md "production universe").
 *
 * D is the denominator of the kill metric, so every decision here is made in
 * the direction that CANNOT flatter the result:
 *
 *  - Package ownership is semantic (nearest ancestor package.json with a name),
 *    never a `node_modules` path test — ADR-0006 requires hoisting- and
 *    symlink-safe ownership.
 *  - Byte accounting is done in REALPATH space with de-duplication. A pnpm tree
 *    reaches one physical file through `node_modules/<pkg>` (a symlink) and
 *    through `node_modules/.pnpm/<pkg>@v/node_modules/<pkg>`; counting both
 *    would inflate D and therefore deflate every percentage. Symlinks are
 *    recorded and never walked through, exactly like `cli/build.ts`.
 *  - When a frozen production package population is supplied it — not the disk —
 *    defines third-party membership. Anything installed but not declared is
 *    OUTSIDE the universe: it is not analyzed and not counted, UNLESS positive
 *    evidence (an NFT trace hit, or a static edge from a universe module that
 *    resolves into it) proves it participates. Positive evidence widens: such a
 *    file is pulled in, analyzed, and counted in BOTH D and E, and the
 *    divergence between the frozen population and the disk is recorded.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * RES-F11. `fs.realpathSync` does NOT canonicalize case on a case-insensitive
 * filesystem; `realpathSync.native` delegates to the OS and does. Physical
 * identity is the dedup key for D and the key for module-identity unification,
 * so it must be the same under node and under bun — `./foo.js` and `./Foo.js`
 * are ONE module on macOS, and counting them twice inflates D while splitting
 * one module's usage across two records (the unsound direction).
 */
export const realpath: (p: string) => string = realpathSync.native ?? realpathSync;

export interface PkgId {
  name: string;
  version: string;
  /** package root as walked (physical: the walk never crosses a symlink) */
  dir: string;
}

export interface UniverseFile {
  abs: string;
  /** physical identity — the dedup key */
  real: string;
  /** POSIX path relative to the universe root; canonical (first walked) */
  rel: string;
  bytes: number;
  /** executable JS: .js/.cjs/.mjs, or an extensionless `#!…node` entry bin */
  isJs: boolean;
  thirdParty: boolean;
  pkg: PkgId | null;
  /** pulled in by positive evidence despite being absent from the frozen set */
  outside: boolean;
}

export interface Universe {
  root: string;
  entryAbs: string;
  entryRel: string;
  files: UniverseFile[];
  byRel: Map<string, UniverseFile>;
  byReal: Map<string, UniverseFile>;
  /** package name → every universe JS file of every install of that name */
  jsByPkgName: Map<string, UniverseFile[]>;
  /** package dir → id, for the opaque-boundary scan */
  pkgDirs: Map<string, PkgId>;
  /** frozen production population as "name@version", or null (fallback mode) */
  frozen: Set<string> | null;
  /** Σ third-party executable JS bytes, realpath-deduped */
  D: number;
  warnings: string[];
}

/** cli/build.ts findBase, ported verbatim: the highest explicit workspace marker wins. */
export function findBase(entryAbs: string): string {
  let dir = path.dirname(entryAbs);
  let nearest: string | null = null;
  let workspaceRoot: string | null = null;
  while (true) {
    if (existsSync(path.join(dir, 'package.json'))) {
      nearest ??= dir;
      try {
        const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        if (pj.workspaces) workspaceRoot = dir;
      } catch {
        /* unreadable manifest is not a root signal */
      }
    }
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml')) || existsSync(path.join(dir, 'lerna.json'))) {
      workspaceRoot = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return workspaceRoot ?? nearest ?? path.dirname(entryAbs);
}

const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

/**
 * An extensionless file whose first bytes are a node shebang is executable JS
 * (package `bin` entries routinely have no extension). Reading 128 bytes of an
 * extensionless file is cheap; a misclassification in EITHER direction is a
 * measurement error, so this is not optional.
 */
function shebangIsNode(abs: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, 128, 0);
    const head = buf.subarray(0, n).toString('utf8');
    if (!head.startsWith('#!')) return false;
    const line = head.split('\n', 1)[0];
    return /\bnode\b/.test(line);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function isExecutableJs(abs: string, rel: string): boolean {
  const ext = path.posix.extname(rel);
  if (JS_EXT.has(ext)) return true;
  if (ext !== '') return false;
  return shebangIsNode(abs);
}

/**
 * cli/build.ts collectUniverse dev boundary, ported including the stale-lockfile
 * guard: only install-tree entries are excludable, and if the lockfile's dev
 * flags disagree with package.json's production dependencies the lockfile is not
 * trustworthy proof and NOTHING is excluded.
 */
function devPackageRels(root: string, warnings: string[]): Set<string> {
  const devPkgRels = new Set<string>();
  try {
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    for (const [p, entry] of Object.entries<any>(lock.packages ?? {})) {
      if (p && entry?.dev === true && p.startsWith('node_modules/')) devPkgRels.add(p);
    }
    try {
      const pj = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      const prodDeps = new Set([
        ...Object.keys(pj.dependencies ?? {}),
        ...Object.keys(pj.optionalDependencies ?? {}),
        ...Object.keys(pj.peerDependencies ?? {}),
      ]);
      const stale = [...devPkgRels].filter((p) => {
        const name = p.slice('node_modules/'.length);
        return !name.includes('/node_modules/') && prodDeps.has(name);
      });
      if (stale.length > 0) {
        warnings.push(
          `lockfile dev flags disagree with package.json production dependencies (${stale.join(', ')}); ` +
            'lockfile is stale — excluding nothing from the production universe',
        );
        devPkgRels.clear();
      }
    } catch {
      /* no readable package.json — keep the lockfile boundary as-is */
    }
  } catch {
    /* no lockfile — no production-install boundary, exclude nothing */
  }
  return devPkgRels;
}

function readPkgId(dir: string): PkgId | null {
  try {
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof pj.name !== 'string' || pj.name.length === 0) return null;
    return { name: pj.name, version: String(pj.version ?? '0.0.0'), dir };
  } catch {
    return null;
  }
}

const underNodeModules = (rel: string): boolean => rel.split('/').includes('node_modules');

export interface BuildUniverseOptions {
  entry: string;
  root?: string;
  frozenPackages?: { name: string; version: string }[];
}

export function buildUniverse(opts: BuildUniverseOptions): Universe {
  const entryAbs = path.resolve(opts.entry);
  if (!existsSync(entryAbs)) throw new Error(`entrypoint not found: ${entryAbs}`);
  // The root is realpath'd once so every walked path below it is physical: the
  // walk never crosses a symlink, which is what makes the ownership walk (which
  // uses walked paths) realpath-correct without per-file realpath calls.
  const rawRoot = path.resolve(opts.root ?? findBase(entryAbs));
  let root = rawRoot;
  try {
    root = realpath(rawRoot);
  } catch {
    /* keep the literal root */
  }

  const warnings: string[] = [];
  const frozen = opts.frozenPackages
    ? new Set(opts.frozenPackages.map((p) => `${p.name}@${p.version}`))
    : null;
  const devPkgRels = frozen ? new Set<string>() : devPackageRels(root, warnings);

  const ownerCache = new Map<string, PkgId | null>();
  const ownerOf = (fileAbs: string): PkgId | null => {
    let dir = path.dirname(fileAbs);
    const chain: string[] = [];
    while (true) {
      const hit = ownerCache.get(dir);
      if (hit !== undefined) {
        for (const d of chain) ownerCache.set(d, hit);
        return hit;
      }
      chain.push(dir);
      const id = readPkgId(dir);
      if (id) {
        for (const d of chain) ownerCache.set(d, id);
        return id;
      }
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const d of chain) ownerCache.set(d, null);
    return null;
  };

  const u: Universe = {
    root,
    entryAbs,
    entryRel: path.relative(root, entryAbs).split(path.sep).join('/'),
    files: [],
    byRel: new Map(),
    byReal: new Map(),
    jsByPkgName: new Map(),
    pkgDirs: new Map(),
    frozen,
    D: 0,
    warnings,
  };

  const add = (abs: string, rel: string, outside: boolean): UniverseFile | null => {
    let real = abs;
    let bytes = 0;
    try {
      real = realpath(abs);
      bytes = statSync(abs).size;
    } catch {
      return null; // dangling symlink / unreadable: nothing to count or analyze
    }
    // REALPATH DEDUP: one physical file is counted exactly once, and the first
    // walked rel stays canonical so module-identity unification has one key.
    const seen = u.byReal.get(real);
    if (seen) {
      if (!u.byRel.has(rel)) u.byRel.set(rel, seen); // alias path → canonical record
      return seen;
    }
    const pkg = ownerOf(abs);
    const isJs = isExecutableJs(abs, rel);
    const thirdParty = frozen
      ? !!pkg && frozen.has(`${pkg.name}@${pkg.version}`)
      : !!pkg && underNodeModules(rel);
    const f: UniverseFile = { abs, real, rel, bytes, isJs, thirdParty, pkg, outside };
    u.files.push(f);
    u.byRel.set(rel, f);
    u.byReal.set(real, f);
    if (pkg) {
      u.pkgDirs.set(pkg.dir, pkg);
      if (isJs) {
        let list = u.jsByPkgName.get(pkg.name);
        if (!list) u.jsByPkgName.set(pkg.name, (list = []));
        list.push(f);
      }
    }
    if (isJs && thirdParty) u.D += bytes;
    return f;
  };

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`could not read ${path.relative(root, dir) || '.'}: ${String(err).slice(0, 100)}`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel === '.git') continue;
      if (devPkgRels.has(rel)) continue; // dev-only package subtree: not production
      if (e.isSymbolicLink()) {
        // Recorded, never walked through. Its physical content is reached by
        // walking the real directory (in-tree stores like .pnpm), or — if the
        // target is out of tree — it is a divergence we must not silently count.
        let target: string | null = null;
        try {
          target = realpath(abs);
        } catch {
          /* dangling */
        }
        if (target && !(target === root || target.startsWith(root + path.sep))) {
          warnings.push(`symlink ${rel} targets outside the universe root (${target}); its content is not walked`);
        }
        continue;
      }
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) add(abs, rel, false);
    }
  };
  walk(root);

  // The entry must be in the universe even if the walk could not see it.
  if (!u.byRel.has(u.entryRel)) add(entryAbs, u.entryRel, false);

  // Frozen mode: everything installed but undeclared is outside until proven
  // otherwise. Drop it from the universe (and from D) here; `pullIn` restores
  // any file that positive evidence later reaches.
  if (frozen) {
    const kept: UniverseFile[] = [];
    let dropped = 0;
    for (const f of u.files) {
      const installed = !!f.pkg && underNodeModules(f.rel);
      if (installed && !f.thirdParty) {
        u.byRel.delete(f.rel);
        u.byReal.delete(f.real);
        if (f.isJs) dropped++;
        continue;
      }
      kept.push(f);
    }
    if (dropped > 0) {
      warnings.push(
        `${dropped} installed JS file(s) belong to packages absent from the frozen production population; ` +
          'treated as outside the universe unless positive evidence reaches them',
      );
    }
    u.files = kept;
    for (const [name, list] of u.jsByPkgName) {
      const f = list.filter((x) => u.byReal.has(x.real));
      if (f.length === 0) u.jsByPkgName.delete(name);
      else u.jsByPkgName.set(name, f);
    }
  }

  return u;
}

/**
 * Positive evidence reached a file the frozen population did not declare.
 * Absence of a declaration is not proof of absence at runtime, so the file is
 * pulled in: analyzed, and counted in both D and E. The divergence is recorded.
 */
export function pullIn(u: Universe, abs: string, why: string): UniverseFile | null {
  let real = abs;
  try {
    real = realpath(abs);
  } catch {
    return null;
  }
  const seen = u.byReal.get(real);
  if (seen) return seen;
  let bytes: number;
  try {
    bytes = statSync(abs).size;
  } catch {
    return null;
  }
  const relRaw = path.relative(u.root, abs);
  const rel = relRaw.startsWith('..') ? abs.split(path.sep).join('/') : relRaw.split(path.sep).join('/');

  let pkg: PkgId | null = null;
  let dir = path.dirname(abs);
  while (true) {
    const id = readPkgId(dir);
    if (id) {
      pkg = id;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const isJs = isExecutableJs(abs, rel);
  const f: UniverseFile = {
    abs,
    real,
    rel,
    bytes,
    isJs,
    // A pulled-in installed package is third-party by construction: it is
    // vendored code the app loads. Counting it in D is the conservative side —
    // it enlarges the denominator we must prove reductions against.
    thirdParty: !!pkg && (underNodeModules(rel) || relRaw.startsWith('..')),
    pkg,
    outside: true,
  };
  u.files.push(f);
  u.byRel.set(rel, f);
  u.byReal.set(real, f);
  if (pkg) {
    u.pkgDirs.set(pkg.dir, pkg);
    if (isJs) {
      let list = u.jsByPkgName.get(pkg.name);
      if (!list) u.jsByPkgName.set(pkg.name, (list = []));
      list.push(f);
    }
  }
  if (isJs && f.thirdParty) u.D += bytes;
  u.warnings.push(`universe divergence: ${rel} is absent from the frozen production population but ${why}; pulled in`);
  return f;
}

/**
 * The universe record for an absolute path, however it is spelled: physical
 * path, an alias path (a pnpm symlink farm entry), or a not-yet-canonicalized
 * path from a resolver. One lookup so every caller agrees on module identity.
 */
export function fileFor(u: Universe, abs: string): UniverseFile | undefined {
  const direct = u.byReal.get(abs);
  if (direct) return direct;
  const rel = path.relative(u.root, abs).split(path.sep).join('/');
  const byRel = u.byRel.get(rel);
  if (byRel) return byRel;
  try {
    return u.byReal.get(realpath(abs));
  } catch {
    return undefined;
  }
}

/** Every universe JS file of every install of `name` (package-tier domain). */
export function packageJsFiles(u: Universe, name: string): UniverseFile[] {
  return u.jsByPkgName.get(name) ?? [];
}
