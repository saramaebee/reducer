# Does Node semantics generalise to execution the workload never showed it?

ADR-0007 experiment 4. Preregistration: [`../DESIGN.md`](../DESIGN.md) (+ three
recorded amendments). Provenance: [`RUN-INFO.md`](RUN-INFO.md). Refute-by-default
review: [`ADVERSARIAL.md`](ADVERSARIAL.md). Generated tables:
[`SUMMARY.md`](SUMMARY.md) and `<app>.metrics.json`.

**408 measured trials** across six applications, four strategies, four prewarm
budgets and four cold traffic families, plus 30 eager-reference trials.
**Zero correctness mismatches** anywhere: 384 arm-vs-eager trial comparisons,
every request matched on status, on byte length, on body fingerprint where the
body is deterministic, and on the declared semantic header where it is not.

---

## 1. The result in one paragraph

Where a real application has a module-shaped long tail, Node semantics covers it
and generic filesystem-trace prefetch does not — decisively, at a fraction of the
budget, and the arm that does it (**R1**) uses **no workload training at all**.
On juice-shop at a 10 % prewarm budget, R1 takes **1 post-admission remote fault
where the generic arms take 21–24**, and it serves the first request into a lazily
imported 19 MB subtree in **120 ms against the generic arms' 1 041–1 131 ms** —
i.e. it removes a full one-second latency cliff. But two things stop that from
being the traffic-warm product wedge. First, **most real Node servers have almost
no long tail to generalise to**: four of the five real applications, workloads
built from source surveys and spanning six categories, held out ten files or
fewer, because modern Node servers load their whole dependency graph at boot.
Second, **an equal byte budget is not an equal time budget** — the semantic arms
pay for their coverage by prefetching many small scattered files, admission is
gated by prefetch completion, and on the preregistered primary metric
(`T_steady − T0`) the *weakest* strategy wins by ten seconds on the largest app
simply by prewarming less and admitting sooner.

---

## 2. What was actually measured

Six applications, five real and one controlled fixture, chosen before any
outcome (DESIGN §3) — two of them (uptime-kuma, json-server) specifically so the
hypothesis could lose.

| app | universe | TRAIN observed | TEST needs | **held out** | categories with any held-out surface |
| --- | ---: | ---: | ---: | ---: | --- |
| juice-shop | 24 020 f / 270.5 MB | 2 671 f / 26.9 MB | 3 340 f / 35.2 MB | **669 f / 8.30 MB** | optional-feature 424, tenant-config 237, rare-route 10 |
| nextjs-longtail *(fixture)* | 11 918 f / 362.6 MB | 445 f / 8.0 MB | 1 155 f / 12.4 MB | **710 f / 4.42 MB** | all six |
| strapi | 123 474 f / 915.0 MB | 4 845 f / 32.2 MB | 5 118 f / 34.5 MB | **273 f / 2.33 MB** | optional-feature 272, rare-route 1 |
| uptime-kuma | 28 851 f / 200.7 MB | 4 277 f / 27.4 MB | 4 287 f / 27.8 MB | **10 f / 0.33 MB** | locale 6, rare-route 4 |
| verdaccio | 9 530 f / 59.9 MB | 1 800 f / 5.4 MB | 1 801 f / 5.4 MB | **1 f / 0.02 MB** | rare-route 1 |
| json-server | 1 288 f / 3.2 MB | 134 f / 0.5 MB | 134 f / 0.5 MB | **0 f** | — |

### 2.1 The first finding is the size of that last column

This is the most important number in the experiment and it is independent of
every strategy, every timing and the substrate itself.

The long-tail workloads were not casual. Each application's route table and
source were surveyed with file:line citations; every held-out group carries a
written argument for why a production deployment serves it and which Node
mechanism it exercises; every request declares the statuses that count as the
intended behaviour, and prep-time validation refuses to proceed silently when
one is wrong (it caught six, [`ADVERSARIAL.md`](ADVERSARIAL.md) D7–D8). The
groups include an `import()` hidden behind `new Function('specifier','return
import(specifier)')`, a computed `require()` inside express's view-engine
resolution, a lazy `require('cheerio')` in a plugin-only handler, a lazy
`await import('file-type')` in an upload pipeline, request-time directory
listings, and a full publish → tag → unpublish write lifecycle.

