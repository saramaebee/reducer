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

This directory currently holds the **pinned specification only**. Building the
service (fabricated package sources, the endpoint router, the mutation-injector,
and the red-team forced-invocation harness) is the next step; it must implement
`MANIFEST.json` exactly, and every real package must be installed at its pinned
version + integrity.
