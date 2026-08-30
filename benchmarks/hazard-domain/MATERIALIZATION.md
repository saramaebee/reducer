# Corpus-v1 universe materialization record (hazard-domain experiment)

Date: 2026-08-22. Clone root: `~/.cache/reducer-corpus-v1` — the
frozen clones from `benchmarks/cve-population/materialization.json`, HEADs
verified against `corpus.json` `resolvedSha` (re-verified by `run-corpus.ts`
before each analysis; no refs advanced, no SHAs substituted).

The CVE-population freeze was a lockfile walk without installation. Running the
analyzer requires the production universes on disk, so each app was installed
**lockfile-exact against its frozen lockfile** (the same lockfiles the
population extraction walked) and built where `corpus.json` declares a build.
Installing adds `node_modules/` and build output only; source trees stay at the
pinned SHAs.

## Install commands (lockfile-exact, per frozen `packageManager`)

- npm apps: `npm ci` (dev deps included — builds need them; the frozen
  production package list, not the install, defines D's third-party membership).
- yarn-classic (node-express-boilerplate, express-rest-boilerplate,
  excalidraw-room): `yarn@1.22.22 install --frozen-lockfile` (corepack's
  default yarn resolved to berry, which refuses v1 lockfiles).
- yarn-berry (outline, strapi): `corepack yarn install --immutable`.
- pnpm (json-server, verdaccio, ghost, n8n): `pnpm install --frozen-lockfile`;
  n8n via `corepack pnpm` (packageManager pins pnpm@10.32.1; pnpm 11 fails).
- Node runtime for installs/builds: asdf `nodejs 24.19.0` (`.tool-versions`
  pin), after several repos' shims mis-resolved under other versions.
- Env guards (no JS content impact): `CI=1 HUSKY=0` plus skip flags for
  Puppeteer/Playwright/Cypress browser downloads.

## Per-app deviations and incidents (all recorded, none affect frozen inputs)

1. **nodebb** — no root `package.json` at the SHA (NodeBB convention). Applied
   NodeBB's own installer step: `cp install/package.json package.json`, and
   used the snapshot-generated `install/package-lock.json` (1365 packages;
   the root-level generated lockfile was an empty stub) copied to root for
   `npm ci`. This mirrors `./nodebb setup`.
2. **bulletproof-nodejs** — `argon2@0.x` native build fails on modern Node
   (napi-v3-era node-pre-gyp). Installed with `npm ci --ignore-scripts`;
   `npm run build` (tsc) then emitted `build/` successfully despite 99
   `@types`-conflict type errors (tsc emits on type errors; emit verified).
   Consequence: some native binaries are absent on disk, so native-boundary
   detection must not rely solely on built `.node` presence — the analyzer
   also widens on `binding.gyp` / install-script evidence.
3. **nestjs-realworld** — npm's known "Exit handler never called" teardown bug
   fired on every `npm ci` (install content verified complete; only
   `node_modules/.bin` links missing, which analysis does not use). The
   declared `npm run build` does not exist at the SHA; the repo **commits
   `dist/` at the pinned SHA**, and that committed build is used as the entry.
4. **juice-shop** — no committed lockfile at the SHA; installed with the
   lockfile generated at snapshot time (preserved in the frozen clone), per
   the population freeze's recorded uncertainty. `npm install` postinstall
   built `build/`.
5. **Entry-path corrections** (corpus.json declarations verified against
   disk; three are stale — deviations recorded in run output):
   - express-realworld: `dist/api/main.js` (declared `dist/main.js`; matches
     what the published calibration actually measured).
   - verdaccio: `packages/verdaccio/bin/verdaccio` (declared
     `build/lib/cli.js` does not exist at the SHA; bin is the production
     start).
   - strapi: declared entry is the directory `examples/getstarted`; resolved
     to `packages/core/strapi/bin/strapi.js`, the file its `strapi start`
     script executes (workspace-linked). Control app; decision recorded.
6. **express-realworld** — `prisma generate` ran via postinstall; generated
   client present under `node_modules/.prisma/client`.
7. **ghost** — frozen lockfile is pnpm (corpus.json's `yarn install` note is
   stale); installed with `pnpm install --frozen-lockfile` at the monorepo
   root.

Full logs: `<cloneRoot>/materialize-universe/*.log` (not committed; STATUS
file records exit codes and timestamps).

## Third-party membership

D's third-party set is **not** derived from the installs: it is the frozen
per-app `productionPackages` population in
`benchmarks/cve-population/corpus-packages.json` (6603 unique name@version).
The installs only materialize file bytes. On-disk packages absent from the
frozen list are outside the universe unless positive evidence (NFT trace or a
static edge from a universe module) pulls them in; each such divergence is
recorded in the app's report warnings.
