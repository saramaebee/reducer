# Provenance — cost-aware traffic-warm run 1

Everything needed to say exactly what was measured, on what, with which
versions, and where each deviation from the preregistration lies.

---

## Environment

```text
host              macOS 26.1, arm64 (Apple Silicon)
container VM      Docker Desktop 27.4.0 — linux/aarch64, kernel 6.10.14-linuxkit,
                  10 CPU, 8 217 968 640 B RAM
privileges        --privileged (needs /dev/fuse, overlayfs, NET_ADMIN for tc)
runtime image     node:24-bookworm-slim → Node v24.19.0
substrate         nydus v2.4.5, git e3190057422fee17f594bb3a5c10741b45dac6ce
                  (nydusd + nydus-image, static linux/arm64)
registry          registry:2, container `reducer-registry` on docker network `reducer-net`
network profile   tc netem on the REGISTRY's egress: 25 ms delay, 100 Mbit,
                  re-applied and re-verified at the start of every trials run
                  and every probe run
```

Analysis host runtime is bun; the applications always run under the pinned stock
Node inside the trial container.

## Nothing was built

This experiment builds no image, materialises no tree and re-derives no ranking.
Every physical artefact is experiment 4's, reused by path:

```text
tree              /Users/sara/.cache/reducer-longtail-v1/stage/<app>
RAFS bootstrap    /Users/sara/.cache/reducer-longtail-v1/images/<app>/base/boot.img
RAFS blob         already in the registry, repo longtail/<app>
rankings          ../longtail/run-1/prefetch/<app>/{G2,R1,O}.ranking.json.gz
traffic families  ../longtail/traffic.ts + workloads.ts (unchanged)
steady-state band ../longtail/run-1/band/<app>.json (frozen, not re-derived)
```

Bootstrap digests, blob ids and the invariant checks are in
[`VERIFY.json`](VERIFY.json).

| app | universe | blob | chunks | shared chunks | frozen band |
| --- | ---: | ---: | ---: | ---: | ---: |
| strapi | 123 474 f / 915.0 MB | 228.3 MB | 75 245 | 22 870 | 80 ms |
| juice-shop | 24 020 f / 270.5 MB | 75.6 MB | 17 770 | 3 721 | 37 ms |
| uptime-kuma | 28 851 f / 200.7 MB | 56.8 MB | 22 315 | 3 830 | 7 ms |

## Trial grid

```text
per app   4 families × (1 eager reference + 4 arms × 5 measured-cost rungs) = 84 trials
total     3 apps × 84 = 252 measured trials
order     family-major with the arm order rotated per family; the executed order
          is preserved in trials/<app>/index.json
per trial fresh container; /work (blobcache + overlay upper/work) wiped pre-t0;
          fresh /scratch tmpfs; the post-admission stream run twice (cold, then
          warm as that arm's own reference)
```

Plus the preregistered network-sensitivity grid (DESIGN §12): 5 ms / 1000 Mbit,
strapi and juice-shop, arms G1C and R1C at the two middle rungs, 4 families,
with the eager reference — **40 trials**, in `fast/`.

Plus the calibration record, which is not a trial grid but is preserved in full:
116 neutral probes (`calibration/`) and 96 deployed-manifest cost probes
(`manifest-cost/`), all application-free.

## Reproduce

```bash
bun benchmarks/costaware/physical.ts   --all              # chunk map from the frozen bootstraps
bun benchmarks/costaware/calibrate.ts  probes   --all     # neutral probes
bun benchmarks/costaware/calibrate.ts  fit      --all     # freeze cost-model.json
bun benchmarks/costaware/calibrate.ts  validate --all     # estimator accuracy
bun benchmarks/costaware/run.ts        prep     --app <n> # candidate manifests
bun benchmarks/costaware/calibrate.ts  manifests --all    # measure each manifest's cost
bun benchmarks/costaware/run.ts        ladder   --app <n> # measured-cost rungs
bun benchmarks/costaware/verify.ts                        # fairness invariants
bun benchmarks/costaware/run.ts        trials   --app <n> --e0
bun benchmarks/costaware/analyze.ts    metrics  --all
bun benchmarks/costaware/analyze.ts    summary
```

## Deviations from the preregistration

One amendment, recorded in [`../DESIGN.md`](../DESIGN.md) with the numbers as
they stood before the change, and made **before any measured strategy trial**:

- **A1** — the estimator was improved once on neutral calibration data (the
  §5 escape clause), and the budget was redefined from a nominal parameter to a
  *measured* prewarm cost. Both corrections came from probe families that
  contain no strategy, no trace and no outcome.

The commit that carries `DESIGN.md`, `cost-model.json` and the whole calibration
record precedes the first strategy trial in the history.

## Where the evidence lives

```text
../DESIGN.md                     the preregistration and its amendment
RUN-INFO.md                      this file
cost-model.json                  the frozen calibrated model
calibration/<app>/               every neutral probe: manifest (gzipped),
                                 nydus telemetry, log
calibration/validation.json      predicted-vs-measured for every probe and for
                                 every deployed manifest
manifest-cost/<app>/measured.json  each candidate manifest's application-free
                                 measured prefetch cost — the ladder's input
prep/<app>.json                  physical facts, cost model, every arm's
                                 selection at every parameter, ranking inputs,
                                 the physical oracle
prep/<app>.ladder.json           which manifest each arm deploys at each rung
prefetch/<app>/<arm>.<param>.txt.gz  the exact deployed prewarm manifests
VERIFY.json                      mechanical fairness invariants
trials/<app>/index.json          the exact executed trial order
trials/<app>/traffic-f<N>.json   the exact traffic sequence for family N, stored
                                 ONCE per family because every arm at every rung
                                 runs the identical sequence for a given family
trials/<app>/<cell>/             milestones (trial.json), per-request events,
                                 100 ms fetch samples, nydus telemetry, the chunk
                                 residency bitmaps at admission and after each
                                 pass, app log, runner log, cgroup CPU
fast/<app>/                      the same, for the sensitivity profile
<app>.metrics.json               computed per-arm-per-rung metrics
<app>.fast.metrics.json          the same for the sensitivity profile
SUMMARY.md                       generated tables
ADVERSARIAL.md                   defects found and fixed; the attack list walked
FINDINGS.md                      the result and the verdict
```

The bulky streams (events, samples, app log) and the chunk residency bitmaps are
stored gzipped; `analyze.ts` reads either form, so the whole analysis re-runs
from the preserved record without unpacking anything. Two per-trial copies were
removed because they are exactly reproducible: the prewarm manifest (identical to
the deployed manifest preserved once under `prefetch/`) and the traffic spec
(identical for every arm and rung of a family, preserved once as
`traffic-f<N>.json`).
