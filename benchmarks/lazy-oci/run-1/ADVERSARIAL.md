# Adversarial review — refute by default

The repository's standing discipline: a measurement is assumed wrong until each
known way of being wrong has been attacked and either **closed** or **stated as
a limitation**. This file is the record for ADR-0007 experiment 3.

Every defect in §1 was found and fixed **before** any result was frozen, and
every affected run was redone.

---

## 1. Confirmed measurement defects, found and fixed

| # | defect | how it would have corrupted the result | fix |
| --- | --- | --- | --- |
| D1 | **Network shaping was on the wrong direction.** `tc netem … rate` was attached to the *application* container's egress. `rate` limits only the direction it is attached to, and blob bytes travel registry → app. | Range *requests* would have been delayed while *responses* arrived at VM speed: lazy loading with no bandwidth cost at all. Every arm's fetch time would have collapsed toward zero and the whole B0-vs-lazy comparison would have been meaningless. | shaping moved to the registry container's egress; verified end-to-end with a 50 MB blob (11.5 MB/s = 92 Mbit/s, twice, stable). |
| D2 | **overlayfs upperdir on overlayfs.** `/work` was the container's own writable layer, so `mount -t overlay` failed with `wrong fs type`. | The app never saw the lazy mount; the trial "completed" with a ready-timeout that a summary could easily have read as a slow arm. | `/work` is a docker volume; it is wiped before t0 in every trial (which is also the blobcache cold-start reset). |
| D3 | **Inode join silently collapsed.** nydusd reports `st_ino` as `2^56 + RAFS nid`, which exceeds 2^53; parsing it as a JS Number rounded it to a multiple of 16. | 1 288 distinct files mapped onto 328 keys; only 11 of 134 observed accesses joined. Every per-file metric would have been ~90 % under-counted, and the TRAIN evidence handed to B2 would have been almost empty — flattering the Reducer arms. | parsed as `BigInt`, offset subtracted, and the join asserted non-empty. |
| D4 | **`data_all_ready` is not a completion signal.** It stays `false` even after `prefetch_all` has fetched the entire blob. | The eager arm B0 would have spun until its 20-minute cap on every app and been recorded as pathologically slow — a fake win for every lazy arm. | B0 waits on the blobcache's `prefetch_end_time_secs`. |
| D5 | **Multi-line setup commands were eval'd line by line.** Several recipes build a config file with a multi-line `printf`. | verdaccio got a truncated `config.yaml` (`CONFIG: storage path not defined`) and never started; the arm would have been recorded as a failure of *lazy loading*. | setup entries are written to one script and executed as a unit. |
| D6 | **Dev dependencies inflated the universe.** `buildUniverse` derives the dev boundary from `package-lock.json`, which pnpm and yarn-berry trees do not have. | json-server's "production universe" measured 65.3 MB instead of 3.2 MB — a 20× inflated image, an inflated eager-arm download, and an inflated lazy advantage. | the frozen production population is used as the filter, as in experiments 1–2, plus the optional-dependency platform variants a linux install legitimately resolves. |
| D7 | **nydusd truncates its own per-file telemetry.** `/api/v1/metrics/files` and `/api/v1/metrics/pattern` are cut at ~290 KB / ~219 KB and are not valid JSON for any real application. | Precision/recall/waste would have been computed from a silently truncated prefix of the accessed set. | the per-file ground truth comes from the experiment-2 observe-only tracer on an eager instrumented run; substrate telemetry is still used for everything it reports completely (remote request count, remote bytes, latency, prefetch counters). |
| D10 | **uptime-kuma's held-out socket.io phase does not execute in this harness.** The phase is a `node -e` socket.io client. It ran correctly once, and thereafter exits immediately with **exit 0, no stdout, no stderr** — reproducibly, including in isolation against an eagerly-mounted, fully-started uptime-kuma, and including when the same program is run from a file rather than `-e`. A minimal socket.io client in the same image against the same server connects and receives acks normally, so the substrate, the network and the client library are not the cause; the fault is in that specific program under this driver and was **not diagnosed**. | Every arm skipped the held-out socket surface. Two consequences: the trials exercised less than the workload claims, and uptime-kuma's **`needed(TEST)` was measured on the same truncated workload**, so its "0 TEST-only files" is *not* evidence that the socket surface needs no new files. | **uptime-kuma is withdrawn from the held-out-surface claim** and kept only as a cold-start timing data point, where it remains valid because every arm ran the identical (truncated) workload. Its readiness predicate is now the app's own HTTP surface and all 18 trials were rerun under that single definition. The analyzer now flags any command phase that produced no output, so this class of failure cannot pass silently again. |
| D9 | **Stale per-arm blob directories made two recorded digests wrong.** The first image builder took the blob digest from `ls <blobdir> \| head -1`; when a directory still held a previous build's blob, it reported the alphabetically-first one. For json-server, B2's recorded digest was the *base* arm's blob and B2d's was a blob from an earlier prep, so the object actually referenced by the bootstrap was never pushed. | The trial died on `BLOB_UNKNOWN` — visible as a hang, not as an error. Had the stale blob happened to exist in the registry, an arm would silently have run somebody else's image and its numbers would have looked fine. | each arm's blob directory is emptied before its build, and the digest read from the directory is now asserted equal to the one `nydus-image inspect` reports the bootstrap references. All affected images were rebuilt and all affected trials rerun. |
| D8 | **The tracer has a blind spot, and it is exactly the resolver metadata.** Node reads a package's `package.json` during resolution through the C++ binding `internalModuleReadJSON`, which no JS-level `fs` patch can see. Measured on json-server: tracer 94 files, substrate 133, and the 39 missing were *all* `package.json`. | `needed(TEST)` would have excluded resolver metadata, so the arms that deliberately prefetch every `package.json` (B3a, B3b) would have been charged for it as pure waste. The bias ran **against** Reducer. | for every touched file, its owning package's `package.json` is added. Reproduces the substrate set exactly (133/133) on the app where the substrate response is complete enough to check. |