**And on three of five real applications it moved fewer than eleven files.**

The reason is uniform and worth stating plainly: **modern Node servers load
their dependency graph eagerly at boot.**

- **uptime-kuma** requires all 25 monitor-type modules (`server/uptime-kuma-server.js:568-592`)
  and all ~106 notification providers (`server/notification.js:3-108`) at startup.
  `pg`, `mysql2`, `mongodb`, `redis`, `mssql`, `oracledb`, `mqtt`, `playwright-core`
  — every one resident before the first request. What remains is per-locale and
  per-route *frontend build chunks* served from `dist/assets`.
- **strapi 5.7.0** loads every enabled plugin, every route, the whole error
  machinery and every `zod`/`yup` locale at boot. Exactly two candidates in the
  entire survey moved genuinely new bytes.
- **verdaccio**'s tarball validation, storage write path and error formatting are
  all boot-resident; the publish lifecycle executes new *code paths* over
  already-resident *files*.
- **Next.js App Router** preloads **every** app route module at server startup:
  measured at **968 files resident before any traffic, versus 377** with
  `experimental.preloadEntriesOnStart: false`. A default-configured self-hosted
  Next deployment — the stated ICP shape — has essentially **no** module-shaped
  long tail at all. The fixture only has one because that documented opt-out is
  set.

A prediction problem needs something to predict. On most of this corpus, by the
time traffic arrives there is almost nothing left that the startup path did not
already read.

---

## 3. Equal cost — same prewarm file bytes, 10 % reference budget

Post-admission remote faults and the worst rolling-window p99 of the
post-admission stream. `E0` is the eager arm: the whole image fetched before
traffic is admitted.

| app | E0 | G1 (trace) | G2 (trace + path distance) | **R1 (static semantics)** | R2 (semantics + trace) |
| --- | ---: | ---: | ---: | ---: | ---: |
| **juice-shop** | 0 f / 152 ms | 24 f / 478 ms | 21 f / 449 ms | **1 f / 169 ms** | 17 f / 503 ms |
| **strapi** | 0 f / 127 ms | 9 f / 229 ms | 1 f / 130 ms | **0 f / 132 ms** | **0 f / 131 ms** |
| nextjs-longtail | 0 f / 45 ms | 16 f / 347 ms | 1 f / 304 ms | 1 f / 305 ms | 1 f / 296 ms |
| uptime-kuma | 0 f / 7 ms | 2 f / 130 ms | 2 f / 131 ms | 2 f / 136 ms | 2 f / 130 ms |
| verdaccio | 0 f / 178 ms | 0 f / 175 ms | 0 f / 176 ms | 0 f / 176 ms | 0 f / 175 ms |
| json-server | 0 f / 11 ms | 1 f / 12 ms | 1 f / 12 ms | 0 f / 12 ms | 0 f / 10 ms |

On the two apps with a real module-shaped long tail, R1 is at or near the eager
arm and the generic arms are not. On the three without one, nothing distinguishes
anything.

### 3.1 First-hit latency, arrival position 1 only

The only contamination-free latency measurement: the first request of a long-tail
group when that group is the *first unusual request the pod ever sees*.

| app | category | E0 | G1 | G2 | **R1** | R2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| **juice-shop** | optional-feature *(lazy `import('ethers')`, 19 MB; `import('pdfkit')`)* | 118 ms | 1 131 ms | 1 041 ms | **120 ms** | 729 ms |
| **strapi** | optional-feature *(lazy `require('cheerio')` + parse5)* | 148 ms | 785 ms | 417 ms | **158 ms** | 155 ms |
| nextjs-longtail | tenant-config *(config file → dynamic renderer chunk)* | 39 ms | 347 ms | 39 ms | 40 ms | 41 ms |
| **uptime-kuma** | locale *(per-locale frontend chunk from `dist/assets`)* | 11 ms | 245 ms | 249 ms | **256 ms** | 257 ms |
| juice-shop | tenant-config *(computed `require('hbs')` → handlebars)* | 66 ms | 102 ms | 68 ms | 66 ms | 102 ms |
| verdaccio | error-path *(404 through a dead uplink)* | 1 089 ms | 1 125 ms | 1 071 ms | 1 078 ms | 1 086 ms |

