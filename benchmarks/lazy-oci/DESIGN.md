# Experiment 3 — semantic placement on a commodity lazy-OCI substrate

**Preregistration. Written and committed before any arm was executed and
before any timing, fetch or correctness outcome was observed.**

ADR-0007 experiment 3. Experiments 1 (static working-set placement) and 2
(runtime hydration curves) are preserved untouched in
`benchmarks/working-set/first-run/` and `benchmarks/hydration/run-1/`; this
directory is new and overwrites nothing.

---

## 1. The question

Experiments 1–2 established two facts about the frozen corpus:

```text
large static working-set sparsity exists        YES  (Plan B cold: 72.7% median)
most of the candidate-COLD set stays cold       YES  (99.3% byte-weighted)
```

Neither establishes that Reducer is a differentiated product. The commercial
null hypothesis is:

> Generic lazy OCI (eStargz / Nydus / SOCI / image streaming) plus generic
> filesystem-access prefetch captures nearly all of the performance and
> reliability benefit, leaving little incremental value for Node-semantic
> planning.

This experiment attempts to **falsify** that null hypothesis. Reducer is not
assumed to win. Two separable hypotheses:

- **Hypothesis A (recoverability).** A complete immutable lazy-loaded image
  preserves execution on held-out Node paths that a closed static-traced/slim
  artifact omits.
- **Hypothesis B (semantic advantage).** Given the *same* lazy-OCI substrate,
  Node/package/module knowledge makes materially better residency/prefetch
  decisions than a generic file-access training trace.

Hypothesis B is the product-differentiation test.

---

## 2. Phase 0 — substrate selection

### 2.1 Candidates evaluated

| substrate | standalone data path | prefetch input | telemetry | verdict |
| --- | --- | --- | --- | --- |
| **Nydus** (dragonflyoss) v2.4.5 | `nydusd` fusedev + registry backend — no containerd required | explicit **file list** at build (`nydus-image create --prefetch-policy fs`), honoured natively by `nydusd` `fs_prefetch` | per-inode access pattern with first-access timestamps, per-file `data_read`, backend **request count** + **byte count** + latency histograms, blobcache prefetch counters | **SELECTED** |
| **stargz-snapshotter** (eStargz) v0.18.2 | requires containerd + snapshotter plugin (or `stargz-store` FUSE daemon) inside the VM | prioritised files expressed only as a **contiguous prefix** of layer order + `.prefetch.landmark`, normally produced by running the workload under `ctr-remote images optimize` | Prometheus counters at layer granularity; no per-file first-access record | rejected — see below |
| SOCI / managed image streaming | AWS-hosted control plane, not runnable locally | — | — | rejected: not available in this environment |

**Why Nydus.** Three requirements decided it:

1. **The prefetch input is an arbitrary file list.** That is exactly the shape
   of a Reducer plan (whole-file HOT/COLD placement, ADR-0007). eStargz can
   only express a prefetch set as a prefix of a total file order, which is
   expressively equivalent but forces the strategy and the layout to be varied
   together, confounding "which files" with "how they were packed".
2. **Per-file telemetry.** The generalisation metrics in §8 need to know which
   *files* faulted remotely and when. Nydus exposes `/api/v1/metrics/pattern`
   (inode → first-access timestamp) and `/api/v1/metrics/files` (inode →
   bytes read). eStargz exposes neither.
3. **Least invasive.** `nydusd` runs standalone against an OCI registry; it
   does not require installing containerd, CNI and a snapshotter plugin inside
   the Docker Desktop VM. `nydusd` *is* the production Nydus data path —
   `nydus-snapshotter` only manages its mount lifecycle — so this is the
   commodity implementation, used without the orchestration layer that this
   experiment does not test.

Reducer therefore owns only:

```text
Node semantics  →  working-set / prefetch decisions  →  commodity lazy OCI
```

