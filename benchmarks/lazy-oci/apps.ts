/**
 * The 7 applications selected for the lazy-OCI experiment, and where their
 * measured tree lives. Selection criteria are preregistered in DESIGN.md §3.1
 * and were fixed before any arm ran.
 *
 * `tree` says which tree is measured:
 *   'frozen'  — the darwin-materialised corpus-v1 clone, unmodified, because
 *               the app boots under Linux as-is (zero deviation)
 *   'linux'   — re-materialised corpus-v1-linux (same SHA, same lockfile,
 *               node_modules re-resolved for linux/arm64; DESIGN.md §3.2)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ENTRY_TABLE, cloneDir, loadFrozenPackages } from '../hazard-domain/corpus-apps.ts';

export const LINUX_ROOT = '/Users/sara/.cache/reducer-lazyoci-v1/apps';

export interface LazyApp {
  name: string;
  tree: 'frozen' | 'linux';
  /** the preregistered property this app is in the set for */
  criterion: string;
  /** external services the recipe needs, as container names on reducer-net */
  services: ('pg' | 'mongo' | 'redis' | 'mysql')[];
}

export const APPS: LazyApp[] = [
  { name: 'json-server', tree: 'frozen', criterion: 'smaller/control application', services: [] },
  { name: 'verdaccio', tree: 'frozen', criterion: 'control + dynamic plugin resolution', services: [] },
  { name: 'express-realworld', tree: 'linux', criterion: 'native/ORM-heavy (the Prisma case)', services: ['pg'] },
  { name: 'uptime-kuma', tree: 'linux', criterion: 'strong existing workload incl. a held-out extended phase', services: [] },
  { name: 'juice-shop', tree: 'linux', criterion: 'many mixed HOT/COLD packages', services: [] },
  { name: 'strapi', tree: 'linux', criterion: 'framework-heavy, plugin/dynamic loading', services: [] },
  { name: 'n8n', tree: 'linux', criterion: 'very large universe + highest static uncertainty', services: [] },
];

export const appByName = (name: string): LazyApp => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`app '${name}' is not in the preregistered selection`);
  return a;
};

export function appRoot(name: string): string {
  const a = appByName(name);
  return a.tree === 'frozen' ? cloneDir(name) : path.join(LINUX_ROOT, name);
}

/** The pinned corpus SHA of the tree actually measured. Never re-fetched. */
export function appSha(name: string): string {
  const a = appByName(name);
  if (a.tree === 'linux') return readFileSync(path.join(LINUX_ROOT, name, '.reducer-sha'), 'utf8').trim();
  return execFileSync('git', ['-C', cloneDir(name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export const entryRel = (name: string): string => {
  const e = ENTRY_TABLE[name];
  if (!e) throw new Error(`no verified ENTRY_TABLE entry for '${name}'`);
  return e;
};

/**
 * The production package population of the tree ACTUALLY MEASURED.
 *
 * Experiments 1–2 filtered the universe with `benchmarks/cve-population/
 * corpus-packages.json` — the frozen production population — because the
 * lockfile dev-flag boundary only exists for npm apps, so a pnpm/yarn tree
 * otherwise drags its whole dev dependency set into the "production" universe
 * (json-server: 65 MB instead of 2.8 MB). The same filter is used here.
 *
 * One correction is required and is a consequence of DESIGN.md §3.2: a
 * linux/arm64 install resolves the *linux* platform-optional packages, which
 * by construction are absent from a population frozen on darwin. Dropping them
 * would delete the native binaries the application dlopen()s — an image that
 * cannot run. So the population is:
 *
 *     every installed package whose NAME the frozen population declares
 *   ∪ every installed package named by an optionalDependency of one of those
 *     (the platform-variant mechanism: @img/sharp-linux-arm64, @esbuild/…,
 *      @rollup/rollup-linux-arm64-gnu, …)
 *
 * at the versions actually installed. For a frozen (darwin) tree this reduces
 * to exactly the experiment-1/2 population.
 */
export function productionPackages(app: string, root: string): { name: string; version: string }[] {
  const declared = new Set(loadFrozenPackages(app).map((p) => p.name));
  const installed = new Map<string, { name: string; version: string; dir: string }>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.isSymbolicLink()) continue;
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      stack.push(child);
      if (e.name !== 'node_modules') continue;
      // every package directory directly under this node_modules (incl. @scope)
      let pkgs;
      try {
        pkgs = readdirSync(child, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const p of pkgs) {
        const dirs = p.name.startsWith('@')
          ? (() => {
              try {
                return readdirSync(path.join(child, p.name), { withFileTypes: true })
                  .filter((x) => x.isDirectory() || x.isSymbolicLink())
                  .map((x) => path.join(child, p.name, x.name));
              } catch {
                return [];
              }
            })()
          : [path.join(child, p.name)];
        for (const d of dirs) {
          try {
            const pj = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8'));
            if (typeof pj.name === 'string' && pj.name) {
              const key = `${pj.name}@${String(pj.version ?? '0.0.0')}`;
              if (!installed.has(key)) installed.set(key, { name: pj.name, version: String(pj.version ?? '0.0.0'), dir: d });
            }
          } catch {
            /* not a package directory */
          }
        }
      }
    }
  }
  const keep = new Map<string, { name: string; version: string }>();
  const wanted = new Set(declared);
  for (const [key, p] of installed) if (wanted.has(p.name)) keep.set(key, { name: p.name, version: p.version });
  // one pass of optional-dependency platform variants of kept packages
  const optNames = new Set<string>();
  for (const [key] of keep) {
    const rec = installed.get(key);
    if (!rec) continue;
    try {
      const pj = JSON.parse(readFileSync(path.join(rec.dir, 'package.json'), 'utf8'));
      for (const n of Object.keys(pj.optionalDependencies ?? {})) optNames.add(n);
    } catch {
      /* unreadable */
    }
  }
  for (const [key, p] of installed) if (optNames.has(p.name)) keep.set(key, { name: p.name, version: p.version });
  return [...keep.values()];
}
