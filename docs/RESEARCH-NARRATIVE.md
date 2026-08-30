# Reducer — the research narrative in one page

Written 2026-08-29 as a synthesis of the committed record (ADR-0001–0008,
`benchmarks/*/DESIGN.md`, `*/FINDINGS.md`, `*/SUMMARY.md`,
`benchmarks/hazard-domain/first-run/DECISION.md`). Every number here is copied
from a preserved run; the primary documents remain authoritative. Labels:
**measured** = a preserved result; **interpretation** = the experiment's own
stated reading; **retrospective** = added later (see `docs/adr/0008`).

Reducer asked two different research questions in sequence, using one shared
infrastructure (NFT tracing, production-universe discovery, capability
analysis, a frozen 19-application corpus, and the Torture Garden oracle).
Both questions are now answered. Neither answer is "active".

## Arc A — sound conservative removal (ADR-0001–0006, 2026-08-22 → 23)

**The question.** Can Reducer remove third-party dependency code from a
production Node.js application while obeying an absolute soundness invariant?

```text
Proven reachable   → KEEP
Possibly reachable → KEEP
Unknown            → KEEP
Proven unreachable → MAY REMOVE      (ADR-0001)
```

1. **Calibration (measured, `benchmarks/CALIBRATION-FINDINGS.md`).** On five
   real applications, the incremental reduction *beyond an `@vercel/nft`
   trace* that could be proven sound was **0.0 % median**; zero functions were
   stubbed on any app. Every surviving symbol was retained by a *global*
   hazard — one `eval`, `new Function`, or non-literal `require` anywhere
   widened the whole tree to unknown.
2. **Syntax was the wrong model (ADR-0002).** Treating dangerous *syntax* as
   the hazard is both unsound (on Node 24, `new Function` can reconstruct
   `require` via `process.getBuiltinModule`) and too coarse. Reducer moved to
   a **capability-based hazard model**: which module-loading capabilities can
   flow to which reachable code, with what specifier-target and property
   domains.
3. **Measure before transforming (ADR-0003, superseded by ADR-0006).** Build a
   non-transforming hazard-domain analyzer and a kill criterion before
   investing in a transform.
4. **The Torture Garden exposed the artifact model (measured,
   `benchmarks/garden/results/FINDINGS.md`).** The emitted tree used to be
   exactly the NFT trace. The oracle app proved that unsound at file level:
   13 contract divergences and a WASM crash from `createRequire` targets,
   computed requires, `vm`-loaded modules, and emscripten's computed-path
   `sql-wasm.wasm` — all invisible to a static tracer.
5. **ADR-0005** changed the artifact to *the complete production universe
   minus explicit proofs of unreachability*. `nftTrace.has(f) === false`
   never implies `proven-unreachable`.
6. **ADR-0006** fixed the kill metric as **net universe-relative reduction** —
   `(D − E) / D` over executable third-party JavaScript bytes, median over
   target-category corpus apps — with a go threshold of roughly **10–15 %**,
   and separated the *sound-refinement counterfactual* (the only thing that
   can rescue) from the *gate-off counterfactual* (diagnostic, can only kill).
7. **Hazard-domain first run (measured, `DECISION.md`, 2026-08-23).** Across
   16 of 19 frozen corpus apps (11 targets), strict net universe-relative
   reduction was **exactly 0.0 % on every app** (D = E to the byte). All four
   named sound refinements: 0.0 %. Every single-gate and pairwise gate-off:
   0.0 %. Retained modules were jointly blocked by 13–15-gate unions; the
   saturation is structural.
8. **Decision: the whole-application sound size-reduction thesis is
   RETIRED.** A 0 % result was a valid preregistered outcome.
9. **Important non-conclusion (stated in the same decision).** The frozen
   24-row app × CVE table read 0/24 removable, but it was computed under the
   same whole-app widening. It does **not** show that a *particular*
   vulnerable function can never be proven unreachable.
10. **FE-1, the sound-island hypothesis, remains unresolved / dormant**
    (`docs/future-experiments.md`): a vulnerable symbol may sit in a local
    sub-closure free of reach-any capabilities even in a saturated app.
    Named as the highest-information next action for the security wedge;
    never run. Why the project branched elsewhere instead is explained in
    `docs/adr/0008-why-virtualization-before-sound-islands.md`
    (retrospective).

## Arc B — recoverable working sets / dependency virtualization (ADR-0007, 2026-08-23 → 24)

**The new invariant.** Instead of putting correctness inside the analyzer,
keep the complete immutable artifact **recoverable** and treat semantic
prediction as *placement / prefetch advice*:

```text
wrong prediction != wrong program
wrong prediction == recoverable runtime miss + performance cost
```

Every production-universe file is HOT (locally resident) or COLD (recoverable
byte-for-byte from immutable storage); prediction chooses placement, never
availability. Informally this direction was sometimes called "semantic virtual
memory" in conversation; that phrase is not repository terminology. The
product framing behind experiments 3–5 (the candidate ICP, the practitioner
interview, why time-to-steady-state became the metric) is in
`docs/PROBLEM-CONTEXT.md`.

| # | name | path | verdict |
| --- | --- | --- | --- |
| 1 | static working-set sparsity | `benchmarks/working-set/first-run/` | large candidate-COLD sets exist |
| 2 | runtime hydration / coldness | `benchmarks/hydration/run-1/` | predicted-cold bytes stay cold |
| 3 | commodity lazy OCI (Nydus) | `benchmarks/lazy-oci/run-1/` | recoverability wins; semantic performance weak; clustering refuted |
| 4 | long-tail traffic-warm, equal file-byte budgets | `benchmarks/longtail/run-1/` | coverage real; wedge not supported; bytes ≠ time |
| 5 | cost-aware prewarming, equal measured prewarm time | `benchmarks/costaware/run-1/` | **STOP** — null survives; performance wedge closed |