No proprietary hydration runtime, CAS, FUSE filesystem, registry, snapshotter,
control plane, or ML predictor is built.

### 2.2 Selected substrate configuration

```text
image build   nydus-image create --fs-version 6 --compressor zstd
                                 --digester sha256 --chunk-size 0x100000
                                 --repeatable [--prefetch-policy fs < list]
remote        registry:2 (OCI distribution v2), real /v2/<repo>/blobs/<digest>
              HTTP Range requests, on a separate container
mount         nydusd --config … --mountpoint /mnt/rafs --bootstrap …
              backend=registry, cache=blobcache(work_dir, wiped per trial)
writable      overlayfs: lowerdir=/mnt/rafs, upperdir=tmpfs  (what a
              snapshotter does; app writes never touch the immutable image)
prefetch      native fs_prefetch: {enable, threads_count:4,
              merging_size:131072, prefetch_all}
telemetry     /api/v1/metrics{,/backend,/blobcache,/pattern,/files}
network       tc netem on the app container's eth0
```

**Caching behaviour.** `blobcache` stores fetched chunks under a work dir plus
a chunk map; it is deleted before every trial. The kernel page cache for the
FUSE mount dies with the container. The registry's own page cache in the VM
cannot be reset and is warm for every arm equally (§9).

**Prefetch mechanism.** Native. The prefetch set is compiled into the RAFS
bootstrap as a prefetch table; `nydusd` fetches it with 4 background threads
at mount, merging adjacent chunks up to `merging_size`, concurrently with
application start — exactly as a snapshotter deployment behaves.

**Limitations of the substrate choice** (carried into the report):

- Nydus reorders blob chunks so that prefetch-table files are contiguous.
  Different arms therefore produce **different blob layouts**. Mitigation:
  every arm's image is proven **content-identical** (same file set, same
  per-file SHA-256, same mode/symlink structure) before any trial, and blob
  size + compressor + chunk size are reported per arm (§9 attack 3).
- Only the **application universe** is in the lazy image. The Node binary and
  the base OS come from the container image and are eagerly present in every
  arm. This is conservative: it removes ~120 MB of download that a real lazy
  deployment would charge to the eager arm, so it *understates* the lazy
  advantage uniformly.

### 2.3 Environment and privileges

```text
host            macOS 25.1.0, arm64 (Apple M1 Pro), 64 GiB
container VM    Docker Desktop 4.37.2, Linux 6.10.14-linuxkit aarch64,
                10 CPU, 7.65 GiB RAM
privileges      --privileged (needs /dev/fuse, SYS_ADMIN for overlayfs,
                NET_ADMIN for tc netem)
node            node:24-bookworm-slim → Node v24.19.0, the exact version
                .tool-versions pins and the corpus was materialised with
```

**Blocker recorded, not worked around:** macFUSE is not installed and cannot
be installed non-interactively (kernel/system extension, admin approval,
reboot). A lazy mount therefore cannot exist on the macOS host, so the
applications must execute inside Linux. This forces §3.2.

---

## 3. Corpus

### 3.1 Application selection criteria (fixed before any outcome)

Selection maximises experimental information under the research priorities of
the external brief (recorded retrospectively in `docs/PROBLEM-CONTEXT.md` §5;
originally "the goal's list"), subject to
the hard constraint that the application must be able to execute under Linux
arm64 at its frozen SHA:

| # | required property | app chosen | evidence used (all from experiments 1–2, i.e. prior) |
| --- | --- | --- | --- |
| 1 | very large dependency universe | **n8n** | 2 074 MB universe / 252 545 files — largest in corpus |
| 2 | high static uncertainty | **n8n** | 29 491 NFT warnings (100× the next app) |
| 3 | framework-heavy, plugin/dynamic loading | **strapi** | 820 MB, 2 019 packages, `control` category |
| 4 | native/ORM-heavy ("the Prisma case") | **express-realworld** | Prisma + Postgres, 6 native addons |
| 5 | many mixed HOT/COLD packages | **juice-shop** | 834 `mixed-stays-mixed` packages, 21 112 files |
| 6 | smaller / control application | **json-server** | 2.8 MB universe, 1 137 files |
| 7 | strong existing representative workload | **uptime-kuma** | `common` + `full` + `extended` phases already exist; 26 604 files, native sqlite |
| 8 | second boots-as-is control, dynamic plugin resolution | **verdaccio** | 53 MB, plugin loader, boots unmodified under Linux |

