# Why dependency virtualization was explored before the sound-island probe (FE-1)

Status: **retrospective note**, written 2026-08-29 about decisions taken on
2026-08-23. It records rationale that was discussed outside the repository at
the time and was not committed contemporaneously. It does not change any
measured result, does not supersede any earlier ADR, and does not alter the
status of FE-1 (`docs/future-experiments.md`), which remains **open /
unresolved**.

## The apparent contradiction this note resolves

Two committed documents, read in sequence, look inconsistent:

1. `benchmarks/hazard-domain/first-run/DECISION.md` (2026-08-23) retires the
   whole-application size-reduction thesis and names one next step: *"Measure
   the 'sound-island' hypothesis for the wedge, not another whole-app
   refinement"* — "the single next engineering action with the highest
   information value." That experiment was pinned as FE-1 in
   `docs/future-experiments.md` the same day.
2. `docs/adr/0007-dependency-virtualization-pivot.md` (also 2026-08-23) opens
   a different research direction — dependency virtualization / recoverable
   working sets — and the next five experiments in the repository
   (`benchmarks/working-set/`, `hydration/`, `lazy-oci/`, `longtail/`,
   `costaware/`) all belong to that direction. FE-1 was never run.

Nothing in the repository explained why the recommended action was pinned and
a different one taken. This note does.

## What was, and was not, killed on 2026-08-23

**Killed (measured, ADR-0006 kill criterion):** the *whole-application*
sound size-reduction thesis. Strict net universe-relative reduction — the
fraction of executable third-party JavaScript bytes in the complete production
universe that the analyzer could prove removable — measured a median of
**exactly 0.0 %** on all 11 measured target applications (and 0.0 % on the
5 measured controls), against a preregistered go threshold of roughly
10–15 % median. No sound-refinement counterfactual and no gate-off
counterfactual moved the number, because every retained module was jointly
blocked by 13–15-gate unions of reach-any and open-export-surface hazards.
The saturation is structural, not a precision gap. This is the measured
result and it stands.

**Not killed (explicitly, in the same document):** per-vulnerability
elimination. The frozen 24-row application × CVE feasibility table reported
0/24 strictly removable, but that table was computed under the *same
whole-app widening*. `DECISION.md` §"What this does and does not conclude"
says the run "does not conclude anything about a *different unit of
analysis*." ADR-0007 repeats this as a precision note that summaries must
preserve: *"Per-vulnerability symbol elimination remains unresolved … Cleanup
must not reclassify it as falsified."*

**The sound-island hypothesis (FE-1), stated once more so this note is
self-contained:** whole-app 0.0 % is a property of a *byte-sum* metric — one
reach-any capability anywhere in the reachable closure widens the entire
production universe, so the total collapses. Reachability of one *specific*
vulnerable symbol is a narrower question. Roughly 294,000 of the ~300,000 load
sinks the analyzer saw across 16 applications were already exact-tier; only
about 6,590 unbounded sinks force the widening, and their conservative
"targets = the whole universe" default is not a proof that any given one can
actually reach any given package. A vulnerable symbol may therefore sit in a
local reachable sub-closure that crosses no reach-any boundary — a *sound
island* — even inside an application whose whole-app number is 0.0 %. Candidate
targets discussed at the time, from the frozen CVE set, included symbols of the
shape `tar.Unpack`, `form-data._generateBoundary`, and `underscore.template`
(named here as illustrative candidates, not as measured islands — none was
probed).

FE-1 was, and is, the highest-information next experiment **conditional on
continuing to pursue the vulnerability-removal / VEX wedge**. That conditional
is the key to the chronology.

## What actually happened: a branch into a different research question

After the whole-app product thesis died, the author chose not to continue the
security branch immediately, and instead opened a second question that the same
infrastructure could address:

> Can the conservative information Reducer already discovers — the production
> universe, NFT positive evidence, capability and hazard classification,
> package boundaries, resolver metadata — be useful for deciding *what must be
> present initially*, while keeping the complete artifact recoverable?

That question became the dependency-virtualization / working-set direction of
ADR-0007. The conceptual change was the important part:

```text
conservative reduction (ADR-0001–0006):
    prediction error  →  potentially incorrect program
    therefore: uncertainty must widen retention; only proofs may remove

dependency virtualization (ADR-0007):
    prediction error  →  fetch more of the complete immutable artifact
    therefore: uncertainty is an I/O and latency cost, never a correctness cost
```