**Experiment 1 — static sparsity (measured, 19/19 apps).** Under the naive
planner, candidate-COLD bytes were **81.3 %** of the universe (Plan A, no
hazard or opaque-boundary forcing) and **72.7 %** (Plan B, opaque native /
WASM / install-script packages forced HOT), median per app. Plan B's
constraints cost 950.8 MB of Plan A's opportunity, 26.6 % of it first-party
code caught by a native-dependency heuristic.

**Experiment 2 — runtime hydration (measured, 16/19 apps, observe-only).**
**99.3 %** of Plan B candidate-COLD bytes (byte-weighted) were never read under
the strongest available workload — 23.4 MB hydrated of 3.37 GB, 3,706 misses
over 304,381 accesses. 94.1 % of hydration happened before the app was ready;
misses clustered in time (99.1 % within 50 ms) and package (89.5 %).
*Interpretation:* the sparsity premise holds; semantic prefetching is plausible.

**Experiment 3 — commodity lazy OCI (measured, 6 apps on Nydus).** Two
hypotheses. *Recoverability:* a closed `@vercel/nft` artifact (73–87 % of the
universe absent — the thing a slimming product ships) **failed to start on 4
of 6 applications**, each by a different Node mechanism (untraced relative
require, computed ORM dialect require, conditional-export subpath, CLI data
file); the complete lazy image making the *identical* placement decision ran
all six. **Established.** *Semantic advantage:* readiness advantage median ≈ 0
over six apps; on the 915 MB strapi, eager pull → ready 20.2 s, generic trace
prefetch 6.8 s, Reducer semantic prefetch 5.3 s — lazy delivery is worth
10–15 s and is commodity, the semantic layer 1–2 s. The "many small files /
same-package clustering" hypothesis was **refuted**: trace-ordered layout
merged better. Verdict: continue as enabling technology.

**Experiment 4 — long-tail, equal file-byte budgets (measured, 5 real apps +
a Next.js fixture).** Static Node semantics with no training run (arm R1) does
cover a held-out module-shaped long tail that a filesystem trace cannot: on
juice-shop at a 10 % budget, 1 post-admission remote fault vs 21–24, first hit
120 ms vs 1,041–1,131 ms. But (a) **most Node servers have no long tail** —
three of five real apps held out ≤ 10 files, and the default Next.js App
Router preloads every route (968 files resident vs 377 with
`preloadEntriesOnStart: false`); and (b) on strapi at an identical 45.8 MB
file-byte budget the semantic arm prefetched 66,628 small scattered files vs
6,579, took 78 % longer to prewarm, and lost the primary metric
`T_steady − T0` by 9.5 s to the *weakest* generic arm. *Interpretation:* an
equal byte budget is not an equal time budget — the substrate charges for
scatter, not bytes.

**Experiment 5 — cost-aware prewarming, equal measured prewarm time
(measured, strapi / juice-shop / uptime-kuma).** The confound was corrected: a
calibrated physical retrieval-cost model (R² 0.998, 11 % MAPE), contiguous
retrieval units, minimal chunk-cover manifests, budgets in measured seconds —
identical machinery for both prediction sources. The correction was worth
**5.4 s** of strapi's time-to-steady-state for the generic ranking and 4.8 s
for the semantic one, and removed juice-shop's one-second first-hit cliff for
both. Then: under equal cost the two rankings **converge on the same physical
content** (resident-set overlap 0.51–0.57 at the tightest budget rung, 1.00
within three rungs); the generic cost-aware arm G1C leads on 11 of 15 cells;
the one semantic win (strapi p99 130 ms vs 228 ms) does not reproduce on
juice-shop and vanishes on a 5 ms / 1000 Mbit link. The **physical oracle**:
prefetching exactly the 5,118 files the test workload touches costs 1,697
backend requests / predicted 18.1 s; buying 21× more content chosen only for
contiguity costs 132 requests / measured 1.9 s. *Interpretation:* on a
request-bound, chunk-deduplicated, one-dimensional blob, **precision is a
liability**; a perfect predictor loses, so accuracy is not the binding
constraint.

## Final state (as of the ADR-0007 closing decision, 2026-08-24)

- **Closed:** whole-application sound dependency reduction as a size product
  (Arc A, measured 0.0 %). Semantic working-set prediction as the
  differentiating mechanism for faster traffic readiness (Arc B, null
  survived). Per the preregistered decision rule, no further planner variant
  is proposed and performance experimentation has stopped. Dependency
  virtualization is **not active research**.
- **Retained as a correctness principle:** complete, immutable, recoverable
  artifacts. A closed statically-traced artifact is startup-fatal on a
  majority of the corpus; a complete lazy artifact is not (experiment 3).
- **Retained as an enabling technique, not a wedge:** retrieval-cost-aware,
  unit-granularity prewarming with a minimal-descriptor manifest. Needs a
  chunk map and arithmetic — no Node analysis, no dependency graph, no
  training run — and is portable to any lazy-OCI substrate.
- **Retained as infrastructure:** the conservative soundness machinery,
  capability / hazard analysis, the frozen corpus, and the Torture Garden.
- **Unresolved / dormant:** FE-1, sound islands for per-vulnerability
  elimination. Not refuted; not started. Reopening conditions are in
  `docs/adr/0008`.

The repository holds research conclusions. It does not hold an approved next
product build.