Two readings, both true:

- **The cliff is real and R1 removes it.** A one-second first-hit penalty on a
  route that lazily imports a large subtree is exactly the "Kubernetes Ready ≠
  traffic warm" failure the operator described, and static Node semantics —
  *with no training run* — serves it at eager latency.
- **It only works when the long tail is module-shaped.** uptime-kuma's locale
  chunk is a build artefact in `dist/assets`, not a module edge, and every arm
  including both Reducer arms pays ~250 ms for it. verdaccio's error path costs
  a second in *every* arm including eager, because it is an uplink timeout, not
  a fetch.

---

## 4. The arm that wins is the one with no training data

**R1 uses no workload evidence whatsoever** — entrypoint, `@vercel/nft` positive
trace, package identity, resolver metadata, opaque-boundary classification and
the declared dependency graph, and nothing about what any request ever did.
**R2, which gets all of that plus exactly the generic arms' TRAIN trace, is
consistently worse than R1** on juice-shop (17 faults vs 1 at 10 %; 729 ms vs
120 ms first hit).

The trace does not help; it *hurts*, by anchoring the ranking to what the
training run happened to touch. Experiment 3 found the same thing about its B3a
arm and it was the one result of that experiment that survived. It now
reproduces against a purpose-built held-out surface, which is the strongest
methodological statement this experiment makes.

---

## 5. Equal outcome — the budget needed to be no worse than eager

Smallest swept budget at which an arm's worst post-admission window p99 is within
the eager arm's own worst family. (The preregistered band, taken from the eager
arm's *warm* pass, is unreachable even by the eager arm's own *cold* pass —
every cold first pass carries an application warm-up tail no prewarming can
remove. Both criteria are reported in SUMMARY.md; this is the one that is
answerable.)

| app | G1 | G2 | **R1** | R2 |
| --- | --- | --- | --- | --- |
| **strapi** (915 MB) | never | 10 % | **5 %** | 40 % |
| nextjs-longtail *(fixture)* | never | 40 % | **20 %** | **20 %** |
| juice-shop | never | 40 % | never (169 ms vs 154 ms threshold) | never |
| uptime-kuma | **20 %** | 40 % | 40 % | never |
| verdaccio | 5 % | 5 % | 5 % | 5 % |
| json-server | 5 % | 5 % | 5 % | 5 % |

On the ICP size class, R1 reaches eager-equivalent post-admission latency at
**half** G2's budget and where G1 never does. On the fixture, R1/R2 need half of
G2's. On uptime-kuma the ordering reverses and the *plain trace* wins. juice-shop
is the honest awkward case: R1 has 24× fewer faults than the generic arms but
sits 15 ms over a threshold set by application warm-up, so the binary test says
"never" while the fault and first-hit numbers say it is far ahead.

---

## 6. The finding that undercuts the wedge: bytes are not the cost

An equal **file-byte** budget is not an equal-**time** budget, and admission is
gated by prefetch completion.

strapi, every arm prewarming the identical 45.8 MB of file bytes (5 %):

| arm | prewarm files | chunk MB moved | **prewarm duration** | admission | post-adm faults | max window p99 | **time-to-steady** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| G1 | 6 579 | 13.3 | **12.7 s** | 16.5 s | 7 | 224 ms | **19.2 s** |
| G2 | 35 131 | 18.5 | 20.6 s | 24.5 s | 4 | 174 ms | 27.5 s |
| R1 | 66 628 | 24.7 | 22.6 s | 26.5 s | **0** | **129 ms** | 28.8 s |
| R2 | 40 358 | 18.7 | 24.6 s | 28.5 s | 1 | 132 ms | 31.9 s |
| *E0 (whole image)* | *all* | *228.3* | *22.7 s* | *26.6 s* | *0* | *127 ms* | *28.6 s* |

The semantic arms buy their coverage by prefetching many small scattered files.
At identical file bytes R1 moves nearly twice G1's chunk bytes and takes 78 %
longer to prewarm, so it admits traffic ten seconds later.

