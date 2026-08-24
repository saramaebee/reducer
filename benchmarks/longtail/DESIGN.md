# Experiment 4 — long-tail traffic-warm: does Node semantics generalise beyond workload observation?

**Preregistration. Written and committed before any measured trial of this
experiment ran and before any timing, fetch or coverage outcome was observed.**

ADR-0007 experiment 4. Experiments 1–3 are preserved untouched in
`benchmarks/working-set/first-run/`, `benchmarks/hydration/run-1/` and
`benchmarks/lazy-oci/run-1/`; this directory is new and overwrites nothing.

---

## 1. What experiment 3 left open, and what this one asks

Experiment 3 measured semantic vs generic prefetch on a commodity lazy-OCI
substrate and returned a mixed verdict
(`benchmarks/lazy-oci/run-1/FINDINGS.md`):

```text
recoverability (complete immutable + lazy)     WINS, clearly
readiness advantage of Node semantics          median ≈ 0, three wins three losses
semantic clustering for request merging        REFUTED — trace order merges better
held-out coverage                              the one surviving semantic signal
```

The surviving signal was coverage: generic trace prefetch reached Ready quickly
and then faulted on TEST-only files, adding +294 ms, +339 ms and +1.24 s to
early requests, while the Reducer arms mostly did not. But experiment 3's
held-out surface was *tiny* — 9, 9 and 10 files on three of five apps — because
its TRAIN/TEST split was "phase common" vs "phase full", and `full` was mostly
more ordinary requests over the same code. The coverage result therefore rested
on almost no held-out surface at all.

This experiment tests that surviving signal properly, against a held-out surface
built on purpose:

> **Given a fixed prewarm budget, can Node-semantic planning cover legitimate
> long-tail execution paths better than generic filesystem-trace prefetch, and
> thereby reduce post-admission remote faults and time to steady-state p99?**

and its inverse:

> **To reach the same traffic-warm latency target, does Reducer need materially
> less prewarming than a generic strategy?**

The design is built so that either answer can come out. Several of its
deliberate choices — the app set, the shared size tiebreak, the strength of G2 —
exist specifically to make a negative result reachable.

### Not being tested here

Container slimming, generic image streaming, storage cost, package pruning,
generic Node startup optimisation, security policy, and the dormant
sound-island thesis (FE-1). Experiment 3's recoverability result is already
established and is not re-litigated. Semantic clustering for request merging was
refuted in experiment 3 and is **not** revived: nothing in this design optimises
for chunk merging, and the substrate change in §2 removes layout as a variable
entirely.

---

## 2. Substrate — one image, one packing, one variable

Nydus v2.4.5 (dragonflyoss), RAFS v6 over `nydusd` in fusedev mode, registry
backend, overlayfs upper: the same commodity lazy-OCI data path experiment 3
selected, for the same reasons (§2.1 of `../lazy-oci/DESIGN.md`).

**One change, and it is a strict improvement.** Experiment 3 compiled each arm's
prefetch set into the RAFS bootstrap at build time (`nydus-image
--prefetch-policy fs`). Nydus reorders blob chunks so prefetch-table files are
contiguous, so *every arm had a physically different blob*, and "which files did
the strategy choose" was confounded with "how was the image packed". That was
carried as a limitation and is the most likely explanation for experiment 3's
clustering result.

`nydusd` accepts a prefetch file list **at mount time** (`--prefetch-files`), so
here:

```text
one nydus image per app          one blob, one bootstrap, one chunk layout
every arm mounts THAT image      identical packing, byte for byte
the only difference is the file list handed to --prefetch-files
```

Content identity across arms is no longer something to prove — there is one
image. Adversarial attacks 2, 3 and 18 from experiment 3 are eliminated by
construction rather than mitigated.

Verified before adoption (json-server, 1 288 files): mount with a 134-file
prefetch list, wait for prefetch completion, then read every listed file →
**zero additional backend requests**; then read the whole tree → 3 more
requests. The list is honoured exactly.

```text
image build   nydus-image create --fs-version 6 --compressor zstd
                                 --digester sha256 --chunk-size 0x100000
                                 --repeatable          (NO prefetch policy)
remote        registry:2, real /v2/<repo>/blobs/<digest> HTTP Range requests
mount         nydusd --bootstrap … --prefetch-files <arm's list>
              fs_prefetch {enable:true, threads_count:4, merging_size:131072,
                           prefetch_all:<true only for E0>}
writable      overlayfs: lowerdir=/mnt/rafs, upperdir=tmpfs
telemetry     /api/v1/metrics{,/backend,/blobcache}, sampled every 100 ms and
              snapshotted exactly at admission and at the end of each pass
network       tc netem on the REGISTRY's egress: 25 ms delay, 100 Mbit
```

Environment: macOS 25.1.0 arm64 host; Docker Desktop VM, Linux 6.10.14-linuxkit
aarch64, 10 CPU, 7.65 GiB; `--privileged` (needs `/dev/fuse`, overlayfs, `tc`);
`node:24-bookworm-slim` → Node v24.19.0, the version `.tool-versions` pins.

