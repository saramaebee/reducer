# Refute-by-default review — cost-aware traffic-warm run 1

The attack list is [`../DESIGN.md`](../DESIGN.md) §14, written before the
experiment ran. Each item is walked here: what it would look like if true, what
was checked, and what was found. Defects found during the run are recorded with
the numbers as they stood before the fix.

Mechanical checks are in [`VERIFY.json`](VERIFY.json) — invariants that would
invalidate the headline are asserted by code against the artefacts, not claimed
in prose.

---

## Defects found and fixed

### D1 — the physical cost model under-predicted request count by ~15×

**Found:** during calibration, before any strategy trial.

The first cost model treated one 128 KB compressed region as one backend
request, because that is what the `span` probe family measured. It is wrong for
the manifests a cost-aware selector actually produces. On strapi, the manifest
the selector built for a 400 ms parameter measured **4 068 ms**, ten times its
prediction.

**Cause:** nydusd builds one prefetch descriptor per **(file, chunk)** pair from
the list — `prefetch_unmerged_chunks` counts *files*, not distinct chunks — and
merges that stream. Chunk deduplication (22 870 of strapi's 75 245 chunks back
more than one file) makes the same blob offset appear at scattered positions, so
the stream stops being monotone and merging collapses.

**Evidence, on two same-sized contiguous regions of the same blob:**

```text
allspan-500-a   1 237 files, 500 chunks   164 backend requests   3 832 ms
allspan-500-b     916 files, 500 chunks    18 backend requests     728 ms
```

**Fix:** every arm's manifest is a **minimal chunk cover** — one covering file
per distinct chunk, ascending, drawn only from files entirely inside the bought
chunk set. Residency is identical; the descriptor stream is monotone again.

```text
same 500 chunks, same 2.9 MB of backend traffic
1 237-file listing   164 requests   3 832 ms
  496-file cover      13 requests     593 ms
```

Applied to **all four arms**, so it cannot be a cost-aware-only advantage.
Recorded as DESIGN amendment A1. No trial had run.

### D2 — a wall-clock deadline does not stop nydus prefetching

**Found:** in a pilot trial, before any measured strategy trial.

The design's primary budget is a prewarm deadline. Nydus has no API to abort an
in-flight prefetch, so the deadline gated *admission* while fetching continued.
Measured on a strapi pilot: the deadline fired at 8 010 ms, and prefetch went on
until ~17 500 ms, because the application was not ready until 18 600 ms and
`T_traffic = max(t_ready, deadline)`. An arm with a larger manifest would have
collected more content for the same nominal budget — the equal-cost premise
would have been silently false.

**Fix:** a rung is a **measured** prewarm cost. Every candidate manifest is
probed with no application running (`manifest-cost/`), and each arm deploys the
candidate whose measured prefetch duration is nearest the rung. The nominal
parameter is demoted to a knob. Verified: at strapi's 1 600 ms parameter the
four arms measure 589 / 594 / 584 / 586 ms.

The deadline is retained as the admission gate, and what prefetch still does
after it is measured rather than assumed away — see attack 7.

---

## The attack list

### 1. The physical cost model does not correlate with real fetch time

Checked by prediction from the physical map alone — no measured counter anywhere
in the prediction — against each probe's real prefetch duration.

```text
R² of prewarm ms on measured backend counters              0.998   (n=116)
MAPE, cover-manifest regime (the deployed one)             13.8 %  (n=86)
MAPE, THE DEPLOYED MANIFESTS THEMSELVES                    11.0 %  (n=96)
MAPE including the file-listing regime no arm deploys      28.8 %  (n=116)

out-of-sample, never in the fit — the whole blob, against experiment 4's
measured eager arm
  uptime-kuma  predicted  5 547 ms  measured  5 604 ms   −1.0 %
  juice-shop   predicted  6 508 ms  measured  7 535 ms  −13.6 %
  strapi       predicted 17 920 ms  measured 22 715 ms  −21.1 %
```

Not refuted. The model is also not load-bearing for the headline: the budget is
set by measurement, so the model only has to *order* candidates.

### 1b. Equal cost, as realised inside the trials rather than in the probe

The rung is matched on probe-measured cost; what matters is whether the two arms
being compared actually spent the same prewarm time *in the trial*. Median
in-trial prewarm duration, G1C against R1C:

```text
strapi        0.1 %  1.8 %  2.0 %  1.2 %  0.0 %
juice-shop    0.5 %  0.1 %  1.6 %  0.1 %  11.2 %
uptime-kuma   0.2 %  0.2 %  0.6 %  23.9 %  1.5 %
```

