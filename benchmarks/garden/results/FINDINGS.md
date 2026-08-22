# Garden findings — 2026-08-22 (reducer 0.0.1, node v25.5.0 runtime, bun 1.3.1 tooling)

The garden was built exactly per `MANIFEST.json` and run end-to-end. Everything
below is a spec-vs-reality discrepancy or a pipeline defect the garden
surfaced. None of these were papered over; the labels and mechanisms are as
pinned.

## Headline numbers (full-garden run — `garden-score.md`)

- **False removal: 0. Unsafe optimism: 0.** The analyzer layer is sound on the
  oracle: six global hazards (dynamic-require, runtime-code-generation,
  require-cache-mutation, dynamic-import-nonliteral, unsupported-syntax,
  nft-warning) widened everything, so **0 of 439 traced files were
  transformed**.
- **Achieved/ceiling: 0/16 fabricated, 0/102 validator.** The manifest's own
  0%-calibration-ceiling reproduction, now under controlled conditions. This is
  the expected strict-model result, not a garden defect.
- **Over-retention: 13/16** MUST_REMOVE symbols retained; the other 3 vanished
  *unsoundly* (below).

## Critical pipeline findings (17 criticals in the score)

1. **File-level unsound removal by the tracer (13 contract divergences, 3
   MUST_REMOVE modules dropped).** NFT cannot trace: `createRequire()` targets
   (`cr-target`), `process.getBuiltinModule('module')`-derived loaders
   (`gbf-target`), try/catch require wrappers (`rrw-foo`, `rruc-target`),
   escaped loaders (`el-target`), non-literal `import()` (`din-target`),
   requires inside `eval`/`vm` source strings (`ecc-target`, `del-target`,
   `vil-target`), prefix-concatenated package-scoped requires
   (`rps-scopedtarget/*`), and fully unbounded `require(name)`
   (`rubp-target`, `rucp-target`, `rve-target`). All these modules are absent
   from the reduced tree, so the reduced service 500s on their live paths
   while the analyzer's verdicts say "retain everything". The retention layer
   is sound; **the emitted tree is not** — module-level soundness is currently
   bounded by NFT, exactly the gap ADR-0002's capability analysis is meant to
   close at the *symbol* level.
2. **sql.js's `dist/sql-wasm.wasm` is not traced** (emscripten loads it via a
   computed fs path). Worse than a missing endpoint: the failed wasm
   instantiation calls emscripten's `abort()`, which **kills the whole reduced
   service process** on first `/real/sqljs` hit (the scorer now reboots and
   attributes this correctly). Consequently the `wasm-boundary` opacity gate
   never keys (it triggers off a traced `.wasm` file that never appears) —
   see reason coverage below.
3. **Source maps ship the removed implementation.** In the hazard-free VEX
   sub-tree, `mergeVuln` is correctly stubbed, fails closed
   (`ReducerReachabilityViolation`), and `vex.ts` emits
   `not_affected / vulnerable_code_not_present` — but the emitted
   `index.js.map` contains the ORIGINAL vulnerable body in `sourcesContent`,
   contradicting the VEX impact statement "the vulnerable implementation bytes
   are physically absent from the deployment". `vex-check.ts` fails on this by
   design. Fix belongs in the transformer/CLI (strip or redact
   `sourcesContent` for stubbed ranges), not in the garden.

## Spec-vs-reality discrepancies (manifest expectations not reproducible today)

4. **`validator` positive control does not reduce (0/102).** Its CJS build
   ends `module.exports = exports.default; module.exports.default = …` — a
   double export-machinery write that (correctly, per the temporal-aliasing
   rule) marks every file's surface `export-object-mutation`/unknown. The
   package is hazard-free as pinned, but its *interop shape* defeats the
   closed-surface gate, so the "broad static CJS export surface that SHOULD
   yield real symbol-level reduction" yields none under the current model.
   The positive control currently measures the babel-interop recognition gap,
   which is real signal — but not the signal the manifest intended.
5. **`dynamic-property-access` is unexercisable under the current analyzer.**
   Both claimed entries produce different reasons today:
   `require-unbounded-computed-projection`'s non-literal specifier raises the
   `dynamic-require` hazard before any projection is analyzed, and
   `cjs-getter`'s surface-unknown check (`export-object-mutation`) pre-empts
   usage reasons. The manifest's `expectedReason` is the *future* model
   (bounded projection over unbounded specifiers — the Q10 rescue lever); the
   reason will only become observable once that lands.
6. **`native-boundary` is emitted internally but shadowed in verdicts.**
   better-sqlite3's `.node` prebuilds ARE traced and the package is marked
   opaque, but its own loader code raises global hazards, and the verdict loop
   returns `global-hazard:*` before the opacity reason is reported. Any tree
   containing better-sqlite3 therefore never *shows* `native-boundary`.
   Gate-ordering/reporting issue in the analyzer, not a garden or truth issue.
7. **`wasm-boundary` unexercisable** — direct consequence of finding 2. The
   manifest's own `inspectionCaveat` flagged a build-time swap decision for a
   hand-fabricated tiny `.wasm` control; that swap is the remedial path but
   was NOT applied, because the pinned spec lists sql.js and the garden must
   implement the manifest exactly. Decision deliberately left to the manifest
   owner.

## What holds