Selected: **json-server, verdaccio, express-realworld, uptime-kuma,
juice-shop, strapi, n8n** (7 apps). This deliberately includes two `control`
apps (strapi, n8n-adjacent difficulty) and the two hardest apps in the corpus;
it is not a favourable-only subset.

Explicitly **not** selected and why: `ghost`, `bulletproof-nodejs`,
`nestjs-realworld` are BLOCKED in experiment 2 for frozen-materialisation
reasons; `outline`, `nodebb`, `parse-server`, `hackathon-starter`,
`node-express-boilerplate`, `express-rest-boilerplate` need external
Mongo/Redis services and add no property not already covered;
`excalidraw-room`, `nestjs-typescript-starter`, `fastify-demo` are dominated
by json-server/verdaccio as controls.

### 3.2 Deviation: linux/arm64 re-materialisation

The frozen corpus was installed on darwin-arm64. Its native addons are Mach-O
and abort under any Linux substrate (`invalid ELF header`), and its
platform-optional packages are the darwin ones (`@img/sharp-darwin-arm64`, …).

For apps that need them, the universe is re-materialised as
**corpus-v1-linux**:

```text
same pinned app SHA          (verified with git rev-parse before copying)
same lockfile                (npm ci / pnpm install --frozen-lockfile /
                              corepack yarn install --immutable)
same install command as benchmarks/hazard-domain/MATERIALIZATION.md
built artefacts (dist/, build/) kept — JS output is platform-independent
only node_modules is re-resolved, for linux/arm64
```

`npm ci` is run with `--dangerously-allow-all-scripts` because npm 11.17
otherwise refuses install scripts by default, which would reproduce the
missing-binary failure.

Apps that boot unmodified under Linux with the darwin tree
(**json-server**, **verdaccio**) keep the **frozen** tree: zero deviation.

Consequence, stated so it cannot drift: the preserved experiment-1/2 byte
numbers describe the darwin tree. Every number in this experiment is computed
over the tree actually measured, and the placement plan is **recomputed** with
the same `packages/working-set-planner` code over that tree. No preserved
result is edited.

---

## 4. TRAIN and HELD-OUT TEST workloads

Workloads come from `benchmarks/hydration/recipes.ts` — the repository's own
routes, already written for experiment 2 without knowledge of this
experiment. Nothing is invented to defeat static tracing.

```text
TRAIN  =  startup  +  phase "common"
TEST   =  startup  +  phase "full" (and "extended" where it exists)
```

- `startup` is **shared**: both workloads boot the pinned entry.
- `common` requests are **TRAIN-only** (they are not replayed in TEST unless a
  `full` sequence needs them for state).
- every request in `full` / `extended` is **TEST-only**.

The per-app TRAIN-only / shared / TEST-only request lists are emitted verbatim
into `run-*/workloads.json` at run time. TRAIN is executed **once per app**,
offline, purely to produce evidence for B2/B3b. Every *measured* trial runs
the **TEST** workload. A generic trace is therefore never evaluated on the
exact accesses it was trained on.

---

## 5. Experiment A — closed traced artifact vs recoverable lazy artifact

| arm | artifact | files physically present |
| --- | --- | --- |
| **A1** | full eager universe | all |
| **A2** | closed static-traced slim artifact | **only** the `@vercel/nft` trace of the pinned entry (`packages/tracer`) — the same strategy Next.js `output: "standalone"` ships |
| **A3** | complete immutable lazy image, initial residency = the A2 set | all (non-resident files are still in the image) |

