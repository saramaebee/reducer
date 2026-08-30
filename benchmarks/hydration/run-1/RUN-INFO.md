# First-run provenance — runtime hydration measurement (ADR-0007 experiment 2)

This directory is the **preserved first corpus-wide hydration result**. It is a new
artifact and overwrites nothing: `benchmarks/working-set/first-run/` (the static
placement result this builds on) and `benchmarks/hazard-domain/first-run/` (the
retired conservative-linker evidence) are untouched.

Repository commit at measurement time: `1d78a1ef603415bd86c84c851165e3395a40d0de`
(the preserved static working-set result; this experiment's code was added on top).
Runtime: **Node 24.19.0** (`~/.asdf/installs/nodejs/24.19.0/bin/node`) —
the same version `.tool-versions` pins and the same one the corpus was materialized
and built with. The analysis tooling runs under Bun; only the applications run under
Node, and only stock Node.

## What was measured

For each frozen corpus application, starting from the **preserved Plan B placement**
(NFT-positive + entrypoint + resolver metadata + `opaquePackages().own` → HOT,
everything else candidate-COLD), the application was started from its **pinned entry
file** and driven with the strongest workload that already exists in its repository.
Every file access was observed, and each first *content* read of a candidate-COLD
file was recorded as a **simulated hydration miss**.

```text
initial Plan B resident set
        ↓  execute application + representative workload
observe accesses to candidate-COLD files
        ↓  first content touch = hydration miss; every later touch = resident hit
cumulative resident working set per phase
```

**This remains a simulation.** No file was removed, hidden, or recovered; no missing
file was intercepted; no runtime behaviour was modified to make the application
depend on the experiment. The complete production universe was on disk the whole
time. The only thing added to each process was `--require tracer.cjs`.

## Baseline fidelity — proven, not assumed

The preserved first run records Plan A/B *metrics*, not the per-file placement list,
and the join needs the list. `snapshot-plan.ts` therefore recomputes placement
through the same calls in the same order as `working-set/run-corpus.ts` and then
**proves the recomputation identical to the preserved result** before it may be used:
every denominator's bytes/files/hot/cold, every attributed and covering reason byte
total, and every package-classification count must match `first-run/corpus/<app>.json`
exactly, and Plan B's hot set must remain a superset of Plan A's.

**All 19 applications matched exactly.** Each app's clone was verified
`git rev-parse HEAD === corpus.json resolvedSha` first; no ref was fetched or
advanced.

## Instrumentation

A single CJS preload (`tracer.cjs`) injected through `NODE_OPTIONS`, so it is
inherited by every child process and worker thread. It patches, on `fs` and
`fs.promises`: content reads (`readFile*`, `open*` — classified by flags —
`createReadStream`, `copyFile*`), metadata (`stat*`, `lstat*`, `access*`, `exists*`,
`realpath*`, `readlink*`, `statfs*`), directory listings (`readdir*`, `opendir*`,
`glob*`) and writes (`writeFile*`, `mkdir*`, `rename*`, `unlink*`, `rm*`, `symlink`,
`link`, `truncate*`, `utimes*`, `chmod*`); plus `process.dlopen` (native addons),
every `Module._extensions[ext]` handler (CJS module bodies, which are read through
the internal binding and would otherwise be invisible), and `module.registerHooks`
(ESM). `child_process` spawns are recorded as events.

### Access classes, and why the split matters

| class | meaning | counts as hydration? |
| --- | --- | --- |
| `content` | the bytes were read | **yes** |
| `metadata` | existence/attributes only (`stat`, `existsSync`, …) | no — reported separately as an upper bound |
| `dir` | a directory listing | no — a directory is not a placeable file |
| `write` | the process created or changed it | no — identifies generated files |

Only `content` moves bytes. `metadata` and `dir` are served by a whole-file
virtualizer from a local index without materializing anything; that is a stated
design assumption, not a hidden one, which is why the metadata-inclusive number is
reported alongside every headline (99.3% surviving → 99.0% under the upper bound).

### Verified coverage

- **Module loading has no blind spot.** For node-express-boilerplate, Node's own
  `require.cache` at shutdown held **1,152** entries; the tracer recorded **1,153**
  content touches; the only entries in the cache the tracer did not record were
  `tracer.cjs` and the verification preload itself. That is an independent oracle
  for the dominant access class.
- ESM named imports of `node:fs/promises` are captured (verified by experiment).
- Worker threads, child processes and cluster workers are captured and attributable
  (outline's run recorded 6+ processes; n8n recorded a worker thread and its JS task
  runner).

### Known blind spots

- **Node's internal resolver reads** (`package.json` via `internalModuleReadJSON`)
  bypass the public `fs`. Immaterial here: Plan B forces every `package.json` HOT as
  resolver metadata, so they can never be a miss.
- **Native addons reading files from C++** are invisible. `process.dlopen` catches
  the `.node` load itself, but not what the addon then reads.
- **A child process that rebuilds its own environment escapes the preload.** The
  tracer travels in `NODE_OPTIONS`, so a child spawned with an explicit `env` that
  omits it is untraced. Two apps do this, and both are now *counted* rather than
  assumed away — each result file publishes `untracedChildren` (spawn events vs
  child processes actually traced):
  - **n8n's JS task runner** (`spawn('node', …)` with a constructed env), bounded
    by the cold bytes of the package it would load — **233 KB of
    `@n8n/task-runner` against 1.11 GB of candidate-COLD: 0.021%**. Charging all
    of it moves n8n from 99.89% to 99.87%.
  - **NodeBB's asset minifier** (`fork(__filename, [], {env:{minifier_child:true}})`),
    where the sass/CSS compile runs unobserved. Measured floor: **+140 miss files
    (+72%) and +0.43 MB (+13%)** for NodeBB, moving it from 99.15% to ~99.04% and
    the corpus byte-weighted figure by **−0.011 pp**.
  Fixing either would require mutating the application's spawn options, which an
  observe-only experiment must not do.
- **Non-node child processes** are recorded as spawn events only. The only ones
  observed in this run are n8n's two `python3 --version` probes, which read nothing
  inside any clone.
- A loader that *replaces* `Module._extensions[ext]` without chaining would shadow
  the tracer; the corpus apps that transform (pirates-based) wrap rather than replace.
- **`hotNeverTouched` over-counts by file.** Node's resolver reads `package.json`
  through the internal binding, so a manifest the run demonstrably used still counts
  as untouched — 62% of verdaccio's and 72% of json-server's hot-never-touched
  *files* are such manifests. The byte figure is barely affected (manifests are
  small), and this metric is secondary; the hydration numbers do not use it.

Direction of bias: every one of these can only cause hydration to be **under**counted,
so they make the surviving-cold number look better than truth. Each is bounded above:
the `require.cache` oracle puts the dominant class at ≈0, and the largest remaining
one is worth 0.02 pp on the single app it affects.

## Attribution

`HYDRATION_RUN_LABEL` is inherited by every child, so the application's own process
tree (`<app>:app`) is distinguishable from a workload runner the harness started
(`<app>:workload:<phase>`). **Only the application's own tree contributes to its
resident set** — a test runner or socket client reading its own dependencies is not
the application's working set, and merging the two would be the single largest
available way to inflate this result. Setup (database creation, migrations, seeding,
builds) runs *before* the trace exists and *without* the preload.

The tracer's observation boundary is the **clone dir**, not the universe root, so a
file under the clone that is outside the frozen universe is recorded and reported
separately rather than silently dropped. Paths outside the clone root are counted in
aggregate buckets.

## Phases

Boundaries are recorded as absolute high-resolution timestamps in each `*.run.json`,
so alternative phase splits can be recomputed from the same event stream without
re-running anything.

```text
T0  process spawned
T1  the application reports ready (its own log line, its port, or its health URL)
T2  the "common" workload completes
T3  the strongest available workload completes  (some apps have a third, "extended")
```

Phases are not faked uniform across apps: an app with only one workload phase reports
one, and `reachedGoal` records whether the phase actually did anything.

## Frozen-input policy

One rule, applied uniformly and stated because it decides three apps:

> The experiment may create files that the application's own documented build or
> install step produces. It may **never** modify or delete a file present in the
> frozen production universe.

Everything added this way lands outside the frozen universe and is reported in the
out-of-universe section, never as hydration. Where a workload wrote a *tracked* file
in a clone (json-server persisting a POST into `fixtures/db.json`), the harness diffs
the dirty set before and after and reverts with `git checkout`, recording it as a
deviation. Ghost's `build:tsc` output was produced during triage and then **reverted**;
its clone is byte-identical again.

## Chronology of confirmed measurement defects

Every one of these was found and fixed **before** the numbers here were recorded.

1. **CLI bodies ran on import.** `snapshot-plan.ts` and `run-app.ts` executed their
   top-level CLI when imported for a type — importing `run-app.ts` in the analysis
   would have *launched an application* as a side effect. Guarded with
   `import.meta.main`.
2. **Access totals silently zero for every server.** The per-process summary was
   emitted only from `process.on('exit')`, which does not run when a signal
   terminates the process — i.e. for every app that had to be SIGTERM'd, which is
   most of them. Made periodic (500 ms); the analysis takes the last summary per
   process and never sums the cumulative ticks.
3. **File creation was invisible.** A write that *creates* a file has no realpath
   yet, so it was dropped — removing the only signal that distinguishes a
   runtime-generated file from a universe file. Write-class paths now resolve
   through the parent directory.
4. **Workloads mutated frozen clones.** json-server's POST persisted into
   `fixtures/db.json`. The harness now diffs tracked-dirty state before/after and
   reverts what the run dirtied (never what materialization left dirty).
5. **Setup ran in a directory setup had to create**, so every setup command failed
   with ENOENT and the failures were reported only as `setup non-zero (undefined)`.
   The cwd is now created first and failures are recorded explicitly.
6. **A recipe `rm -rf`'d its own cwd**, which made the *spawn* fail with a
   misleading ENOENT naming the node binary rather than the missing directory.
7. **Directories counted as out-of-universe files** (and as "unique files touched"). A `statSync` on a directory is
   class `metadata`, so directories entered the out-of-universe file set and
   inflated it with inode sizes — **519 of 923** entries were directories. This is
   the same trap the static first run documented for NFT's directory entries. Now
   stat-checked and counted separately. (Hydration numbers were never affected:
   out-of-universe paths are never counted as hydration.)

### …and the ones the adversarial review added

The measurement was then reviewed on five independent axes (double counting and
identity; contamination and attribution; phase and timing; universe join and
denominators; blind spots), refute-by-default, with every surviving candidate
re-derived by a second agent whose default answer was REFUTED. 31 agents ran; the
review confirmed these, all fixed before the numbers below were recorded:

8. **A workload's auth capture failed silently and nobody noticed.** `reachedGoal`
   passed on any single response below 500, so outline's entire authenticated
   sweep — 22 of 23 requests returning 401 because a `regex:` capture read an
   empty 302 body instead of `Set-Cookie` — was reported as a completed workload.
   Fixed three ways: `Set-Cookie` capture now uses `getSetCookie()` and builds a
   real Cookie header; a `cookie:<name>` capture extracts one cookie so the token
   can be sent as a Bearer (outline applies CSRF to cookie transport but not to
   Bearer); and the analysis recomputes each phase's outcome from the stored
   statuses, publishing the **share of requests that succeeded** per phase instead
   of a bare flag. Outline now runs 22/23 and its full write path — create
   collection, create/update/export/share/delete document, search — actually
   executes. This is the single most important fix in the list: it is the one
   that was making a workload look real when it was not.
9. **Mongo-backed apps reused state across runs**, so `register` returned 400 and
   the authenticated half of three workloads quietly degraded. Their databases are
   now dropped in `setup`. Outline's postgres database is likewise recreated per
   run, because `installation.create` refuses to run once a Team exists.
10. **`settleMs` was charged to the first workload phase** — the exact opposite of
    its purpose, which is to let late startup work land in *startup*. The startup
    boundary now ends where the workload begins.
11. **A run that never reached ready lost its startup boundary**, so all of its
    first touches were stamped with the first workload phase's name — describing
    pre-crash startup as workload hydration. Such runs now get an explicit
    `startup-incomplete` boundary. (Both affected runs are excluded from the
    aggregates anyway.)
12. **Timing windows were measured from each app's first observed touch**, an
    origin that lands 31–167 ms in and varies per app, so the short windows were
    not comparable across the corpus. Now measured from process spawn.
13. **`totalAccesses` folded the workload runner's accesses** into a total
    labelled as the application's. Now gated on process role, like the touch loop.
14. **`compare()` could pass vacuously**: an absent or non-object expected subtree
    produced zero compared leaves and therefore a silent "match" on the gate that
    licenses every downstream number. It now rejects that outright.
15. **The placement gate was enforced in only one of its two consumers.**
    `run-app.ts` refused a mismatching snapshot but `analyze.ts` did not, so a
    later re-analysis against a re-snapshotted plan could have joined silently
    against a different placement. Both now refuse.
16. **Generated files were inferred from writes observed during one run**, which
    misclassifies anything an earlier run created — juice-shop builds `i18n/*.json`
    from `data/static/i18n` at first start, so 6.1 MB of its own generated locale
    data looked like a gap in the universe model. Classification now asks each
    repository's own `.gitignore`. The result: **every** out-of-universe content
    read in this run is application-generated output, and the frozen universe
    model is missing nothing the applications read.
17. **Three instrumentation blind spots**, each measured at ≈0 impact but fixed so
    that the committed tracer is the tracer that produced the numbers:
    `fs.openAsBlob` was not on the patch list; `fs.realpathSync.native` /
    `fs.realpath.native` were copied onto the wrapper *unwrapped*, so calls
    through `.native` (graceful-fs uses them) were invisible; and the tracer's own
    stack capture ran the application's `Error.prepareStackTrace`, which under
    `source-map-support` reads `.map` files and would attribute them to the app.
    **The whole corpus was re-run after these fixes.**
18. **The `prepareStackTrace` fix in (17) was itself wrong, and the review caught
    it.** V8 formats a stack *lazily*, on first read of `.stack` — not at capture.
    Disabling the hook, capturing, restoring the hook and *then* reading `.stack`
    (the obvious-looking order) leaves the application's formatter running after
    all. Worse than the original problem: because it then runs inside the
    tracer's re-entrancy guard, any file the formatter reads is **silently
    dropped** instead of recorded, so genuine application hydration disappeared.
    The string is now forced while the hook is still disabled; a probe confirms
    the app's hook is invoked 0 times. Affected n8n only (the one app with an
    active `source-map-support`), bounded at a few percent of its 1.2 MB.
    **The corpus was re-run again after this fix.**
