# Problem context for the dependency-virtualization experiments (3–5)

Written 2026-08-29 as a retrospective reconstruction. Experiments 3, 4 and 5
(`benchmarks/lazy-oci/`, `benchmarks/longtail/`, `benchmarks/costaware/`) were
designed against a product framing — a candidate customer, a practitioner
interview, and an external research brief — that lived in conversations
outside this repository. Their DESIGN and FINDINGS files refer to "the ICP",
"the operator", and "the goal" without expanding them. This document supplies
that context so the experiments can be read without access to those
conversations.

Every statement below is labelled as one of: **measured** (a preserved result
in this repository), **product hypothesis** (a belief the research was
designed to test or that framed it), **practitioner report** (what an
interviewee said), or **retrospective** (the author's later account). The
experimental documents remain authoritative for all measurements.

## 1. The candidate ICP (product hypothesis, never validated as a segment)

"ICP" throughout the corpus means *ideal customer profile*. The working
hypothesis was:

> Platform / infrastructure teams operating substantial self-hosted Node.js
> applications on Kubernetes, particularly where scale-out or cold-node
> startup can affect latency-sensitive production traffic.

This was a **working hypothesis, not a validated market segment.** No customer
was signed, no segment was sized, and — see §2 — market discovery weakened
rather than strengthened the claim that the underlying pain is universal.

How the hypothesis shaped the corpus (measured facts about the corpus):

- **Strapi** (915 MB installed footprint, 123,474 files, 2,019 packages;
  plugin- and configuration-driven) was the primary "ICP-shaped" application.
  It is the largest application every performance experiment could actually
  run, and the corpus documents call it "the ICP size class."
- **Juice Shop** (OWASP Juice Shop) was the strong secondary workload: it has a
  genuine module-shaped long tail (lazily imported subtrees), which is the
  case where semantic prediction had the best chance to matter.
- **Uptime Kuma** was the preregistered **adverse control**: a Node server that
  loads nearly its entire dependency graph at boot and therefore has almost
  no long tail to predict. Its role was to make sure the experiments did not
  report only favourable workloads.
- **Self-hosted Next.js** was the motivating real-world *shape* (the
  interviewee's deployment, §3). Experiment 4 used a controlled Next.js
  fixture (`benchmarks/longtail/fixture-app/`) for this, and measured a
  finding *against* the hypothesis: the Next.js App Router preloads every
  route module at startup by default (968 files resident before traffic, vs
  377 with `preloadEntriesOnStart: false`), so the ICP's own framework has
  essentially no module-shaped long tail in its default configuration
  (`benchmarks/longtail/run-1/FINDINGS.md` §2.1).

Do not read this document as saying every Node-on-Kubernetes operator has the
problem the experiments were built around. It says the opposite in §2.

## 2. Negative market evidence (practitioner reports, retrospective)

Informal discovery conversations with practitioners running Node services on
Kubernetes produced the following, which weakened the "image loading latency is
a large universal problem" premise:

- Teams commonly **pre-pull images** onto nodes or **pre-warm nodes** before
  they take traffic.
- A **DaemonSet that pulls the image and sleeps** is an ordinary, cheap
  mitigation for image-pull latency on new nodes.
- Some operators simply **keep spare capacity**; roughly **10 % excess
  capacity** was described as normal in one discussion.
- **Extreme scale events (x → 100x)** are unusual; most scale-out is gradual
  enough that pull latency is absorbed.
- Therefore **image-loading latency is not automatically a large problem** for
  a typical operator, and a product whose only value is faster image
  availability competes with mitigations that cost almost nothing.

This is why the experiments did not measure "image pull time" or "image size"
as the product metric, and why the bar for the semantic wedge was set at
*materially better than a strong generic baseline* rather than *better than
nothing* (§5).

## 3. "The operator" — the practitioner interview behind the traffic-warm metric

The experiment 4 and 5 documents refer to "the operator" and "the operator's
criterion." This is a single practitioner interview, conducted before
experiment 4 was designed, with an engineer who had operated **self-hosted,
multi-tenant Next.js on Kubernetes** and had worked on cache behaviour across
pods. The interviewee's identity is recorded outside the repository and is
deliberately not reproduced here; the substance of the interview is what the
experiments depend on.

Practitioner reports from that interview (paraphrased; each shaped a design
choice in experiments 3–5):

- **Same image + same configuration must behave identically on every pod.**
  Pod-to-pod behavioural drift is unacceptable. → Every lazy arm in
  experiments 3–5 uses a content-identical complete image; only *placement*
  varies.
- **Exact artifact rollback matters.** A release must be re-deployable
  byte-for-byte. → Hydrated content must be byte-identical and bound to the
  release manifest (ADR-0007 correctness rule 2).
- **Request-time fetching that makes behaviour depend on external mutable
  state is undesirable.** → The design forbids any arm from fetching from
  anything but the immutable image; a hydration miss reads the frozen
  artifact, never a live registry or a mutable cache.
- **Pre-warm fetching from a complete immutable artifact is acceptable.**
  This is what made lazy OCI with prefetch a legitimate substrate rather than
  a compromise.
- **Image size itself was not a major pain** for this operator; their runtime
  images were already reasonably small. → Bytes on disk stopped being the
  product metric (§4).
- **Image pulling and serial secret fetching were the relevant scale-out
  costs** in their experience — i.e. the time between a scale decision and a
  pod that is genuinely serving.
- **Rare routes, error paths, locale fallbacks, and tenant-specific branches**
  were named as the plausible places where semantic prediction might beat
  ordinary startup locality. → Experiment 4's six long-tail categories
  (module-shaped, data-shaped, config-shaped, per-locale, per-tenant,
  error-path) were built from this list.
- The interviewee's central statement was, in effect: **"Ready is a lie."**
  A pod that passes its Kubernetes readiness probe is not necessarily a pod
  that can serve production traffic at steady-state latency.

The metric the interviewee actually cared about:

> **HPA / scale-out decision → new capacity serving production traffic at
> steady-state tail latency, without causing a p99 regression at the edge
> during the transition.**

That interval is exactly what experiment 4 preregistered as the primary metric,
`T_steady − T0` (`benchmarks/longtail/DESIGN.md` §5, §8.3), and what experiment
5 inherited. It is why experiment 4 says *"a strategy that reports Ready earlier
by pushing work onto production requests has not won, and admitting traffic on
Ready would reward exactly that."* The terms are defined in `CONTEXT.md`
§"Traffic-warm experimentation".

## 4. Why latency replaced bytes as the payoff (measured → product hypothesis)

The virtualization branch began as a question about *bytes*: how much of a
production Node application could be absent initially if absence were
recoverable? The first two experiments answered that question and, in doing
so, showed it was not the product question.

**Measured, experiment 1 — static working-set sparsity**
(`benchmarks/working-set/first-run/SUMMARY.md`, 19 of 19 corpus apps):

- Plan A candidate-COLD (no hazard widening, no opaque-boundary forcing):
  **81.3 %** median of universe bytes across all 19 apps.
- Plan B candidate-COLD (Plan A plus every opaque native/WASM/install-script
  package forced HOT): **72.7 %** median of universe bytes.
- Plan B candidate-COLD as a fraction of third-party JavaScript bytes (the
  ADR-0006 denominator): **65.6 %** median.

**Measured, experiment 2 — runtime hydration**
(`benchmarks/hydration/run-1/SUMMARY.md`, 16 of 19 apps, observe-only tracer,
nothing removed):

- **99.3 %** of Plan B candidate-COLD bytes (byte-weighted; 99.8 % per-app
  median) were never read under the strongest available workload — the
  sparsity is real at runtime, not only statically.
- But **94.1 %** of the hydration that did occur happened *before* the
  application reported ready, and hydration misses clustered tightly in time
  (99.1 % of consecutive misses within 50 ms) and in package (89.5 % in the
  same package).

**Interpretation, at the time:** "many bytes can be absent initially" was
established. That alone is not a product benefit — it is a storage and
transfer property. Combined with §2 (operators already mitigate image
transfer cheaply) and §3 (the operator's pain was time-to-serving, not bytes),
the commercial question became:

> Does Reducer's semantic placement make a *new replica traffic-warm
> materially sooner* than commodity lazy loading plus a generic prefetch —
> and if so, by enough that a platform team would act on it?

Experiments 3, 4 and 5 are that question asked three times with successively
tighter controls: on a commodity substrate (Nydus), against a held-out long
tail at equal file-byte budgets, and finally at equal *measured prewarm time*
under a calibrated retrieval-cost model. The answer, after experiment 5, was
that the null survived (§5).

### Five things that "ready" can mean — kept distinct throughout

| term | meaning | who decides | used as a metric? |
| --- | --- | --- | --- |
| **Kubernetes Ready** | the pod's readiness probe passes | the application's own predicate | recorded as `t_ready`, diagnostic only |
| **artifact availability** | every file the process could ever need is retrievable | the substrate (complete immutable image) | a correctness precondition, never a metric |
| **first successful request** | the first post-admission request returns correctly | the traffic generator | reported as first-hit latency, secondary |
| **traffic-warm** | every post-admission latency window's p99 is inside the steady-state band | preregistered criterion, §8.3–8.4 of the longtail DESIGN | the equal-outcome target |
| **steady-state tail latency** | the p99 a fully warm pod actually produces | measured from the eager arm's warm pass | the band that defines traffic-warm |

Conflating the first with the fourth is the failure mode the interviewee
described; the experiments were designed so that it could not happen.

## 5. "The goal" — the external research brief

Three documents refer to "the goal" (`benchmarks/lazy-oci/DESIGN.md` §3.1,
`benchmarks/longtail/DESIGN.md` §9, `benchmarks/costaware/run-1/FINDINGS.md`
§10). **There was no committed repository document named "the goal."** The
phrase refers to the external experimental brief that directed the research
at the time. It is not being reconstructed as a formal document here; what
matters for reading the experiments is the set of priorities it imposed, which
were, in order of importance:

1. **Correctness / recoverability is non-negotiable.** No arm may ever be in
   a state where a prediction error can change program behaviour.
2. **Compare strategies under equivalent real resource / prewarm
   constraints.** An arm that wins by spending more is not a win.
3. **Measure traffic readiness, not merely Kubernetes Ready** (§3).
4. **Evaluate steady-state p95 / p99 impact, especially p99** — the operator's
   criterion is a tail-latency one.
5. **Semantic prediction is only a product wedge if it materially outperforms
   a strong generic baseline.** The generic baseline must be the strongest
   one definable without Node knowledge, not a straw man; experiments 3, 4 and
   5 each record an amendment strengthening the generic arm before any result
   was viewed for exactly this reason.
6. **Preserve negative and adverse controls** rather than optimising only for
   favourable workloads (Uptime Kuma in every performance experiment).

By experiment 5 the question had become especially strict (measured framing,
`benchmarks/costaware/DESIGN.md` §1):

> Given the same real prewarm time and the same measured retrieval-cost model,
> does semantic prediction create a better traffic-ready working set than
> generic workload observation?

with the null hypothesis:

> Generic trace locality captures enough of the benefit that semantics is not
> materially better.

**The null survived** (measured; `benchmarks/costaware/run-1/FINDINGS.md` §10;
recorded as the closing decision in `docs/adr/0007` §Decision, 2026-08-24).
Under equal measured prewarm cost the generic and semantic rankings converge on
the same physical content, the generic cost-aware arm leads on 11 of 15 cells,
and a perfect-precision oracle is *more* expensive than a contiguous overfetch,
because on a request-bound, chunk-deduplicated blob "precision is a
liability."

Per priority 5 and the preregistered decision rule, a negative result was not
to be rescued by another planner variant, and none was proposed. Performance
experimentation stopped there.

## 6. What this context does not license

- It does not make the ICP a validated segment, and it does not make
  "Ready is a lie" a measured result — it is one practitioner's report that
  the experiments then took seriously enough to build a metric around.
- It does not revive the semantic prewarming wedge. The measured answer to the
  §4 question is no.
- It does not bear on the sound-island probe FE-1 or the security wedge; those
  belong to the other research arc (see `docs/adr/0008`).

Related: `docs/RESEARCH-NARRATIVE.md` (the full chronology),
`CONTEXT.md` (definitions of every term used above),
`docs/adr/0007-dependency-virtualization-pivot.md` (the correctness model and
the closing decision).
