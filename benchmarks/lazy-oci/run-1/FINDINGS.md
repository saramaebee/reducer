# Does Reducer's Node-semantic layer add value on top of commodity lazy OCI?

ADR-0007 experiment 3. Preregistration: [`../DESIGN.md`](../DESIGN.md).
Provenance: [`RUN-INFO.md`](RUN-INFO.md). Refute-by-default review:
[`ADVERSARIAL.md`](ADVERSARIAL.md). Numbers: [`SUMMARY.md`](SUMMARY.md) and
`run-1/<app>.metrics.json`.

---

## 1. Substrate

**Nydus v2.4.5** (dragonflyoss), RAFS v6 over `nydusd` in fusedev mode, with an
OCI **registry backend** (`registry:2`) and an overlayfs upper — the commodity
lazy-OCI data path a snapshotter drives, used without containerd.

Chosen over **stargz-snapshotter v0.18.2** for three reasons, all of which are
about whether the experiment can be *measured*, not about which is better
technology:

1. **The prefetch input is an arbitrary ordered file list**, which is exactly
   the shape of an ADR-0007 placement plan. eStargz can only express a
   prioritised set as a prefix of a total layer order plus a landmark, which
   forces "which files" and "how they were packed" to vary together.
2. **Per-file telemetry.** The generalisation metrics need to know which files
   faulted and when.
3. **Least invasive.** `nydusd` runs standalone; stargz needs containerd plus a
   snapshotter plugin inside the VM.

SOCI / managed image streaming were excluded: they are hosted control planes,
not runnable in this environment.

Reducer owns only the layer under test:

```text
Node semantics → working-set / prefetch decisions → commodity lazy OCI
```

No hydration runtime, CAS, FUSE filesystem, registry, snapshotter, control
plane or predictor was built. Prefetch is nydus's own `fs_prefetch`, driven by
a build-time prefetch table.

## 2. Environment limits

- **macFUSE is absent** and cannot be installed non-interactively (system
  extension + admin approval + reboot), so no lazy mount can exist on the macOS
  host and the applications must run inside Linux.
- That forces **corpus-v1-linux**: five of the seven selected apps were
  re-installed for linux/arm64 at the same pinned SHA, from the same lockfile,
  with the same install command. Two (json-server, verdaccio) boot unmodified
  and keep the frozen tree.
- **Docker Desktop VM**: 10 CPU, 7.65 GiB, kernel 6.10.14-linuxkit aarch64.
  `--privileged` is required (`/dev/fuse`, overlayfs, `tc`).
- **Only the application universe is lazy**; Node and the base OS are eagerly
  present in every arm. That removes ~120 MB of download from the **eager**
  arm, so it understates the lazy advantage.
- **One network profile**: 25 ms delay, 100 Mbit, applied to the registry's
  egress and verified at 11.5 MB/s.

## 3. What was measured

Seven applications were selected against preregistered criteria (DESIGN.md
§3.1) before any outcome was seen. Six were measured; **n8n was not** — see §9.

Six arms, one content-identical complete image per app, differing only in the
prefetch table:

```text
B0   eager      the docker-pull analogue: prefetch_all, start blocked until done
B1   lazy       no prefetch at all
B2   generic    the TRAIN filesystem access trace, in access order
B2d  generic+   TRAIN trace ∪ one level of directory expansion
B3a  Reducer    static only: NFT + entry + resolver metadata + opaque boundaries
B3b  Reducer    the SAME TRAIN trace as B2, widened by Node semantics
```

Every measured trial ran the **held-out TEST** workload. TRAIN was executed
once per app, offline, purely to produce the evidence B2/B2d/B3b may see.

## 4. Workloads, and how much held-out surface actually exists

Workloads are the repository's own experiment-2 recipes, written before this
experiment existed. `TRAIN = startup + phase "common"`;
`TEST = startup + every other phase`.

