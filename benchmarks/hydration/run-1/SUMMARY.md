# Runtime hydration of the Plan B candidate-COLD set — corpus-v1

ADR-0007 experiment 2. **Nothing was removed and nothing was recovered**: every application ran
against its complete, untouched production universe with an observe-only tracer preloaded. A
"hydration miss" is a counterfactual — the first time execution *read the content of* a file that
Plan B had placed candidate-COLD.

Measured **16 of 19** frozen corpus applications.

## Headline

```text
initial Plan B resident (byte-weighted)   39.1%
after startup                             39.5%
after strongest available workload        39.5%

Plan B cold bytes hydrated                0.7%  (23.4 MB of 3.37 GB)
Plan B cold bytes STILL COLD              99.3%
  …counting metadata-only touches too     99.0%
```

## Miss metrics — three different quantities, never collapsed

| quantity | corpus total |
| --- | ---: |
| total observed accesses (application trees) | 304,381 |
| unique files touched by the applications | 43,282 |
| directories touched (not placeable files) | 517 |
| **hydration misses** (first content touch of a cold file) | 3,706 |
| **unique bytes hydrated** | 23.4 MB |
| cold files touched for metadata only (no bytes moved) | 114 (11.5 MB) |
| cold files excluded because only a workload RUNNER read them | 21 (200.0 KB) |

A hydration miss count and a unique-file count are the same number here **by construction**: a
recovery runtime caches what it recovered, so every later access to a hydrated file is a resident
hit. The quantity that is genuinely different is total accesses — 304k accesses produced 3.7k misses.

## Per-app distribution

| metric | n | min | P25 | median | P75 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| resident % — initial (Plan B) | 16 | 2.6% | 18.7% | 27.4% | 33.9% | 89.3% |
| resident % — after startup | 16 | 2.7% | 18.7% | 28.0% | 34.6% | 89.3% |
| resident % — after strongest workload | 16 | 2.9% | 18.7% | 28.0% | 34.6% | 89.3% |
| cold bytes hydrated % | 16 | 0.0% | 0.0% | 0.3% | 1.1% | 9.6% |
| **cold bytes still cold %** | 16 | 90.4% | 98.9% | 99.8% | 100.0% | 100.0% |
| cold still cold % (metadata-inclusive) | 16 | 90.4% | 98.9% | 99.8% | 100.0% | 100.0% |
| unique miss files | 16 | 0 | 1 | 128 | 268 | 1,333 |
| unique miss bytes | 16 | 0 B | 309 B | 1.2 MB | 1.9 MB | 6.5 MB |
| Plan B HOT bytes never touched | 16 | 13.8% | 31.3% | 54.6% | 75.7% | 88.9% |

Target apps only (n=10): median cold surviving **100.0%**, byte-weighted **98.8%**.

## Byte-weighted vs per-app — they answer different questions

| | byte-weighted | per-app median |
| --- | ---: | ---: |
| cold bytes still cold | 99.3% | 99.8% |
| resident after strongest workload | 39.5% | 28.0% |

## Third-party denominators

| denominator | initial cold | hydrated | still cold |
| --- | ---: | ---: | ---: |
| entire production universe | 3.37 GB | 23.4 MB | 99.3% |
| third-party production files | 3.10 GB | 21.5 MB | 99.3% |
| third-party JS (ADR-0006 D) | 1.14 GB | 20.0 MB | 98.2% |

## Hydration shape

Of every cold byte the corpus hydrated, **94.1%** was hydrated before the
application reported ready. Startup is where hydration happens; workload adds comparatively little.

## Miss size profile

| file size | miss files | bytes |
| --- | ---: | ---: |
| <1 KB | 1,461 | 706.8 KB |
| 1–4 KB | 1,158 | 2.5 MB |
| 4–16 KB | 802 | 6.6 MB |
| 16–64 KB | 254 | 6.3 MB |
| 64–256 KB | 27 | 3.1 MB |
| 256 KB–1 MB | 3 | 2.2 MB |
| ≥1 MB | 1 | 1.9 MB |

## Do initially-mixed packages stay mixed?

The static run found 57.8% of Plan B cold bytes inside partially-HOT packages — the part of the
opportunity that exists only because placement is per-file. Execution barely touches it:

```text
initially-mixed packages            1,182
their candidate-COLD bytes          1.42 GB
…hydrated by execution              2.2 MB  (0.2%)
…that became ≥95% resident          37 packages
```

## Miss clustering

**99.1%** of consecutive hydration misses arrive within 50 ms of the previous one, and
**89.5%** are in the SAME package as the previous miss. Misses are not scattered: they arrive in
tight, package-local bursts. (Evidence that semantic prefetching is plausible — no predictor is built here.)

## Does static NFT warning density predict runtime hydration?

No. Pearson r = **0.035** between an app's NFT-warning density and its unique hydrated bytes.

| app | NFT warnings | warnings/traced file | unique hydrated |
| --- | ---: | ---: | ---: |
| n8n | 29,491 | 0.315 | 1.2 MB |
| outline | 340 | 0.028 | 6.5 MB |
| hackathon-starter | 98 | 0.021 | 1.9 MB |
| parse-server | 52 | 0.021 | 2.8 MB |
| express-rest-boilerplate | 48 | 0.019 | 0 B |
| uptime-kuma | 52 | 0.010 | 1.5 MB |
| strapi | 184 | 0.009 | 1.0 MB |
| nodebb | 140 | 0.009 | 3.3 MB |
| nestjs-typescript-starter | 7 | 0.008 | 0 B |
| juice-shop | 23 | 0.006 | 1.6 MB |
| node-express-boilerplate | 1 | 0.001 | 2.1 KB |
| fastify-demo | 0 | 0.000 | 3.3 MB |
| express-realworld | 0 | 0.000 | 0 B |
| json-server | 0 | 0.000 | 309 B |
| verdaccio | 0 | 0.000 | 0 B |
| excalidraw-room | 0 | 0.000 | 304.6 KB |

## Accesses outside the frozen production universe

403 files under the clone roots were touched that the frozen universe does not contain
(6.9 MB of them content-read), plus 517 directories. These are recorded separately and
never counted as hydration.

**All of it is application-generated output.** Classified against each repository's own
`.gitignore` (writes observed during a single run are not sufficient — juice-shop builds
`i18n/*.json` from `data/static/i18n` at first start, so a later run reads files it did not
create), the split is:

```text
app-generated / build output      6.9 MB
genuinely absent from the model   0 B   (0 files)
```

So this run found **no production dependency that the frozen universe model missed**. The
out-of-universe reads are sqlite databases, compiled templates, generated locale files and
vite/tsc bundles — exactly the things that should not be in a production-universe artifact.

**Sensitivity anyway.** Were every one of those bytes folded in as candidate-COLD *and* counted as
hydrated, cold surviving would move from **99.3%** to **99.1%** — the conclusion does not depend on the choice.

## Package behaviour

| class | packages |
| --- | ---: |
| mixed-stays-mixed | 9,770 |
| cold-stays-cold | 1,288 |
| all-hot-initially | 614 |
| mixed-becomes-hot | 93 |
| cold-becomes-resident | 35 |

## Outliers, and the stress case

- **Worst case — fastify-demo**: 90.4% of its cold bytes survive, on
  1,333 misses totalling 3.3 MB. Even the worst application in the corpus keeps ~9/10 of its
  candidate-COLD bytes cold, and its misses are overwhelmingly tiny files, not large ones.
- **n8n, the designated stress case**: 29,491 NFT warnings (0.32 per traced file, mostly unresolved
  computed specifiers) produced **128 misses / 1.2 MB** across **3 packages**, leaving
  99.9% of its 1.11 GB cold set untouched. The static uncertainty did **not** become
  runtime hydration. Its workload created and executed a real workflow, so the node/credential
  loading machinery behind those warnings did run.
- **Zero misses**: express-realworld, express-rest-boilerplate, nestjs-typescript-starter, verdaccio — the NFT-positive set already covered everything executed.
- **Over-provisioning cuts the other way too**: 81.3% of the bytes Plan B placed HOT were
  never touched at all. The resident set is not just recoverable-sparse; it is itself far larger
  than what execution needs. (Counting is by byte; see RUN-INFO.md on the by-file caveat.)

## Untraced child processes — the blind spot, measured