Only the application universe is lazy; Node and the base OS are eagerly present
in every arm. That removes ~120 MB of download from the eager arm, so it
understates the lazy advantage uniformly.

---

## 3. Application selection — criteria fixed before any outcome

Selection maximises information about *long-tail generalisation* subject to the
hard constraint that the app must boot under Linux arm64 at its frozen SHA. Six
applications: five real, one controlled fixture.

| app | criterion it is in the set for | long-tail mechanisms it exposes |
| --- | --- | --- |
| **juice-shop** | richest genuine request-time module long tail in the corpus | lazy `import()` of large optional subtrees (ethers 19 MB, pdfkit, svg-captcha, pug); a computed `require()` inside express's view-engine resolution (hbs → handlebars); an `import()` hidden behind `new Function('specifier','return import(specifier)')` (libxml2-wasm + .wasm); request-time reads of package asset directories and of config-computed paths; serve-index directory listings |
| **strapi** | the ICP size class — 915 MB, 123 474 files, 2 019 packages; plugin- and config-driven | lazy `require('cheerio')` in a plugin-only handler (+parse5, ~5.5 MB); lazy `await import('file-type')` in the upload pipeline; admin/background surfaces (api tokens, webhooks, preview script read at request time); production-only error paths |
| **verdaccio** | write-path and rare-route long tail on a mid-size tree | publish → dist-tag → deprecate → unpublish lifecycle (tarball validation, storage writes); profile/password rotation (htpasswd rewrite + file locking); error paths through a dead uplink and through tarball validation |
| **uptime-kuma** | **ADVERSE CASE, selected to be able to lose** | its long tail is *asset*-shaped, not module-shaped: the server eagerly requires all 25 monitor-type modules and all ~106 notification providers at boot, so what remains is per-locale and per-route frontend chunks served from `dist/assets`. Generic directory widening should cover those better than any module-graph reasoning can. |
| **json-server** | smaller/control application, 3.2 MB universe | none expected. Included as the negative control. |
| **nextjs-longtail** | controlled fixture; self-hosted Next.js is the stated ICP shape | module-shaped (per-route chunk + external subtree), data-shaped (per-locale catalogue and content directory read from disk), config-shaped (per-tenant config file + per-tenant renderer) — all six categories, by construction |

Two of the six are in the set because the hypothesis is expected to do *badly*
on them (uptime-kuma, json-server). That is deliberate: a favourable-only
selection would make a positive result unreportable.

**n8n** (2 074 MB, the largest corpus app) is again excluded: experiment 3
recorded that its analysis phase did not complete in over two hours at ~9 GB
RSS. **express-realworld** is excluded because experiment 3 measured its
held-out surface at 9 files / 0.1 MB and json-server already carries the control
role more cheaply. Both exclusions are decided here, before any outcome.

App SHAs, image digests and universe sizes are recorded per app in
`run-1/prep/<app>.json`.

### 3.1 The controlled fixture, and what it may and may not conclude

`benchmarks/longtail/fixture-app` is a self-hosted Next.js 15 App Router
application authored in this repository. Its purpose is **interpretability, not
headline evidence**: it answers *why* one strategy generalises better, on a tree
whose long tail is known by construction and spans all six categories. Real
applications answer whether the advantage exists outside a construction. The two
conclusions are reported separately, and **a fixture-only win is reported as
negative/inconclusive for product differentiation.**

Every mechanism in it is an ordinary ecosystem pattern: a message catalogue and
content directory read from disk per locale (the `i18next-fs-backend` /
`next-intl` file-loader shape), a per-tenant JSON config read from a config
directory selecting a dynamically imported renderer, an admin export behind a
heavy optional library, per-format dynamic imports on a report route, lazily
loaded error-reporting libraries, and a feature flag read from configuration
gating a conditional import. Nothing is contrived to defeat tracing.

Two build settings are recorded because they are findings in themselves:

- `serverExternalPackages` keeps the heavy leaf libraries as real `node_modules`
  requires instead of being inlined into a server chunk — the ordinary
  configuration for large server dependencies.
- `experimental.preloadEntriesOnStart: false`. **Next's production server
  otherwise preloads every app route module at startup**, pulling each route's
  whole external dependency subtree into memory before the first request:
  measured here at **968 files resident before any traffic, versus 377 with the
  option set**. That is a real property of self-hosted Next.js App Router — it
  means a default-configured Next deployment has essentially no module-shaped
  long tail at all — and it is reported, not hidden. The option is Next's own
  documented opt-out.

---

## 4. TRAIN, LONG-TAIL TEST, SHARED

```text
TRAIN      startup + the COMMON request set, cycled 6×.
           The ONLY application behaviour G1, G2 and R2 observe.
LONG-TAIL  legitimate production behaviour COMMON does not reach, organised
TEST       into GROUPS. A group is one atomic unit of application behaviour
           (a publish→deprecate→unpublish lifecycle, an authenticate-then-use
           pair) and is the unit the traffic model permutes.
SHARED     process startup, and a per-app PRELUDE of one-time state
           establishment (admin registration) that every trial performs
           identically and that is measured like any other request.
```