A2 is a *legitimate* production tracing strategy, not a deliberately broken
image. A2 and A3 make the **same placement decision**; only recoverability
differs. Recorded per arm: artifact bytes, TRAIN result, TEST result,
`MODULE_NOT_FOUND`/`ERR_MODULE_NOT_FOUND`/`dlopen` failures, and the identity
of every missing file.

Every A2 failure is classified by Node mechanism: computed `require`/`import`,
`createRequire`, dynamic path, plugin resolution, filesystem lookup, generated
source, worker/secondary entrypoint, native/WASM discovery, symlink/workspace,
other. Isolated artificial failures are not overstated: a failure counts only
if it arises from the application's own code or its dependencies' own
resolution behaviour.

---

## 6. Experiment B — arms

All lazy arms use a **content-identical** complete image of the same universe.
The only intentional variable is the initial-residency / prefetch decision.

| arm | mount config | prefetch set |
| --- | --- | --- |
| **B0** eager | `fs_prefetch.prefetch_all=true`, app start **blocked until `data_all_ready`** | everything — the `docker pull`-then-run analogue |
| **B1** generic lazy | `fs_prefetch.enable=false` | ∅ (substrate default only) |
| **B2** generic trained | native fs prefetch | see §7.1 |
| **B2d** generic trained + generic expansion | native fs prefetch | see §7.1b |
| **B3a** static Reducer | native fs prefetch | see §7.2 |
| **B3b** Reducer + TRAIN | native fs prefetch | see §7.3 |

### 6.1 Fairness — what each arm is allowed to know

| information | B1 | B2 | B3a | B3b |
| --- | --- | --- | --- | --- |
| file paths + sizes of the image | ✓ | ✓ | ✓ | ✓ |
| TRAIN filesystem accesses (which files, order, timestamps) | — | **✓** | — | **✓** |
| Node module graph / import edges | — | — | ✓ | ✓ |
| package identity + boundaries | — | — | ✓ | ✓ |
| `@vercel/nft` positive trace | — | — | ✓ | ✓ |
| resolver metadata semantics (`package.json` must be readable first) | — | — | ✓ | ✓ |
| opaque-boundary (native/WASM/install-script) package classification | — | — | ✓ | ✓ |
| any TEST-phase information | — | — | — | — |

B3b receives **exactly** B2's behavioural evidence plus the static rows above.
Nothing else. No arm sees TEST.

---

## 7. Prefetch strategies — frozen before any TEST result is viewed

### 7.1 B2 — generic trace prefetch (the strongest generic null)

```text
input : TRAIN access log at the filesystem layer only —
        (path, first-content-read timestamp) for every file whose CONTENT
        was read by the application process tree during TRAIN
output: those paths, ordered by first-access timestamp
```

No path is interpreted. `node_modules`, `package.json`, `.js` mean nothing to
this strategy. This is the representation a generic system builds from a
workload trace (eStargz `ctr-remote images optimize`, Nydus prefetch hint).

### 7.1b B2d — generic trace prefetch with generic directory expansion

**Amendment, added before any measured trial ran** (recorded rather than
silently folded in). B3b expands around what TRAIN observed; a null hypothesis
that is forbidden to expand is a straw man. B2d therefore gets:

```text
S  = TRAIN-touched files
S' = S ∪ every file in a directory that contains a file of S   (one level,
                                                                non-recursive)
order = TRAIN first-access order, directory-grouped
```

Directory membership is filesystem structure, available to any generic
snapshotter. B2d still cannot tell a package from a folder, an import edge
from a coincidence, or `node_modules` from `views`. Recursive expansion is
excluded because "prefetch every descendant" is not a strategy, it is the
eager arm.