19. **A child process with a REPLACED environment is untraced, and that was
    invisible.** The tracer travels in `NODE_OPTIONS`, so
    `fork(file, [], {env: {...}})` — which discards it — produces no trace at
    all. NodeBB does exactly this for its asset minifier
    (`src/meta/minifier.js`: `fork(__filename, [], {cwd, env:{minifier_child:true}})`),
    so its sass/CSS bundle compile happens in a process this experiment cannot
    see. Re-injecting the preload would mean **mutating the application's spawn
    options**, which an observe-only experiment must not do, so the gap is
    *measured* instead: every spawn is recorded, every traced process announces
    itself, and each app now publishes `untracedChildren` (spawn events vs child
    processes actually traced). The review's measured floor for NodeBB is
    194 → ≥334 miss files (+72%) and 3.28 → ≥3.71 MB (+13%), moving its surviving
    cold from 99.15% to ~99.04% and the **corpus byte-weighted figure by −0.011 pp**.
    It is a real under-count, it is bounded, and it is now visible per app rather
    than assumed away.

Refuted, and recorded because the refutation is part of the evidence: symlink/pnpm
alias double counting between the plan and the tracer; lost `proc` headers
excluding a process; miss bytes taken from a live `stat` rather than the frozen
plan; hydration after the last phase boundary escaping the curve; the band between
`HYDRATION_APP_ROOT` and the universe root going unclassified; third-party
denominators diverging from ADR-0006 `D`; a clone mutated after its snapshot
changing the join; module loading paths that bypass `fs`; native addons' own file
reads changing the conclusion; and signal-killed processes losing the trace tail.

