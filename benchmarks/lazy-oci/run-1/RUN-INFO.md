# First-run provenance — semantic placement on a commodity lazy-OCI substrate

ADR-0007 experiment 3. This directory is **new**: `benchmarks/working-set/first-run/`
(experiment 1) and `benchmarks/hydration/run-1/` (experiment 2) are untouched, and no
preserved number in either was edited.

The design, the arm definitions, every prefetch strategy and every metric formula were
frozen in [`../DESIGN.md`](../DESIGN.md) and committed **before any arm was executed**.

## What was measured

Seven frozen corpus applications were packaged as complete immutable
[Nydus](https://github.com/dragonflyoss/nydus) RAFS v6 images, pushed to a local OCI
registry, and started under `nydusd` (fusedev) + overlayfs — the commodity lazy-OCI
data path, without containerd. Six arms differ **only** in which files the substrate's
own `fs_prefetch` fetches at mount:

```text
B0   eager      prefetch_all, and nothing starts until the fetch completes
B1   lazy       no prefetch at all
B2   generic    the TRAIN filesystem access trace, in access order
B2d  generic+   TRAIN trace ∪ one level of directory expansion
B3a  Reducer    static: NFT positive evidence + entry + resolver metadata +
                opaque-boundary packages (the ADR-0007 Plan B HOT set)
B3b  Reducer    the SAME TRAIN trace as B2, widened by Node semantics
```

Every measured trial ran the **held-out TEST workload**; TRAIN was executed once per
app, offline, only to produce the evidence B2/B2d/B3b are allowed to see.

## Versions

| component | version |
| --- | --- |
| nydus (`nydusd`, `nydus-image`, `nydusctl`) | v2.4.5, linux/arm64 static (`e3190057422fee17f594bb3a5c10741b45dac6ce`) |
| RAFS | v6, zstd, sha256 digester, 1 MiB chunks, `--repeatable` |
| registry | `registry:2` (OCI distribution v2) |
| Node (applications) | v24.19.0 — `node:24-bookworm-slim`, the version `.tool-versions` pins |
| Docker | 27.4.0 / Docker Desktop 4.37.2 |
| VM kernel | Linux 6.10.14-linuxkit aarch64, 10 CPU, 7.65 GiB |
| host | macOS 25.1.0 arm64 |
| analysis | Bun 1.3.1 (only the harness; applications run under stock Node) |

## Network

Shaping is applied to the **registry container's egress**, i.e. the direction blob
bytes travel: `tc qdisc replace dev eth0 root netem delay 25ms rate 100mbit`.

Verified before the run, with a 50 MB blob fetched twice through the same path:

```text
50 000 000 B in 4.346 s → 11.5 MB/s   (92 Mbit/s)
50 000 000 B in 4.341 s → 11.5 MB/s
```

Shaping the *application* container's egress instead would have been a measurement
error: `netem rate` limits only the direction it is attached to, so the app's tiny
range requests would be delayed while responses arrived at VM speed — a lazy-loading
benchmark in which downloading is free.

## Cold-start reset, per trial

```text
container            fresh (the FUSE mount's page cache dies with it)
/work docker volume  wiped before t0 — blobcache, overlay upper and work dirs
/scratch             fresh tmpfs
postgres database    dropped and recreated from the host, before t0
image                identical bytes in the registry across all trials
```

Not resettable, and therefore equal for every arm: the VM's page cache over the
registry's own blob storage, and the host SSD.

## Deviations from the frozen corpus

1. **linux/arm64 re-materialisation (corpus-v1-linux).** The frozen corpus was
   installed on darwin-arm64; its native addons are Mach-O and abort under any Linux
   substrate (`invalid ELF header`), and its platform-optional packages are the darwin
   ones. Five apps were therefore re-installed at the **same pinned SHA** from the
   **same lockfile** with the **same install command**
   (`benchmarks/lazy-oci/materialize.sh`); built artefacts (`dist/`, `build/`) were
   kept because JS output is platform-independent. `json-server` and `verdaccio` boot
   unmodified under Linux and keep the frozen tree: zero deviation.
   `npm ci` needed `--dangerously-allow-all-scripts`, because npm 11.17 refuses
   install scripts by default and would reproduce the missing-binary failure.
2. **Production population.** The universe filter is the frozen production population
   (`benchmarks/cve-population/corpus-packages.json`), as in experiments 1–2, *plus*
   installed packages named by an `optionalDependency` of a declared production
   package. Without that second clause a darwin-frozen population deletes the
   linux-arm64 platform variants (`@img/sharp-linux-arm64`, `@esbuild/linux-arm64`, …)
   and produces an image that cannot run. Universe sizes therefore differ slightly
   from experiment 1 (json-server: 1 288 files / 3.2 MB here vs 1 137 / 2.8 MB there).
3. **macFUSE is absent and cannot be installed non-interactively** (system extension,
   admin approval, reboot), so the applications cannot run against a lazy mount on the
   macOS host. This is what forces (1).
4. **Only the application universe is lazy.** Node and the base OS come from the
   container image and are eagerly present in every arm. This removes ~120 MB of
   download that a real lazy deployment would charge to the **eager** arm, so it
   understates the lazy advantage rather than inflating it.

## Layout

```text
DESIGN.md              the preregistration
materialize.sh         corpus-v1-linux materialisation
apps.ts                the 7 selected apps + production-population derivation
plan.ts                universe, NFT evidence, Plan B, pruned staging tree
prefetch.ts            the frozen prefetch strategies
images.ts              per-arm RAFS build, registry push, content-identity proof
container/             the trial container: runner.sh, driver.mjs, sampler.mjs
run.ts                 prep / trials / Experiment A
analyze.ts             per-trial and per-arm metrics
analyze-expa.ts        Experiment A correctness and Node-mechanism classification
summarize.ts           SUMMARY.md
run-1/prep/*.json      per-app image digests, prefetch sizes, content digest
run-1/prefetch/*.json  the exact frozen prefetch manifests
run-1/trials/<app>/    one directory per trial: milestones, events, samples,
                       nydus telemetry, app log
run-1/expA/<app>/      Experiment A trials
run-1/*.metrics.json   per-app computed metrics
run-1/SUMMARY.md       the result
```
