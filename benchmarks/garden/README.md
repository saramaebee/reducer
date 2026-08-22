# Reducer Oracle / Torture Garden

An executable specification of the analyzer's semantic model: a real HTTP
service whose dependency tree exercises every capability, domain tier,
reachability case, safety gate, retention reason, and the vulnerability-removal
case — each with ground truth declared **by construction**, independent of what
the analyzer currently reports.

This is **not** the real-app measurement set. The locked 16-project corpus
([`../corpus.json`](../corpus.json)) measures reduction on real applications;
the garden is the controlled **soundness + ceiling oracle**. Both feed the
decision in [ADR-0003](../../docs/adr/0003-non-transforming-analyzer-first.md).

## What's pinned

[`MANIFEST.json`](./MANIFEST.json) is the source of truth. Two layers:

- **Real packages** (version + integrity pinned to what the calibration
  observed, so the semantics reproduce permanently):
  - *hazard controls* — `optional-require`, `require-at`, `depd`, `lodash`,
    `express`: the actual 0%-ceiling reproducers. Nothing here may be stubbed.
  - *reducible positive control* — `validator@13.15.35` (lib/ verified
    hazard-free): a broad closed CJS export surface that **should** reduce, so
    the real layer measures more than pessimism.
  - *native opaque control* — `better-sqlite3` (`.node`): must be marked
    `native-boundary`, zero removal.
  - *WASM opaque control* — `sql.js` (ships discrete `sql-wasm.wasm`): must be
    marked `wasm-boundary`, zero removal.
- **Fabricated packages** (47) — one per mechanism in the Q8–Q13 semantic
  matrix plus every safety gate / retention `Reason`, with per-symbol
  `MUST_RETAIN` / `MUST_REMOVE` / `MUST_RETAIN_CONSERVATIVELY` truth.

## The three ground truths (why an HTTP service)

1. **By construction** — every symbol's label is declared in the manifest, not
   inferred from test coverage. "Not observed" is never "unreachable."
2. **Behavioral** — every `MUST_RETAIN` path has a deterministic endpoint; the
   recorded request→response contract replayed against the **reduced** service
   under stock node must match the original byte-for-byte. Divergence = unsound
   removal.
3. **Mutation-sensitivity** — before an endpoint is trusted to protect a
   symbol, that symbol is mutated in the *original* app and the endpoint must
   fail. An endpoint that passes even when its own symbol is broken protects
   nothing.

## Scoring (three independent axes)

| outcome | axis | severity |
|---|---|---|
| `MUST_RETAIN` transformed | false removal | **critical** soundness failure |
| `MUST_RETAIN_CONSERVATIVELY` transformed | unsafe optimism | **critical** soundness failure |
| `MUST_REMOVE` retained | over-retention | precision failure (non-fatal) |
| removed / total `MUST_REMOVE` | achieved-vs-ceiling | the product metric |

The load-bearing case is `require-unbounded-bounded-projection`: an unbounded
`require(name).foo()` where a co-located export **not** named `foo`, on a
closed-surface module, is `MUST_REMOVE`. If the analyzer reclaims it soundly,
symbol-level reduction survives even without solving dynamic module resolution
— the central bet of the whole rescue experiment.

## Build status

The garden is **built**. Layout:

- `fab/` — the 47 fabricated packages (committed sources; copied into
  `app/node_modules/` by setup).
- `app/` — the HTTP service: `server.mjs` (generated; 49 fab routes + 9 real
  routes + the `__force` handler), `real.cjs` (pinned real-package wiring),
  `__redteam.mjs` (generated; loaded ONLY via `node --import` by the harness —
  the analyzed tree never references it, so MUST_REMOVE stays unreachable by
  construction), `vuln-entry.mjs` (hazard-free sub-entry for the VEX check).
- `wiring.json` / `garden-map.json` — the machine-readable join between
  manifest truth and physical files (generated).
- `fixtures/contracts.json` — the recorded behavioral oracle (58 endpoints).
- `tools/` — setup, generator, verifiers, harnesses, scorer.
- `results/` — scorer output (`garden-score.{json,md}`, `vex-check.json`,
  `reason-coverage.json`, `FINDINGS.md`).

### Running it

```bash
bun benchmarks/garden/tools/setup.ts        # npm ci + integrity vs MANIFEST (hard fail) + copy fabs
bun benchmarks/garden/tools/verify-fabs.ts  # sentinel/marker/convention checks
bun benchmarks/garden/tools/gen.ts          # regenerate server.mjs/__redteam.mjs/garden-map.json
bun benchmarks/garden/tools/record-fixtures.ts  # re-record the behavioral oracle (original app)
bun benchmarks/garden/tools/mutate.ts       # mutation-sensitivity: every MUST_RETAIN endpoint has teeth
bun benchmarks/garden/tools/score.ts        # reducer build + three-axis score + contract replay + red team
bun benchmarks/garden/tools/vex-check.ts    # hazard-free vuln-localized reduction + VEX evidence
bun benchmarks/garden/tools/reason-coverage.ts  # per-entry isolation analysis of every retention Reason
```

Known spec-vs-reality discrepancies are recorded in
[`results/FINDINGS.md`](./results/FINDINGS.md) — they are findings about the
current pipeline (or the spec), deliberately not smoothed over in the garden.
