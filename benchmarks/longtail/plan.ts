/**
 * Per-app inputs for the long-tail traffic-warm experiment.
 *
 * The universe walk, NFT positive evidence, NFT graph order, the ADR-0007
 * Plan B HOT set and the pruned staging tree all come from
 * `benchmarks/lazy-oci/plan.ts` unchanged — one implementation, no second
 * drifting copy. This module adds the one input experiment 3 did not need:
 *
 *   pkgDeps — the DECLARED package dependency graph, resolved with Node's own
 *             resolution algorithm from each package's directory.
 *
 * That edge set is what lets a semantic strategy reach a subtree the workload
 * never touched *and* the module graph never statically reached — an optional
 * feature's library, a plugin-only dependency — without resorting to "prefetch
 * everything nearby", which is what the generic strategies already do better.
 * It is Node/package knowledge by construction, so it is available only to
 * R1/R2 (DESIGN.md §7).
 *
 * Usage: bun benchmarks/longtail/plan.ts --app <name> | --all
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { realpath } from '@reducer/production-universe';
import { buildPlanFor, type AppPlan } from '../lazy-oci/plan.ts';
import { APPS, WORK_ROOT, appByName, appRoot, appSha, frozenPopulation } from './apps.ts';

export interface LongtailPlan extends AppPlan {
  /** package dir → package dirs it declares a dependency on (Node-resolved) */
  pkgDeps: [string, string[]][];
  /** package dirs reachable from the app root over pkgDeps, with their hop count */
  pkgDepth: [string, number][];
}

/**
 * Resolve every declared dependency of every universe package to the package
 * DIRECTORY that Node would actually load, by walking `node_modules` upward
 * from the dependent — the real algorithm, so hoisting, scoping and workspace
 * symlinks resolve the way the runtime resolves them. A name that resolves
 * outside the universe (a dev-only or absent optional dependency) is dropped.
 */
function packageDependencyGraph(
  root: string,
  pkgDirs: Set<string>,
  /** BFS sources: the ENTRYPOINT's own package, plus the tree root.
   *  Seeding only from the root is wrong for a workspace monorepo, whose root
   *  package.json declares nothing but devDependencies and a `workspaces` glob —
   *  verdaccio and strapi both resolved to a single reachable package that way,
   *  silently emptying R1/R2's only non-generic input. */
  sources: string[],
): { deps: Map<string, string[]>; depth: Map<string, number> } {
  /**
   * Package directories are recorded in PHYSICAL (realpath-deduped) space by
   * the universe walk, because pnpm and workspaces reach one physical package
   * through several symlinked aliases. A resolution candidate must therefore be
   * realpath'd before it can be matched, or every pnpm tree resolves to zero
   * edges — which is silent, and would quietly delete R1/R2's only input that
   * the generic strategies do not have.
   */
  const canonical = (abs: string): string | null => {
    let real = abs;
    try {
      real = realpath(abs);
    } catch {
      return null;
    }
    const rel = path.relative(root, real).split(path.sep).join('/');
    return pkgDirs.has(rel) ? rel : null;
  };

  const resolveFrom = (fromRel: string, name: string): string | null => {
    // node_modules walk: <from>/node_modules/<name>, then each ancestor's
    let dir = fromRel === '' ? root : path.join(root, fromRel);
    for (;;) {
      const cand = path.join(dir, 'node_modules', name);
      if (existsSync(path.join(cand, 'package.json'))) {
        const c = canonical(cand);
        if (c !== null) return c;
      }
      const parent = path.dirname(dir);
      if (parent === dir || !parent.startsWith(root)) return null;
      dir = parent;
    }
  };

  const deps = new Map<string, string[]>();
  for (const p of pkgDirs) {
    let pj: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    try {
      pj = JSON.parse(readFileSync(path.join(root, p === '' ? '' : p, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const names = new Set([
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
      ...Object.keys(pj.peerDependencies ?? {}),
    ]);
    const out: string[] = [];
    for (const n of names) {
      const r = resolveFrom(p, n);
      if (r !== null && r !== p) out.push(r);
    }
    if (out.length) deps.set(p, out.sort());
  }

  // BFS from the application itself
  const depth = new Map<string, number>();
  let frontier: string[] = [];
  for (const s0 of sources) {
    if (!pkgDirs.has(s0) || depth.has(s0)) continue;
    depth.set(s0, 0);
    frontier.push(s0);
  }
  for (let d = 1; frontier.length; d++) {
    const next: string[] = [];
    for (const p of frontier) {
      for (const q of deps.get(p) ?? []) {
        if (depth.has(q)) continue;
        depth.set(q, d);
        next.push(q);
      }
    }
    frontier = next;
  }
  return { deps, depth };
}

export async function buildLongtailPlan(app: string): Promise<LongtailPlan> {
  const a = appByName(app);
  const root = appRoot(app);
  const base = await buildPlanFor({
    app,
    root,
    entryRel: a.entryRel,
    frozenPackages: frozenPopulation(app),
    sha: appSha(app),
    stageDir: path.join(WORK_ROOT, 'stage', app),
  });
  const pkgDirs = new Set(base.pkgOf.map(([, dir]) => dir));
  const entryPkg = new Map(base.pkgOf).get(base.entryRel) ?? '';
  const { deps, depth } = packageDependencyGraph(root, pkgDirs, [entryPkg, '']);
  return { ...base, pkgDeps: [...deps], pkgDepth: [...depth] };
}

export const planPath = (app: string): string => path.join(WORK_ROOT, 'plans', `${app}.json`);

export function loadPlan(app: string): LongtailPlan {
  return JSON.parse(readFileSync(planPath(app), 'utf8'));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } }, strict: true });
  const apps = values.all ? APPS.map((x) => x.name) : [values.app!];
  mkdirSync(path.join(WORK_ROOT, 'plans'), { recursive: true });
  for (const app of apps) {
    const t0 = Date.now();
    const plan = await buildLongtailPlan(app);
    writeFileSync(planPath(app), JSON.stringify(plan));
    const reachable = plan.pkgDepth.length;
    console.log(
      `[${app}] universe ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB | ` +
        `nft ${plan.nft.length} | planB hot ${plan.planBHot.length} | pkgs ${new Set(plan.pkgOf.map((x) => x[1])).size} ` +
        `(dep-reachable ${reachable}) | staged ${plan.staged.files} (pruned ${plan.staged.prunedFiles}) | ` +
        `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
    for (const w of plan.warnings.slice(0, 2)) console.log(`  ! ${w.slice(0, 160)}`);
  }
}