- All 47 fabricated packages implement their pinned mechanisms; conventions
  verified mechanically (16 sentinels verbatim & unique, 20 marker pairs,
  ≥200-byte bodies, no stray `exports` maps, globally unique package names).
- All 8 real packages verified at exact pinned version + integrity
  (hard-fail check in `tools/setup.ts`); validator re-confirmed hazard-free.
- Original service: 58/58 deterministic contracts, double-fetch determinism
  probe clean.
- **Mutation sensitivity: 22/22** MUST_RETAIN(+validator-used) symbols
  detected when broken — the suite has teeth; no fixture protects nothing.
- Red team: 16/16 `__force` endpoints reach real bodies (sentinel visible) on
  the original; on the reduced tree, 0 breaches — every removed-or-dropped
  symbol failed closed.
- VEX chain: stub → fail-closed throw → `not_affected` evidence all hold in
  the hazard-free sub-tree (modulo the source-map leak, finding 3).
- Reason coverage: 20/23 reasons exercised and attributed; the 3 exceptions
  are findings 5–7 above, with root causes, not silent gaps.

### Adversarial-review round (same day)

A 7-lens adversarial review of the artifact builder (multi-agent, each finding
independently re-verified by refuters with reproduction probes) confirmed 7
further defects in the first remediation pass; all are fixed with regression
tests in `tests/artifact-adversarial-regressions.test.ts`:

1. The on-disk opacity scan had *replaced* trace-kind detection — a symlinked
   `.node` escaped both paths and let a native package's export be removed.
   Now UNIONED (trace kinds + disk scan), symlink dirents count by extension,
   and an unscannable package dir is treated opaque.
2. `dev: true` lockfile keys outside `node_modules/` (file:/workspace source
   dirs) were excluded — deleting source directories `npm ci --omit=dev`
   would never touch. Only `node_modules/` keys are excludable now.
3. A removed implementation could ship verbatim in an untraced sibling copy
   (dual CJS/ESM builds). A physical-absence audit now scans the owning
   package's emitted files (raw + JSON-escaped forms) and REVERTS the
   transformation when the body survives elsewhere.
4. A pre-existing map not named exactly `<file>.map` shipped the removed body
   in `sourcesContent` (suppressed by the same audit), and inline data-URI
   map comments survived transformation (sourceMappingURL comments are now
   stripped at AST level).
5. A stale lockfile dev flag on a declared production dependency silently
   deleted the package — dev flags are now cross-checked against
   package.json; on disagreement nothing is excluded.
6. Empty directories were absent from the artifact (ENOENT on first runtime
   write). Directories are part of the universe and are emitted with modes.
7. A traced dev-flagged workspace symlink crashed the emit with EEXIST; the
   un-exclusion now preserves the link verbatim. Also: `.git` exclusion is
   restricted to the base root, and transformed files keep exact permission
   bits (chmod after write).

Post-fix: all gates re-run green — 84/84 tests, garden 0 criticals with the
reduced tree still byte-identical to the original (plus manifest), VEX 7/7,
mutation 22/22, reason coverage clean.

### Second adversarial round (independent re-run, 27/27 agents)

Re-confirmed the first round's findings and surfaced 3 new soundness defects
plus 2 sharp minors, all fixed with regression tests (N-prefixed in
`tests/artifact-adversarial-regressions.test.ts`):

8. **Monorepo hoisted dependencies silently absent.** `findBase` stopped at
   the nearest package.json, so deps hoisted to a workspace root above it
   were outside both the universe and the (base-scoped) NFT trace — the
   artifact shipped with zero node_modules. `findBase` now prefers the
   highest explicit workspace root (`workspaces` field, pnpm-workspace.yaml,
   lerna.json); and a new fail-stop backstop refuses to emit whenever any
   analyzed dependency resolves outside the production universe (covering
   non-workspace hoisting too) rather than shipping a silently broken tree.
9. **Absolute-target symlinks resurrected removed implementations** by
   resolving back into the ORIGINAL source tree. In-universe symlink targets
   are now retargeted into the artifact (identity emit for ordinary relative
   links); reading through the artifact's link yields the stub.
10. **Symlink deps targeting outside the base** (npm link / file:../sibling)
    shipped only the dangling link. External targets are now materialized
    into the artifact (dereference copy) with a warning; such deps are also
    exempted from the fail-stop since their content ships.
11. Minors: opacity-reason drift for packages with both `.node` and `.wasm`
    restored to exact pre-refactor semantics; output-dir exclusion now uses
    device+inode identity so a case-variant `--out` on macOS/Windows neither
    self-copies stale output nor bricks the build mid-emit.

Final state: 89/89 tests, garden 0 criticals, reduced tree byte-identical to
the original (plus manifest), VEX 7/7, mutation 22/22, reason coverage clean.

### Node runtime pin (2026-08-22)

Reducer's initial target is Node 24 LTS; the repo now pins `nodejs 24.19.0`
in `.tool-versions` (asdf). The full garden was re-run under stock node
v24.19.0 with the asdf shim first on PATH: every result — 0 criticals, 58/58
contracts byte-identical, 16/16 `__force` fail-closed, VEX 7/7, mutation
22/22, reason coverage, and the reduced-tree byte-identity — is identical to
the v25.5.0 run; the only field that changed in `garden-score.json` is
`runtimeNode` itself. No Node-24-vs-25 compatibility difference observed.
Note: the shim wins only when `~/.asdf/shims` precedes Homebrew on PATH.