Every long-tail group carries, in `workloads.ts` and reproduced verbatim into
`run-1/prep/<app>.json`:

- **`why`** — the argument that a real deployment genuinely serves this path;
- **`mechanism`** — the Node behaviour it exercises;
- **`category`** — one of `rare-route`, `error-path`, `locale`, `tenant-config`,
  `optional-feature`, `admin-background`.

Every candidate came from reading the application's own route table and source;
none was invented. The surveys that produced them are recorded in §5 of the
findings with file:line citations.

**Legitimacy is checked empirically, not asserted.** A held-out path counts only
if the observation run shows it returning a status in its declared `expect` set
*and* the per-request first-touch attribution shows what it actually loaded. A
group whose requests all 4xx for an unintended reason (auth misconfiguration, a
route that does not exist at this SHA) is struck from the analysis and said so.

**Categories a given app does not have are declared absent, not faked.** Locale
is absent for verdaccio (the server never reads a locale file), for strapi
(`?locale=xx` loads zero extra server files) and for juice-shop (all 43
catalogues are read at boot). uptime-kuma's tenant and admin surfaces need
socket-driven seeding that was deliberately not built, and no claim is made
about those categories for that app.

---

## 5. The timeline — and why Ready is not the metric

```text
T0          container start; the instant the image is asked for
t_proc      the application process is exec'd
t_ready     the application's own readiness predicate passes
t_prewarm   the substrate reports the arm's permitted prewarm complete
T_traffic   = max(t_ready, t_prewarm)          ← TRAFFIC IS ADMITTED HERE
… pass 1 …  the measured post-admission stream
T_steady    steady-state latency established (§8)
… pass 2 …  the identical stream again, everything now resident: the warmed
            reference for THIS arm
```

The primary interval is **`T_steady − T0`**, not `t_ready − T0`. A strategy that
reports Ready earlier by pushing work onto production requests has not won, and
admitting traffic on Ready would reward exactly that. `t_ready` is recorded for
every trial and reported as a diagnostic.

The application process is started **concurrently** with prewarm, which is what
a pod does: the kubelet starts the container while the snapshotter is still
fetching.

---

## 6. Arms

```text
E0   eager reference   prefetch_all, traffic admitted only when prefetch completes
G1   generic           the literal TRAIN trace, in first-access order
G2   generic widened   the strongest widening definable without Node knowledge
R1   Reducer static    Node semantics, NO workload evidence at all
R2   Reducer + TRAIN   exactly G1/G2's evidence, widened by Node semantics
O    oracle            the TEST first-touch set — ANALYSIS ONLY, never deployed
```

The headline comparison is **R2 vs the better of G1 and G2**, per app, per
budget, per metric. R1 matters because it tests whether semantics is worth
anything with no training run at all — experiment 3's one reliable Reducer
property came from that arm.

The oracle is not a deployable strategy and is never presented as one. It gives
the lower bound: the smallest prewarm perfect future knowledge would have
needed.

### 6.1 The information boundary

| information | G1 | G2 | R1 | R2 | O |
| --- | --- | --- | --- | --- | --- |
| universe path strings | ✓ | ✓ | ✓ | ✓ | ✓ |
| directory structure | — | ✓ | ✓ | ✓ | ✓ |
| file size | — | ✓ | ✓ | ✓ | ✓ |
| TRAIN access log (path + first-content-read timestamp) | **✓** | **✓** | — | **✓** | ✓ |
| package identity and boundaries | — | — | ✓ | ✓ | ✓ |
| `@vercel/nft` positive trace + module-graph order | — | — | ✓ | ✓ | ✓ |
| resolver metadata semantics (package.json precedes resolution) | — | — | ✓ | ✓ | ✓ |
| opaque-boundary (native/WASM/install-script) classification | — | — | ✓ | — | ✓ |
| declared package dependency graph, Node-resolved | — | — | ✓ | ✓ | ✓ |
| **anything derived from the LONG-TAIL TEST workload** | — | — | — | — | **✓** |

R2 receives **exactly** G1/G2's behavioural evidence plus the static Node rows.
Every strategy's consumed inputs are enumerated in code (`strategies.ts`,
`Ranking.inputs`) and emitted verbatim into `run-1/prep/<app>.json`.

One tiebreak — **ascending file size** — is deliberately shared by G2, R1 and
R2. A remote fault costs roughly one round trip regardless of the file's size,
so "more files per prewarmed byte" is a real advantage; giving it to only one
side would be a straw man in whichever direction it fell.

---

## 7. The strategies — total rankings, frozen before any TEST outcome

Every strategy returns a **total ranking of the production universe**, not a
set. A budget is a greedy fill of that ranking (§8.1). This is what makes the
equal-cost comparison exact: at a given budget every arm prewarms the same
number of file bytes and differs only in which files it chose.

