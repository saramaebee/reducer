# Refute-by-default review — long-tail traffic-warm experiment

Every defect below was found and fixed **before** the headline result existed,
and each is recorded with what it would have done to the conclusion had it
survived. The attack list is [`../DESIGN.md`](../DESIGN.md) §12; this file walks
it and says, for each item, addressed or accepted.

---

## Part 1 — defects found and fixed

### D1 — the semantic arms' only non-generic input was empty on two of six apps

`plan.ts:packageDependencyGraph` seeded its BFS from the tree root. A workspace
monorepo's root `package.json` declares nothing but devDependencies and a
`workspaces` glob, so **verdaccio and strapi each resolved to exactly one
reachable package**. The declared dependency graph is the one input R1 and R2
have that G1/G2 do not; on those two apps it was silently empty.

*Fix:* seed from the entrypoint's own owning package as well as the root.
verdaccio went 1 → 248 reachable packages, strapi 1 → 1 424.

*Had it survived:* R1/R2 would have been reported as no better than generic on
the two largest real applications, for a reason that had nothing to do with the
hypothesis. It would have biased the result **against** Reducer.

Related, same root cause: package directories are recorded in realpath-deduped
space by the universe walk, so a pnpm symlink candidate has to be realpath'd
before it can be matched. Without that, *every* pnpm tree resolves to zero
edges.

### D2 — the widening order was the clustering hypothesis experiment 3 refuted