## Tests

`tests/hydration-tracer.test.ts` (9) and `tests/hydration-analysis.test.ts` (8) —
17 assertions over the semantics the headline rests on: repeated access is one
hydration; metadata-only is never content; symlink aliases collapse to one physical
file; `open(…, 'w')` is a write; a probe at a non-existent path hydrates nothing;
workers and children stay attributable; totals survive SIGTERM; a workload runner is
not the application's working set; phase assignment follows timestamps;
hydrated + still-cold == initial cold exactly.

```bash
bun test tests/hydration-tracer.test.ts tests/hydration-analysis.test.ts
```

## Files

- `corpus/<app>.run.json` — the run record: argv, cwd, env keys, readiness, every
  phase with its requests and status codes, shutdown, stdout/stderr tails, deviations.
- `corpus/<app>.json` — the analysis: initial placement, totals, survival, the
  per-phase hydration curve, timing windows, miss size profile, top files and
  packages, concentration, per-package rollup, out-of-universe accesses, process tree.
- `corpus/first-touch/<app>.ndjson` — one record per hydration miss: file, realpath,
  bytes, order, offset, phase, op, package, pid, and the calling frame. This is the
  compact representation the curves are recomputable from.
- `summary.json` / `SUMMARY.md` — corpus aggregates.