The tracer travels in `NODE_OPTIONS`, so a child spawned with a REPLACED environment never loads
it. Re-injecting it would mean mutating the application's spawn options, which an observe-only
experiment must not do — so every spawn is recorded, every traced process announces itself, and the
difference is published here rather than assumed away. A non-zero count understates that app's
hydration by a bounded amount (see RUN-INFO.md for the per-app bounds).

| app | spawn events | child processes traced | untraced |
| --- | ---: | ---: | ---: |
| nodebb | 1 | 0 | 1 |
| n8n | 3 | 0 | 3 |
| outline | 6 | 6 | 0 |

## Workload quality — what each application actually answered

Per phase: the share of its requests that returned < 400. A low `common` ratio is usually correct
(those phases deliberately probe unauthenticated and 404 paths); a low `full` ratio would mean the
authenticated workload degraded, which is exactly how outline's sweep was caught silently returning
401 for every request.

| app | workload | phases (share of requests that succeeded) |
| --- | --- | --- |
| node-express-boilerplate | representative-endpoint-set | common 0.0%, full 75.0% |
| fastify-demo | representative-endpoint-set | common 20.0%, full 71.4% |
| express-realworld | representative-endpoint-set | common 80.0%, full 88.2% |
| json-server | representative-endpoint-set | common 100.0%, full 90.9% |
| uptime-kuma | representative-endpoint-set | common 100.0%, full 100.0%, extended 81.8% |
| hackathon-starter | representative-endpoint-set | common 90.0%, full 86.4% |
| express-rest-boilerplate | representative-endpoint-set | common 33.3%, full 85.7% |
| nestjs-typescript-starter | smoke | common 66.7% |
| parse-server | representative-endpoint-set | common 100.0%, full 58.3% |
| verdaccio | representative-endpoint-set | common 100.0%, full 100.0% |
| nodebb | representative-endpoint-set | common 100.0%, full 95.0% |
| n8n | representative-endpoint-set | common 42.9%, full 77.8% |
| excalidraw-room | representative-endpoint-set | common 80.0%, full 100.0%, extended 100.0% |
| juice-shop | representative-endpoint-set | common 94.4%, full 87.5% |
| outline | representative-endpoint-set | common 100.0%, full 95.7% |
| strapi | representative-endpoint-set | common 66.7%, full 95.7% |

## Per-application results

| app | cat | workload | universe | cold B | resident init | after startup | after workload | cold surviving | miss files | miss bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| n8n | C | representative-endpoint-set | 2.07 GB | 53.7% | 46.3% | 46.3% | 46.3% | **99.9%** | 128 | 1.2 MB |
| outline | T | representative-endpoint-set | 854.7 MB | 67.0% | 33.0% | 33.6% | 33.7% | **98.9%** | 598 | 6.5 MB |
| strapi | C | representative-endpoint-set | 820.5 MB | 52.8% | 47.2% | 47.3% | 47.3% | **99.8%** | 225 | 1.0 MB |
| nodebb | C | representative-endpoint-set | 531.1 MB | 72.6% | 27.4% | 28.0% | 28.0% | **99.1%** | 194 | 3.3 MB |
| hackathon-starter | T | representative-endpoint-set | 283.8 MB | 65.5% | 34.5% | 35.2% | 35.2% | **99.0%** | 125 | 1.9 MB |
| juice-shop | T | representative-endpoint-set | 221.1 MB | 66.1% | 33.9% | 34.6% | 34.6% | **98.9%** | 442 | 1.6 MB |
| uptime-kuma | C | representative-endpoint-set | 172.0 MB | 73.4% | 26.6% | 27.4% | 27.4% | **98.8%** | 268 | 1.5 MB |
| parse-server | C | representative-endpoint-set | 142.4 MB | 74.8% | 25.2% | 27.1% | 27.1% | **97.4%** | 374 | 2.8 MB |
| excalidraw-room | T | representative-endpoint-set | 108.1 MB | 97.4% | 2.6% | 2.7% | 2.9% | **99.7%** | 17 | 304.6 KB |
| express-realworld | T | representative-endpoint-set | 96.5 MB | 10.7% | 89.3% | 89.3% | 89.3% | **100.0%** | 0 | 0 B |
| node-express-boilerplate | T | representative-endpoint-set | 62.4 MB | 83.7% | 16.3% | 16.3% | 16.3% | **100.0%** | 1 | 2.1 KB |
| express-rest-boilerplate | T | representative-endpoint-set | 60.1 MB | 70.0% | 30.0% | 30.0% | 30.0% | **100.0%** | 0 | 0 B |
| verdaccio | C | representative-endpoint-set | 53.1 MB | 83.6% | 16.4% | 16.4% | 16.4% | **100.0%** | 0 | 0 B |
| fastify-demo | T | representative-endpoint-set | 36.0 MB | 95.4% | 4.6% | 13.8% | 13.8% | **90.4%** | 1,333 | 3.3 MB |
| nestjs-typescript-starter | T | smoke | 10.2 MB | 72.7% | 27.3% | 27.3% | 27.3% | **100.0%** | 0 | 0 B |
| json-server | T | representative-endpoint-set | 2.8 MB | 81.3% | 18.7% | 18.7% | 18.7% | **100.0%** | 1 | 309 B |