---

## 2. The attack list, and where each stands

| # | attack | status |
| --- | --- | --- |
| 1 | cache contamination between arms | **closed** — one throwaway container per trial; `/work` (blobcache, overlay upper/work) wiped before t0; the FUSE mount's page cache dies with the container; postgres dropped/recreated per trial. |
| 2 | unequal underlying image contents | **closed** — every arm's image is mounted and hashed (`path\tsize\tmode` for files, `path -> target` for symlinks, `sha256` for every regular file) and the digests must be identical or `prep` aborts. |
| 3 | compression/layout accidentally favouring one arm | **stated** — all arms use identical `--compressor zstd --digester sha256 --chunk-size 1MiB --repeatable`; only the prefetch table (and the chunk ordering nydus derives from it) differs. Blob size per arm is recorded in `prep/<app>.json`. Layout *is* part of what a prefetch strategy legitimately controls (DESIGN.md §2.2). |
| 4 | TRAIN/TEST leakage | **closed** — TRAIN is `startup + phase "common"`, TEST is `startup + every other phase`; the phase lists come from experiment 2's recipes, written before this experiment existed. Every measured trial runs TEST. B3a sees no workload evidence at all. |
| 5 | generic prefetch given less information than it could have | **closed** — B2 gets the complete access log with timestamps, and **B2d** was added before any trial so the generic arm may also expand around what it saw. The headline compares B3b against the better of the two. |
| 6 | Reducer given hidden workload knowledge | **closed** — B3b's inputs are enumerated in `run-1/prefetch/<app>.B3b.json` and are exactly B2's trace plus package boundaries, the NFT trace, and resolver-metadata semantics. No arm sees TEST. |
| 7 | workload failure mistaken for fast readiness | **closed, and it fired** — a trial counts only if the ready predicate passed *and* the workload completed, and every request's status plus a body hash is compared slot-by-slot against B0. That was not sufficient: a *command* phase can connect, do nothing and exit 0 (D10). The analyzer now additionally flags any command phase that produced no output, and `silentCommandTrials` is recorded per app. |
| 8 | instrumentation loading one arm more than another | **closed** — the tracer runs only on observation runs, never on a measured trial. The sampler is one long-lived Node process polling a unix socket every 100 ms, identical in every lazy arm. B0/B1 share an image, so they even share a bootstrap size. |
| 9 | network drift | **closed empirically** — shaping is applied once and verified (11.5 MB/s, twice, stable). Pearson r between a trial's execution order and its ready time is ≈ 0 on every app with a full repetition set (verdaccio −0.03, express-realworld −0.06), so nothing drifted over the run. `orderDrift` is recorded per app in `<app>.metrics.json`. |
| 10 | generated files counted as image files | **closed** — the image contains only production-universe files; everything the app writes lands in the overlay upper (tmpfs-backed volume) and in `/scratch`, neither of which is in the image or in any metric. |
| 11 | background processes | **stated** — trials run serially; no plan/build/observation job overlaps a measured trial. The host is a developer machine, which is why medians over rotated repetitions are reported with min/max, never a single timing. |
| 12 | child-process / worker instrumentation gaps | **closed for the substrate** — nydus counts every read of the mount regardless of which process issues it. For the observation runs the tracer is injected through `NODE_OPTIONS`, so children and workers inherit it. |
| 13 | retries warming later trials | **closed** — no arm is retried inside a trial; a failed trial is recorded as failed, and `/work` is wiped at the start of the next one. |
| 14 | benchmark ordering | **closed empirically** — the arm order rotates by repetition, and the order-vs-ready correlation above shows no position effect. |
| 15 | route setup/auth failures counted as successes | **closed** — the correctness comparison is against B0's status for the same request slot, so a route that 401s in every arm cannot be mistaken for success in one. |
| 16 | Ready-signal differing per arm | **closed** — one predicate per app, taken from experiment 2's recipe, evaluated by the same in-container driver in every arm. |
| 17 | remote read/request accounting differing per arm | **closed** — one source (`/api/v1/metrics/backend`), same units, same endpoint, every lazy arm. B0's own fetch is counted the same way, and the count checks out: uptime-kuma's B0 fetched 57.1 MB against a 57.1 MB blob, i.e. the eager arm really does pull the whole image before starting. |
| 18 | prefetch bytes counted differently across implementations | **closed** — there is one implementation: nydus's native `fs_prefetch` driven by a build-time prefetch table. No arm has a bespoke prefetcher. |

---

## 3. Limitations that remain (stated, not fixed)

1. **Per-trial per-file attribution is unavailable** (D7). `needed(TEST)` is one
   app-level ground truth shared by all arms. This is defensible only because the
   correctness gate shows the arms answered identically; if an arm had diverged,
   its needed set could differ and its precision/recall would be misattributed.
2. **Only the application universe is lazy.** Node and the base OS are eagerly
   present in every arm, removing ~120 MB from the eager arm's download. The
   direction is conservative: it makes B0 look *better* than a real eager pull.
3. **One network profile** (25 ms, 100 Mbit). Conclusions about absolute
   seconds are conditional on it; the shape of the comparison is not.
4. **Single machine, single run.** Medians over rotated repetitions with min/max
   are reported; no cross-machine reproduction was attempted.
5. **corpus-v1-linux** re-materialisation (RUN-INFO.md §Deviations) means the
   measured trees are not byte-identical to the ones experiments 1–2 measured,
   though the app SHA and lockfile are.
