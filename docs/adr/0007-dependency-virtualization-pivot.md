# Pivot: from proving unreachability to predicting the working set

Status: accepted (2026-08-23). Does not supersede ADR-0001–0006 — those govern
the completed conservative-linker experiment, which remains a valid, preserved
research branch. This ADR establishes the correctness model for the
repository's next research direction and the package boundaries between the
two.

## Two distinct research questions

**Conservative linker (completed):**

> Can we prove dependency implementation permanently unnecessary?

Answered for the whole-application unit: **no**. Whole-application
conservative reachability saturates in realistic Node applications because a
small number of unbounded loading capabilities (dynamic `require`,
`createRequire`, escaped loaders, `vm`, generated source) widen to the full
production universe under sound `unknown → KEEP` semantics. The hazard-domain
first run (ADR-0006, `benchmarks/hazard-domain/first-run/DECISION.md`)
measured a strict target-median of exactly 0.0% with no sound-refinement and
no gate-off headroom. This falsifies the *global sound-size-reduction* thesis.

Two precision notes that summaries of this repository must preserve:

- The existing 0/24 CVE-removability result was produced under that same
  whole-app widening model, so it does **not** resolve whether symbol-scoped
  *sound islands* exist. Per-vulnerability symbol elimination remains
  **unresolved** — a dormant research branch pinned as FE-1 in
  [`docs/future-experiments.md`](../future-experiments.md). Cleanup must not
  reclassify it as falsified.
- "Reducer proved no vulnerable functions can be removed" is wrong as a
  summary; the correct statement is the paragraph above.

**Dependency virtualization (this pivot):**

> Can we predict a substantially smaller local working set if prediction
> errors are recoverable?

Ship only the dependency files predicted to be needed locally, keep every
omitted file byte-for-byte recoverable, and let a wrong prediction cost a
runtime hydration miss (latency), never application behavior.

## The correctness inversion

The conservative linker put correctness inside the analyzer: removal required
proof, so uncertainty had to widen retention (ADR-0001). The new direction
moves correctness out of prediction entirely:

1. **A working-set prediction MUST NOT determine whether application behavior
   is possible.** Every file in the production universe is either locally
   materialized (HOT) or recoverable byte-for-byte from immutable storage
   (COLD). A prediction error may add latency; it must never by itself cause
   semantic divergence.
2. **Hydrated content must be byte-identical to the original
   production-universe file and cryptographically bound to the
   release/artifact manifest.**

Consequences, stated so they cannot drift:

- The **complete production universe remains authoritative** (ADR-0005
  stands). Prediction affects *placement*, not membership or semantic
  availability.
- **NFT remains positive evidence only.** Absence from the NFT trace is no
  longer interpreted as anything at all about removability — under this model
  it merely lowers a file's placement confidence.
- **Correctness ultimately comes from recoverability, not analyzer
  soundness.** The analyzer's job degrades gracefully from "prove" to
  "predict well".
- **Hazards become planning signals, not global blockers.** A dynamic require
  might keep a package hot, widen a predicted cluster, or lower confidence —
  it no longer forces retention of the entire universe, because retention is
  no longer the safety mechanism.
- **Granularity is whole-file.** `node_modules/foo/b.js` is HOT or COLD as a
  file; when needed, the exact original file is materialized and stock Node
  semantics proceed. Function-level AST rewriting (ADR-0004's stubbing) is
  preserved as historical work and is not assumed to be on the new critical
  path.

```
wrong prediction != wrong program
wrong prediction == recoverable runtime miss + performance cost
```

## Component classification

**Shared infrastructure (both experiments):**

- `packages/tracer` — NFT positive-evidence tracing.
- `packages/production-universe` — production-universe discovery (extracted
  from the hazard-domain analyzer: realpath-deduped walk, semantic package
  ownership, frozen-population mode, `pullIn` positive-evidence widening).
- `packages/hazard-domain` (analysis primitives) — module facts, load-sink
  classification, exact/finite/unbounded target domains, capability flow,
  loader/`createRequire` tracking, escape and export-surface analysis. These
  primitives now feed *both* consumers: the retired conservative global
  policy, and future planners/island probes.
- Corpus harness and frozen inputs — `benchmarks/corpus.json`,
  `benchmarks/cve-population/`, `benchmarks/hazard-domain/corpus-apps.ts`,
  the Torture Garden (`benchmarks/garden/`), and `fixtures/` (the adversarial
  fixtures are Node-semantics regressions, valuable independent of the
  experiment that motivated them).
- `packages/manifest` doubles as a small shared kernel (`Reason` vocabulary,
  `sha256`, version) plus the frozen conservative manifest schema; splitting
  it is deferred until a virtualization manifest schema actually exists.

**Legacy / conservative-experiment-specific (preserved behind
`conservative-*` names, frozen but runnable):**

- `packages/conservative-analyzer` — the eight-gate proof-of-unreachability
  analyzer.
- `packages/conservative-transformer` — function-body stubbing
  (`ReducerReachabilityViolation`).
- `packages/conservative-runtime-guard` — never built (README only).
- `packages/cli` `analyze`/`build` — the conservative pipeline and its
  emit-grade universe walk.
- `benchmarks/{compare,real,vex,summarize}.ts`, `benchmarks/results/` — the
  experiment's evidence.

**Candidates for reuse:** hazard classification as planner input (forced-hot
signals, cluster widening, confidence); the hazard-domain report machinery for
measuring plans over the frozen corpus; `module.registerHooks` (sketched in
the runtime-guard README) as the eventual hydration interception point; the
manifest's per-file provenance pattern for the hot/cold plan.

**Candidates for retirement (kept only as evidence):** the eight gates as
*mandatory global removal conditions*; function-level stubbing on the product
path; `ReducerReachabilityViolation` as the correctness mechanism; the
NFT-vs-reducer incremental metrics.

Nothing lands in `experiments/`-style quarantine directories: the
`conservative-*` package prefix plus this ADR is the boundary, and moving the
benchmark evidence would break the frozen-run provenance recorded in
`benchmarks/hazard-domain/first-run/`.

## Experiment 1 (what this pivot must make cheap)

Per corpus application, with no recovery runtime built: compute production
universe bytes, NFT-positive bytes, forced-hot bytes, candidate-cold bytes
under the naive planner in `packages/working-set-planner`
(NFT-positive/entry/resolver-metadata/opaque-boundary → HOT; everything else →
candidate COLD). This is *not* a claim that candidate-cold files are
unreachable; it answers: if omitted files were perfectly recoverable, what is
the theoretical initial working-set reduction? Follow-up: instrument
representative workloads to derive hydration curves (hot-set % at startup /
common requests / full workload). Those numbers decide whether a recovery
runtime is worth building. Deliberately out of scope until then: cold stores,
hydration runtimes, CAS protocols, loaders, telemetry backends.