Thirteen of fifteen cells agree within 2 %. The two outliers are both cells where
the ladder has saturated (juice-shop's 7.5 s rung and uptime-kuma's 4 s rung,
where the nearest candidate manifest is the same one as the rung below) and in
both the arms' outcomes are within noise of each other anyway. Reported rather
than smoothed.

**The cost-aware-versus-cost-unaware comparison is NOT in-trial cost-equal, and
the asymmetry runs against the conclusion drawn from it.** At strapi's 8 s rung
G1 prewarms for 5 508 ms and G1C for 6 889 ms: the cost-unaware arm's small
manifest finishes early because much of it overlaps what the application is
demand-loading anyway. So G1C spent 1.4 s *more* prewarming and still admitted
5.0 s earlier, because residency accelerates application startup by more than
prefetching delays it. The 5.4 s figure is a net effect, stated as such.

### 2. Strategy-specific image packing, or different image digests between arms

Impossible by construction: this experiment **builds no image**. Every arm mounts
experiment 4's frozen bootstrap and the blob already in the registry, and the
only per-arm input is the file list handed to `nydusd --prefetch-files`.
`VERIFY.json` records the bootstrap SHA-256 and asserts a single blob index.

### 3. R1C secretly receiving TRAIN information

The semantic arm's behavioural value is experiment 4's **frozen** `R1` ranking,
loaded from that experiment's preserved artefact. Its declared `inputs` array is
asserted by `verify.ts` to contain no workload term (train / workload / access
log / first-content-read / observation). Nothing in `select.ts` reads a trace.

### 4. G1C receiving an artificially weak generic behavioural ranking

The generic arm's value is experiment 4's `G2` ranking, not `G1`. `verify.ts`
asserts that `G2`'s head is byte-for-byte `G1`'s TRAIN-trace tier, so the
generic arm gets the literal trace *plus* the strongest generic widening the
preserved harness contains. Using `G1`'s lexicographic remainder would have been
the straw man this item names.

### 5. The prewarm deadline measured from different moments across arms

`t0` is stamped once in `runner.sh` before the mount, identically for every arm,
and the deadline is `t0 + rung` evaluated in the same loop. The cutoff reason
(`plateau` or `deadline`) is recorded per trial.

### 6. Content counted as resident before its bytes arrived

Not counted from the manifest at all. Residency at `T_traffic` is read out of
nydus's own blobcache chunk bitmap, snapshotted at the admission instant. The
decoder asserts the file is at least `4096 + ceil(chunks/8)` bytes, and was
validated against a known manifest: 99.6 % of that manifest's chunks present,
plus the amplification and demand-fault chunks that must also be there.

### 7. Prefetch continuing after `T_traffic` and being misclassified

Real in principle (D2), and **measured to be absent in practice**. The
blobcache's own prefetch-request counter is snapshotted at admission and again
at the end of the post-admission stream:

```text
cells with ANY prefetch request issued after admission
  strapi        0 of 21        juice-shop    0 of 21        uptime-kuma   0 of 21
```

Because `T_traffic = max(t_ready, prewarm-close)` and these applications are not
ready before their manifests finish, prefetch had always completed by admission.
Every post-admission backend request in every reported cell is therefore a
genuine demand fault, not residual prefetch. The chunk bitmap independently
confirms it: the resident set at admission and at the end of pass 1 differ only
by demand-faulted chunks.

### 8. Cache contamination between trials

Unchanged from experiment 4: the blobcache work dir, the overlay upper and work
dirs, the container, the `/scratch` tmpfs and every application artefact are
destroyed before each trial; scaffolding runs pre-`t0` against an eager copy of
the tree, never the lazy mount. Not resettable and documented: the VM's page
cache over the registry's own blob storage, warm equally for every arm.

### 9. Merged backend requests causing double counting

The two byte currencies are never added: file bytes (placement) and backend
bytes (transfer) appear in separate columns everywhere. Backend requests and
bytes come from nydus's own counters; predicted requests and bytes come from the
merge model; both are printed side by side in `calibration/validation.json`.

### 10. Compressed versus logical byte confusion

`physical.ts` stores compressed and decompressed extents in separately named
fields; the summary labels every column. The blobcache stores *decompressed*
data, so `prefetch_data_amount` is not comparable with compressed blob bytes and
is never used as one.

### 11. The physical cost estimator using TEST information

