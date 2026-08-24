# Experiment 5 — cost-aware prewarming: does semantic prediction survive real retrieval economics?

**Preregistration. Written and committed before any measured strategy trial of
this experiment ran and before any post-admission latency, fault count or
time-to-steady-state of any arm was observed.** The one thing that was measured
first is the physical cost model itself (§5), which is *required* to be measured
first, is measured on manifests no strategy produced, and is frozen in
`run-1/cost-model.json` by the same commit that carries this file.

ADR-0007 experiment 5. Experiments 1–4 are preserved untouched in
`benchmarks/working-set/first-run/`, `benchmarks/hydration/run-1/`,
`benchmarks/lazy-oci/run-1/` and `benchmarks/longtail/run-1/`. This directory is
new, builds no image, rebuilds no tree, and overwrites nothing.

---

## 1. The one remaining explanation, and the null that kills it

Experiment 4 (`../longtail/run-1/FINDINGS.md`) closed with a split verdict:

```text
semantic coverage of a module-shaped long tail    REAL, and reproduced twice
  juice-shop @10%:  R1 1 fault vs generic 21–24
                    R1 120 ms first hit vs generic 1 041–1 131 ms
  strapi     @5 %:  R1 0 faults / 129 ms vs G1 7 / 224 ms

the traffic-warm performance wedge                NOT SUPPORTED
  strapi, identical 45.8 MB FILE-byte budget:
    G1  6 579 files  13.3 chunk MB  12.7 s prewarm   T_steady 19.2 s
    R1 66 628 files  24.7 chunk MB  22.6 s prewarm   T_steady 28.8 s
  the WEAKEST arm won the preregistered primary metric by 9.5 s, by
  prewarming less and admitting sooner
```

The stated cause was that an equal **file-byte** budget is not an equal **time**
budget: the semantic arm bought its coverage in many small scattered files, and
the substrate charges for scatter, not for bytes. That is a hypothesis about the
*budget currency*, not about the prediction. It leaves exactly one explanation
that could still rescue the wedge, and this experiment tests it:

> **Given the same amount of real prewarm time, and with both strategies
> optimising against the same measured model of what retrieval physically
> costs, does semantic prediction produce a better traffic-ready working set
> than generic workload observation?**

and its inverse:

> **To reach eager-like post-admission behaviour, does the cost-aware semantic
> strategy need materially less prewarm time than the cost-aware generic one?**

### The null hypothesis

> Once both strategies account for Nydus's real retrieval economics, generic
> trace locality captures enough of the advantage that semantic knowledge does
> not materially improve time-to-steady-state.

There is a concrete structural reason to expect the null, and it is recorded
here *before* the result so it cannot be presented afterwards as insight: the
blob's chunk order is the image builder's directory walk, so **physical
adjacency in the blob is very nearly directory adjacency in the tree**. A
cost-aware optimiser therefore rewards directory-local widening — which is
precisely what the generic arm already does natively (`G2`'s distance is edges
of the directory tree) and what the semantic arm has to reach by a different
route. Cost-awareness may simply hand the generic arm what semantics was for.

### Not being tested here

The recoverability result (experiment 3), the size thesis (ADR-0006), the
same-package clustering hypothesis (refuted in experiment 3 and **not** revived
— nothing here groups by package), whether semantics can predict long-tail
execution better than a trace (established in experiment 4 and **not** retested),
container slimming, storage cost, and the dormant sound-island probe (FE-1).

**This is the last performance experiment.** §14 states the decision rule: a
negative result closes the wedge and no further planner variant is proposed.

---

## 2. Substrate — nothing about it changes, and nothing is rebuilt

Every physical artefact is experiment 4's, reused by path:

```text
application trees      /Users/sara/.cache/reducer-longtail-v1/stage/<app>
RAFS bootstrap         /Users/sara/.cache/reducer-longtail-v1/images/<app>/base/boot.img
RAFS data blob         already in the local registry, repo longtail/<app>
                       (strapi's blob digest fd4656ceb30d…, 228.3 MB — the exact
                        object experiment 4 measured)
behavioural rankings   ../longtail/run-1/prefetch/<app>/{G2,R1,O}.ranking.json.gz
traffic families       ../longtail/traffic.ts, ../longtail/workloads.ts
steady-state band      ../longtail/run-1/band/<app>.json   (frozen, not re-derived)
```