**On the preregistered primary metric — `T_steady − T0`, the interval the
operator actually named — G1, the weakest strategy in the experiment, wins on
strapi by 9.5 seconds.** It wins by prewarming *less*: seven remote faults
costing ~3 MB are far cheaper than ten seconds of prefetch. The same ordering
holds on juice-shop.

This is not a defect in the measurement; it is the answer to the question. Within
this budget range, **prewarm time dominates fault time**, so the operating point
that minimises time-to-traffic-warm is "prefetch the trace and admit early", not
"predict the long tail well". Reducer's advantage is real but it is spent on the
wrong axis.

---

## 7. Does generic training close the gap?

Analytic: re-rank the generic strategies against a TRAIN augmented with one more
long-tail category's observed first-touches, and recount coverage. No semantic
information enters.

| app | G2 @10 %, common-only | +1 category | +all categories | R2 @10 %, no extra training |
| --- | ---: | ---: | ---: | ---: |
| strapi | 4 899 | **5 117** | 5 118 | 4 942 |
| juice-shop | 2 675 | 2 694 | 2 694 | 2 707 |
| nextjs-longtail | 1 049 | **1 125** | 1 155 | 1 032 |
| uptime-kuma | 3 623 | 3 623 | 3 623 | 3 623 |

Mixed, and the mix is informative. On strapi and on the fixture, **one** extra
trained category lifts generic *past* the semantic arm — the matrix does not
need to be exhaustive, it needs one more workload. On juice-shop the whole matrix
buys 19 files and generic still trails. On uptime-kuma extra training buys
nothing, because the budget rather than the knowledge is binding.

So the "generic profiling requires an exhausting workload matrix" argument is
**not supported in general**. On two of the four apps with any held-out surface,
one additional trained path is enough.

---

## 8. Sensitivity: is it the size term doing the work?

DESIGN amendment A2 required this check. All three widening strategies share one
rule, `key = distance + log2(size+1)`. Repeating the coverage curve with the size
term removed:

| app @10 % | G2 with size | G2 distance-only | R2 with size | R2 distance-only |
| --- | ---: | ---: | ---: | ---: |
| juice-shop | 2 675 | 2 671 | 2 707 | 2 707 |
| uptime-kuma | 3 623 | 3 623 | 3 623 | 3 623 |
| nextjs-longtail | 1 049 | 452 | 1 032 | 536 |

On the real applications the size term changes almost nothing and the semantic /
generic ordering is unchanged, so the result is not an artefact of the
normaliser. On the fixture it matters enormously (its universe contains a few
very large files in `next/`), and note that *without* it R2 leads G2 — the size
term is what lets generic catch up there. Both are reported; neither is hidden.

---

## 9. The controlled fixture versus the real applications

The fixture was built to favour the hypothesis: all six categories present by
construction, 710 held-out files, module-shaped, data-shaped and config-shaped
long tails side by side. It delivers a clean 2× budget advantage for R1/R2 over
G2 — and it agrees with strapi, which is real. It does **not** manufacture an
advantage the real applications lack, and per DESIGN §14 that is the test it had
to pass. Its own most useful contribution was negative and about the ICP: the
968-vs-377 preload measurement, which says a default self-hosted Next.js App
Router deployment has no module long tail to plan for.

---

## 10. Answers

**A. Under an equal prewarm budget, does Node semantics produce better long-tail
traffic-warm behaviour than generic trace prefetch?**
**Yes, where a module-shaped long tail exists — decisively, and on real
applications.** juice-shop at 10 %: 1 fault vs 21–24, 120 ms vs 1 041 ms first
hit. strapi at 5 %: 0 faults / 129 ms vs 7 / 224 ms. **No, where the long tail is
asset-shaped** (uptime-kuma: every arm pays ~250 ms), and **not at all on the
three real applications that have no held-out surface.**

**B. To achieve the same eager-like p99 target, does Reducer require materially
less prewarming?**
**In bytes, yes: half or less** (strapi 5 % vs G2's 10 % and G1's never; fixture
20 % vs 40 %). **In time, no** — the semantic arms' byte saving does not convert,
because they select many small scattered files and take longer to prefetch. R1's
5 % budget on strapi costs 22.6 s of prewarm against G2's 20.6 s at 5 %; the
byte advantage buys 8 % less prewarm time, not 50 %.