Every calibration probe is generated from blob geometry plus a preregistered LCG
seed. No probe reads the TRAIN trace, the TEST first-touch set, an arm's
ranking, or any outcome. The probe manifests are preserved so this is checkable.

### 12. Correctness routes not executing

Every arm is compared to the eager arm of the same family, request for request,
on status, byte length, body fingerprint where declared stable, and the declared
comparison header. Requests outside their declared `expect` set are counted
separately. Results in `SUMMARY.md` §8.

### 13. Network shaping attached in the wrong direction

`tc netem` is applied to the **registry's** egress, so both the request latency
and the response bandwidth are shaped. Shaping the application container instead
would delay its tiny range requests while leaving the download unlimited. It is
re-applied and echoed at the start of every trials run and every probe run.

### 14. Trial-order drift

**Checked, and it is a family effect, not machine drift.** The within-cell
Pearson correlation between a trial's position in the executed order and its
worst post-admission window p99 is non-zero (juice-shop mean −0.67 over 21
cells), which looked like drift. It is not: the grid runs family-major, so each
family is one contiguous block of 21 trials, and the by-family and by-block
medians are identical by construction —

```text
                by family                    by order block
strapi        145 151 152 163              145 151 152 163
juice-shop    375 375 340 342              375 375 340 342
uptime-kuma   126 126 127 127              126 126 127 127
```

— i.e. what varies is *which long-tail group arrives first*, which is the
family's designed purpose. Every arm appears in every family, so the effect is
common-mode and cancels in every arm-vs-arm comparison. The residual spread is
8 % (strapi), 10 % (juice-shop), 1 % (uptime-kuma).

The grid is walked family-major with the arm order rotated per family; the
executed order is preserved in `trials/<app>/index.json`. The eager reference
occupies the first slot of each family, which is a fixed position — noted rather
than hidden.

### 15. p99 sample instability

Rolling windows of 100 requests stepped by 20 over a 400-request post-admission
stream, four families per cell, nearest-rank percentile so every reported p99 is
a real sample. The band is experiment 4's frozen one and is not re-derived.

**The one comparison the verdict turns on was checked per family.** strapi at
the 3.3 s rung, worst post-admission window p99 by family:

```text
G1C   250  214  246  228
R1C   130  129  132  151
```

Disjoint, so that difference is reported as real. Every other G1C-vs-R1C
difference has overlapping family distributions and is reported as a tie for
exactly that reason.

**A defect was found in the preregistered steady-state metric itself.** The
frozen band comes from the eager arm's warm pass and is unreachable by any cold
pass, including the eager arm's own (strapi: band 80 ms, eager cold peak
132 ms, `T_steady` undefined in 2 of 4 eager trials). Taking a median over the
trials that happened to reach it is a median over a self-selected subset. The
same construction against a reachable threshold — the eager arm's own worst cold
window — is defined in 4/4 trials almost everywhere and is what `FINDINGS.md`
quotes; the preregistered figure is computed and printed beside it in
`SUMMARY.md` §2 and is not replaced. This is experiment 4's amendment A4 applied
again for the same measured reason, and it is an analysis choice made after the
trials ran. It does not change the ordering of G1C and R1C.

### 16. Optimiser coefficients tuned on final outcomes

There are no per-arm and no per-app coefficients. The value transform
`1/(1+rank)` has no constant to tune. The cost coefficients were fitted once, on
neutral probes, and committed with `DESIGN.md` before the first strategy trial —
the commit order is the proof.

### 17. The value transform advantaging one ranking's tier structure

Both rankings are total orders over the same universe and are read through the
same transform. The sensitivity this deserves is reported in `FINDINGS.md`: the
two arms' selections are compared directly, so a transform artefact would show
up as the two arms buying the same units for different reasons.

### 17b. The value transform, checked against the outcome

Both rankings pass through `1/(1+rank)`, which has no constant. If the transform
were doing the work, the two arms would buy the same units for different
reasons; instead their selections start 43–49 % disjoint at the tightest rung and
converge to identical only as the budget approaches the whole blob. The
divergence that exists is attributable to the rankings, not to the transform.

### 18. The adverse control won by a generic physical effect in semantic clothing

**Not observed — the control behaved.** uptime-kuma's band is 7 ms, the tightest
in the corpus. R1C is behind G1C at all five rungs (by 0.04–0.80 s on
`T_steady`), and the cost-unaware semantic arm R1 is the only arm in the entire
experiment that never becomes eager-matched. Nothing in the cost model
manufactures a semantic-looking advantage.