There is **one image per application and every arm mounts that image**, so
"strategy" cannot reach RAFS packing, blob layout, compression, chunk boundaries
or image contents. That was already true in experiment 4 and it remains true by
construction here, because this experiment builds no image at all. Arms differ
in exactly one thing: the file list handed to `nydusd --prefetch-files` at mount.

```text
mount        nydusd --bootstrap … --prefetch-files <arm's list>
             fs_prefetch {enable:true, threads_count:4, merging_size:131072,
                          prefetch_all:<true only for E0>}
network      tc netem on the REGISTRY's egress: 25 ms delay, 100 Mbit
             (§12 adds ONE preregistered faster profile, as a separate result)
runtime      node:24-bookworm-slim → Node v24.19.0, --privileged, Docker Desktop
             linux/aarch64 6.10.14-linuxkit, 10 CPU
```

### 2.1 The single change to the harness

`container/runner.sh` and `container/driver.mjs` are copies of experiment 4's
with two additions, both stated in their headers and both additive:

1. **`PREWARM_DEADLINE_MS`** — the permitted proactive prewarm window closes at
   `t0 + budget` even if the substrate is still fetching. Unset, the code path
   is line-for-line experiment 4's, which is what the re-run eager arm (§8)
   checks.
2. **`snapshotChunkMap`** — nydus's blobcache keeps `<blob>.blob.data.chunk_map`,
   a 4096-byte header followed by one bit per chunk, set when that chunk's bytes
   are local. It is copied at the admission instant and at the end of each pass.
   Residency at `T_traffic` is therefore a measured fact about which chunks had
   *arrived*, never a claim about what was in a manifest.

---

## 3. Applications — three, preregistered, one of them adverse

```text
strapi        PRIMARY. 915 MB / 123 474 files — the ICP size class. In
              experiment 4 R1 achieved 0 post-admission faults and near-eager
              p99 on it and STILL lost time-to-steady-state by 9.5 s purely on
              prewarm cost. If cost-awareness rescues anything, it rescues this.

juice-shop    SECONDARY POSITIVE. The richest genuine module-shaped long tail in
              the corpus (669 held-out files / 8.30 MB). Experiment 4's R1 turned
              a 1 041–1 131 ms generic first-hit cliff into 120 ms. Tests whether
              any result generalises beyond one application.

uptime-kuma   ADVERSE CONTROL. Its long tail is asset-shaped, not module-shaped
              (the server eagerly requires all 25 monitor types and ~106
              notification providers at boot; what remains is per-locale frontend
              chunks in dist/assets). Experiment 4 measured every arm paying
              ~250 ms for it. R1C must NOT win here. If it does, the cost model
              is manufacturing a semantic-looking advantage out of a generic
              physical optimisation, and that is a defect, not a result.
```