**C. Does the advantage hold on real applications, not just controlled
fixtures?**
**Yes, on two of five** — juice-shop and strapi, including the 915 MB ICP-size
app. The fixture agrees with them rather than exceeding them. But three of five
real applications had no measurable long tail at all, so the advantage is real
and also **narrow**.

**D. Does generic training require a meaningfully more exhaustive workload matrix
to close the gap?**
**No, not in general.** On strapi and on the fixture, adding a *single* long-tail
category to TRAIN lifts generic coverage past the semantic arm. Only juice-shop
resists the full matrix. This weakens the product thesis materially.

**E. Is the absolute difference large enough that a platform team would plausibly
care?**
**On the latency axis, yes — a one-second first-hit cliff removed on scale-out is
exactly what the operator described.** On the metric that operator actually
named — HPA decision to serving at steady-state p99 — **no**: the semantic arms
reach steady state *later* than the plain trace, by ten seconds on the largest
app, because they spend longer prewarming than the faults they avoid would have
cost.

---

## 11. Verdict

```text
CONTINUE AS ENABLING TECHNOLOGY — SEMANTICS IMPROVES
COVERAGE BUT NOT ENOUGH TO SUPPORT THE PERFORMANCE WEDGE
```

Stated so a later reader can attack it:

1. **The coverage property is real and now reproduced twice.** Static Node
   semantics with no training run keeps early-request latency at the eager
   baseline where generic trace prefetch defers 0.4–1.1 s into the first
   requests. Experiment 3 found this and this experiment confirms it against a
   held-out surface built on purpose to test it.
2. **It does not convert into the traffic-warm wedge.** The operator's interval
   is HPA decision → steady-state p99. Prewarm time dominates fault time in this
   budget range, so the strategy that minimises that interval is the one that
   prewarms *least*. Reducer's advantage is spent buying coverage the clock does
   not reward.
3. **The addressable surface is small.** Three of five real applications had ten
   held-out files or fewer, because Node servers load their graph at boot — and
   the ICP's own framework preloads every route module by default. A planner
   cannot beat a trace on paths the trace already saw.
4. **Generic training closes the gap cheaply on half the cases.** One extra
   trained category, not an exhaustive matrix.
5. **The one property worth keeping is training-free.** R1 needs no workload
   run, no profiling infrastructure and no training matrix — which makes it a
   good *default residency policy* for a lazy-delivery product, and a poor
   basis for a performance product sold on its own.

What would change this verdict: a deployment shape where the long tail is
genuinely large and module-shaped *and* prefetch time is not the binding
constraint — a much faster registry link, or a substrate that can admit traffic
before prewarm completes and prioritise on demand. Both are measurable, and
neither is measured here.

---

## 12. Limitations

1. **One network profile** (25 ms, 100 Mbit). The direction of every comparison
   is independent of it; §6's conclusion that prewarm time dominates fault time
   is **not** — a faster link shifts that trade-off toward the semantic arms, and
   this is the single most load-bearing limitation in the report.
2. **Only the application universe is lazy.** Node and the base OS are eager in
   every arm, removing ~120 MB from the eager arm's download and understating the
   lazy advantage uniformly.
3. **Four families per cell, single machine, single run.** Median with min/max
   reported; no cross-machine reproduction.
4. **Two apps' family rotation collides** (json-server, juice-shop), giving three
   distinct uncontaminated first-arrival orders instead of four — ADVERSARIAL.md.
5. **Per-category first-hit latency is only measurable for the groups that reach
   arrival position 1**, which is four groups per app at most; the analytic
   per-category coverage covers all of them and is exact.
6. **corpus-v1-linux**: four trees are not byte-identical to the ones experiments
   1–2 measured, though the app SHA and lockfile are.
7. **juice-shop runs a background source-tree scanner every 5 s**, live during
   the post-admission window; identical across arms, but it inflates that app's
   absolute fault counts.
8. **verdaccio's deprecate branch answers 422 at this SHA and did not execute**;
   no claim is made about it.
9. **uptime-kuma's tenant and admin categories were not built** (they need
   socket-driven seeding), so that app speaks only to locale, rare-route and
   error-path.
