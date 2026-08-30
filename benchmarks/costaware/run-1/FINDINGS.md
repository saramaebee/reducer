# Does semantic prediction survive real retrieval economics?

ADR-0007 experiment 5. Preregistration: [`../DESIGN.md`](../DESIGN.md) (+ one
recorded amendment). Provenance: [`RUN-INFO.md`](RUN-INFO.md). Refute-by-default
review: [`ADVERSARIAL.md`](ADVERSARIAL.md). Mechanical fairness invariants:
[`VERIFY.json`](VERIFY.json). Generated tables: [`SUMMARY.md`](SUMMARY.md) and
`<app>.metrics.json`.

**252 measured trials** on the primary network profile plus **40** on the
preregistered sensitivity profile, across three applications, four arms, five
measured-cost rungs and four cold traffic families, on top of **212
application-free probes** that calibrated the cost model and priced every
manifest. **Zero correctness mismatches** anywhere: 272 arm-vs-eager trial
comparisons, every request matched on status, byte length, body fingerprint
where the body is deterministic, and the declared semantic header where it is
not. **22/22 fairness invariants hold.**

---

## 1. The result in one paragraph

Experiment 4's diagnosis was right: **file bytes were the wrong currency, and
fixing it is worth about five seconds.** Charging both strategies in measured
prewarm milliseconds and letting each spend them on contiguous retrieval units
instead of individually-chosen files takes **5.4 s off strapi's time to
steady-state for the generic ranking and 4.8 s off it for the semantic one**,
and removes juice-shop's one-second first-hit cliff for *both*. But the wedge
does not follow, for a reason sharper than a tie: once retrieval cost is
accounted for, **the two prediction sources converge on the same physical
content** — resident-set overlap rises from 0.51–0.57 at the tightest rung to
1.00 within three rungs — and on the preregistered primary metric the *generic*
cost-aware arm is ahead on three of strapi's five rungs, tied on juice-shop, and
ahead at every rung of the adverse control. The deepest finding is the physical
oracle: prefetching **exactly** the files the workload will touch costs strapi
**1 697 backend requests and a predicted 18.1 s**, while buying 21× more content
chosen purely for physical cheapness costs **132 requests and a measured 1.9 s**.
On this substrate precision is a liability, so a better predictor is optimising
the wrong quantity.

---

## 2. What cost-awareness bought — the effect is real, and it is generic

Same behavioural ranking, same measured prewarm budget; the only difference is
whether selection is cost-aware. `T_steady − T0` against the eager arm's own
worst cold window (§4 explains why the frozen band cannot be used), median of
four families:

**strapi** — 915 MB, 123 474 files, the ICP size class

| measured prewarm | G1 | **G1C** | R1 | **R1C** |
| ---: | ---: | ---: | ---: | ---: |
| 1.9 s | 26.0 s | **24.8 s** | 26.4 s | **26.8 s** |
| 3.3 s | 24.9 s | **22.5 s** | 25.0 s | **22.3 s** |
| 6.2 s | 22.9 s | **17.5 s** | 23.5 s | **18.7 s** |
| 11.3 s | 20.7 s | **19.2 s** | 22.7 s | **19.7 s** |
| 19.8 s | 25.2 s | **25.2 s** | 23.2 s | **25.2 s** |
| *eager (whole image)* | | *28.1 s* | | |

At the 6.2 s rung cost-awareness is worth **5.4 s** to the generic ranking and
**4.8 s** to the semantic one. On juice-shop the same comparison at 3.0 s is
worth **2.9 s** and **3.1 s**. The mechanism experiment 4 blamed was real and it
is fixed.

This one is a *net* effect and the asymmetry runs against it: in-trial, G1
prewarms for 5.5 s and G1C for 6.9 s at that rung, because the cost-unaware
arm's small manifest overlaps what the application demand-loads anyway and
finishes early. G1C spent 1.4 s **more** prewarming and still admitted 5.0 s
sooner — residency accelerates startup by more than prefetching delays it. The
headline R1C-versus-G1C comparison has no such asymmetry: those two are matched
in-trial to within 2 % in thirteen of fifteen cells
([`ADVERSARIAL.md`](ADVERSARIAL.md) §1b).