Raw per-process traces live in `~/.cache/reducer-hydration-v1/traces/` and
the placement snapshots in `~/.cache/reducer-hydration-v1/plans/` (a
per-file index of a 252k-file universe is not a committable artifact); each snapshot
records its own `planSha256`.

## Reproduction

```bash
bun benchmarks/hydration/snapshot-plan.ts --all      # proves placement == first run
bun benchmarks/hydration/run-app.ts --app <name>     # per app
bun benchmarks/hydration/analyze.ts --all
bun benchmarks/hydration/summarize-corpus.ts
```

Requires: PostgreSQL on 127.0.0.1:5432, and mongo/redis/mysql containers
(`mongo:7`, `redis:7-alpine`, `mysql:8` with a `test_user`/`test_db`).

## Limitations

- **Runs are minutes, not days.** Nothing here observes a long-tail workload, a
  cron/backup path, an error path, or an admin operation nobody exercised. "Still
  cold" means "not touched by this workload", not "never needed".
- Workload quality is per-app and honestly labelled; one app is `smoke` because its
  entire route table is one handler.
- One workload run per app; no repetition, so run-to-run variance is unmeasured.
- Multi-entry surfaces (CLI subcommands, alternative services) are only represented
  where the existing workload happened to exercise them; none were invoked
  artificially to inflate coverage.
- 3 of 19 applications could not be measured, all for frozen-materialization or
  upstream-packaging reasons recorded in `SUMMARY.md`, none for reasons related to
  virtualization.
