# ADR-0006 decision — hazard-domain first run

**Decision: RETIRE the generalized whole-app size thesis.**

Analyzer `0.0.1`, source hash `67c0575974566cab832bd1a7808c83b216a5563c5d0fcbb42c3a899246bfef84`
(identical across garden conformance and every corpus report). Non-transforming;
no reduction semantics changed. Measured 16/19 frozen corpus-v1 apps at pinned
SHAs (11/12 targets, 5/7 controls); the 3 unmeasured are an analysis-timeout
tooling deviation on the largest universes, not a result (see `RUN-INFO.md`).

## The kill metric (ADR-0006 primary statistic)

Strict net universe-relative size reduction, median over target apps:

| segment | n | median | P25 | P75 | ≥10% | ≥15% |
|---|---|---|---|---|---|---|
| **target** | 11 | **0.0%** | 0.0% | 0.0% | 0/11 | 0/11 |
| control | 5 | 0.0% | 0.0% | 0.0% | 0/5 | 0/5 |
| full | 16 | 0.0% | 0.0% | 0.0% | 0/16 | 0/16 |

Every measured app is **exactly 0.0%** (D = E to the byte). Threshold was
~10–15% median on targets. **Not met, by the maximum possible margin.**

## Counterfactuals — neither role rescues it

- **Sound-refinement counterfactuals** (the only path that *can* rescue, ADR-0006):
  all four named refinements — SR-vm-known-globals, SR-subpath-exports-narrowing,
  SR-import-condition-resolution, SR-cross-module-wrapper — produce **0.0% median
  on every segment.** None clears the threshold; none clears anything.
  (SR-vm-known-globals was additionally *withdrawn as not-soundly-definable*
  during adversarial review — constant vm code performs the cross-realm
  constructor escape — so its number is a ceiling on an unbuildable refinement.)
- **Gate-off counterfactuals** (diagnostic upper bounds, cannot rescue): every
  single-gate and every top-pairwise suppression yields **0.0% (median = mean =
  max).** This is the decisive mechanistic finding: no single approximation, and
  no pair, is the bottleneck. The dominant blocking sets are 13–15-gate *unions*
  — every retained module is jointly blocked by a dozen reach-any and
  open-surface gates at once, so removing any one (or two) leaves the rest still
  widening the whole universe. Precision is not what stands between 0% and a
  viable ceiling; the saturation is structural.

## Why 0% is the sound answer, not an engineering gap

Across 16 apps the analyzer saw ~300k load sinks, **293,980 of them exact-tier
(bounded target)** — the specifier side is mostly analyzable. But every app also
contains reach-any-module capability (≈6,590 unbounded sinks; escaped loaders;
generated source; `createRequire`; vm) *and* 88,599 of 140,165 export surfaces
are **open** — 87,710 via `export-object-mutation`, the Babel/TS interop
`exports.default`/`__esModule` shape that is pervasive in compiled-TS corpus apps
(this exact shape was predicted in the calibration and defeated the garden
`validator` positive control). A single reach-any capability plus an open surface
is enough to make the whole production universe possibly-reachable at full
surface. Real production Node trees contain these by construction, so a sound
"proven-unreachable-only" model genuinely cannot specialize them. This matches
the pre-registered calibration prior (0% on 5/5) and the garden combined-tree
result (0/16 fab, 0/102 validator).

## The vulnerability-removal wedge — evaluated independently (ADR-0006)

Frozen 24-row app×CVE feasibility table (`cve-feasibility.md`), all 15 selected
CRITICAL advisories, all 8 affected apps measured:

- 24/24 present in the production universe and materialized; 21/24 affected
  symbols textually resolved.
- **0/24 strictly removable. 0/24 removable under any named sound refinement.
  0/24 physical-removal / VEX candidates.**

Every vulnerable package is retained whole by the same hazard saturation. The
security angle is **gated by the identical reach-any problem, not independent of
it** — precisely the risk ADR-0006 named when it refused to presume the wedge
survives a size-thesis kill. This is a **technical** feasibility result only; the
commercial wedge remains a separate decision, but the technical signal on the
whole-app unit is negative.

## What this does and does not conclude

- Concludes: whole-application, zero-transformation, sound size reduction on
  ordinary production Node apps has **no ceiling worth pursuing** (target median
  0%, no sound refinement headroom, no gate-off headroom). Per ADR-0006 this
  retires the generalized size thesis. A 0% result is a valid result; the
  experiment was not optimized toward continuation.
- Does not conclude anything about a *different unit of analysis*. The whole-app
  universe saturates because one hazard anywhere in the reachable closure widens
  everything; the calibration VEX success required a hazard-free tree.

## Single next engineering action with the highest information value

**Measure the "sound-island" hypothesis for the wedge, not another whole-app
refinement.** For each frozen CVE package, determine whether its vulnerable
symbol sits in a reachable sub-closure that crosses **no** reach-any boundary —
i.e. whether a hazard-free island exists around the vulnerable code even though
the app as a whole is saturated. Gate-off already proved no whole-app precision
refinement moves the number, so the only remaining thread with information value
is whether the unit should shrink from the application to the localized
vulnerable-package sub-closure. It is localized, soundly-definable, and directly
decides whether the vulnerability-removal wedge has any technical future.
**Per the experiment's terms, this action is named, not started here.**
