# Universe-relative kill criterion for the hazard-domain analyzer

Status: accepted. Supersedes [ADR-0003](./0003-non-transforming-analyzer-first.md)
(fully restated here — this document is self-contained; 0003 is historical).
Amended after ADR-0005 made the production universe the artifact model and
after an external design review of the 0003 criterion.

## The decision

The next build is a hazard-domain analyzer that transforms *nothing*: it
computes capabilities, resolved-target and property domains, and
module-vs-export reachability, and reports the strict predicted ceiling,
counterfactual headroom, and per-symbol blocking-sets. We measure before
transforming because calibration returned 0% on real apps and the open
question is whether *sound* capability scoping can lift that; the analyzer
answers it without the cost and risk of building a transform.

## The metric

**Primary size metric (the kill metric)** — net universe-relative reduction,
per application:

```
D = raw bytes of executable third-party .js/.cjs/.mjs files in the
    production universe (ADR-0005). Third-party is defined by semantic
    package ownership (lockfile-declared packages, hoisting- and
    symlink-safe), not by a node_modules path test.
E = raw bytes of the corresponding executable third-party JS emitted
    into the reduced artifact.

net size reduction = (D − E) / D
```

This may go **negative**: a fail-closed stub larger than the body it replaced
counts against the metric. NFT is not the baseline of this metric in any form
— ADR-0005 removed NFT as the artifact universe, and the kill metric must not
reintroduce it.

**Secondary security/precision metric**: original implementation bytes
physically eliminated from the artifact (the attack-surface / VEX quantity).
It is reported alongside, never substituted for the size metric.

**Context metrics** (reported, not decision inputs): total artifact bytes,
Δ vs the NFT-traced artifact, Δ vs the strongest passing bundler.

**Decision statistic**: the **median over target-category apps** of the
pre-registered corpus (v1: 19 apps pinned to exact SHAs) (`benchmarks/corpus.json`). Target apps also
report P25/P75 and the fraction of apps ≥10% and ≥15%; negative controls are
reported separately (they were selected to be hostile — including them in the
primary statistic would make the experimental design fight itself); the full
corpus is reported descriptively. There is no "not concentrated" pass
condition: category-level distributions are how a viable segment is
distinguished from cherry-picking, and a strong identifiable segment is a
product-boundary finding, not a failure.

**Threshold**: **~10–15% median net universe-relative reduction on target
apps**. This is a *newly chosen, provisional commercial threshold* — it is
not inherited from the old NFT-relative 10–15%, which measured against a
different (and unsound) baseline and does not transfer mathematically.

## Counterfactuals: two roles, strictly separated

**Gate-off counterfactuals** (single-relaxation, top pairwise, and per-symbol
blocking-sets) are *diagnostics*: each is an upper bound on what any
refinement of that gate could recover, **conditional on the other gates
remaining conservative**. Because blockers interact, a single-gate zero does
not prove futility (VM-off = 0 and escape-off = 0 can coexist with
both-off = 20%) — hence pairwise deltas and blocking-sets are part of the
required output. Gate-off numbers may *disfavor or kill* an investment; they
may never rescue the thesis.

**Sound refinement counterfactuals** are the only rescue path: a *named*
refinement with stated proof obligations — e.g. VM contexts with statically
known globals; finite target-domain propagation through known non-escaping
wrappers; closed export surface plus known property projection. "Assume
dynamic require is harmless" or "ignore escaped module values" are relaxed
approximations, not refinements, and never qualify. A rescue additionally
requires the refinement be **single, localized, soundly-definable, and
plausibly implementable** — a localized proof demanding a near-whole-program
points-to analysis (or an absurdly expensive solver) does not qualify.
Rescue numbers are themselves upper bounds until the refinement is
implemented and tested.

## The kill decision

- Median net universe-relative reduction on target apps **≥ ~10–15%** →
  proceed to the transform.
- Below threshold **and** no sound refinement counterfactual clears it →
  drop the whole-app size thesis.
- Below threshold **but** a qualifying sound refinement restores meaningful
  headroom → **implement and test that refinement**, not stop. A
  deliberately pessimistic default (VM modeled as maximally loader-capable,
  etc.) must never silently kill the thesis; that is exactly why each
  approximation's blocked reduction is measured separately.

Only a low strict ceiling with no sound-refinement headroom retires the size
thesis.

## The vulnerability-removal wedge

The wedge is **evaluated independently** — it is not presumed to survive a
size-thesis kill, because real vulnerable APIs may be blocked by exactly the
same reachability uncertainty (the calibration VEX experiment succeeded only
on a hazard-free tree). This analyzer run measures the wedge's *technical*
feasibility cheaply: for each entry of the pre-registered CVE set
(`benchmarks/cve-set.json`), per **app × advisory instance**, report presence
in the corpus, strict removability, the blocking-set, removability under a
named sound refinement, and physical-removal/VEX candidacy. The *commercial*
wedge go/no-go (enough real CVEs, VEX defensibility, scanner consumption,
customer remediation value) is a separate later decision on its own evidence.
