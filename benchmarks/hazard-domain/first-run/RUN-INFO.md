# First-run provenance (hazard-domain experiment, ADR-0006)

This directory is the **preserved first corpus-wide result**, committed before
any post-result precision work (the experimental-chronology rule). Do not
re-run and overwrite it to improve numbers; a later measurement is a separate,
separately-reported artifact.

## Analyzer identity

- `analyzerVersion`: 0.0.1
- `analyzerSourceHash` (sha256 over packages/hazard-domain/src/*.ts):
  `67c0575974566cab832bd1a7808c83b216a5563c5d0fcbb42c3a899246bfef84`
- The identical hash appears in `garden-conformance.json` and in every
  `corpus/<app>.json` `strict.analyzerSourceHash`, proving one analyzer
  produced both the soundness gate and the corpus measurement.
- Committed at (analyzer): the `fix:` soundness commit that precedes this
  directory's commit on `feat/hazard-domain-analysis`.
- Analysis process runtime: bun 1.3.1 (Node-compatible); the analyzer resolves
  with `createRequire`/`realpathSync.native`. Reported host node: v25.5.0
  (Homebrew); repo pins `nodejs 24.19.0` for corpus install/build.

## Coverage: 16 of 19 frozen corpus-v1 apps

Each measured app was verified `git rev-parse HEAD === corpus.json resolvedSha`
before analysis (no ref advanced), with third-party membership taken from the
frozen `benchmarks/cve-population/corpus-packages.json` production population.

**Measured (16):** all 11 non-excluded target apps
(bulletproof-nodejs, excalidraw-room, express-realworld,
express-rest-boilerplate, fastify-demo, hackathon-starter, json-server,
juice-shop, nestjs-realworld, nestjs-typescript-starter,
node-express-boilerplate) and 5 of 7 controls (ghost, nodebb, parse-server,
uptime-kuma, verdaccio).

**Not measured (3) — recorded analysis-timeout deviation, NOT a result:**
outline (target), strapi (control), n8n (control). These are the three largest
production universes (1595 / 1624 / 2040 frozen packages). The per-app
counterfactual sweep (strict + one config per suppressible gate + top-5
pairwise + 4 sound refinements ≈ 30 full re-analyses over the whole universe)
is superlinear in universe size; on n8n it exceeded 12h of wall clock without
completing and was bounded. This is a **tooling performance limit of the
counterfactual harness, not a property of the analyzer or a measured value** —
the single strict analysis is cheap (see `summary.json.analysisTimes`); the
blow-up is the ~30× re-analysis. The three were left unmeasured rather than
reported with a partial/altered config, to keep every reported app's treatment
identical.

**Effect on the ADR-0006 decision: none.** The decision statistic is the median
strict net reduction over target apps; 11 of 12 targets are measured and
unanimously 0.0% (P25 = P75 = 0, fraction ≥10% = 0). One missing target cannot
move a median of eleven zeros. The two missing apps are hostile controls,
reported separately and never part of the primary statistic; both are
architectures (workflow-engine dynamic node loading; plugin-by-name framework)
for which a wide/zero result is the expected honest measurement.

## Files

- `corpus/<app>.json` — per-app full strict report (D, E_predicted,
  netReduction, per-file blocking sets, distributions, vm evidence, widened-case
  log, stats) + gate-off (single), pairwise gate-off, and 4 sound-refinement
  config summaries.
- `summary.json` / `summary.md` — target/control/full distributions
  (median, P25, P75, fraction ≥10/15%), single + pairwise gate-off headroom
  (labeled unsound diagnostics), dominant blocking sets by retained bytes,
  capability/domain/result-flow/export-surface distributions, analysis times,
  widened-case counts.
- `cve-feasibility.json` / `cve-feasibility.md` — the 24-row (app × pkg@ver ×
  advisory) frozen CVE feasibility table + 23-row aggregate + 314-population
  descriptive stats.
- `DECISION.md` — the ADR-0006 pursue / implement-refinement / retire call.
