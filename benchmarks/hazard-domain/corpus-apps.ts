/**
 * Shared corpus-v1 app metadata for the hazard-domain benchmark scripts
 * (run-corpus.ts, cve-feasibility.ts). Factored out so both scripts read the
 * SAME verified entry table, the SAME git-HEAD verification, and the SAME
 * frozen production-package lookup — a second, drifting copy of any of these
 * would be exactly the kind of silent inconsistency ADR-0006 exists to avoid.
 *
 * Nothing here calls into the analyzer; it only locates inputs on disk.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CLONE_ROOT = '/Users/sara/.cache/reducer-corpus-v1';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CORPUS_JSON = path.join(REPO_ROOT, 'benchmarks', 'corpus.json');
const CORPUS_PACKAGES_JSON = path.join(REPO_ROOT, 'benchmarks', 'cve-population', 'corpus-packages.json');

/**
 * Entrypoints VERIFIED present on disk at the pinned SHA (see MATERIALIZATION.md).
 * `corpus.json`'s own `entry` field is a DECLARATION, not a verified fact — three
 * of these disagree with it (recorded in ENTRY_DEVIATIONS below), which is why
 * this table, not corpus.json, is the one the runner trusts.
 */
export const ENTRY_TABLE: Record<string, string> = {
  'node-express-boilerplate': 'src/index.js',
  'fastify-demo': 'dist/server.js',
  'express-realworld': 'dist/api/main.js',
  'json-server': 'lib/bin.js',
  'uptime-kuma': 'server/server.js',
  'hackathon-starter': 'app.js',
  'express-rest-boilerplate': 'src/index.js',
  'bulletproof-nodejs': 'build/app.js',
  'nestjs-realworld': 'dist/main.js',
  'nestjs-typescript-starter': 'dist/main.js',
  'parse-server': 'bin/parse-server',
  verdaccio: 'packages/verdaccio/bin/verdaccio',
  nodebb: 'app.js',
  ghost: 'ghost/core/index.js',
  n8n: 'packages/cli/bin/n8n',
  'excalidraw-room': 'dist/index.js',
  'juice-shop': 'build/app.js',
  outline: 'build/server/index.js',
  strapi: 'packages/core/strapi/bin/strapi.js',
};

/** Apps whose corpus.json `entry` declaration disagrees with ENTRY_TABLE, and why. */
export const ENTRY_DEVIATIONS: Record<string, string> = {
  'express-realworld':
    "corpus.json declares 'dist/main.js'; the real build output (and what the published calibration " +
    "actually measured) is 'dist/api/main.js'.",
  verdaccio:
    "corpus.json declares 'build/lib/cli.js', which does not exist at the pinned SHA; the production " +
    "start point is the package's own bin, 'packages/verdaccio/bin/verdaccio'.",
  strapi:
    "corpus.json declares the directory 'examples/getstarted' (not a file). Resolved to " +
    "'packages/core/strapi/bin/strapi.js', the CLI file the workspace's `strapi start` script executes. " +
    'Control app; a wide or zero result here is an expected honest measurement, not a defect.',
};

/** The four named sound-refinement counterfactuals (ADR-0006 design §13), fixed order. */
export const SR_REFINEMENTS = [
  'SR-vm-known-globals',
  'SR-subpath-exports-narrowing',
  'SR-import-condition-resolution',
  'SR-cross-module-wrapper',
] as const;

export interface CorpusApp {
  app: string;
  category: 'target' | 'control';
  resolvedSha: string;
  entryRel: string;
}

let corpusCache: CorpusApp[] | null = null;
export function loadCorpusApps(): CorpusApp[] {
  if (corpusCache) return corpusCache;
  const raw = JSON.parse(readFileSync(CORPUS_JSON, 'utf8'));
  corpusCache = raw.corpus.map((c: any) => {
    const entryRel = ENTRY_TABLE[c.name];
    if (!entryRel) throw new Error(`no verified ENTRY_TABLE entry for corpus app '${c.name}'`);
    return { app: c.name, category: c.category, resolvedSha: c.resolvedSha, entryRel };
  });
  return corpusCache!;
}

export function corpusApp(name: string): CorpusApp {
  const a = loadCorpusApps().find((c) => c.app === name);
  if (!a) throw new Error(`unknown corpus app '${name}'`);
  return a;
}

export function cloneDir(app: string): string {
  return path.join(CLONE_ROOT, app);
}

/**
 * Verify the clone's HEAD is exactly the frozen resolvedSha — NEVER re-fetch or
 * advance it. A mismatch means the frozen input moved (or was never
 * materialized correctly) and the app must be aborted, not silently measured
 * against different code than the preregistration pins.
 */
export function verifyHead(app: string): { ok: true; sha: string } | { ok: false; error: string } {
  const dir = cloneDir(app);
  const expected = corpusApp(app).resolvedSha;
  let actual: string;
  try {
    actual = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (err) {
    return { ok: false, error: `git rev-parse HEAD failed in ${dir}: ${String(err).slice(0, 300)}` };
  }
  if (actual !== expected) {
    return { ok: false, error: `HEAD mismatch in ${dir}: expected ${expected}, got ${actual} (never re-fetched)` };
  }
  return { ok: true, sha: actual };
}

let packagesCache: Map<string, { name: string; version: string }[]> | null = null;
export function loadFrozenPackages(app: string): { name: string; version: string }[] {
  if (!packagesCache) {
    const raw = JSON.parse(readFileSync(CORPUS_PACKAGES_JSON, 'utf8'));
    packagesCache = new Map(
      raw.apps.map((a: any) => [a.app, a.productionPackages.map((p: any) => ({ name: p.name, version: p.version }))]),
    );
  }
  const pkgs = packagesCache.get(app);
  if (!pkgs) throw new Error(`no corpus-packages.json entry for app '${app}'`);
  return pkgs;
}