## What this establishes — and what it does not

Establishes: **real Node applications can execute representative workloads while leaving a large
majority of their complete production dependency universe untouched, starting from the practical
Plan B placement.** It says nothing about remote miss latency, SLO viability, economics, safe code
distribution, eviction, prefetch, security, cross-machine caching, or final architecture, and it
claims no performance improvement — placement here is simulated, not applied.

**"Still cold" means "not touched by this workload", never "never needed".** These runs last
minutes. Nothing here exercises a cron path, a backup, an error path, an admin operation, a second
locale, or an alternative database driver. A material part of the surviving cold set is certainly
untested functionality rather than proven-dead code — which is exactly why the model is recovery,
not removal: a wrong prediction costs latency, never correctness.

Other limitations: one run per application, so run-to-run variance is unmeasured; multi-entry
surfaces (CLI subcommands, alternative services) appear only where an existing workload happened to
exercise them; and the instrumentation blind spots enumerated in RUN-INFO.md all bias hydration
DOWNWARD, each bounded (the largest is worth 0.02 pp on the one application it affects).

## Not measured

- **bulletproof-nodejs** — Two independent blockers, both materialization/upstream defects. (1) argon2's native binding is absent (MATERIALIZATION.md records this clone was installed with --ignore-scripts) and is on the startup require path; `npm rebuild argon2 --build-from-source` fails because argon2@0.27 pins node-pre-gyp v0.15.0, which does not work on Node 24, and no darwin-arm64 prebuild exists upstream. (2) Separately, tsc leaves the app's `@/…` tsconfig-path imports unrewritten and the repo ships no module-alias, so its own Procfile command cannot resolve them; that half was worked around with NODE_PATH and did resolve. The app reaches build/services/auth.js and then dies on argon2, so no startup trace is obtainable.
- **nestjs-realworld** — Frozen materialization defect, not an experiment limitation: 47 top-level directories in this clone's node_modules are EMPTY (no package.json, no files) — the recorded npm "Exit handler never called" failure in MATERIALIZATION.md. `require("@nestjs/core")` fails at the first import of the pinned entry with Cannot find module 'event-emitter', so no startup trace is obtainable. Repairing it needs a re-install, which would rewrite files INSIDE the frozen production universe and invalidate the preserved placement, so the app is reported as not-measured instead. Fixing it requires an explicit corpus revision.
- **ghost** — Frozen materialization gap, surfaced by this experiment: corpus.json declares build:null for ghost, but Ghost's monorepo ships its workspace packages as TypeScript SOURCE ONLY (packages/adapters/storage-base has `main: build/index.js` and no build/), and ghost/core's own core/shared/config is index.ts. The pinned entry therefore cannot boot: first MODULE_NOT_FOUND on './shared/config', and after running the repo's own `build:tsc`, MODULE_NOT_FOUND on ghost-storage-base (an unbuilt workspace package). Making it run needs a full `pnpm nx run-many -t build` of the Ghost monorepo, which would produce a materially different tree from the one the preserved placement was computed against. The tsc output was reverted and the clone left byte-identical. NOTE: the same gap means the preserved Plan A/B numbers for ghost describe a tree that cannot execute, which is a finding about the corpus, not about virtualization.