| app | TRAIN reads | TEST reads | **TEST-only** |
| --- | ---: | ---: | ---: |
| json-server | 134 files / 0.5 MB | 133 files / 0.5 MB | **0 files** |
| verdaccio | 1 790 / 5.3 MB | 1 800 / 5.4 MB | **10 files / 0.1 MB** |
| express-realworld | 318 / 18.2 MB | 327 / 18.3 MB | **9 files / 0.1 MB** |
| uptime-kuma | 4 277 / 27.4 MB | 4 277 / 27.4 MB | **withdrawn** — see below |
| juice-shop | 2 707 / 28.7 MB | 3 114 / 34.7 MB | **452 files / 7.9 MB** |
| strapi | 4 835 / 32.1 MB | 4 844 / 32.2 MB | **9 files / 0.1 MB** |

**uptime-kuma is withdrawn from this table.** Its held-out socket.io phase did
not execute (ADVERSARIAL.md D10), and the observation run that produced its
`needed(TEST)` was truncated the same way, so its "0 TEST-only files" measures
a workload that did not run. It stays in the timing results — every arm ran the
identical truncated workload — but it is not evidence about held-out surface.

On the **five** applications where the held-out workload demonstrably ran, the
table is still the single most important result in the experiment, and it is
independent of every arm, every timing and the substrate itself:

> An entire held-out execution surface — a full authenticated CRUD sweep over
> Prisma, a plugin-driven admin API, a package-registry publish/unpublish
> cycle — reads **almost no file that startup plus a handful of common routes
> did not already read**: 9, 9 and 10 files respectively, ~0.1 MB each.

juice-shop is the single exception, and it is the informative one: 452 files /
7.9 MB of genuinely new surface.

The consequence for the commercial question is direct: a generic
workload-trace prefetcher starts with near-perfect recall on held-out
execution, so there is very little generalisation headroom for a semantic
layer to capture — except on applications shaped like juice-shop.

## 5. How the closed static artifact was produced (Experiment A)

`A2` contains **only** the `@vercel/nft` trace of the pinned entrypoint —
`packages/tracer`, the same strategy Next.js `output: "standalone"` ships.
Files outside the trace are physically absent. Symlinks whose target survives
are kept, so no failure is manufactured by breaking resolution for reasons
unrelated to tracing.

`A3` is the same placement decision expressed as initial residency inside the
**complete** lazy image. A2 vs A3 therefore isolates recoverability from
prediction quality.

## 6. Fairness — what each arm was allowed to know

| information | B1 | B2 | B2d | B3a | B3b |
| --- | --- | --- | --- | --- | --- |
| file paths + sizes | ✓ | ✓ | ✓ | ✓ | ✓ |
| TRAIN access log (paths + timestamps) | — | **✓** | **✓** | — | **✓** |
| directory membership | — | — | ✓ | ✓ | ✓ |
| package identity / boundaries | — | — | — | ✓ | ✓ |
| `@vercel/nft` static trace | — | — | — | ✓ | ✓ |
| resolver-metadata semantics | — | — | — | ✓ | ✓ |
| opaque-boundary classification | — | — | — | ✓ | — |
| anything from TEST | — | — | — | — | — |

`B2d` exists so the null hypothesis is not a straw man: B3b expands around
what TRAIN saw, so the generic arm is allowed to expand too, using filesystem
structure alone. The headline comparison is **B3b vs the better of B2 and
B2d**, per app and per metric.

### The exact strategies

**B2 (generic).** The set of files whose *content* was read during TRAIN,
ordered by first-access timestamp. No path is interpreted;
`node_modules`, `package.json` and `.js` mean nothing to it.

**B2d (generic + directory expansion).** B2's set, plus every file in a
directory that contains a B2 file — one level, non-recursive, ordered by
TRAIN first-access and grouped by directory.

**B3a (static Reducer, no workload evidence at all).** The existing ADR-0007
Plan B HOT set, recomputed over the measured tree:
`NFT-positive ∪ entrypoint ∪ every package.json ∪ opaque-boundary packages`,
ordered depth-first along the NFT module graph from the entrypoint.