### G1 — the literal generic trace

```text
tier 0   TRAIN-touched files, in first-access order
tier 1   everything else, by lexicographic path        (no signal, by design)
```

Above its own size G1 has, by construction, nothing further to say. That is not
a weakened baseline — it is what "prefetch the trace" *is*. The generic strategy
that generalises beyond the trace is G2, and the comparator is
`best(G1, G2)`.

### G2 — the strongest generic widening

```text
tier 0   TRAIN-touched files, in first-access order
tier 1   every other file, ordered by
           (a) DISTANCE from its directory to the nearest directory containing
               a TRAIN-touched file, in edges of the directory tree
           (b) the TRAIN first-access time of that nearest anchor
           (c) ascending file size
           (d) path
```

Distance 0 is exactly experiment 3's B2d (one-level directory expansion);
distance 1 adds parents and siblings; and so on. This is a genuine
generalisation, not a straw man: in a `node_modules` tree the files of one
package are near each other, so distance-based widening approximates package
widening *without ever knowing what a package is*. It is strictly stronger than
B2d, and it may use path, directory structure, TRAIN order and file size — and
nothing else.

### R1 — static semantics, no workload evidence

```text
tier 0   the entrypoint
tier 1   every package.json in the universe (resolver metadata)
tier 2   NFT-positive files, in module-graph depth-first order
tier 3   the remaining ADR-0007 Plan B forced-hot set (opaque boundaries)
tier 4   the rest of every package the module graph proved live
           (package by first graph rank; within a package: graph order, then
            ascending size)
tier 5   packages reachable over the DECLARED dependency graph
           (by hop depth from the application, then ascending size)
tier 6   remainder, ascending size then path
```

### R2 — semantics given exactly G1/G2's evidence

```text
tier 0   TRAIN-touched files, in first-access order       (identical to G1)
tier 1   every package.json in the universe
tier 2   NFT-positive files of packages TRAIN touched
tier 3   the REST of every package TRAIN touched
tier 4   NFT-positive files of packages TRAIN did not touch
tier 5   packages reachable over the declared dependency graph from a
           TRAIN-touched package, by hop distance
tier 6   remainder, ascending size then path
```

Tiers 3 and 5 encode the hypothesis under test: a package the workload proved
live is likely to have more of itself needed (the locale directory, the sibling
module, the error formatter); and a package one declared dependency hop from a
live package is the next most likely, which is how an optional feature's library
gets covered without the workload ever having exercised that feature.

This is deliberately **not** "prefetch the whole package": experiment 1 measured
57.8 % of cold bytes inside partially-HOT packages, so whole-package widening
spends exactly the file-level sparsity this direction exists to exploit. The
budget sweep is what keeps that honest — if R2's early tiers are bloated, it
loses at small budgets, and the curve will say so.

No machine learning. No predictor invented for this benchmark. Every input
already existed in the repository except the declared dependency graph, which is
`plan.ts:packageDependencyGraph` and is Node's own resolution algorithm.

---

## 8. Budgets, traffic, and steady state

### 8.1 The prewarm budget sweep

Preregistered budgets, as a fraction of universe **file** bytes:

```text
5 %    10 %    20 %    40 %
```

Truncation is a greedy fill in ranked order: walk the ranking, take each file
that still fits, skip one that does not, stop when nothing further fits.
Skip-and-continue rather than stop-at-first-overflow, because a hard prefix
would let one large file early in a ranking discard the whole remaining budget —
an artefact of the truncation rule, not a property of the strategy. Identical
for all four arms and for the oracle.

**File bytes, not chunk bytes.** File bytes are the only currency every strategy
controls exactly and every arm is charged identically in, so "equal cost" is
equal by construction. What the substrate actually moves (compressed chunk
bytes, backend request count) is measured separately and always reported beside
it.

The reference budget for the headline equal-cost table is **10 %**.

### 8.2 The traffic model

Four **families** per (app, arm, budget). A family is a cold trial in which a
different long-tail group arrives first:

```text
prelude (once)
then, phase 1:  2 common requests, then one long-tail group — repeated until
                every group has arrived once. The first unusual request is
                therefore at stream position 3, and WHICH group that is rotates
                by family.
then, phase 2:  4 common requests, then one repeatable long-tail group,
                cycling, until the stream reaches 400 post-prelude requests.
```

Every arm at every budget sees the **identical** sequence for a given family.
Sequences are constructed deterministically (`traffic.ts`) with no RNG, and are
emitted into each trial's `spec/spec.json`.

Pass 2 re-runs the identical stream with everything now resident: that is the
arm's own warmed reference, and it is how we check that every arm converges to
the same steady state rather than one being permanently slower.

**Warm-order contamination is modelled, not assumed away.** Within one trial an
earlier long-tail group can hydrate files a later one needs. Two things bound
it:

1. the family rotation puts a different group in the first slot, so the
   uncontaminated "first unusual request on a cold pod" measurement exists for
   four distinct groups per app, and the headline first-hit number is
   **position 1 only**;
