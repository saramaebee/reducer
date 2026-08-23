# reducer — Node.js dependency research monorepo

Two research branches share this repository's infrastructure (NFT tracing,
production-universe discovery, capability analysis, a frozen 19-app corpus,
and an adversarial fixture/oracle suite):

1. **Conservative production linker** — completed. Asked: *can we prove
   dependency implementation permanently unnecessary?*
2. **Dependency virtualization** — active. Asks: *can we predict a
   substantially smaller local working set if prediction errors are
   recoverable?* (ADR-0007)

## Research branch 1: conservative linker (completed, preserved)

Under the sound invariant `proven reachable / possibly reachable / unknown →
KEEP; only proven unreachable → remove` (ADR-0001), whole-application
conservative reachability **saturates** on realistic Node applications: a
small number of unbounded loading capabilities (dynamic `require`,
`createRequire`, escaped loaders, `vm`, generated source) widen to the full
production universe. The hazard-domain first run measured a strict
target-median net reduction of exactly **0.0%**, with no sound-refinement and
no gate-off headroom (`benchmarks/hazard-domain/first-run/DECISION.md`). This
falsifies the global sound-size-reduction thesis.

Two results must not be over-summarized:

- The 0/24 CVE-removability table was produced under the same whole-app
  widening, so it is **not** evidence about symbol-scoped *sound islands*.
  Per-vulnerability elimination is **unresolved** — pinned as FE-1 in
  `docs/future-experiments.md`.
- The eight safety gates, capability/target-domain machinery, and adversarial
  fixtures are preserved: each exists because a fixture or review demonstrated
  the unsound alternative, and the capability primitives are inputs to both
  the new planner and any future island probe.

The pipeline still runs (frozen, not the product path):

```bash
bun run reducer analyze fixtures/basic/app.mjs --verbose
bun run reducer build   fixtures/basic/app.mjs --out dist-reduced
bun run bench basic
```

## Research branch 2: dependency virtualization (active)

Ship only the dependency files predicted to be needed locally; keep every
omitted production-universe file byte-for-byte recoverable from immutable
storage. Correctness comes from **recoverability, not analyzer soundness**:

```
wrong prediction != wrong program
wrong prediction == recoverable runtime miss + performance cost
```

The production universe (ADR-0005) remains authoritative; NFT remains
positive evidence only; prediction affects *placement* (HOT locally / COLD
recoverable), never availability; granularity is whole-file. Hazards are
planning signals (keep a package hot, widen a cluster, lower confidence), not
global blockers. See ADR-0007 for the full correctness model.

Current state: `packages/working-set-planner` holds the naive experiment-1
planner (NFT-positive / entrypoint / resolver metadata / opaque native
boundaries → HOT; everything else → candidate COLD) and reports universe /
NFT-positive / forced-hot / candidate-cold bytes. No recovery runtime exists
yet — the corpus measurement decides whether one is worth building.

## Layout

```
packages/
  tracer/                     shared: @vercel/nft positive-evidence tracing
  production-universe/        shared: universe discovery (realpath-deduped,
                              frozen-population aware) — the authoritative file set
  hazard-domain/              shared: capability/load-sink/target-domain analysis
                              + the ADR-0006 non-transforming measurement policy
  working-set-planner/        active: naive HOT/COLD placement planning (ADR-0007)

  cli/                        conservative pipeline CLI (analyze/build)
  conservative-analyzer/      frozen: eight-gate proof-of-unreachability analysis
  conservative-transformer/   frozen: function-body stubbing
  conservative-runtime-guard/ frozen: never built (README only)
  manifest/                   shared kernel (Reason, sha256) + frozen
                              conservative manifest schema

fixtures/     adversarial Node-semantics regressions (both experiments)
benchmarks/   corpus harness, Torture Garden, frozen first-run evidence
tests/        bun test suite; fixture artifacts execute under stock node
docs/adr/     ADR-0001–0006 conservative experiment; ADR-0007 the pivot
```

```bash
bun install
bun test tests
bun run typecheck
```

Reduced/verified artifacts target stock Node 24.19.0 (`.tool-versions`).