The clearest single statement of what changed is experiment 4's own R1 manifest,
re-priced in physical units and set beside this experiment's R1C:

```text
strapi                              files    chunks   backend req   prewarm
experiment 4  R1 @ 40 % file bytes  106 512   68 803        1 567    25.3 s (measured)
experiment 5  R1C @ the 8 s rung    106 663   61 811          537     6.2 s (measured)
```

The same amount of content resident, **one third of the backend requests, four
times faster** — because it is bought as contiguous regions instead of as
individually valuable scattered files.

### 2.1 And the one-second cliff is gone — for both arms

juice-shop's `optional-feature` group (lazy `import('ethers')`, 19 MB, plus
`import('pdfkit')`) was experiment 4's headline: R1 served it in 120 ms where
the generic arms took 1 041–1 131 ms. First-hit latency at arrival position 1,
at the 6.1 s rung:

```text
G1  1 055 ms      G1C  126 ms      R1  463 ms      R1C  122 ms      eager  122 ms
```

Cost-awareness, not semantics, is what removes it. The generic arm reaches the
eager baseline as completely as the semantic one.

---

## 3. The headline comparison: R1C versus G1C

### 3.1 On the primary metric, semantics does not win

`T_steady − T0`, R1C minus G1C (negative = semantic better):

```text
strapi        +2.00 s  −0.14 s  +1.15 s  +0.47 s  −0.01 s    (5 rungs)
juice-shop    +0.26 s  +0.62 s  −0.40 s  −0.17 s  +0.31 s    (5 rungs)
uptime-kuma   +0.80 s  +0.50 s  +0.55 s  +0.34 s  +0.04 s    (adverse control)
```

Of fifteen cells, R1C is ahead in four, by 0.01–0.40 s, inside an interval of
11–27 s. G1C is ahead in eleven, by up to 2.0 s. On the metric the operator
named — HPA decision to serving at steady-state p99 — **cost-aware semantics does
not beat cost-aware generic prediction on any application.**

### 3.2 There is one genuine semantic win, and it is narrow

On strapi at the 3.3 s rung the worst post-admission window p99 is **130 ms for
R1C against 228 ms for G1C**, and the four families are disjoint — 130/129/132/151
against 250/214/246/228 — so this is not noise. It carries the equal-outcome
result:

```text
smallest rung at which an arm is EAGER-MATCHED
(median worst post-admission window p99 ≤ the worst the eager arm itself produced)

strapi        G1  19.8 s     G1C  6.2 s     R1  22.7 s     R1C  3.3 s
juice-shop    G1   6.7 s     G1C  6.1 s     R1   6.8 s     R1C  6.1 s
uptime-kuma   G1   5.2 s     G1C  5.2 s     R1  never      R1C  5.2 s
```

**On strapi, R1C reaches eager-like post-admission latency at half G1C's prewarm
time.** That is a real advantage and it is the strongest thing this experiment
found for the semantic side. Three facts stop it from being the wedge:

1. **It does not reproduce on the second positive application.** juice-shop —
   which has the *richer* module-shaped long tail, 669 held-out files against
   strapi's 273 — is a dead tie at 6.1 s.
2. **It does not move the headline.** At that very rung R1C's `T_steady` is
   22.3 s and G1C's is 22.5 s: the better p99 buys 0.1 s, because `T_steady` on
   strapi is dominated by application readiness (16.8–21.5 s), not by prewarming.
3. **It is an artefact of the slow link** — §5.

### 3.3 Why the split, and it is interpretable

The two arms are good at different halves of the timeline, and the frozen
rankings say exactly why:

- **G1C's value is the TRAIN trace, which *is* the startup path.** It reaches
  application-ready sooner: at the 6.2 s rung strapi boots in 12.7 s under G1C
  against 14.0 s under R1C — while R1C actually had *more* content resident at
  admission (111 838 files against 111 175). Faster boot → earlier admission →
  lower `T_steady`.
- **R1C's value is static module structure, which covers the long tail.** It
  takes the lower post-admission p99 at tight budgets.

`T_steady` is admission plus post-admission warming, and on these applications
admission dominates. So the generic arm wins the metric by being better at the
part that dominates it.

---

## 4. Why the preregistered steady-state figure is reported twice

DESIGN §9 froze experiment 4's band (strapi 80 ms, juice-shop 37 ms, uptime-kuma
7 ms), taken from the eager arm's *warm* pass. Measured again here, it remains
unreachable by any cold pass **including the eager arm's own**: strapi's eager
cold pass peaks at 132 ms against a band of 80 ms, and `T_steady` is undefined
in 2 of 4 eager trials. A median over the subset that happened to reach it is a
median over a self-selected sample.

So the same construction is also computed against a reachable threshold — the
eager arm's own worst *cold* post-admission window — which is defined in 4/4
trials in almost every cell. Both appear in [`SUMMARY.md`](SUMMARY.md) §2 and
neither replaces the other; §2 and §3 above quote the reachable one. This is
experiment 4's amendment A4 applied again, for the same measured reason, and it
is an analysis choice made after the trials — labelled as such wherever it
appears. It does not change the verdict: on the preregistered band the ordering
of G1C and R1C is the same.

---

## 5. Network sensitivity — the one semantic win is a slow-link artefact

Preregistered before any result existed: one faster profile, 5 ms RTT / 1000
Mbit, on strapi and juice-shop, arms G1C and R1C, the two middle rungs, four
families, same manifests.

```text
strapi, the 3.3 s rung — max post-admission window p99
  25 ms / 100 Mbit     G1C  228 ms      R1C  130 ms      (the §3.2 win)
   5 ms / 1000 Mbit    G1C  131 ms      R1C  130 ms      (gone)
```

Every arm's fault count is unchanged — same manifests, same residency — so the
difference was never coverage. G1C's misses were expensive *because the link was
slow*; make the link fast and its p99 collapses onto R1C's. Experiment 4 named
network sensitivity as its most load-bearing limitation and expected a faster
link to help the semantic side. It does the opposite: **the faster link removes
the only p99 advantage semantics had.** The ordering on `T_steady` is unchanged
(strapi 6.2 s rung: G1C 10.4 s, R1C 11.0 s).

---

## 6. The finding underneath all of it: precision is a liability

The physical oracle — the exact set of files the TEST workload first-touches,
priced in the same units, computed only after every deployed manifest was frozen:

| app | oracle files | chunks | **backend requests** | compressed | predicted prewarm |
| --- | ---: | ---: | ---: | ---: | ---: |
| strapi | 5 118 | 4 834 | **1 697** | 9.6 MB | 18.1 s |
| juice-shop | 3 340 | 3 210 | **681** | 7.8 MB | 7.4 s |
| uptime-kuma | 4 287 | 3 886 | **740** | 8.2 MB | 8.1 s |

Set that against what a cost-aware arm actually pays:

```text
strapi
  oracle:   5 118 files      1 697 requests      18.1 s predicted
  G1C:     44 531 files        132 requests       1.9 s MEASURED
  G1C:    108 134 files        536 requests       6.2 s MEASURED
```

**Perfect knowledge of the future is three times more expensive than knowing
nothing and buying whatever is cheap.** 9.6 MB is the minimum *logical* content;
1 697 scattered range requests is its minimum *physical* cost, and on a
request-bound substrate that is what you pay. Twenty-one times more content,
chosen only for contiguity, arrives in a seventh of the time.

This is why the wedge cannot be rescued by a better predictor. The quantity a
predictor optimises — *which files will be needed* — is not the quantity the
substrate charges for. Chunk deduplication (22 870 of strapi's 75 245 chunks
back more than one file), a median compressed chunk of ~500 bytes, and a
one-dimensional blob laid out in directory-walk order together mean the cheapest
way to become traffic-warm is to sweep contiguous regions. Any two rankings that
are forced to pay that cost end up buying the same regions:

```text
resident-set overlap (Jaccard), cost-aware pair versus cost-unaware pair
                     tightest rung  →  widest rung
strapi     G1C/R1C   0.570  0.652  0.931  1.000  1.000
           G1 /R1    0.013  0.023  0.026  0.049  0.112
juice-shop G1C/R1C   0.509  0.791  0.990  1.000  1.000
           G1 /R1    0.037  0.058  0.106  0.119  1.000
uptime-kuma G1C/R1C  0.532  0.768  0.981  0.981  1.000
           G1 /R1    0.016  0.019  0.058  0.058  0.041
```

The two prediction sources genuinely disagree — the cost-unaware arms overlap by
1–12 % — and physics erases the disagreement.

---

## 7. Prewarm waste, and why it does not matter

At strapi's 6.2 s rung the cost-aware arms make **106 000 files / ~420 MB**
resident that no workload ever touches, against the cost-unaware arms' ~85 000 /
~370 MB. The cost-aware arms waste *more* and still win by five seconds, because
the waste is contiguous and therefore nearly free. Waste is the wrong thing to
minimise on this substrate; requests are.

---

## 8. The adverse control behaved

uptime-kuma is in the set to catch a generic physical optimisation dressed as
semantic value, and its band (7 ms) is the tightest in the corpus. **R1C does not
win it at any rung** — G1C is ahead at all five — and the cost-unaware semantic
arm R1 is the only arm in the whole experiment that never becomes eager-matched.
Nothing about the cost model manufactures a semantic advantage.

---

## 9. Answers

**A. Did physical retrieval cost explain why the previous semantic strategy lost
on time-to-steady-state?**
**Yes.** Re-priced physically, experiment 4's R1 at an identical 45.8 MB
file-byte budget needed **5 263 backend requests against G1's 1 588** with 1.38×
overfetch against 1.10× — 3.3× the requests for the same file bytes. Correcting
the currency and selecting contiguous retrieval units recovers **5.4 s (generic)
and 4.8 s (semantic)** of time-to-steady-state on strapi, and delivers the same
content as experiment 4's widest R1 manifest at one third of the requests and
four times the speed. The diagnosis was right.

**B. Does cost-aware R1 retain its long-tail coverage advantage?**
**Partly, and not where it was claimed.** On juice-shop it does: needed TEST
files still missing at admission, 15 for R1C against 30 for G1C at the 3.0 s
rung, and 72 against 139 at 1.6 s. On strapi it **reverses** — G1C misses 113
against R1C's 144 at 3.3 s, and 37 against 41 at 6.2 s. The coverage advantage
experiment 4 measured under a byte budget does not survive a cost budget intact.

**C. Under equal prewarm time, does R1C produce materially better post-admission
p99 / fault behaviour than G1C?**
**In one cell of fifteen.** strapi at 3.3 s: 130 ms against 228 ms, 9 faults
against 12, with the four families disjoint. Everywhere else the two are within
measurement noise (strapi 6.2 s: 131 vs 131; juice-shop 3.0 s: 274 vs 290;
uptime-kuma: G1C ahead throughout). And §5 shows that one cell is a property of
the 25 ms link, not of the prediction.

**D. To achieve eager-like traffic behaviour, does R1C require materially less
prewarm time than G1C?**
**On strapi yes — 3.3 s against 6.2 s, about half. On juice-shop no (6.1 s
each). On uptime-kuma no (5.2 s each).** One application of three, and it is the
one with the *smaller* held-out surface.

**E. Does that advantage hold on both real positive applications and disappear on
the adverse control?**
**No.** It disappears on the adverse control, correctly — but it also disappears
on the second positive application. An advantage that appears on one of two
positive cases, on a metric that does not move the headline interval, and that
vanishes under a faster network, is not a product property.