2. per-category **coverage** — which of a category's files a budget did and did
   not prewarm — is computed analytically from the ranked set against the
   per-category first-touch oracle. That is exact for every category and cannot
   be contaminated by execution order at all.

Measured first-hit latency is always reported with the group's arrival position.

### 8.3 Steady state — the criterion, and how its constant is fixed

Rolling window over pass 1: **W = 100 requests, step S = 20**. Window p99 is the
nearest-rank 99th percentile of the window's latencies.

```text
T_steady = the completion time of the earliest window W_i such that EVERY
           window W_j, j ≥ i, has p99 ≤ BAND.
           If no such window exists, T_steady is UNDEFINED and the trial is
           reported as "steady state not reached within the stream" — a
           legitimate and informative outcome, never silently dropped.
```

`BAND` is derived from measurement stability, exactly as required, and is fixed
before any strategy trial is analysed:

```text
primary       BAND = max over ALL E0 pass-2 windows, across all E0 families
              and repetitions, of the window p99.
              (the worst window a fully-warm eager pod actually produced —
               no tunable constant, and nothing that can be adjusted afterwards)

sensitivity   BAND' = median + 3 × MAD of the same distribution.
              Reported alongside; if the two disagree on any headline claim,
              that disagreement is the result.
```

**Procedure, so the constant cannot be chosen to suit an outcome:** this file is
committed first; then the E0 trials are run for every app; then `BAND` and
`BAND'` are computed from E0 alone and appended to this file as a dated
amendment; only then are the G1/G2/R1/R2 trials run. The commit history is the
proof.

### 8.4 The traffic-warm target (equal-outcome)

```text
TRAFFIC-WARM  an arm is traffic-warm at a budget iff EVERY pass-1 window p99
              is ≤ BAND — equivalently T_steady = T_traffic, "warm on arrival".
```

Equal-outcome result = the **minimum budget at which an arm is traffic-warm**,
reported as a bracket between the tested budgets (e.g. "between 10 % and 20 %"),
since the sweep is discrete. The operator's criterion is a latency one ("no p99
regression at the edge"), so the target is defined on latency; post-admission
remote faults and bytes are reported next to it, never folded into it.

---

## 9. Metrics — formulas fixed before computation

Ranked by importance, as the goal specifies.

```text
1  time to traffic-warm        T_steady − T0            (primary)
2  max post-admission p99      max(pass-1 window p99) − median(E0 pass-2 window p99)
   regression                  reported in absolute ms
3  post-admission remote       backend.read_count(end of pass 1) − (at admission)
   faults                      unique files: from the analytic coverage model
4  post-admission remote       backend.read_amount_total(end of pass 1) − (at admission)
   bytes
5  first-hit latency per       the latency of a group's first request, reported
   long-tail category          with its arrival position; headline = position 1
6  prewarm bytes               file bytes (the budget) AND chunk bytes moved
7  prewarm duration            t_prewarm − t_mount
8  waste                       prewarmed file bytes never touched during pass 1
```

Also retained and reported, but never allowed to dominate: `t_ready`, first
successful request time, p50/p95, remote operation count, nydusd + app CPU
seconds from cgroup accounting.

Two byte currencies, never added together: **file bytes** (whole-file placement,
the ADR-0007 model) and **chunk bytes** (what the substrate moved). Every
relative number is printed next to its absolute. No composite score is computed.

### 9.1 Long-tail coverage, per category

For each category, computed analytically from the ranked set against the
per-category first-touch oracle (exact, contamination-free):

```text
needed TEST files/bytes already resident at T_traffic
post-admission miss files/bytes
first-hit added latency (measured, position-annotated)
```

Grouped by `rare-route`, `error-path`, `locale`, `tenant-config`,
`optional-feature`, `admin-background`, and reported per app. Categories a given
app does not have are declared absent (§4).

### 9.2 Oracle efficiency

```text
strategy prewarm bytes / oracle bytes at the same coverage
avoidable post-admission misses = misses the oracle would not have had
```

### 9.3 Training-matrix sensitivity (secondary)

The product-derived question: if generic tracing loses because TRAIN did not
cover the long tail, how much *more* training does generic need to catch up?

Computed analytically, no extra trials:

```text
TRAIN-1 = common only                                (the primary TRAIN)
TRAIN-2 = common + one long-tail category
TRAIN-3 = common + two categories
…
```

Each augmented TRAIN is a superset of first-touch observations already recorded
in the observation runs, so G1/G2 can be re-ranked against it directly. The
question answered is whether generic coverage approaches R2's with a small
number of added categories (which weakens the product thesis) or needs a
combinatorially exhaustive matrix (which strengthens it). This is bounded to the
per-category augmentations, not the full power set.

---

## 10. Correctness

Every arm must match E0's behaviour for the exercised traffic. Per request the
driver records status, an 8 KB body fingerprint, and any declared comparison
header. The gate:

```text
same status for every request, at every index, in every pass
same body fingerprint wherever the request is declared body-stable
same comparison header where one is declared
```