The comparison that matters for the product question is therefore
**B3b vs max(B2, B2d)**, not B3b vs B2 alone.

### 7.2 B3a — static Reducer (no workload evidence at all)

The existing Plan B HOT set from `packages/working-set-planner`, recomputed
over the measured tree:

```text
nft-positive        ∪  entrypoint  ∪  resolver-metadata (package.json)
                    ∪  opaque-boundary packages (own files)
```

ordered depth-first along the NFT module graph from the entrypoint, so that
import-adjacent files are adjacent in the prefetch order.

### 7.3 B3b — Reducer with the same TRAIN evidence as B2

Motivated directly by the experiment-2 finding that **99.1 % of consecutive
hydration misses arrive within 50 ms** and **89.5 % are in the same package**:

```text
S0 = TRAIN-touched files                       (identical to B2's set)
S1 = S0 ∪ every package.json in the universe   (resolver metadata: Node must
                                                read these to resolve at all,
                                                and they are tiny)
S2 = S1 ∪ { NFT-positive files of every package that S0 touched }
                                               (bounded semantic companion
                                                cluster: static positive
                                                evidence, restricted to
                                                packages already proven live)
prefetch set = S2
order        = package-major, then NFT-graph depth-first within a package,
               so one package's files form one contiguous blob run
```

Deliberately **not** "prefetch the whole package" — experiment 1 showed 57.8 %
of cold bytes sit inside partially-HOT packages, so file-level sparsity is the
asset being protected. No machine learning. No new predictor invented for this
benchmark; every input already exists in the repository.

---

## 8. Metrics — formulas fixed before computation

Whole-file placement is the model (ADR-0007), so precision/recall are computed
over **file bytes**; substrate cost is reported separately in **chunk bytes**.

```text
needed(TEST)      = { f : nydus per-file data_read(f) > 0 during the TEST run }
neededBytes       = Σ size(f) for f ∈ needed(TEST)
prefetched        = the arm's prefetch set ∩ universe
prefetchedBytes   = Σ size(f) for f ∈ prefetched

precision         = Σ size(f), f ∈ prefetched ∩ needed(TEST)   /  prefetchedBytes
waste             = 1 − precision                (also reported in bytes)
recall            = Σ size(f), f ∈ prefetched ∩ needed(TEST)   /  neededBytes
unexpectedMiss    = needed(TEST) \ prefetched      (files + bytes)
faultAmplification= backend.read_count  /  |needed(TEST)|      (remote requests
                                                                per needed file)
remoteOpsPerMB    = backend.read_count  /  (backend.read_amount_total / 2^20)
```

Timing milestones, all measured from **t0 = container start**:

```text
t_mount        nydusd mount + overlay ready
t_proc         node process exec'd
t_ready        the recipe's own ready predicate satisfied
t_req1         first TEST request that returns its expected status
per-request latency for every TEST request: p50 / p95 / p99 (p99 only where
n ≥ 100 across repetitions)
```

Fetch state is sampled every 100 ms (`backend.read_count`,
`backend.read_amount_total`, `blobcache.prefetch_data_amount`,
`fs.data_read`) to produce cumulative curves with the four milestones marked.
Bytes fetched **before** `t_proc`, `t_ready`, `t_req1` are read off those
curves. CPU overhead is `nydusd` + app CPU-seconds from cgroup accounting.

**No composite score is computed.** Absolute differences are reported
alongside relative ones, always.

---

### 8.1 Amendment — where `needed(TEST)` and the TRAIN trace come from

**Recorded before any measured trial ran.** §8 originally intended to read both
the TRAIN access trace and `needed(TEST)` out of nydus's own per-file
telemetry. That is not possible: `nydusd` truncates `/api/v1/metrics/files`
(~290 KB) and `/api/v1/metrics/pattern` (~219 KB), so for any real application
the response is not even valid JSON.

