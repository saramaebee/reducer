/**
 * The applications selected for the long-tail traffic-warm experiment.
 *
 * Selection criteria are preregistered in DESIGN.md §3 and were fixed, in
 * writing and in git, before any arm of this experiment ran. Every app here was
 * already materialised and proven bootable by ADR-0007 experiment 3, except the
 * controlled Next.js fixture, which is authored in this repository.
 *
 * `tree`:
 *   'frozen'  — the darwin-materialised corpus-v1 clone, unmodified
 *   'linux'   — corpus-v1-linux (same SHA, same lockfile, linux/arm64 install)
 *   'fixture' — authored here; its SHA is this repository's commit
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cloneDir } from '../hazard-domain/corpus-apps.ts';
import { LINUX_ROOT, productionPackages } from '../lazy-oci/apps.ts';

export const FIXTURE_ROOT = path.join(LINUX_ROOT, 'nextjs-longtail');
export const WORK_ROOT = '/Users/sara/.cache/reducer-longtail-v1';

export interface LongtailApp {
  name: string;
  tree: 'frozen' | 'linux' | 'fixture';
  kind: 'real' | 'fixture';
  entryRel: string;
  /** the preregistered property this app is in the set for */
  criterion: string;
  /** which long-tail mechanisms this app was selected to expose */
  mechanisms: string[];
  services: ('pg' | 'mongo' | 'redis' | 'mysql')[];
}

export const APPS: LongtailApp[] = [
  {
    name: 'juice-shop',
    tree: 'linux',
    kind: 'real',
    entryRel: 'build/app.js',
    criterion: 'richest genuine request-time module long tail in the corpus',
    mechanisms: [
      'lazy import() of large optional subtrees (ethers, pdfkit, svg-captcha, pug)',
      "computed require() inside express's view-engine resolution (hbs -> handlebars)",
      "an import() hidden behind new Function('specifier','return import(specifier)') (libxml2-wasm)",
      'request-time reads of package asset directories (swagger-ui-dist, pdfkit .afm) and of config-computed paths',
      'lazily-fetched frontend route chunks',
    ],
    services: [],
  },
  {
    name: 'strapi',
    tree: 'linux',
    kind: 'real',
    entryRel: 'packages/core/strapi/bin/strapi.js',
    criterion: 'largest measured universe (915 MB) — the ICP size class; plugin- and config-driven',
    mechanisms: [
      'lazy require of a plugin-only dependency subtree (documentation -> cheerio/parse5)',
      'lazy ESM import() in the upload pipeline (file-type)',
      'admin/background surfaces (api tokens, webhooks, preview) absent from common traffic',
      'production-only error paths (is-development-mode 403, strict-params 400)',
    ],
    services: [],
  },
  {
    name: 'verdaccio',
    tree: 'frozen',
    kind: 'real',
    entryRel: 'packages/verdaccio/bin/verdaccio',
    criterion: 'write-path and rare-route long tail on a mid-size tree; dynamic plugin loader present',
    mechanisms: [
      'publish / deprecate / unpublish write path (tarball validation, storage writes)',
      'dist-tag and profile surfaces no read-only workload reaches',
      'error paths through a dead uplink and through tarball validation',
    ],
    services: [],
  },
  {
    name: 'uptime-kuma',
    tree: 'linux',
    kind: 'real',
    entryRel: 'server/server.js',
    criterion:
      'ADVERSE CASE: its long tail is asset-shaped, not module-shaped — the server eagerly requires all 25 monitor types and all ~106 notification providers at boot',
    mechanisms: [
      'per-locale frontend chunks served from dist/assets (66 of them, browser-lazy)',
      'per-route frontend chunks served from dist/assets',
      'status-page / badge / RSS surfaces',
      'authentication error paths',
    ],
    services: [],
  },
  {
    name: 'json-server',
    tree: 'frozen',
    kind: 'real',
    entryRel: 'lib/bin.js',
    criterion: 'smaller/control application — 3.2 MB universe, no plausible long tail',
    mechanisms: ['none expected; included as the negative control'],
    services: [],
  },
  {
    name: 'nextjs-longtail',
    tree: 'fixture',
    kind: 'fixture',
    entryRel: 'node_modules/next/dist/bin/next',
    criterion: 'controlled interpretability fixture; self-hosted Next.js is the stated ICP shape',
    mechanisms: [
      'module-shaped: per-route lazy chunk + external package subtree (exceljs, marked, papaparse, temporal, serialize-error)',
      'data-shaped: per-locale catalogue and content directory read from disk',
      'config-shaped: per-tenant config file + per-tenant renderer chunk',
    ],
    services: [],
  },
];

export const appByName = (name: string): LongtailApp => {
  const a = APPS.find((x) => x.name === name);
  if (!a) throw new Error(`app '${name}' is not in the preregistered selection`);
  return a;
};

export function appRoot(name: string): string {
  const a = appByName(name);
  if (a.tree === 'fixture') return FIXTURE_ROOT;
  return a.tree === 'frozen' ? cloneDir(name) : path.join(LINUX_ROOT, name);
}

/** The pinned SHA of the tree actually measured. Never re-fetched. */
export function appSha(name: string): string {
  const a = appByName(name);
  if (a.tree === 'frozen') return execFileSync('git', ['-C', cloneDir(name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return readFileSync(path.join(appRoot(name), '.reducer-sha'), 'utf8').trim();
}

/**
 * The production package population of the measured tree.
 *
 * Corpus apps reuse experiment 3's rule verbatim (the frozen darwin population,
 * widened by the platform-variant optionalDependencies a linux install
 * resolves). The fixture has no frozen population — it is installed with
 * `npm prune --omit=dev`, so the installed tree IS the production population,
 * and `null` puts the universe walk into that fallback mode.
 */
export function frozenPopulation(name: string): { name: string; version: string }[] | null {
  const a = appByName(name);
  if (a.tree === 'fixture') return null;
  return productionPackages(name, appRoot(name));
}
