# First-run provenance — initial working-set measurement (ADR-0007 experiment 1)

This directory is the **preserved first corpus-wide working-set result**. It is a
new artifact and overwrites nothing: the conservative-linker evidence in
`benchmarks/hazard-domain/first-run/` and `benchmarks/results/` is untouched and
remains the record of that (completed, retired) experiment.

## What was measured

For every frozen corpus-v1 application, the complete production universe was
partitioned into HOT (initially resident) and candidate-COLD (not selected for
initial local placement) under two plans:

```text
Plan A  NFT-positive + entrypoint + resolver metadata (package.json) -> HOT
        everything else -> candidate COLD
        NO hazard widening: dynamic require, createRequire, escaped loaders,
        vm, generated source and unbounded load sinks do NOT expand the hot set

Plan B  Plan A + every package in opaquePackages(universe, ...).own forced HOT
        (.own, never the ancestor-propagated .all — that propagation is
         conservative export-surface semantics, not a virtualization constraint)
```

`COLD` means **only** "not selected for initial local placement". It does not
mean dead, unused, unreachable, or removable, and this run demonstrates nothing
about runtime recoverability, miss latency, startup time, or correctness.

## Pipeline

Per app, once: `buildUniverse` (realpath-deduped walk, frozen production
population from `benchmarks/cve-population/corpus-packages.json`) → `trace`
(@vercel/nft positive evidence) → `opaquePackages().own` → `planWorkingSet` ×2 →
`measurePlan` ×2. No parse, no fixpoint, no transformation, no runtime.

Every app's clone was verified `git rev-parse HEAD === corpus.json resolvedSha`
before measurement; no ref was fetched or advanced.

## Positive-evidence semantics

The NFT set here keeps **every traced kind**, not just JS. The hazard-domain
analyzer keeps JS only because it reasons about module graphs; this is a
placement question, and an asset the trace proves is read must be resident too.
Traced files absent from the frozen production population are `pullIn`-ed as
positive evidence and counted, exactly as in the hazard-domain runner.

NFT also emits the **directory symlinks it backtracks through** (pnpm and
workspace `node_modules/<pkg>` links), and the tracer keeps them because
`statSync` on a directory succeeds. A directory is not a placeable file, so
non-regular-file traced entries are skipped and counted in `nft.tracedNonFiles`.
Without that guard `pullIn` fabricates a universe member per directory — inode
size, marked third-party, forced HOT — which inflates the universe and biases
the cold fraction downward. The magnitude is not marginal: 398 of verdaccio's
2251 traced entries are directories.

A failed trace is a **fail-safe all-HOT plan**, recorded with `traceOk: false`
and `planAValid: false`, and excluded from every statistic. It is an
infrastructure failure, never a measured 0%-cold result. The corpus roster for
the summary comes from the frozen `corpus.json`, never from the result
directory, so an app that never ran is reported as `no-result` instead of
silently shrinking the denominator.

## Chronology

The measurement code was adversarially reviewed (4 independent axes, 12
candidate findings, each verified refute-by-default) **before** this run was
recorded. Two defects were confirmed and fixed first — the NFT directory-entry
fabrication above, and the summarizer taking its corpus roster from the output
directory — so every number here comes from one consistent version of the code.
A third-party-JS denominator equal to `universe.D` is asserted per app, which is
why the directory defect did not surface there: directories are not `isJs`.

## Invariants enforced at measurement time

Not only in tests — every app's numbers are refused if any of these breaks:

- one placement per universe file, joined to the canonical record;
- no physical file counted twice (realpath dedup re-proven on the plan);
- HOT + COLD == total, per denominator;
- the third-party-JS denominator equals `universe.D` exactly (ADR-0006
  semantics preserved, so these results stay comparable with the prior corpus);
- attributed reason bytes sum to HOT bytes (each byte charged exactly once);
- Plan B's hot set is a superset of Plan A's;
- opaque-attributed bytes == the opaque evidence breakdown == the Plan A → Plan
  B loss (three independent routes to the same number).

## Byte-attribution rule

Each HOT byte is charged to exactly one reason — the first it carries in the
order `no-positive-evidence`, `nft-positive`, `entrypoint`, `resolver-metadata`,
`opaque-boundary`. A reason's total is therefore the bytes it forces hot that no
earlier reason already would. `opaque-boundary` is last deliberately, which is
what makes its total identical to the Plan A → Plan B loss. Overlapping
(non-deduplicated) per-reason coverage is reported alongside in
`planA.reasons.coverage` / `planB.reasons.coverage`.

## Opaque-evidence classification (diagnostic only)

`opaquePackages().own` marks a package on any of five different facts — a
`.node`, a `.wasm`, a `binding.gyp`, an install/postinstall script, or an
unscannable directory. The run classifies which one applied so the Plan B cost
can be attributed, **without refining the heuristic** (explicitly out of scope).
Artifact evidence outranks the install-script proxy, so `install-script` counts
only packages where the script is the sole signal.

Artifact evidence is derived from the already-walked universe rather than a
second recursive disk scan, crediting every opaque ancestor up to the first
`node_modules` boundary — which mirrors `opaquePackages`' own scan, including
packages whose artifact sits under a nested manifest (wasm-bindgen output dirs
ship their own `package.json`). One consequence is recorded rather than papered
over: an artifact reachable *only* through a symlink is not walked by the
universe, so its package can land in `unclassified`.

## Files

- `corpus/<app>.json` — per-app full result: universe metrics, trace status and
  warnings, Plan A and Plan B metrics for all three denominators, HOT-reason
  breakdown (attributed + coverage), complete per-package byte statistics, the
  opaque-evidence cost breakdown, failures, timings.
- `summary.json` — corpus aggregates: per-app distributions (min/P25/median/
  P75/max), byte-weighted totals, Plan A → Plan B loss, reason totals, package
  structure, granularity split, failures. Sufficient to recompute the summary
  without rerunning the corpus.
- `SUMMARY.md` — the human-readable summary.

## Reproduction

```bash
bun benchmarks/working-set/run-corpus.ts --all
bun benchmarks/working-set/summarize-corpus.ts
bun test tests/working-set-measure.test.ts tests/working-set-planner.test.ts
```

`--all` runs each app in its own process with a 30-minute wall-clock bound: a
hung or memory-hungry app cannot take the corpus with it, and a bound hit is
recorded as a deviation in that app's result file rather than as a measured
value.