Moving correctness out of the analyzer and into recoverability turned
uncertainty from a correctness problem into a performance problem. That made it
possible to ask whether Reducer's semantic knowledge had *any* operational
value — as placement or prefetch advice rather than as removal proof —
without weakening the original soundness standard of ADR-0001 in the slightest.
The conservative branch was preserved frozen, not relaxed.

So the accurate sequence is:

- Whole-app sound reduction: **retired** (measured, 2026-08-23).
- Per-vulnerability elimination: **unresolved** (stated explicitly, same day).
- FE-1: **pinned** as the next experiment *if the project returns to the
  VEX / security wedge*.
- Separately and in parallel, the author explored whether the same semantic
  knowledge could produce a useful initial working set under a
  recoverable-artifact model — ADR-0007 and experiments 1–5.

**ADR-0007 is a branch into a different research question. It is not evidence
against FE-1, and FE-1 is not evidence against it.** Neither direction's
result bears on the other; ADR-0007's closing decision says so in its own
words ("nothing here speaks to the dormant sound-island probe (FE-1)").

## Product-selection rationale — retrospective, not measured

The following is **retrospective product reasoning** supplied by the author. It
was not an experimental result of the hazard-domain run and should not be cited
as one.

A positive FE-1 result would establish that *some* vulnerable symbols can
*sometimes* be neutralized soundly. On its own it would not establish how
often islands occur across real applications, whether the affected CVEs are the
ones customers care about, or whether "we can remove this specific vulnerable
function, in this specific app, when the island condition happens to hold"
supports a commercially significant security product. Establishing frequency
and applicability would have required a further, larger measurement after
FE-1 itself.

Dependency virtualization offered a hypothesis with potentially wider
operational applicability if it held: Kubernetes scale-out, container image
loading, cold-node startup, and time to traffic readiness affect every
substantial self-hosted Node deployment, not only the ones that happen to
contain a removable CVE. The author judged that the broader question was worth
answering first, with the security wedge held in reserve. That judgement was a
bet on breadth of applicability, not a claim that FE-1 would fail.

In hindsight, experiments 3–5 answered the broader question negatively for the
*semantic prediction* part (the traffic-warm performance wedge is closed — see
ADR-0007 §Decision) and positively for the *recoverability* part (a complete
lazy artifact runs where a closed statically-traced artifact fails to boot on
four of six applications — `benchmarks/lazy-oci/run-1/FINDINGS.md` §11b.A).
None of that outcome was known when the branch was chosen, and none of it
changes FE-1's status.

## Conditions under which FE-1 should be reopened

Any one of the following would justify picking FE-1 up from its pin in
`docs/future-experiments.md`:

1. **Renewed interest in the vulnerability-removal product.** The whole-app
   wedge is dead; the per-vulnerability wedge is the only technical route left
   for a VEX `vulnerable_code_not_present` claim, and FE-1 is the experiment
   that decides whether that route exists.
2. **Evidence that customers value per-vulnerability elimination or VEX
   evidence enough to pay for it** — the commercial go/no-go that ADR-0006
   deliberately separated from the technical feasibility question.
3. **A need to establish the actual incidence rate of sound islands** — the
   quantity that a positive FE-1 would leave open and that decides whether
   the product is "occasionally" or "usually" applicable.

When reopened, the constraints already recorded in `docs/future-experiments.md`
apply unchanged: non-transforming, read-only, sound (uncertainty widens);
scoped to one symbol's neighbourhood using the existing capability-flow and
resolved-target machinery; frozen corpus, CVE set, and garden inputs immutable;
preserve-before-refine chronology.

## What this note does not do

- It does not backdate rationale into ADR-0006, ADR-0007, or `DECISION.md`;
  those documents are unchanged and remain authoritative for what was measured
  and decided on their dates.
- It does not claim FE-1 was disproven, technically impossible, or superseded.
- It does not propose running FE-1 now. FE-1 stays a pin, not a plan.

Related: `docs/RESEARCH-NARRATIVE.md` (the whole chronology in one page),
`docs/PROBLEM-CONTEXT.md` (the product framing behind experiments 3–5).