**F. Is the absolute time-to-steady-state improvement large enough to matter to
the target platform ICP?**
**The cost-aware improvement is: about five seconds off a twenty-three second
interval on a 915 MB application, and a one-second first-hit cliff removed. The
semantic contribution to it is not: zero to 0.4 s, in the wrong direction on ten
of fifteen cells.** A platform team would ship cost-aware prewarming. Nothing in
this data would make them pay for the semantic planner that produces it.

---

## 10. Verdict

```text
STOP PERFORMANCE WEDGE — SEMANTIC PREDICTION DOES NOT
BEAT GENERIC PREFETCH UNDER REAL RETRIEVAL ECONOMICS
```

Stated so a later reader can attack it:

1. **The correction worked and the wedge still failed.** This was the one
   remaining explanation, it was implemented, it was worth five seconds, and the
   five seconds went to both prediction sources equally.
2. **The two sources converge on the same physical content.** Not a tie in
   outcomes — a tie in *plans*, visible in the manifests before any latency was
   measured, rising to identical selections within three rungs.
3. **The one semantic win is single-application and network-conditional.** It
   does not appear on the application with the richer long tail, it buys 0.1 s
   of the headline interval, and a faster link erases it.
4. **A perfect oracle loses too.** Prefetching exactly the right files is three
   times more expensive than prefetching twenty-one times too much cheaply. No
   improvement in prediction accuracy can fix that, because accuracy is not the
   binding constraint.
5. **What is worth keeping is not the planner.** Cost-aware, unit-granularity
   prewarming with a minimal-descriptor manifest is a real and portable
   improvement to lazy delivery. It needs a chunk map and an arithmetic model —
   no Node analysis, no dependency graph, no training run.

Per DESIGN §16's decision rule — a negative result is not rescued with another
planner revision (the same rule the external research brief imposed; see
`docs/PROBLEM-CONTEXT.md` §5) — performance experimentation stops here. No
further planner variant is proposed.

---

## 11. Limitations

1. **`T_steady` is dominated by application readiness on these applications**
   (strapi 12.7–21.5 s of a 17.5–26.8 s interval). The experiment therefore
   measures the prewarming contribution to a metric prewarming only partly
   controls — which is exactly the operator's framing, but it compresses every
   difference. The p99 and fault columns are the sensitive ones.
2. **The preregistered steady-state band is unreachable by the reference arm**,
   so the headline uses the reachable-threshold variant (§4). Both are reported.
3. **The cost model over-predicts in the file-listing regime** (28.8 % MAPE)
   and is accurate in the cover regime every arm actually deploys (11.0 % on the
   deployed manifests). The re-priced experiment-4 manifests in §9A are in the
   former regime: their chunk, request and overfetch counts are exact geometry,
   but their *predicted* durations should be read as ordering, not magnitude.
4. **Nydus cannot abort a prefetch**, so the wall-clock deadline gates admission
   only, and equal cost is achieved by sizing manifests against measured probes.
   Measured consequence: prefetch had completed before admission in **all 63
   cells**, so no reported post-admission request is residual prefetch. Two of
   fifteen G1C/R1C cells are in-trial cost-matched only to 11 % and 24 %; both
   are saturated rungs where the outcomes are within noise regardless.
5. **Four families per cell, one machine, one run.** Median with min/max; the
   one decisive p99 comparison (§3.2) has disjoint distributions, most others do
   not and are reported as ties for that reason.
6. **Three applications**, chosen in DESIGN §3 before any outcome. Experiment
   4's other three had held-out surfaces of 0, 1 and 10 files and could not
   discriminate anything.
7. **The blob's chunk order is the image builder's directory walk.** A different
   packer would change which content is physically cheap — and would change it
   for both arms. The preregistration recorded this as the structural reason to
   expect the null; it is a property of how OCI images are built, not of this
   benchmark.
8. **Only the application universe is lazy.** Node and the base OS are eager in
   every arm, understating the lazy advantage uniformly.