**B3b (Reducer given exactly B2's evidence).**

```text
S0 = TRAIN-touched files                      (identical to B2)
S1 = S0 ∪ every package.json in the universe  (Node must read these to resolve
                                               at all, and they are tiny)
S2 = S1 ∪ NFT-positive files of every package S0 touched
order = package-major; within a package, NFT-graph depth-first
```

Deliberately **not** "prefetch the whole package": experiment 1 measured 57.8 %
of cold bytes inside partially-HOT packages, so whole-package widening spends
exactly the file-level sparsity this direction exists to exploit. No machine
learning; no predictor invented for this benchmark.

## 7. Metric definitions (fixed before computation)

Two byte currencies, never added together:

- **FILE bytes** — whole-file placement, the ADR-0007 model. Used for
  precision, recall, waste and prefetch size.
- **CHUNK bytes** — what the substrate actually moved: nydus
  `backend.read_amount_total`, and `backend.read_count` for remote requests.

```text
needed(TEST)   = files whose CONTENT the TEST workload read (observation run)
precision      = bytes(prefetched ∩ needed) / bytes(prefetched)
waste          = 1 − precision
recall         = bytes(prefetched ∩ needed) / bytes(needed)
held-out miss  = needed \ prefetched                       (files and bytes)
faultAmp       = remote requests / |needed|
remoteOpsPerMB = remote requests / (remote bytes / 2^20)
```

**A caveat the data forced, worth stating before any table is read.** File-level
*precision* is the wrong lens on a chunk-addressed substrate. On verdaccio, B3b
prefetches a **larger** file set than B2 (8.4 MB vs 5.3 MB) at a much lower
file-precision (64.5 % vs 100 %) — and still moves **fewer** bytes over the
network (3.2 MB vs 4.2 MB) in about the same number of remote requests. The
"wasted" files ride along inside chunks that were being fetched anyway, because
the semantic ordering packed them next to files that were needed. So
precision/recall/waste are reported because DESIGN.md fixed them, but the
decision-relevant quantities are **remote bytes**, **remote request count** and
**early-request latency**.

Milestones are all measured from **t0 = the instant the image is asked for**:
`t_mount`, `t_proc` (node exec'd), `t_ready` (the recipe's own predicate),
`t_req1` (first held-out request returning its expected status). Fetch state is
sampled every 100 ms so bytes-by-milestone are read off a curve rather than
assumed. No composite score is computed, and every relative number is printed
next to its absolute.

## 8. Cold-start discipline

Per trial: fresh container, `/work` docker volume wiped before t0 (blobcache,
overlay upper and work dirs), fresh `/scratch` tmpfs, postgres dropped and
recreated from the host. Arms rotate by repetition so no arm systematically
follows another. Medians over repetitions with min/max; a single timing is
never a conclusion. What cannot be reset — the VM's page cache over the
registry's own storage — is warm equally for every arm.

## 9. n8n: selected, not measured

n8n was preregistered for two criteria it uniquely satisfies (largest universe:
2 074 MB / 252 545 files; highest static uncertainty: 29 491 NFT warnings). It
is **not in the results**, and the reason is stated rather than hidden:

- its linux/arm64 re-materialisation succeeded (7.2 GB tree), but
- the analysis phase — production-universe walk, `@vercel/nft` trace and
  staging of 252 545 files — ran for over two hours without completing at ~9 GB
  RSS, and
- the six-arm content-identity build (six RAFS builds plus six full-tree
  SHA-256 verifications over a 2 GB universe) was projected to exceed the run
  budget by a wide margin on this machine.

The process was paused rather than killed, so the work is recoverable, but the
result below is a **six-application** result. strapi (915 MB, 123 474 files,
2 019 packages) is the largest and most plugin-dynamic application actually
measured, and it carries the "large universe / many small files" criterion
alone. Any claim about the 2 GB class is therefore **extrapolation**, and is
flagged as such wherever it appears.

## 10. What the arms actually did

Full tables are in [`SUMMARY.md`](SUMMARY.md). Three things it shows.

**(a) Lazy delivery is the large win, and it needs prefetch to be a win at
all.** Against the eager pull, the best lazy arm saves 1.4 s on verdaccio,
1.4 s on express-realworld and **14.9 s on strapi** (20.2 s → 5.3 s, −74 %).
But B1 — lazy with *no* prefetch — is **slower than eager** on verdaccio
(4.3 s vs 2.9 s), json-server, juice-shop and strapi, because thousands of
sequential 25 ms faults cost more than one bulk download. "Lazy OCI" is not
the product; "lazy OCI with a good initial residency set" is.

**(b) On readiness alone, semantic widening is a wash.** B3b against the
better of B2/B2d, per app: −12 ms (verdaccio), −1 564 ms (strapi),
+104 ms (json-server), +402 ms (express-realworld), +810 ms (juice-shop).
Median ≈ 0. The one large, consistent win is on the **largest** application.

**(c) Where the arms genuinely differ is early-request latency.** The generic
arms buy their fast Ready by leaving held-out files unfetched, and pay for it
on the first requests:

| app | p95 eager | p95 generic (worst) | p95 B3a | p95 B3b |
| --- | ---: | ---: | ---: | ---: |
| verdaccio | 187 ms | **526 ms** | 188 ms | 188 ms |
| express-realworld | 182 ms | **476 ms** | 176 ms | 183 ms |
| juice-shop | 142 ms | **1 386 ms** | **145 ms** | 1 209 ms |
| strapi | 34 ms | 43 ms | 39 ms | 30 ms |
| json-server | 12 ms | 11 ms | 10 ms | 13 ms |

**B3a — the arm that uses no workload evidence whatsoever — is the only arm
that never defers latency**, on every app, including the one app with a large
held-out surface. Its cost is a slower Ready (juice-shop 5.6 s vs the generic
3.3 s; strapi 10.8 s vs 6.8 s), because forcing every opaque-boundary package
hot is expensive.

Neither Reducer arm dominates: B3a owns latency, B3b owns readiness on the big
apps and inherits B2's blind spot on juice-shop. Their union is the obvious
next strategy and is **not measured here** — inventing it now to rescue the
number is exactly what this experiment was designed to prevent.

## 11. The many-small-files hypothesis: **not** where the advantage is

Public evidence says Node is hurt by the number of loose module files, not only
by total size, so the natural hope was that semantic clustering would fetch the
same working set in fewer remote operations. Measured, it does not:

| app | arm | prefetch files | merged prefetch requests | files per request |
| --- | --- | ---: | ---: | ---: |
| verdaccio | B2 | 1 790 | 43 | **41.6** |
| verdaccio | B2d | 3 816 | 249 | 15.3 |
| verdaccio | B3b | 1 994 | 77 | 25.9 |
| juice-shop | B2 | 2 707 | 150 | **18.0** |
| juice-shop | B2d | 6 353 | 609 | 10.4 |
| juice-shop | B3b | 5 249 | 646 | 8.1 |

The generic trace-ordered arm merges **best**, and the reason is structural:
nydus lays the prefetch table out contiguously in the order it is given, and a
trace's order is exactly the order the application will read in. Reducer's
package-major order is a worse match for the blob layout than "the order it
actually happened".

So where an arm does fetch fewer total bytes than B2 (uptime-kuma: 11.7 MB vs
14.9 MB), the cause is **coverage of the held-out paths** — it does not pay
for a second round of on-demand faults later — and not a clustering advantage.
Any claim that Reducer wins by reducing remote operation count is **not
supported by this data**.

## 11b. The three questions

### A. Does recoverable lazy delivery solve a real static-tracing failure mode?

**Yes — clearly, and on the majority of the corpus.** A2 is the closed
`@vercel/nft` artifact, 73–87 % of the universe physically absent. It **failed
to start at all** on **four of the six** applications, each by a different Node
mechanism, and in every case A3 — the complete lazy artifact making the
*identical* placement decision — started and matched the full artifact on
every held-out request:

| app | closed-artifact failure | mechanism |
| --- | --- | --- |
| json-server | `File fixtures/db.json not found` | data file passed as a CLI argument — outside any module graph |
| uptime-kuma | `Cannot find module '../src/util'` (server.js:49) | **relative require the trace missed** |
| juice-shop | `Please install sqlite3 package manually` + `No configurations found in configuration directory` | **computed dynamic package require** (Sequelize dialect loader) *and* an untraced config directory |
| strapi | `Cannot find module '/mnt/app/node_modules/async-function/require.mjs'` | **conditional-export / ESM subpath resolution** the trace did not follow |

verdaccio and express-realworld ran correctly under the closed artifact —
including express-realworld's Prisma query engine, which was the case this
corpus was chosen to stress.

The juice-shop case is the canonical one: `require(dialectName)` inside an ORM
is invisible to a static tracer by construction, and the resulting artifact
fails at **startup**, not on some rare route. The uptime-kuma case is worse in
one sense — it is a plain relative require in first-party code.

Quantitatively, the held-out workload read files the closed trace omits on
every app that failed: 275 files / 3.5 MB (uptime-kuma), 732 files / 10.4 MB
(juice-shop), 232 files / 1.0 MB (strapi).

The closed artifact omitted 73–87 % of the universe in every case, which is
exactly the size win a slimming product sells — and on four of six
applications that artifact does not boot.

So recoverability converts an artifact-construction failure into a latency
cost, and the failure mode is **real, common, and startup-fatal** — not an
exotic edge case. This is the strongest single result in the experiment, and
it is a *reliability* result, not a performance one.

### B. Does the Node-semantic layer materially outperform generic trace prefetch?

**Not on readiness. Yes on early-request latency, and yes on the largest app.**

- **Readiness**: median advantage ≈ 0 across apps (−12 ms, −1 564 ms,
  +104 ms, +402 ms, +810 ms). Mixed signs. The null survives here.
- **Held-out coverage**: B3b drives held-out misses to zero on every app but
  juice-shop; the generic arms always leave some.
- **Early-request p95**: the generic arms defer 294 ms (express-realworld),
  339 ms (verdaccio) and 1 244 ms (juice-shop) into the first requests. **B3a
  defers essentially nothing on any app**, matching the eager baseline within
  a few ms — and it uses no workload evidence at all.
- **Remote operations**: no advantage. The generic trace-ordered layout merges
  *better* (§11).
- **Largest app**: strapi, 915 MB — B3b is **1.56 s (22.9 %) faster to Ready**
  and 1.9 s faster to first request than the best generic arm, on the same
  fetched bytes.

### C. Is the absolute improvement large enough to matter?

The honest decomposition of a strapi cold start, at 25 ms / 100 Mbit:

```text
eager pull → ready                 20.2 s
lazy + generic trace prefetch       6.8 s     ← −13.4 s, and this is commodity
lazy + Reducer semantic prefetch    5.3 s     ← −1.5 s more, and this is us
```

**Lazy delivery is worth ten to fifteen seconds. The semantic layer is worth
one to two.** On the smaller applications the semantic layer is worth tens to
hundreds of milliseconds on readiness, and its clearest contribution is
removing a 0.3–1.2 s early-request latency cliff that generic prefetch
introduces.

## 11c. Recommendation

```text
CONTINUE AS FEATURE/ENABLING TECHNOLOGY — RECOVERABILITY WORKS,
BUT SEMANTIC PERFORMANCE DIFFERENTIATION IS WEAK
```

The reasoning, stated so a later reader can attack it:

1. **The wedge is lazy delivery, and lazy delivery is commodity.** 13.4 s of
   strapi's 14.9 s saving is available from `nydus-image --prefetch-policy fs`
   plus a workload trace — no Node knowledge required.
2. **The semantic layer's readiness advantage is not consistent.** Median ≈ 0
   over six applications, with three wins and three losses. One large win
   (−22.9 % on the largest app) is not a product claim at n=6.
3. **The one thing the semantic layer does reliably** is keep early-request
   latency at the eager baseline while the generic arms defer 0.3–1.2 s into
   the first requests — and the arm that does this best, B3a, needs **no
   training run at all**. That is a real, defensible property, and it is a
   *feature* of a delivery product rather than a product by itself.
4. **The clustering hypothesis is dead** (§11): trace-order layout merges
   better than semantic order.
5. **The recoverability story is the strong half** (§A): a legitimate closed
   NFT artifact — the thing a slimming product ships — **failed to start on
   four of six applications**, by four different Node mechanisms, while the
   complete lazy artifact making the identical placement decision ran all six.
   That is a reliability argument for immutable-complete + lazy delivery. It
   is not, by itself, an argument that the *semantic* layer is the product.

What would change this verdict: the strapi result is the only one at the
scale the ICP actually cares about, and it is the strongest. Measuring the
2 GB / 250 000-file class (n8n) is the single highest-value follow-up, because
the semantic advantage is the only measured quantity that grew with
application size.

## 12. Measurement limitations

1. **Per-trial per-file attribution is unavailable** (`ADVERSARIAL.md` D7).
   `needed(TEST)` is one app-level ground truth shared by every arm. That is
   sound only while the arms behave identically, which the correctness gate
   checks on every trial — but if an arm had diverged, its precision/recall
   would be misattributed.
2. **Only the application universe is lazy.** Node and the base OS are eager in
   every arm, removing ~120 MB from the eager arm's download. Conservative: it
   makes B0 look better than a real eager pull.
3. **One network profile** (25 ms / 100 Mbit). The *shape* of the comparison is
   not conditional on it; the absolute seconds are.
4. **Single machine, single run**, on a developer laptop's Docker VM. Medians
   over rotated repetitions with min/max are reported; no cross-machine
   reproduction was attempted.
5. **corpus-v1-linux**: five trees are not byte-identical to the ones
   experiments 1–2 measured, though the app SHA and lockfile are.
6. **Reps are 5 for the three smaller apps and 3 for the three larger ones**, as
   DESIGN.md §9 allows. Three points is a weak basis for a spread.
7. **n8n is missing** (§9), so the largest size class is represented by
   extrapolation from strapi.

## 13. Where the evidence lives

```text
benchmarks/lazy-oci/DESIGN.md              the preregistration (committed before any arm ran)
benchmarks/lazy-oci/run-1/RUN-INFO.md      versions, digests, network verification, deviations
benchmarks/lazy-oci/run-1/ADVERSARIAL.md   defects found and fixed; the attack list
benchmarks/lazy-oci/run-1/SUMMARY.md       generated tables
benchmarks/lazy-oci/run-1/FINDINGS.md      this file
benchmarks/lazy-oci/run-1/prep/<app>.json  per-arm blob digests, sizes, content-identity digest
benchmarks/lazy-oci/run-1/prefetch/        the exact frozen prefetch manifests, per arm
benchmarks/lazy-oci/run-1/trials/<app>/    one directory per trial: milestones, request events,
                                           100 ms fetch samples, nydus telemetry, app log
benchmarks/lazy-oci/run-1/expA/<app>/      Experiment A trials
benchmarks/lazy-oci/run-1/<app>.metrics.json    computed per-arm metrics + order-drift
benchmarks/lazy-oci/run-1/<app>.expA.json       Experiment A results + mechanism classification
```

Reproduce with:

```bash
bun benchmarks/lazy-oci/plan.ts   --all
bun benchmarks/lazy-oci/run.ts    prep   --app <name>
bun benchmarks/lazy-oci/a2.ts     --app  <name>
bun benchmarks/lazy-oci/run.ts    trials --app <name> --reps 5
bash benchmarks/lazy-oci/finish.sh
```
