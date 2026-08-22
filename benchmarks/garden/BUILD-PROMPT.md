# Build the Reducer Oracle / Torture Garden

You are working in the `reducer` repo, a conservative Node.js production linker.
Tooling runs under `bun`; reduced artifacts are executed and tested under stock
`node` (the target runtime). Read these first and treat them as binding:

- `benchmarks/garden/MANIFEST.json` — THE SOURCE OF TRUTH for what to build.
- `benchmarks/garden/README.md` — the three ground truths and scoring axes.
- `CONTEXT.md` — the domain glossary (capability, load sink, specifier/resolved-
  target domain, module-vs-export reachability, the three MUST_* labels, etc.).
- `docs/adr/0001..0004` — the invariants you must not violate.
- `packages/cli/src/index.ts` / `build.ts` — how to run the reducer:
  `bun packages/cli/src/index.ts build <entry> --out <dir>` emits a reduced tree
  + `reducer-manifest.json`. `tests/helpers.ts` shows the build+run pattern.

## Objective

Build the Garden described by MANIFEST.json: a real HTTP service that is an
executable specification of the analyzer's semantic model, plus the harness that
scores a reduced build of it against by-construction ground truth. Do NOT build
or modify the analyzer/transformer in this task — you are building the oracle the
analyzer will later be judged against.

## Core invariant (never weaken)

Proven reachable / possibly reachable / unknown => KEEP. Only proven-unreachable
may be stubbed. The Garden must make any violation of this DETECTABLE, never
paper over it.

## Deliverables

Build under `benchmarks/garden/`:

1. **Fabricated packages** — one local package per entry in
   `fabricatedPackages` (47), as a real installable dependency tree (each with
   its own package.json + source), implementing EXACTLY the mechanism described.
   - Every `MUST_REMOVE` symbol embeds its declared `sentinel` string in its body
     and must be genuinely unreachable by construction.
   - Every function body must be large enough (>200 bytes) that stubbing is
     measurable.
   - `MUST_RETAIN` symbols are reachable only through the HTTP contract;
     `MUST_RETAIN_CONSERVATIVELY` symbols are possibly-reachable/unknown by the
     stated mechanism and need NOT be invoked by any endpoint.
   - Where the manifest says `"*"`, apply the label to every export of that
     package.

2. **Real packages** — install the `realPackages` at their EXACT pinned
   version + integrity (fail the build on any mismatch). Wire each into the
   service so its hazard/boundary is genuinely exercised (e.g. better-sqlite3
   opens an in-memory DB and queries; sql.js loads its .wasm; express mounts a
   view; optional-require/require-at/depd/lodash are actually called on a live
   path).

3. **HTTP service** — a real server (framework your choice; keep deps minimal)
   with, per the manifest's endpointConvention:
   - `GET /fab/<id>/<symbol>` for every MUST_RETAIN symbol, returning a
     deterministic body derived from that symbol's output.
   - `GET /fab/<id>/__force/<symbol>` for every MUST_REMOVE symbol that
     deliberately invokes it (red-team; on a reduced build this must throw
     ReducerReachabilityViolation and the endpoint must fail closed, not 200).
   - Endpoints for the real packages that exercise their live paths.
   The service must boot without external services (in-memory only) so it runs
   in CI and in the reduced tree.

4. **Contract fixtures** — recorded request→response pairs for every
   non-`__force` endpoint (the behavioral oracle). Deterministic; no clocks/
   randomness in bodies.

5. **Mutation-sensitivity harness** — for every MUST_RETAIN symbol: stub/mutate
   it in the ORIGINAL app, replay that symbol's endpoint, and assert the endpoint
   FAILS. A MUST_RETAIN symbol whose endpoint still passes when the symbol is
   broken is a spec bug in the Garden — report it, don't hide it.

6. **Scorer** — given an original build and a reduced build (produced via the
   reducer CLI) + a `reducer-manifest.json`, compute the three axes from
   MANIFEST.json's `scoring`:
   - false removal: a MUST_RETAIN symbol was transformed -> CRITICAL
   - unsafe optimism: a MUST_RETAIN_CONSERVATIVELY symbol was transformed -> CRITICAL
   - over-retention: a MUST_REMOVE symbol was retained -> precision (non-fatal)
   - achieved/ceiling: removed(MUST_REMOVE) / |MUST_REMOVE|
   Also run the full contract suite against the REDUCED service under stock node
   and flag ANY divergence from the fixtures as an unsound removal.
   Emit machine-readable JSON + a concise Markdown summary.

7. **VEX check** — the `vuln-localized` package: after reduction, assert the
   fail-closed chain and that `benchmarks/vex.ts` emits a
   not_affected/vulnerable_code_not_present record for its vexMapping entry.

## Constraints

- Implement MANIFEST.json EXACTLY. If a mechanism can't be built as specified,
  or the observed reducer behavior contradicts the declared truth, STOP and
  report the discrepancy honestly — do NOT adjust the Garden or the labels to
  make a run look clean. A mismatch is a finding (possibly a soundness bug in the
  analyzer, possibly a spec error), not something to smooth over.
- Do not touch `packages/analyzer`, `packages/transformer`, or existing
  `tests/adv-*` / `tests/retention.test.ts`.
- Keep the sentinel strings from MANIFEST.json verbatim so the scorer can check
  byte-absence in the reduced artifact.
- Pin real packages by integrity; a version/integrity mismatch fails the build.

## Acceptance criteria

- The ORIGINAL service boots under stock node, every contract fixture passes, and
  every mutation-sensitivity check fails-on-mutation (the suite has teeth).
- The service builds through the reducer CLI, and the REDUCED service boots and
  passes every non-`__force` contract fixture (soundness).
- The scorer runs end-to-end and reports the three axes + achieved/ceiling +
  any discrepancies, as JSON + Markdown.
- Every retention Reason in `reasonCoverage` is exercised by at least one entry.

## Milestone order

1. Fabricated packages + local dep tree (build the semantic matrix first).
2. HTTP service + contract fixtures + mutation harness on the ORIGINAL only;
   prove the suite has teeth before any reduction.
3. Install + wire the pinned real packages.
4. Wire the reducer CLI build + the scorer; run original vs reduced; report.

At the end, report: what was built, any manifest entries that couldn't be built
as specified, any reduced-tree contract divergences or fail-closed failures, and
the scorer output — with disappointing/zero reduction treated as valid data and
every soundness violation treated as a serious defect.