Excluded, decided here before any outcome: **verdaccio** and **json-server**
(experiment 4 measured held-out surfaces of 1 file and 0 files — there is
nothing to predict, and both apps' arms were already indistinguishable);
**nextjs-longtail** (a fixture — experiment 4's §14 rule stands, a fixture may
not carry a conclusion, and it is used here only if implementation debugging
requires it); **n8n** (analysis never completed, experiment 3).

---

## 4. What Nydus actually exposes, and the retrieval unit

`nydus-image check -v <bootstrap>` dumps every inode and every chunk. Measured
on the frozen bootstraps, recorded in `run-1/prep/<app>.json`:

```text
file  →  ordered chunk indexes
chunk →  (blob_index, compressed_offset, compressed_size)
```

| app | files | chunks | shared chunks | compressed | blob indexes | layout gaps | overlaps |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| strapi | 123 474 | 75 245 | 22 870 | 228.3 MB | [0] | 0 | 0 |
| juice-shop | 24 020 | 17 770 | 3 721 | 75.6 MB | [0] | 0 | 0 |
| uptime-kuma | 28 851 | 22 315 | 3 830 | 56.8 MB | [0] | 0 | 0 |

Three facts follow, and all three are measured rather than assumed:

1. **One blob.** A chunk index is a total order over the blob's bytes.
2. **Chunks are contiguous in index order** — zero gaps and zero overlaps
   between chunk *i*'s end and chunk *i+1*'s start, across every chunk of every
   app. "Adjacent in the blob" is exactly "consecutive index".
3. **Chunks are deduplicated across files.** 22 870 of strapi's 75 245 chunks
   back more than one file: a second file with identical content is physically
   free. No strategy in experiment 4 could see that, and it is one of the things
   a cost-aware selector can exploit — identically for both arms.

### 4.1 The retrieval unit

nydusd's prefetch worker coalesces requested chunks into backend HTTP Range
requests bounded by its own `merging_size`. So the chunk axis is partitioned
into consecutive **units** whose compressed span does not exceed that bound: a
unit is exactly what the substrate turns into one backend request. The partition
depends only on the image, so both arms see the same units, and a file inside an
already-selected unit costs nothing further.

The median compressed chunk is ~500 B, so a unit holds tens of files. This is
the mechanism the whole experiment turns on: **selecting whole units converts
"many small scattered files" into "few large contiguous reads"** without
changing the image, and it is available to the generic arm and the semantic arm
on exactly equal terms.

---

## 5. The cost model — measured before it is allowed to select anything

```text
prewarm ms  ≈  fixedMs  +  α · backend requests  +  β · backend bytes
```

`requests` and `bytes` are computed from a chunk set by merging it into ranges
with two parameters — `gapBridge` (how much unrequested blob a merge will bridge
and therefore also transfer) and `maxRange` (how large one request may grow).
All five numbers are **fitted, not chosen**.

### 5.1 The calibration protocol

`calibrate.ts` runs neutral probes: a mount with a manifest, no application, no
traffic, and the same netem profile every trial uses. Manifest families, all
generated from the image and a preregistered LCG seed (`SEED = 20260824`) and
from nothing else:

```text
span-N-{a,b,c}   N consecutive chunks, from three places in the blob
stride-K         every K-th chunk over a window
runs-RxG         runs of R consecutive chunks separated by G unrequested chunks
uniform-N        seeded uniform sample of N files of the whole universe
```

No TRAIN trace, no TEST first-touch, no arm's ranking and no outcome of this
experiment enters a probe. `(gapBridge, maxRange)` are then grid-searched
against **nydus's own backend counters** (`read_count`, `read_amount_total`),
and `(fixedMs, α, β)` are fitted by ordinary least squares of measured prewarm
duration on those same *measured* counters — so an error in the merge rule
cannot leak into the time coefficients.

### 5.2 What the probes already showed, and why the previous result happened

The probe set is preserved in full in `run-1/calibration/`. Two rows of it are
the whole story of experiment 4 §6, on strapi:

```text
manifest        chunks   backend requests   backend MB   prewarm
span-16000-c    16 000              242         35.8       3 430 ms
uniform-8000     7 211            3 615        104.9      38 467 ms
```

Half the chunks, **eleven times the time**. Scatter is charged twice over: it
multiplies requests, and because a merge transfers the unrequested bytes it
bridges, it also multiplies *bytes* — `uniform-2000` moved 75.6 MB of backend
traffic to deliver 1 899 chunks. File bytes were never the cost.

### 5.3 The frozen model

```text
gapBridge       2 048 B
maxRange      131 072 B          (the substrate's own merging_size)
fixedMs         181.07 ms
α (per request)  10.446 ms
β (per byte)      1.5566e-5 ms   ≈ 15.6 ms per MB
```

Fit quality, on 86 neutral probes across the three applications:

```text
R² of prewarm ms on the MEASURED backend counters            0.998
MAPE predicting prewarm ms from the PHYSICAL MAP ALONE
   (no measured counter anywhere in the prediction)
     cover-manifest regime, the one every deployed arm is in  13.8 %  n=86
     THE DEPLOYED MANIFESTS THEMSELVES                        11.0 %  n=96
     including the file-listing regime no arm deploys (§7.3)  28.8 %  n=116

out-of-sample, never in the fit: the whole blob, against
experiment 4's measured eager arm
   uptime-kuma   predicted  5 547 ms   measured  5 604 ms    −1.0 %
   juice-shop    predicted  6 508 ms   measured  7 535 ms   −13.6 %
   strapi        predicted 17 920 ms   measured 22 715 ms   −21.1 %
```

The estimator under-predicts, i.e. a manifest costs slightly more than planned,
never less. That direction is safe here: the admission gate is a wall clock, so
under-prediction shows up as content that did not arrive, which the chunk bitmap
measures, rather than as an unnoticed budget overrun.

The same `(gapBridge, maxRange, fixedMs, α, β)` values price every arm, the
control arms, and the oracle. There is no per-arm and no per-app coefficient.
And because the *budget* is ultimately set by measurement (§8.1), the absolute
accuracy of the model matters less than the fact that it is one function applied
to both prediction sources.

---

## 6. Arms, and the information boundary

```text
E0    eager reference        prefetch_all, admitted on prefetch completion
G1    generic, cost-UNAWARE  generic value, longest prefix fitting the time budget
G1C   generic, cost-aware    generic value, cost-aware unit selection
R1    semantic, cost-UNAWARE semantic value, longest prefix fitting the time budget
R1C   semantic, cost-aware   semantic value, cost-aware unit selection
O     physical oracle        TEST first-touch set, priced — ANALYSIS ONLY
```

This is a clean 2 × 2: **prediction source × cost-awareness**. Within a
prediction source the two arms differ in exactly one thing, so "what did the
optimiser change" is answered by G1→G1C and R1→R1C, and "does the prediction
source matter under equal economics" is answered by the primary comparison
**R1C vs G1C**.

### 6.1 Behavioural value

Each arm's value is a **frozen experiment-4 ranking**, loaded from that
experiment's preserved artefacts — not re-derived here, so it cannot drift and
cannot acquire information it did not have.

| arm | frozen ranking used as value | what that ranking is |
| --- | --- | --- |
| G1, G1C | `G2.ranking.json.gz` | the TRAIN trace in first-access order (its head is literally identical to G1's), then the strongest generic widening: directory-tree distance from a TRAIN-touched directory, size-disciplined |
| R1, R1C | `R1.ranking.json.gz` | entrypoint, then every `package.json`, then semantic-distance widening over NFT evidence, Plan-B opaque boundaries, live packages and declared dependency hops |

**The generic arm is given G2's ranking on purpose.** G1's own ranking has
nothing to say below the trace (its remainder is lexicographic), and using it
would be exactly the artificially-weak-generic-baseline the adversarial list
forbids. G2 is the strongest generic prediction the preserved harness contains,
and it contains the literal trace as its strict prefix.

**R1C receives no workload TRAIN trace.** R1's frozen ranking was produced from
static Node structure alone — entrypoint, `@vercel/nft` positive trace and its
graph order, package identity, resolver metadata, opaque-boundary classification
and the declared dependency graph. That is the surprising property under test
(useful traffic-warming predictions without workload training) and it is not
quietly relaxed into R2.

| information | G1 / G1C | R1 / R1C | O |
| --- | --- | --- | --- |
| universe paths, directory structure, file size | ✓ | ✓ | ✓ |
| TRAIN access log (path + first-content-read time) | **✓** | — | ✓ |
| package identity, NFT trace, resolver + dependency graph | — | **✓** | ✓ |
| physical map: file→chunk→offset/size, adjacency, dedup | ✓ | ✓ | ✓ |
| calibrated cost model | ✓ | ✓ | ✓ |
| anything derived from the LONG-TAIL TEST workload | — | — | **✓** |

The physical rows are identical by construction: both arms call the same
`select.ts` functions with the same `PhysicalMap`, the same `Units` and the same
`CostModel` object. `run-1/prep/<app>.json` records the ranking `inputs` array of
every arm verbatim.

### 6.2 The value transform — one function, no free parameter

A ranking is an ordinal claim, so it is turned into a value by the standard rank
prior and nothing else:

```text
value(f) = 1 / (1 + rank(f))
```

No fitted constant, no per-app constant, no per-arm constant — which is what
makes "identical machinery" checkable rather than asserted. Its shape is right at
both ends: the head of a ranking is bought at almost any price (the cumulative
value of the first *k* ranks grows like ln *k*), while deep in the speculative
tail consecutive ranks differ by a factor of (1 + 1/*i*) and physical cheapness
decides. That is the trade-off under test, applied identically to both arms.

---

## 7. The selection rule — frozen here, before any strategy trial

### 7.1 Cost-aware (G1C, R1C)

```text
unitValue(u) = Σ over files whose chunks touch u of value(f) / (number of units
               that file touches)
unitCost(u)  = α + β · (compressed bytes spanned by u)

take units in descending unitValue/unitCost while the running predicted cost
fits the budget; skip a unit that does not fit and continue

resident     = every file entirely inside the taken units
manifest     = a minimal chunk cover of those units (§7.4)
```

One sort, one greedy fill. Because units partition the chunk axis and each is
one backend request, a unit's cost does not depend on which other units are
taken: the marginal cost of a file inside a taken unit is exactly zero, so the
greedy sees the "candidate A is nearly free" case without iterating. Chunk
deduplication is handled automatically — value accrues to a chunk's unit however
many files reference it.

Taking *whole* units rather than individual files is deliberate and is what
makes the predicted cost trustworthy: the resulting manifest is contiguous
within each unit, which is the regime §5.2's `span` probes measure most
precisely, and it is the regime in which the two plausible readings of nydus's
merge behaviour agree.

### 7.2 Cost-unaware control (G1, R1)

The longest **prefix** of the same ranking whose predicted cost fits the same
budget, found exactly by binary search (predicted cost is monotone
non-decreasing in prefix length). Same value, same cost model, same budget — no
cost-aware reordering. Experiment 4's byte-budget rule skipped an oversized file
and continued because one large file could otherwise consume a whole byte
budget; under a time budget the boundary is set by thousands of small requests
rather than by one file, so the simpler exact rule is used.

### 7.3 The manifest is a minimal chunk cover — for every arm

nydusd builds one prefetch descriptor per **(file, chunk)** pair from the list
and merges *that stream*. Deduplication makes many files share a chunk, so
listing every file in a region emits the same chunk several times at scattered
positions, the stream stops being monotone in blob offset, and merging
collapses. Measured on strapi's first 500 chunks — identical chunks, identical
2.9 MB of backend traffic either way:

```text
1 237-file listing   164 backend requests   3 832 ms
  496-file cover      13 backend requests     593 ms
```

So every arm's manifest is a minimal cover: one covering file per distinct
chunk, in ascending chunk order, drawn only from files entirely inside the
bought chunk set. Residency is identical either way — a file is resident iff all
its chunks are — so the cover is a pure win, and withholding it from the
cost-unaware arms would be a straw man. Applying it everywhere keeps the only
difference between arms the thing under test.

### 7.4 What is deliberately absent

No machine learning. No global optimiser. No coefficient that can be tuned per
application. No per-arm parameter of any kind. The selection code is one file
(`select.ts`) and both prediction sources enter it through the same two
functions.

---

## 8. Timeline, budgets and admission

```text
T0            container start
t_proc        the application process is exec'd (concurrently with prewarm)
t_ready       the application's own readiness predicate passes
t_prewarm     the permitted prewarm window CLOSES: the earlier of
                (a) the substrate's prefetch counter going quiet, or
                (b) t0 + the arm's prewarm-time budget
T_traffic     = max(t_ready, t_prewarm)          ← TRAFFIC IS ADMITTED HERE
… pass 1 …    the measured post-admission stream
T_steady      steady-state latency established (§9)
… pass 2 …    the identical stream, everything resident: this arm's own warm
              reference
```

`T_traffic = max(application-ready, prewarm-deadline)` is stated explicitly
because on two of the three apps the application is not ready before the smaller
budgets expire, so those budgets cost **nothing** in admission delay and the
arms are separated purely by what they made resident. That is the cleanest
possible equal-time comparison and it is why the ladder spans `t_ready`.

Nydus has no API to abort an in-flight prefetch. What continues after the cutoff
is therefore measured, not assumed away: the chunk bitmap at `T_traffic` gives
the exact resident set, and prefetch progress between `T_traffic` and the end of
pass 1 is reported separately as *post-admission proactive prefetch*.

### 8.1 The preregistered budget ladder

Chosen from experiment 4's measured distributions and from nothing else:

| app | E0 prewarm (median) | t_ready (median) | ladder |
| --- | ---: | ---: | --- |
| strapi | 22.7 s | 13.4 s | 2 / 4 / 8 / 14 / 22 s |
| juice-shop | 7.5 s | 5.9 s | 1 / 2 / 4 / 6 / 9 s |
| uptime-kuma | 5.6 s | 6.5 s | 1 / 2 / 3 / 5 / 8 s |

### 8.2 Traffic

Reused unchanged from experiment 4: four families per (app, arm, budget); a
family is a cold trial in which a different long-tail group arrives first;
sequences are deterministic, contain no RNG, and every arm at every budget sees
the identical sequence for a given family. Pass 2 re-runs the identical stream
warm as that arm's own reference. Nothing is weakened, shortened or re-ordered.

The eager arm is re-run in this harness (4 families × 3 apps) as a harness
integrity check — it must reproduce experiment 4's eager behaviour, and its
`PREWARM_DEADLINE_MS` is unset so it runs experiment 4's code path exactly.

---

## 9. Steady state — reused, not redefined

The frozen band from experiment 4 (`../longtail/run-1/band/<app>.json`,
amendment A3b) is used unchanged: **strapi 80 ms, juice-shop 37 ms, uptime-kuma
7 ms**, each the worst rolling-window p99 a fully-warm eager pod actually
produced. Rolling window W = 100 requests, step S = 20, nearest-rank p99.

```text
T_steady   = completion time of the earliest window W_i such that EVERY window
             W_j, j ≥ i, has p99 ≤ BAND. UNDEFINED is a legitimate, reported
             outcome, never silently dropped.
```

Experiment 4's amendment A4 is also reused verbatim, because the same
measurement fact holds: every cold first pass carries an application warm-up
tail the warm pass by definition does not, so the band drawn from the eager
arm's *warm* pass is unreachable by the eager arm's own *cold* pass.

```text
EAGER-MATCHED   an arm is eager-matched at a budget iff its median worst
                post-admission window p99 is ≤ the WORST such value the eager
                arm itself produced across its four families.
```

Both criteria are computed and reported. Neither is redefined because a strategy
performs poorly.

---

## 10. Metrics — formulas fixed before computation

```text
1  time to traffic-warm      T_steady − T0                          (PRIMARY)
   decomposed as             T_traffic − T0   and   T_steady − T_traffic
2  max post-admission p99    max(pass-1 window p99), and its regression against
                             the eager arm
3  post-admission faults     backend.read_count(end of pass 1) − (at admission)
4  post-admission bytes      backend.read_amount_total, same difference
5  first-hit latency         per long-tail category, arrival position 1 only
6  actual prewarm duration   prefetch-last-progress − mount, and the cutoff
                             reason (plateau | deadline)
7  resident at T_traffic     from the chunk bitmap: unique chunks, compressed MB,
                             files fully resident, logical file MB; and the
                             backend request/byte counters at that instant
8  prewarm waste             resident at T_traffic and never touched in pass 1
9  post-admission proactive  prefetch bytes and requests that arrived AFTER
   prefetch                  T_traffic — the deadline's escape hatch, measured
10 cost-model accuracy       predicted vs actual prewarm ms, per arm per budget
```

Two byte currencies, never added: **file bytes** (the ADR-0007 placement model)
and **backend bytes** (what the substrate moved). Every relative number is
printed next to its absolute. No composite score.

### 10.1 Equal-time curves

For each app, `prewarm budget → {T_steady, max post-admission p99, faults,
long-tail first-hit}`, tabulated for G1, G1C, R1, R1C. The commercially relevant
object is the shape of **G1C versus R1C**.

### 10.2 Equal-outcome

Minimum prewarm budget at which each arm is eager-matched, reported as a bracket
between tested budgets. Then `G1C required time` versus `R1C required time`.

### 10.3 The physical oracle

The TEST first-touch set, mapped onto the same chunks and priced with the same
model: oracle chunks, backend requests, backend bytes, predicted prewarm ms.
Computed **after** every deployed manifest is frozen, and never mounted. It
separates *minimum logical bytes* from *minimum physical retrieval cost*.

### 10.4 Why experiment 4's R1 lost — decomposed

For strapi and juice-shop, experiment 4's own R1 and G1 manifests at each byte
budget are re-priced in the new units: files → unique chunks → backend requests →
backend bytes → predicted and measured prewarm duration. Then the same
decomposition for R1C. This is what shows whether R1C *solves the identified
mechanism* rather than accidentally changing the outcome.

---

## 11. Correctness

Unchanged from experiment 4 and not weakened. Every arm must match the eager
arm's behaviour for the exercised traffic, request for request, at every index,
in every pass: same status, same body byte length, same 8 KB body fingerprint
where the body is declared deterministic, same declared comparison header where
it is not. A strategy that avoids latency by failing to execute the intended
long-tail branch is a failure, not a win.

---

## 12. Network sensitivity — one profile, preregistered

Experiment 4's most load-bearing limitation was that the prewarm-time-dominates
conclusion is network-sensitive. One additional profile is therefore run, chosen
here before any R1C result exists:

```text
primary       25 ms RTT, 100 Mbit      (the verdict is based on this)
sensitivity    5 ms RTT, 1 000 Mbit    (strapi and juice-shop, arms G1C and R1C,
                                        at the two middle budgets, 4 families)
```

It answers one question — *was semantic prewarming losing only because the prior
network made physical reads unusually expensive?* — and it is reported as a
separate result. No matrix.

---

## 13. Trial discipline

Reset before **every** trial, unchanged from experiment 4: the blobcache work
dir, the overlay upper and work dirs, the container itself, the `/scratch`
tmpfs, and every application-generated artefact. Scaffolding runs pre-`T0`
against an eager copy of the tree, never against the lazy mount.

The whole (arm × budget × family) grid is walked **family-major with the arm
order rotated per family**, so no arm systematically follows another and none
occupies a contiguous block of wall-clock time. The executed order is preserved
in `run-1/trials/<app>/index.json`.

---

## 14. Adversarial review — the attack list, applied before freezing

Each must be shown addressed or explicitly accepted, in `run-1/ADVERSARIAL.md`:

1. the physical cost model not correlating with real fetch time
2. strategy-specific image packing, or differing image digests between arms
3. R1C receiving TRAIN information by any route
4. G1C receiving an artificially weak generic behavioural ranking
5. the prewarm deadline being measured from different moments across arms
6. content counted as resident before its bytes arrived
7. prefetch continuing after `T_traffic` and being misclassified
8. cache contamination between trials
9. merged backend requests causing double counting
10. compressed versus logical byte confusion
11. the physical cost estimator using TEST information
12. correctness routes not executing
13. network shaping attached in the wrong direction
14. trial-order drift
15. p99 sample instability
16. optimiser coefficients tuned on final outcomes
17. the value transform advantaging one ranking's tier structure over the other
18. the adverse control being won by a generic physical effect wearing semantic
    clothing

Confirmed defects are fixed and **affected trials rerun** before any result is
frozen.

---

## 15. Preservation

```text
benchmarks/costaware/
  DESIGN.md                this preregistration and its amendments
  physical.ts              RAFS chunk extraction, the merge model
  calibrate.ts             neutral probes, merge-rule and time-coefficient fit
  select.ts                the value transform and BOTH selection rules
  run.ts                   prep (manifests) and the measured sweep
  analyze.ts               metrics, curves, equal-outcome, oracle, decomposition
  container/               runner.sh + driver.mjs (diff from experiment 4 in
                           their headers)
  run-1/
    RUN-INFO.md            provenance, versions, digests, deviations
    cost-model.json        the FROZEN calibrated model
    calibration/<app>/     every probe manifest and its measured result
    physical/<app>.json    per-app retrieval-unit facts
    prep/<app>.json        selections per arm per budget, inputs, oracle pricing
    trials/<app>/          one directory per trial: spec, milestones, per-request
                           events, nydus telemetry, chunk bitmaps, app log
    fast/<app>/            the network-sensitivity trials
    <app>.metrics.json     computed per-arm-per-budget metrics
    SUMMARY.md             generated tables and curves
    ADVERSARIAL.md         defects found and fixed; the attack list walked
    FINDINGS.md            the result and the verdict
```

Nothing under `benchmarks/working-set/`, `benchmarks/hydration/`,
`benchmarks/hazard-domain/`, `benchmarks/lazy-oci/` or `benchmarks/longtail/` is
modified.

---

## 16. What each outcome means, and the decision rule

**PROCEED.** Under equal prewarm time on both real positive applications, R1C
drives post-admission faults and long-tail first-hit latency to near the eager
baseline while G1C does not, and `T_steady − T0` is materially better — or R1C
reaches the eager-matched target at a materially smaller prewarm budget. The
adverse control shows no such advantage. The absolute difference must be large
enough that a platform team would act on it.

**CONTINUE ONLY AS ENABLING TECHNOLOGY.** R1C retains better long-tail coverage,
but `T_steady(R1C) ≈ T_steady(G1C)` or the difference is operationally trivial.

**STOP PERFORMANCE WEDGE.** G1C ≈ R1C, or G1C wins: physical cost-awareness
explains the apparent semantic advantage, and the differentiated performance
thesis fails.

**INCONCLUSIVE.** The cost model does not predict actual prewarm cost, or
measurement quality is insufficient.

```text
DECISION RULE. A negative result is NOT rescued with another planner revision.
The project has now tested static sparsity, runtime coldness, commodity lazy
OCI, generic versus semantic prefetch, held-out long-tail generalisation, equal
logical-byte budgets, and — here — semantic prediction under actual retrieval
economics. A negative result closes the loop and performance experimentation
stops.
```

Fewer faults is **not** a result on its own. It counts only if it shows up in
post-admission latency, in time-to-steady-state, or in substantially lower
prewarm cost.

---

## Amendment A1 — the estimator was improved once, on neutral calibration (2026-08-24)

**Recorded before any measured strategy trial ran.** §5 reserves exactly one
improvement of the cost estimator, to be driven by neutral calibration or else
to end the experiment as INCONCLUSIVE. This is that improvement, and this is the
full chronology so it can be attacked.

### What the first probe set missed

The first neutral probe families (`span`, `stride`, `runs`, `uniform`) all take
**one representative file per chunk**. The fitted model reproduced their prewarm
duration at 13.8 % MAPE and predicted experiment 4's eager arm within 1–21 %
out of sample. But a cost-aware manifest is not shaped like any of them: it asks
for *every* file of a contiguous region, and chunk deduplication means many
files share one chunk. Two probe families were added to cover that regime,
defined by blob geometry and a fixed stride alone — no strategy, no trace, no
outcome:

```text
allspan-N-{a,b}   every file entirely inside a contiguous window of N chunks
regions-KxW       every file inside K evenly spaced windows of W chunks
```

They exposed a factor the model had no term for. On strapi's first 500 chunks:

```text
allspan-500-a   1 237 files, 500 chunks   164 backend requests   3 832 ms
allspan-500-b     916 files, 500 chunks    18 backend requests     728 ms
```

Same chunk count, same ~2.9 MB, ninefold difference in time.

### The mechanism, and the fix

nydusd builds one prefetch descriptor per **(file, chunk)** pair from the list —
`prefetch_unmerged_chunks` tracks the *file* count, not the distinct-chunk count
— and merges that stream. When several files share a chunk, the same blob offset
appears at scattered positions, the stream stops being monotone, and merging
collapses into hundreds of small reads.

The fix is to hand nydusd a **minimal chunk cover** instead of a file listing:
one covering file per distinct chunk, ascending, drawn only from files entirely
inside the bought chunk set. Residency is unchanged — a file is resident iff all
its chunks are — so this is a pure win. Verified on the same probe:

```text
1 237-file listing   164 backend requests   3 832 ms
  496-file cover      13 backend requests     593 ms
```

It is applied to **every arm**, cost-aware or not (§7.3). Withholding it from
the cost-unaware control would have been the straw man the adversarial list
forbids, and applying it everywhere leaves the only difference between arms the
selection rule itself.

### What was NOT changed

The fitted coefficients. `(gapBridge, maxRange, fixedMs, α, β)` are exactly the
values §5.3 froze, fitted before this amendment. With cover manifests the
substrate is back in the contiguous-read regime those probes measured, and the
four arms' manifests at a given parameter now measure within a few percent of
each other — strapi at parameter 400 ms: G1 589 ms, G1C 594 ms, R1 584 ms, R1C
586 ms. That equality across arms, not the absolute accuracy, is what the
comparison rests on.

### And a second, larger correction to the design

The same probes showed that the nominal budget parameter is **not** the cost.
Nydus has no API to abort an in-flight prefetch, so a wall-clock deadline gates
admission but does not stop fetching; an arm is held to a cost only if its
manifest genuinely costs that much. §8.1 was therefore changed before any trial:
a **rung is a measured prewarm cost**, and each arm's manifest for a rung is the
candidate whose application-free probe measured nearest that rung. The budget
parameter is demoted to a knob. Every equal-time result is plotted against
measured cost.