`stableBody: false` is declared per request, in advance, only where the body
legitimately varies (generated ids, zip mtimes in an xlsx export, JWTs); those
requests are still compared on status and, where available, on a declared
header. **A strategy that avoids latency by failing to exercise the intended
branch is a failure, not a win**, and the declared `expect` set on every request
is what makes that detectable.

---

## 11. Cold-start discipline and trial ordering

Reset before **every** trial: the blobcache work dir, the overlay upper and work
dirs, the container itself (so the page cache for the mount dies with it), the
`/scratch` tmpfs, and every application-generated artifact. Scaffolding runs
pre-`T0` against an eager copy of the tree, never against the lazy mount, so it
cannot warm the cache for whichever arm ran it.

Cannot be reset, documented instead: the VM's page cache over the registry's own
blob storage (warm equally for every arm) and the host SSD.

The whole (arm × budget × family) grid is walked **family-major with the arm
order rotated per family**, so no arm systematically follows another and no arm
occupies a contiguous block of wall-clock time. The exact executed order is
preserved in `run-1/trials/<app>/index.json`.

---

## 12. Adversarial review — the attack list, applied before freezing

Each must be shown addressed or explicitly accepted:

1. TRAIN/TEST leakage into any deployable strategy
2. unequal byte budgets between arms
3. semantic strategies receiving more TRAIN evidence than generic ones
4. the generic baseline being artificially weak
5. long-tail routes not actually executing (auth/config failures counted as success)
6. earlier long-tail groups warming later ones
7. warm caches between trials
8. prewarm byte accounting differing between arms
9. Nydus chunk-level effects making file counts misleading
10. different packing/layout across arms
11. Ready versus traffic-admission confusion
12. p99 sample sizes too small for the claim
13. steady-state criterion instability, or chosen after seeing results
14. oracle contamination
15. hidden child processes and workers
16. generated runtime files counted as image files
17. background work continuing after admission
18. strategy-specific instrumentation effects
19. the fixture carrying a conclusion the real applications do not support

Known in advance and carried into the review: **juice-shop runs a background
loop every 5 s that recursively reads `routes/`, `lib/`, `data/`, `models/`,
`infrastructure/` and `frontend/src/app`** for its code-snippet challenge index.
Those trees are hydrated on every arm within seconds of process start,
independent of traffic. No long-tail candidate depends on them and the effect is
identical across arms, but it inflates that app's TRAIN set and it is live
during the post-admission window (attack 17).

Confirmed defects are fixed and **affected trials rerun** before any result is
frozen.

---

## 13. Preservation

```text
benchmarks/longtail/
  DESIGN.md               this preregistration
  apps.ts                 app selection + criteria + mechanisms
  workloads.ts            TRAIN / long-tail TEST, with why + mechanism per group
  traffic.ts              the deterministic traffic model
  strategies.ts           the four rankings + the oracle + budget truncation
  plan.ts                 universe, NFT, Plan B, declared dependency graph
  run.ts                  prep and the measured sweep
  analyze.ts              metrics, curves, steady state, equal-cost/equal-outcome
  fixture-app/            the controlled Next.js fixture, source + lockfile
  materialize-fixture.sh  its reproducible build
  run-1/
    RUN-INFO.md           provenance, versions, digests, deviations
    prep/<app>.json       universe, image digest, TRAIN/TEST/held-out surface,
                          per-category held-out sets, strategy inputs, budgeted
                          list sizes, the long-tail table with why + mechanism
    prefetch/<app>/       the exact frozen rankings, per arm
    trials/<app>/         one directory per trial: spec, milestones, per-request
                          events, 100 ms fetch samples, nydus telemetry, app log
    <app>.metrics.json    computed per-arm-per-budget metrics
    SUMMARY.md            generated tables and efficiency curves
    ADVERSARIAL.md        defects found and fixed; the attack list
    FINDINGS.md           the result and the verdict
```

Nothing under `benchmarks/working-set/`, `benchmarks/hydration/`,
`benchmarks/hazard-domain/` or `benchmarks/lazy-oci/` is modified.

---

## 14. What each outcome means

**Strong positive.** Across credible real applications, at an equal budget, R2
drives post-admission remote faults and long-tail first-hit latency to near the
eager baseline while `best(G1,G2)` leaves a large, consistent gap — or R2 
reaches the traffic-warm target at a materially smaller budget. The absolute
difference must be large enough that a platform team would act on it.

**Negative.** `best(G1,G2)` ≈ R2 at equal budgets on long-tail latency and
time-to-steady-state; or generic needs only trivial additional training (§9.3)
to close the gap.

**Over-prefetch failure.** R2 covers the long tail only by making nearly the
whole universe resident. The budget sweep is what exposes this.

**Fixture-only.** A strong fixture result without real-application support is
reported as negative/inconclusive for product differentiation.

Fewer misses is **not** a result on its own. It counts only if it shows up in
post-admission latency, in time-to-steady-state, or in substantially lower
prewarm cost.

