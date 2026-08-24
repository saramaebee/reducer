# Provenance — long-tail traffic-warm run 1

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
                  (the version .tool-versions pins and the corpus was materialised with)
substrate         nydus v2.4.5, git e3190057422fee17f594bb3a5c10741b45dac6ce
                  (nydusd + nydus-image, static linux/arm64, rustc 1.94.0)
registry          registry:2, container `reducer-registry` on docker network `reducer-net`
network profile   tc netem on the REGISTRY's egress: 25 ms delay, 100 Mbit
                  (verified before every trials run; shaping the app container
                  instead would delay its tiny range REQUESTS while leaving the
                  RESPONSE bandwidth unlimited — a lazy-loading benchmark with
                  no download cost at all)
```

Analysis host runtime is bun; the applications themselves always run under the
pinned stock Node inside the trial container.

## Images — one per app, shared by every arm

Built with `nydus-image create --fs-version 6 --compressor zstd --digester
sha256 --chunk-size 0x100000 --repeatable` and **no prefetch policy**. Arms
differ only in the file list passed to `nydusd --prefetch-files` at mount, so
there is exactly one chunk layout per app and nothing about a strategy reaches
the image. `content digest` is a hash of every file's SHA-256 plus the mode and
symlink structure, taken over the mounted image.

| app | kind | app SHA | universe | NFT | Plan B hot | packages | dep-reachable | RAFS blob | content digest |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| json-server | real | `89a34a44b7a6` | 1 288 f / 3.2 MB | 140 | 150 | 49 | 46 | 1.2 MB `1719c2918705` | `bd95631955b8` |
| verdaccio | real | `79237e3f9f02` | 9 530 f / 59.9 MB | 1 853 | 2 009 | 351 | 248 | 17.7 MB `75f592872af8` | `bace18355d34` |
| juice-shop | real | `1618a611b173` | 24 020 f / 270.5 MB | 4 228 | 5 924 | 1 128 | 689 | 75.8 MB `affd79776d2c` | `c4ea4402ad48` |
| uptime-kuma | real | `6398a9581d1c` | 28 851 f / 200.7 MB | 5 175 | 5 874 | 736 | 645 | 57.1 MB `5939eafcfa19` | `2f1c395dd03f` |
| strapi | real | `1fd9d80ad5f0` | 123 474 f / 915.0 MB | 19 411 | 47 153 | 2 248 | 1 424 | 229.1 MB `fd4656ceb30d` | `347eea75a116` |
| nextjs-longtail | fixture | `b2fa057902bc` | 11 918 f / 362.6 MB | 1 944 | 7 218 | 310 | 169 | 92.4 MB `5ba56f2cd2aa` | `e8d775872946` |

The fixture's "app SHA" is this repository's commit at materialisation time; its
source and lockfile are committed under `../fixture-app/`.

Four of the five real trees are **corpus-v1-linux**: the same pinned app SHA and
the same lockfile as corpus-v1, with `node_modules` re-resolved for linux/arm64
(experiment 3 §3.2 — the darwin tree's native addons are Mach-O and abort under
any Linux substrate). json-server and verdaccio keep the frozen darwin tree
unmodified, because they boot under Linux as-is.

## Trial grid

```text
per app   4 families × (1 eager reference + 4 strategies × 4 budgets) = 68 trials
total     6 apps × 68 = 408 measured trials, plus 30 eager-only trials from the
          band-freezing pass that preceded them
order     family-major with the arm order rotated per family, so no arm
          systematically follows another; the executed order is preserved in
          trials/<app>/index.json
per trial fresh container; /work (blobcache + overlay upper/work) wiped pre-t0;
          fresh /scratch tmpfs; the post-admission stream run twice (cold, then
          warm as that arm's own reference)
```

## Reproduce

```bash
bun benchmarks/longtail/plan.ts    --all
bun benchmarks/longtail/run.ts     prep   --app <name>
bun benchmarks/longtail/run.ts     trials --app <name> --e0only   # then freeze the band
bun benchmarks/longtail/analyze.ts band   --all
bun benchmarks/longtail/run.ts     trials --app <name>
bun benchmarks/longtail/analyze.ts metrics --all
bun benchmarks/longtail/analyze.ts summary
```

The Next.js fixture is rebuilt with `bash benchmarks/longtail/materialize-fixture.sh`.

## Deviations from the preregistration

Three amendments, each recorded in `../DESIGN.md` with the numbers as they stood
before the change, and each made before the measurement it could have affected:

- **A1** — one shared widening rule for every strategy (before any measured
  strategy trial).
- **A2** — only certainty is a strict tier; all prediction goes in the shared
  pool (before any measured strategy trial).
- **A3** — the prewarm-complete signal, and the frozen steady-state band (after
  the eager trials, before any strategy trial).

Workload defects found by prep-time validation and fixed before the sweep are in
[`ADVERSARIAL.md`](ADVERSARIAL.md) D5–D8. One analysis addition made after the
eager trials — comparing each arm against the eager arm measured in the *same*
cold conditions, because the preregistered band comes from the eager arm's warm
pass and the eager arm's own cold pass cannot meet it — is labelled as such
wherever it appears.

## Where the evidence lives

```text
../DESIGN.md                  the preregistration and its three amendments
RUN-INFO.md                   this file
ADVERSARIAL.md                defects found and fixed; the attack list walked
SUMMARY.md                    generated tables and efficiency curves
FINDINGS.md                   the result and the verdict
prep/<app>.json               universe, image digest, TRAIN/TEST/held-out surface,
                              per-category held-out sets, each strategy's declared
                              inputs, budgeted list sizes, the long-tail table
                              with why + mechanism per group, and the workload
                              validation output
prefetch/<app>/<arm>.ranking.json   the exact frozen total ranking per arm
band/<app>.json               the frozen steady-state band and the warm windows
                              it was computed from
trials/<app>/traffic-f<N>.json      the exact traffic sequence for family N —
                              stored ONCE per family rather than per trial,
                              because every arm at every budget runs the
                              identical sequence for a given family
trials/<app>/<cell>/          one directory per trial: milestones (trial.json),
                              per-request events, 100 ms fetch samples, nydus
                              telemetry, app log, runner log, cgroup CPU

The three bulky streams (`events.jsonl`, `samples.jsonl`, `app.log`) and the
frozen rankings are stored gzipped; `analyze.ts` reads either form, so the whole
analysis re-runs from the preserved record without unpacking anything. The
per-trial copies of the budgeted prefetch list were removed: every one is an
exact prefix of the arm's frozen ranking and is reproduced by `truncate()`.
<app>.metrics.json            computed per-cell metrics, coverage, sensitivity,
                              training matrix, correctness, per-trial detail
```
