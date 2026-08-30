# reducer — Node.js dependency research monorepo

Two research branches share this repository's infrastructure (NFT tracing,
production-universe discovery, capability analysis, a frozen 19-app corpus,
and an adversarial fixture/oracle suite). **Both are completed.** The full
chronology is in [`docs/RESEARCH-NARRATIVE.md`](docs/RESEARCH-NARRATIVE.md);
the product framing behind the second branch is in
[`docs/PROBLEM-CONTEXT.md`](docs/PROBLEM-CONTEXT.md).

1. **Conservative production linker** — completed, retired. Asked: *can we
   prove dependency implementation permanently unnecessary?* (ADR-0001–0006)
2. **Dependency virtualization** — completed, performance wedge closed. Asked:
   *can we predict a substantially smaller local working set if prediction
   errors are recoverable — and does that make a replica traffic-warm sooner?*
   (ADR-0007, experiments 1–5)

## Current state

**Closed**

- Whole-application sound dependency reduction as a meaningful size product:
  strict net universe-relative reduction measured exactly **0.0 %** median on
  every target app, no sound-refinement or gate-off headroom
  (`benchmarks/hazard-domain/first-run/DECISION.md`).
- Semantic working-set prediction as a performance differentiator: under equal
  measured prewarm cost, generic and semantic prefetch converge on the same
  physical content and the generic arm is at least as good on 11 of 15 cells
  (`benchmarks/costaware/run-1/FINDINGS.md`; ADR-0007 §Decision, 2026-08-24).
  Per the preregistered decision rule, no further planner variant is proposed.

**Survives**

- The conservative reachability / soundness infrastructure (eight gates,
  capability and target-domain analysis, adversarial fixtures, Torture
  Garden) — frozen and runnable.
- Complete, immutable, **recoverable** artifacts as a correctness principle:
  a closed `@vercel/nft` artifact failed to boot on 4 of 6 corpus apps; the
  complete lazy artifact making the identical placement decision ran all six
  (`benchmarks/lazy-oci/run-1/FINDINGS.md` §11b.A).
- Physical retrieval-cost-aware, unit-granularity prewarming as a *generic*
  technique — worth ~5 s of time-to-steady-state on the 915 MB app, for any
  prediction source; needs a chunk map and arithmetic, no Node analysis.

**Dormant / open**

- Sound-island / vulnerability-specific elimination — **FE-1**,
  `docs/future-experiments.md`. Unresolved, not refuted: the 0/24 CVE table
  was computed under whole-app widening and says nothing about symbol-scoped
  islands. Why the project branched into virtualization instead of running
  FE-1 is recorded retrospectively in
  [`docs/adr/0008-why-virtualization-before-sound-islands.md`](docs/adr/0008-why-virtualization-before-sound-islands.md).

This repository holds research conclusions. It does not contain an approved
next product build.

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
  the working-set planner and any future island probe.

The pipeline still runs (frozen, not the product path):

```bash
bun run reducer analyze fixtures/basic/app.mjs --verbose
bun run reducer build   fixtures/basic/app.mjs --out dist-reduced
bun run bench basic
```

## Research branch 2: dependency virtualization (completed, closed)

Ship only the dependency files predicted to be needed locally; keep every
omitted production-universe file byte-for-byte recoverable from immutable
storage. Correctness comes from **recoverability, not analyzer soundness**:

```
wrong prediction != wrong program
wrong prediction == recoverable runtime miss + performance cost
```

The production universe (ADR-0005) remains authoritative; NFT remains
positive evidence only; prediction affects *placement* (HOT locally / COLD
recoverable), never availability; granularity is whole-file. See ADR-0007 for
the full correctness model and its closing decision.

Five preserved experiments, each with a preregistered `DESIGN.md` and a
results writeup:

```text
1  static sparsity                benchmarks/working-set/first-run/   72.7 % median candidate-COLD (Plan B)
2  runtime coldness               benchmarks/hydration/run-1/         99.3 % of cold bytes stay cold
3  commodity lazy OCI (Nydus)     benchmarks/lazy-oci/run-1/          recoverability wins; semantic gain 1–2 s of 15
4  long-tail, equal byte budgets  benchmarks/longtail/run-1/          coverage real; bytes ≠ time; wedge not supported
5  cost-aware, equal prewarm time benchmarks/costaware/run-1/         null survives — performance wedge CLOSED
```

`packages/working-set-planner` holds the naive experiment-1 planner
(NFT-positive / entrypoint / resolver metadata / opaque native boundaries →
HOT; everything else → candidate COLD); its HOT set is experiment 3's B3a arm
and, re-expressed as a total ranking, experiment 4/5's R1 arm. No recovery
runtime was built; the experiments ran on Nydus. Term definitions and the
arm concordance are in `CONTEXT.md` §"Traffic-warm experimentation".

## Layout

```
packages/
  tracer/                     shared: @vercel/nft positive-evidence tracing
  production-universe/        shared: universe discovery (realpath-deduped,
                              frozen-population aware) — the authoritative file set
  hazard-domain/              shared: capability/load-sink/target-domain analysis
                              + the ADR-0006 non-transforming measurement policy
  working-set-planner/        frozen: naive HOT/COLD placement planning (ADR-0007
                              experiment 1; the B3a / R1 arm of experiments 3–5)

  cli/                        conservative pipeline CLI (analyze/build)
  conservative-analyzer/      frozen: eight-gate proof-of-unreachability analysis
  conservative-transformer/   frozen: function-body stubbing
  conservative-runtime-guard/ frozen: never built (README only)
  manifest/                   shared kernel (Reason, sha256) + frozen
                              conservative manifest schema

fixtures/     adversarial Node-semantics regressions (both branches)
benchmarks/   corpus harness, Torture Garden, hazard-domain first run, and
              frozen evidence for experiments 1-5
              (working-set/, hydration/, lazy-oci/, longtail/, costaware/)
tests/        bun test suite; fixture artifacts execute under stock node
docs/adr/     ADR-0001–0006 conservative branch; ADR-0007 the pivot and its
              closing decision; ADR-0008 retrospective on the branch order
docs/         RESEARCH-NARRATIVE.md, PROBLEM-CONTEXT.md, future-experiments.md
CONTEXT.md    project glossary (both branches, incl. arm concordance)
```

```bash
bun install
bun test tests
bun run typecheck
```

Reduced/verified artifacts target stock Node 24.19.0 (`.tool-versions`).

## License

Code and research materials: [PolyForm Noncommercial 1.0.0](LICENSE) —
free for noncommercial use; commercial use requires a separate license.
Advisory data under `benchmarks/cve-population/` is redistributed from
OSV.dev / the GitHub Advisory Database under CC-BY 4.0; see `NOTICE` and
`benchmarks/cve-population/README.md`.