---

## Amendment A1 — the shared widening rule (2026-08-24)

**Recorded before any measured strategy trial ran.** Detected during pilot
validation of the controlled fixture, from the *analytic* coverage of the ranked
sets — no trial, no latency, no timing was involved.

### What was wrong

§7 as first implemented ordered each strategy's widening as a sequence of
lexicographic tiers: distance class first, size only as a tiebreak inside it.
One enormous distance class then starves every later one. On the Next.js
fixture, R2's class "the rest of a package TRAIN touched" is ~200 MB — almost
all of `next/` — so R2 spent every budget from 5 % to 40 % inside that one class
and never reached the dependency closure where the optional features live:

```text
                covered needed files, by budget (fixture, pre-amendment)
        5 %     10 %    20 %    40 %          of 1 155 needed
G1      522     502     522     972
G2      445     449     452     762
R1      347     348     486     886
R2      536     536     536     588      ← flat: never leaves one class
O      1155    1155    1155    1155
```

Worse, that class was ordered **package-major** — files grouped by owning
package, one package exhausted before the next. That is precisely the
same-package clustering hypothesis experiment 3 **refuted**, and which §1 of
this document says this experiment does not revive. It had been carried over
from experiment 3's B3b without being re-justified.

This is a specification defect, not an unfavourable outcome: the ranking
contradicted the design's own stated intent (§7: "deliberately not 'prefetch the
whole package' … whole-package widening spends exactly the file-level sparsity
this direction exists to exploit").

### The fix

One widening function, used verbatim by G2, R1 and R2:

```text
key(f) = min(distance(f), 16) + log2(size(f) + 1)        ascending
       ≡ order by  size(f) × 2^distance(f)
```

Prefer small files; charge one doubling of size per unit of distance from what
is already known. No class can starve another, and coverage becomes monotone in
budget.

**The only difference between the strategies is now what "distance" means** —
which is exactly the question this experiment asks:

| arm | distance |
| --- | --- |
| G2 | edges of the DIRECTORY TREE to the nearest directory a TRAIN-touched file lives in |
| R1 | declared-dependency hops from the entrypoint's package closure; 0 for a package the module graph proved live |
| R2 | declared-dependency hops from the set of packages TRAIN touched, minus 0.5 when the file carries positive NFT evidence |

Strict, non-widening tiers are unchanged: TRAIN order / entrypoint, resolver
metadata, NFT-positive evidence, and (R1 only) the ADR-0007 Plan B forced-hot
set still precede the pool in the order §7 gives.

The change makes the generic arm **stronger** as well as the semantic arms —
G2's widening now also maximises files-per-byte — so it moves in the direction
that favours the null hypothesis. Nothing about the information boundary (§6.1)
changed: G2 still may not see a package, a module edge or a resolver rule.

---

## Amendment A2 — all prediction goes in the pool (2026-08-24)

**Recorded before any measured strategy trial ran.** Same pilot as A1, same
analytic-coverage-only evidence, same day, same commit sequence.