Both therefore come from **observation runs**: the application on an eager
mount with experiment 2's observe-only tracer preloaded, driven by the TRAIN or
TEST workload. Observation runs are never measured trials — they are eager,
they carry instrumentation, and no timing from them enters any result.

The information handed to B2/B2d is unchanged in kind: *which file's content
was read, and when*. Nothing about Node, packages or module graphs is exposed
by it.

One correction is applied to the tracer's output, and it is a measured
correction, not an assumption: Node reads a package's `package.json` during
resolution through the C++ binding `internalModuleReadJSON`, which no
JS-level `fs` patch can observe. On json-server — small enough that nydus's
own response is complete — the tracer saw 94 files, the substrate 133, and the
39 it missed were *exactly* the `package.json` of every package resolved into.
Adding each touched file's owning-package `package.json` reproduces the
substrate set exactly (133/133). Omitting it would have charged the arms that
deliberately prefetch resolver metadata (B3a, B3b) for it as pure waste, i.e.
would have biased the experiment **against** Reducer.

Per-trial per-file attribution is lost by this change: `needed(TEST)` is one
app-level ground truth shared by every arm. That is sound only while the arms
are behaviourally identical, which the §10 correctness gate checks on every
trial.

## 9. Cold-start discipline and trial ordering

Reset before **every** trial:

```text
blobcache work dir      deleted
overlay upper + work    deleted (fresh tmpfs)
container               fresh (page cache for the mount dies with it)
application state       scratch dir recreated; DB dropped/recreated
generated artifacts     removed
```

Cannot be reset, documented instead: the VM's page cache over the registry's
own blob storage (warm for every arm equally), and the host SSD.

Repetitions: **5** per (app, arm); **3** for apps whose median trial exceeds
60 s. Order is **rotated** so no arm systematically follows another:

```text
rep 1  B0 B1 B2 B3a B3b
rep 2  B1 B2 B3a B3b B0
rep 3  B2 B3a B3b B0 B1
…
```

Reported: median and full spread per (app, arm). A single timing is never a
conclusion.

---

## 10. Correctness gate

A lazy run counts only if it is behaviourally equivalent to A1/B0 for the
exercised workload: same process exit status, same HTTP status per request,
same response body contract (structural comparison of the captured fields the
recipe already extracts), same expected generated files. **A faster arm that
diverges is a failure, not a win.**

---

## 11. Adversarial review (refute-by-default, applied before freezing)

Attack list, each of which must be shown addressed or accepted:

1. cache contamination between arms
2. unequal underlying image contents
3. compression/layout accidentally favouring one arm
4. TRAIN/TEST leakage
5. generic prefetch given less information than it legitimately could have
6. Reducer given hidden workload knowledge
7. workload failure mistaken for fast readiness
8. instrumentation loading one arm more than another
9. network drift between trials
10. generated files counted as image files
11. background processes
12. child-process/worker instrumentation gaps
13. retries warming later trials
14. benchmark ordering
15. route setup/auth failures counted as successes
16. Ready-signal definition differing per arm
17. remote read/request accounting differing per arm
18. prefetch bytes counted differently across implementations

Confirmed defects are fixed and **affected trials rerun** before any result is
frozen.

---

## 12. Preservation

```text
benchmarks/lazy-oci/
  DESIGN.md            this preregistration
  materialize.sh       corpus-v1-linux materialisation
  run-N/
    RUN-INFO.md        provenance, versions, digests, deviations
    workloads.json     TRAIN-only / shared / TEST-only per app
    images.json        per-app per-arm blob digest, size, content proof
    prefetch/          the exact frozen prefetch manifests per arm
    trials/            one JSON per trial: ordering, raw timings, telemetry
    correctness.json   per-request comparison against B0
    SUMMARY.md         per-app and aggregate results
```

Nothing under `benchmarks/working-set/`, `benchmarks/hydration/` or
`benchmarks/hazard-domain/` is modified.