Recorded in full as [DESIGN.md amendment A1](../DESIGN.md#amendment-a1). Each
strategy widened as lexicographic (distance-class, then size) tiers, so one
enormous class starved every later one: R2's "the rest of a package TRAIN
touched" is ~200 MB on the Next.js fixture (almost all of `next/`), and R2's
coverage was **flat at 536 of 1 155 needed files from 5 % to 40 % budget**. The
class was also ordered package-major — the same-package clustering that
experiment 3 refuted and that DESIGN.md §1 says this experiment does not revive.

*Fix:* one shared widening rule, `key = distance + log2(size+1)`, used verbatim
by G2, R1 and R2.

### D3 — the arms did not have the same structure

Recorded as [amendment A2](../DESIGN.md#amendment-a2). After D2, G2's entire
speculation sat inside the size-disciplined pool while R1 and R2 still emitted
speculative tiers ahead of theirs. On the fixture those tiers alone exceed the
10 % budget.

*Fix:* only certainty is strict (the trace, or the entrypoint, plus resolver
metadata for the Node-aware arms). All prediction — NFT evidence included — now
expresses itself as a shorter distance inside the same pool.

*Note the direction:* D2 and D3 both **strengthen the generic arm** as well as
the semantic ones. Neither was made to rescue a number, and the pre-amendment
numbers at every stage are printed in DESIGN.md.

### D4 — the eager reference was not eager (the most dangerous one)

Recorded as [amendment A3](../DESIGN.md#amendment-a3). Traffic was admitted on
nydus's `blobcache.prefetch_end_time_secs`, which is set almost immediately
rather than when the bytes land. Measured: the Next.js **eager** arm reported
prefetch complete at t0 + 297 ms with **64.6 MB of its 92.4 MB blob still
unfetched**, then took 155 further remote requests *during* the post-admission
stream.

*Had it survived:* the arm the whole experiment measures everything against
would itself have been faulting during the measurement window, the band would
have been inflated by those faults, and every strategy would have looked
traffic-warm. The experiment's central distinction — Ready is not traffic-warm —
would have been destroyed silently, with no failing test to reveal it.

*Fix:* detect the plateau of `blobcache.prefetch_data_amount` (six quiet 100 ms
samples); that counter moves for prefetch and never for an on-demand fault. All
E0 trials were re-run: every app now fetches its entire blob before admission
and records **zero** post-admission remote requests.

### D5 — a request that never answers

verdaccio never responds to `GET /.env`, so every occurrence burned the full
request timeout. At 4 occurrences per observation run it dominated the entire
run (120 s of a 130 s workload).

*Fix:* the route is removed as *unmeasurable* — explicitly not as unfavourable —
and the driver's default request timeout is lowered from 30 s to 10 s so that a
non-answering route costs a recognisable failure rather than minutes of wall
clock. Anything legitimately slower declares its own `timeoutMs`.

### D6 — the benchmark reached the real internet

The trial container can route to the public internet through the docker bridge,
so verdaccio's `npmjs` uplink was contacting `registry.npmjs.org`. The
unknown-package 404 path therefore depended on an external service and cost
~15 s per request.

*Fix:* the scratch config points the uplink at an unroutable local port. The
proxy/uplink-failure code path still executes; only the failure is immediate,
and identically so for every arm.

### D7 — long-tail groups could arrive before the authentication they need

The traffic model rotates which long-tail group arrives first, so an
auth-dependent group can legitimately land before the first common login would
have run. On juice-shop that produced spurious 401s on checkout in two of four
families — i.e. **the held-out path did not execute**, which is attack #5 on the
list, caught by the prep-time validation that exists for it.

*Fix:* both logins moved into the shared prelude, which every arm performs
identically before the stream. The ordinary login stays in the common set,
because logging in *is* common traffic.

### D8 — declared statuses that were wrong

Prep-time validation compares every observed status against the `expect` set
declared in advance and prints every mismatch. It found:

| request | declared | observed | resolution |
| --- | --- | --- | --- |
| `vd.bp.nomedia` | 415 | 400 | expect corrected |
| `vd.bp.empty` | 422/400 | 500 | expect corrected |
| `vd.l.deprecate` | 201 | 422 | expect corrected, **and the branch is reported as not executed** |
| `js.co.add` | 200/400 | 500 (and 401 — see D7) | expect corrected |
| `uk.shell` | 200 | 302 | expect corrected |
| `st.wh.trigger` | 200/400/401/404 | 500 | expect corrected |

Correcting an `expect` set to the status the application actually returns is
recording behaviour, not moving a goalpost — the path still executed. The
verdaccio deprecate case is different and is called out separately: at this SHA
the handler answers 422, so the deprecation branch **did not run**, and no claim
is made about it. The other five requests in that group (publish, dist-tag,
un-tag, unpublish, read) all execute, so the group is kept.

---

## Part 2 — the attack list

| # | attack | status |
| --- | --- | --- |
| 1 | TRAIN/TEST leakage into a deployable strategy | **Addressed.** The TRAIN trace comes from a separate observation run driven by the TRAIN stream only (`prelude + common × 6`). No strategy function receives any TEST artefact: `g1/g2/r1/r2` take `(plan, train)`, and only `oracle()` takes the needed set. The oracle is never mounted, never given a budgeted list used by a trial, and is labelled analysis-only in its own `inputs` field. |
| 2 | unequal byte budgets between arms | **Addressed by construction.** A budget is a fixed number of universe FILE bytes; every arm's list is filled greedily against the same number. The per-cell `prewarmFileBytes` in each `<app>.metrics.json` is identical across arms at a given budget — checkable in the generated tables. |
| 3 | semantic strategies receiving more TRAIN evidence | **Addressed.** R2 receives the same `TrainAccess[]` array object as G1 and G2. Each strategy's consumed inputs are enumerated in code and emitted verbatim into `prep/<app>.json`. |
| 4 | the generic baseline being artificially weak | **Addressed, twice over.** G2's widening was strengthened by both amendments, and it uses the same widening function as the semantic arms. G1 is deliberately the *literal* trace and is documented as degenerate above its own size — which is why the comparator is `best(G1,G2)`, never G1 alone. |
| 5 | long-tail routes not actually executing | **Addressed.** Every request declares the statuses that count as intended behaviour, and prep prints every mismatch before a trial is spent (D7, D8). Per-request first-touch attribution additionally shows what each group actually loaded. |
| 6 | earlier long-tail groups warming later ones | **Modelled, not eliminated — see the family-rotation note below.** Per-category coverage is computed analytically from set membership and is therefore exact and order-independent. Measured first-hit latency is reported with the group's arrival position, and the headline first-hit figure uses position 1 only. |
| 7 | warm caches between trials | **Addressed.** Fresh container per trial; `/work` (blobcache, overlay upper and work dirs) wiped before t0; `/scratch` a fresh tmpfs; page cache for the mount dies with the container. Not resettable and documented: the VM's page cache over the registry's own blob storage, warm equally for every arm. |
| 8 | prewarm byte accounting differing between arms | **Addressed.** One accounting rule, applied by one function, over one image. File bytes (the budget) and chunk bytes (`prefetch_data_amount`) are both recorded per trial and never added together. |
| 9 | chunk-level effects making file counts misleading | **Accepted and reported.** A 1 MB chunk can carry several small files, so prewarming N files does not move N files' worth of bytes. That is why every table prints file counts and chunk bytes side by side, and why the equal-cost claim is stated in file bytes — the quantity the strategy controls — with measured chunk bytes beside it. |
| 10 | different packing/layout across arms | **Eliminated by construction.** One image, one blob, one bootstrap, one chunk layout per app; arms differ only in the file list passed to `nydusd --prefetch-files`. This is the change from experiment 3, whose per-arm prefetch tables reordered chunks and made every arm a physically different object. |
| 11 | Ready versus traffic-admission confusion | **Addressed, and it is the point of the design.** Traffic is admitted at `max(t_ready, t_prewarm)`, never at Ready. `t_ready` is recorded and reported as a diagnostic only. D4 was exactly this attack landing, and it was caught. |
| 12 | p99 sample sizes | **Addressed, with a stated limit.** Windows are 100 requests, so a window p99 is the second-largest sample in that window — a real observation, not an interpolation. Whole-stream p99 over ~400 requests is reported separately. No claim is made from a single window. |
| 13 | steady-state criterion instability, or chosen after the fact | **Addressed by commit order.** The criterion was committed before any trial; the band was computed from the eager arm alone, after the E0 trials and before any strategy trial, and committed. Both the primary and the sensitivity definition are reported, and they agree closely on every app. |
| 14 | oracle contamination | **Addressed.** The oracle exists only in the analysis. It is ranked and budgeted like the others so its curve is comparable, but no oracle list is ever handed to `runTrial`, and the trial grid contains only E0/G1/G2/R1/R2. |
| 15 | hidden child processes and workers | **Addressed.** The tracer is installed through `NODE_OPTIONS=--require`, which every child process and worker thread inherits, and it writes one file per pid. The measured trials carry no instrumentation at all — their fetch accounting is the substrate's, which sees every process in the container equally. |
| 16 | generated runtime files counted as image files | **Addressed.** Application writes land in the overlay upper (tmpfs), never in the RAFS lower, so a generated file cannot be a prefetch candidate or a remote fault. Universe membership is computed before any trial runs. |
| 17 | background work continuing after admission | **Accepted and quantified — see below.** |
| 18 | strategy-specific instrumentation effects | **Addressed.** Every arm runs the identical container, identical driver, identical sampler and identical traffic sequence; the only per-arm input is a text file of paths. |
| 19 | the fixture carrying a conclusion the real applications do not support | **Addressed by reporting rule.** Fixture and real-application results are tabulated separately and the verdict rule was fixed in advance: a fixture-only win is reported as negative/inconclusive for product differentiation. |

### Attack 17 in detail — juice-shop's background scanner

juice-shop starts a loop at boot that every 5 s recursively reads `routes/`,
`lib/`, `data/`, `models/`, `infrastructure/` and `frontend/src/app` to build its
code-snippet challenge index (`server.ts:762` → `routes/metrics.ts:163,189` →
`lib/codingChallenges.ts:23,29`). Consequences, all recorded rather than
worked around:

1. those trees are hydrated on **every** arm within seconds of process start,
   independent of traffic, so they inflate that app's TRAIN set and cannot be
   long-tail for any arm;
2. the loop is live during the post-admission window, so it contributes remote
   faults that no request caused;
3. it is identical across arms, so it cannot favour one.

No long-tail candidate for juice-shop depends on those trees. The effect is a
uniform additive term on that app's post-admission fault counts, and juice-shop's
absolute fault numbers should be read with it in mind.

### The family rotation collides on two apps

`rotateGroups` offsets family *f* by `(f · ceil(k/4)) mod k` for *k* long-tail
groups. When `4 · ceil(k/4) ≡ 0 (mod k)` that wraps, and family 3 reproduces
family 0 exactly:

| app | groups *k* | offsets | distinct first-arrival orders |
| --- | ---: | --- | ---: |
| json-server | 3 | 0, 1, 2, 0 | 3 |
| verdaccio | 5 | 0, 2, 4, 1 | 4 |
| uptime-kuma | 4 | 0, 1, 2, 3 | 4 |
| strapi | 7 | 0, 2, 4, 6 | 4 |
| **juice-shop** | 9 | 0, 3, 6, **0** | **3** |
| nextjs-longtail | 10 | 0, 3, 6, 9 | 4 |

Found while the sweep was already running. It is **not** a fairness problem —
every arm still sees the identical sequence for a given family — and it does not
touch the analytic per-category coverage, which is order-free. Its only cost is
that json-server and juice-shop measure three distinct groups at arrival
position 1 instead of four, and their fourth family is an exact repetition of
the first, which is a legitimate variance sample rather than a wasted trial.
`Math.floor(f · k / 4)` would give four distinct offsets in every case; it was
not applied because doing so mid-sweep would have invalidated the trials already
recorded, and the cost is a slightly smaller uncontaminated first-hit sample on
two apps, one of which is the null control.

### Accepted limitations that are not defects

- **One network profile** (25 ms, 100 Mbit). The shape of every comparison is
  independent of it; the absolute seconds are not.
- **Only the application universe is lazy.** Node and the base OS are eagerly
  present in every arm, which removes ~120 MB of download from the eager arm and
  therefore *understates* the lazy advantage uniformly.
- **Single machine, single run**, on a laptop's Docker VM. Four families per
  cell with min/median/max reported; no cross-machine reproduction.
- **corpus-v1-linux**: four trees are not byte-identical to the ones experiments
  1–2 measured, though the app SHA and lockfile are.