After A1 the arms were still not structurally comparable. G2's *entire*
speculation lives inside the size-disciplined pool, but R1 and R2 still carried
speculative tiers ahead of theirs — R2 emitted every NFT-positive file of every
TRAIN-touched package strictly before widening, and R1 emitted the whole
ADR-0007 Plan B forced-hot set. On the fixture those tiers alone exceed the 10 %
budget (`next/`'s NFT closure is bytes-heavy), so R2's coverage was still
essentially flat at 536 files from 5 % to 10 %, and R1's at ~348. The semantic
arms were being judged on a tier structure the generic arm did not have.

**The fix.** Only what is *certain* stays strict:

```text
G1, G2   strict: the TRAIN trace
R2       strict: the TRAIN trace, then every package.json (resolver metadata:
                 Node must read these before anything resolves at all)
R1       strict: the entrypoint, then every package.json
everyone else:   the size-disciplined pool, key = distance + log2(size+1)
```

NFT positive evidence and Plan B forced-hot membership are *predictions*, not
observations, so they now express themselves as a shorter semantic distance
inside the pool rather than as an exemption from the budget discipline:

```text
R1 distance   0    positive module-graph evidence
              0.5  Plan B forced-hot (opaque native/WASM/install-script boundary)
              1    any other file of a package the graph proved live
              1+h  a package h declared-dependency hops from the entry closure
R2 distance   0    graph evidence in a package the workload touched
              1    any other file of a touched package, or graph evidence
                   in an untouched one
              1+h  a package h declared-dependency hops from the touched set
```

The four arms are now identical in structure — `strict certainty ∥ pooled
prediction` — and differ in exactly two things: what each is allowed to know
(§6.1), and how each measures distance. No further knob exists to turn.

### The pre-amendment numbers, so the amendments cannot hide a result

Covered needed files (of 1 155) on the controlled fixture:

```text
              5 %    10 %    20 %    40 %
pre-A1  G2    445     449     452     762
        R1    347     348     486     886
        R2    536     536     536     588
post-A1 G2    767    1049    1148    1155
        R1    347     348     486     886      (unchanged: strict tiers dominated)
        R2    536     536     866    1155
post-A2 G2    767    1049    1148    1155
        R1    828    1040    1146    1155
        R2    818    1032    1152    1155
```

Both amendments were made for structural reasons and both **strengthen the
generic arm** as well as the semantic ones. Note what the corrected table
already shows on the fixture that was built to favour semantics: once every arm
is under the same size discipline, generic directory distance and Node
package distance produce **almost the same coverage curve**. That is a
preliminary negative signal, it is recorded here before any latency was
measured, and it is not going to be tuned away.

### Sensitivity required of the analysis

Because the shared `log2(size)` term is doing real work, the analysis must also
report coverage under a **distance-only** ranking (no size term) for every arm,
so that the conclusion is shown not to be an artefact of the size normaliser.

---

## Amendment A3 — the prewarm-complete signal, and the frozen band (2026-08-24)

**Recorded after the E0 (eager) trials and before any strategy trial ran**, which
is the order §8.3 requires.

### A3a — the prewarm signal was wrong, and it was fixed

The first implementation admitted traffic when nydus's
`blobcache.prefetch_end_time_secs` became non-zero. That counter is set almost
immediately, long before the prefetched bytes have arrived. Measured on the
eager arm of the Next.js fixture: prefetch reported "ended" at **t0 + 297 ms
with 64.6 MB of its 92.4 MB blob still unfetched**, and 155 further remote
requests then landed *during* the post-admission stream — i.e. the eager
reference was not eager, and the experiment's whole distinction between Ready
and traffic-warm would have been silently destroyed.

`blobcache.prefetch_data_amount` counts prefetched bytes and only prefetched
bytes (an on-demand fault does not move it), so prewarm is now detected as that
counter going quiet: polled at 100 ms, six consecutive unchanged samples. The
detection lag is charged identically to every arm, and the last-progress instant
is recorded separately as the true prefetch end, so prewarm *duration* is not
inflated by the detector.

Verified on the re-run: every app's eager arm now fetches its **entire** blob
before admission and records **zero** post-admission remote requests.

```text
app               blob MB   fetched at admission   post-admission requests
json-server           1.2                    2.2                         0
verdaccio            17.7                   17.7                         0
nextjs-longtail      92.4                   92.4                         0
juice-shop           75.8                   75.9                         0
uptime-kuma          57.1                   58.1                         0
strapi              229.1                  229.4                         0
```

### A3b — the frozen band

Computed from the eager arm's warm pass alone, per app, over 4 families × 16
rolling windows = 64 warm windows each. **These values are now frozen.**

| app | warm median window p99 | **BAND (primary)** | BAND′ (median + 3·MAD) |
| --- | ---: | ---: | ---: |
| uptime-kuma | 7 ms | **7 ms** | 7.0 ms |
| nextjs-longtail | 9 ms | **12 ms** | 9.0 ms |
| json-server | 10 ms | **15 ms** | 16.0 ms |
| juice-shop | 33 ms | **37 ms** | 36.0 ms |
| strapi | 78 ms | **80 ms** | 80.0 ms |
| verdaccio | 141 ms | **156 ms** | 144.0 ms |

The two definitions agree closely everywhere, which is the point of reporting
both: no headline claim can turn on which was chosen. Note how tight several of
these are — uptime-kuma's band is 7 ms — so on those apps any real prewarm
shortfall will show up immediately, and any *absence* of a difference is a
genuine null rather than a slack criterion hiding one.

---

## Amendment A4 — the analysis addition, and why it was needed (2026-08-24)

**Made after the strategy trials, and therefore the one amendment that could in
principle have been chosen to suit an outcome.** It is recorded here in full, the
preregistered criterion is still computed and reported unchanged beside it, and
the reasoning is stated so it can be attacked.

§8.4 defines traffic-warm as every post-admission window p99 falling inside a
band derived from the eager arm's **warm** pass. Measured, that target is
unreachable — **by the eager arm itself**. Every cold first pass carries an
application warm-up tail (V8 tiering, first-request initialisation, lazy
in-process caches) that the warm pass by definition does not contain. On
verdaccio, juice-shop, strapi and the fixture, E0 is 0/4 "traffic-warm" against
its own band; on uptime-kuma it is 2/4. A criterion that the reference arm fails
cannot separate the strategies.

The addition asks the question the operator's own framing implies instead:

```text
EAGER-MATCHED   an arm is eager-matched at a budget iff its median worst
                post-admission window p99 is <= the WORST such value the eager
                arm itself produced across its four families.
```

The eager arm's own worst family, not its median: a median is a bound the
reference fails half the time, and on strapi the arms sit within 2–5 ms of it, so
a median threshold would decide the headline on measurement noise.

Both criteria appear in `SUMMARY.md` §5 and §5b, and `FINDINGS.md` reports the
eager-matched one because it is the answerable one. Nothing else about the
analysis changed after the strategy trials ran.
