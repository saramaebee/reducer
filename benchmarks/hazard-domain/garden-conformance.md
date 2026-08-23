# Garden conformance — hazard-domain analyzer (ADR-0006)

Non-transforming. 0.0.1 @ 67c057597456. Generated 2026-08-23T04:00:30.941Z.

## Soundness verdict

**SOUND — no MUST_RETAIN/MUST_RETAIN_CONSERVATIVELY symbol was predicted-removable** — 0 violation(s), 1 pre-registered finding(s) (star-overbreadth, non-fatal).

_no violations._

### Findings (non-fatal, ADR-0006 mode B predicate)

- **[B]** `fab-identity-unification::ledger`: fab-identity-unification is a starPackages ("*") member — every export is MUST_RETAIN_CONSERVATIVELY — pre-registered carrier star-overbreadth FINDING (ADR-0006 mode B predicate), not a soundness failure


## Mode A — combined strict run (the real-app condition)

| metric | value |
|---|---|
| D (universe third-party JS bytes) | 19,184,424 |
| E_predicted | 19,184,424 |
| net reduction | 0.00% |
| achieved/ceiling (fab) | 0/16 = 0.0% |
| achieved/ceiling (validator) | 0/102 = 0.0% |

### Per-MUST_REMOVE blocking sets (combined tree)

| id | symbol | achieved | blocking set |
|---|---|---|---|
| static-basic | deadUnused | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| esm-decl | deadDecl | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| esm-specifier-alias | deadAlias | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| esm-namespace-clean | deadNs | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| esm-reexport | beta | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, nft-positive-evidence, require-cache-mutation, static-import, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| esm-sideeffect | unusedSide | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| cjs-basic | dead | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| cjs-object-literal | dead | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| require-literal | dead | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| require-finite | deadInBoth | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| require-unbounded-bounded-projection | notFoo | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| createrequire | dead | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| reconstructed-require-wrapper | otherUnused | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| eval-constant-benign | deadDead | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| vm-no-loader | deadNoLoader | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |
| vuln-localized | mergeVuln | ✗ | dynamic-property-access, escaped-loader, generated-source-unknown, module-identity-unresolved, native-boundary, require-cache-mutation, unbounded-loader-target, unsupported-syntax, value-escaped, vm-conservative, wasm-boundary, wrapper-unprovable |

## Mode B — isolation sweep (47 fab packages)

Per-package soundness join restricted to that package's own fab-owned packages (garden.md §4.1) — a hit on an unrelated, unreached package is expected and not reported as a violation.

achieved/ceiling (fab, sum over packages): **12/16** vs combined-tree **0/16** — the delta (12) is the global-hazard blast-radius headline.

| package | ceiling | achieved | violations | findings |
|---|---|---|---|---|
| createrequire | 1 | 1 | 0 | 0 |
| reconstructed-require-wrapper | 1 | 0 | 0 | 0 |
| static-basic | 1 | 1 | 0 | 0 |
| esm-decl | 1 | 1 | 0 | 0 |
| esm-specifier-alias | 1 | 1 | 0 | 0 |
| esm-namespace-clean | 1 | 1 | 0 | 0 |
| esm-reexport | 1 | 1 | 0 | 0 |
| esm-sideeffect | 1 | 1 | 0 | 0 |
| eval-constant-benign | 1 | 1 | 0 | 0 |
| require-literal | 1 | 1 | 0 | 0 |
| require-finite | 1 | 0 | 0 | 0 |
| require-unbounded-bounded-projection | 1 | 0 | 0 | 0 |
| cjs-basic | 1 | 1 | 0 | 0 |
| cjs-object-literal | 1 | 1 | 0 | 0 |
| vm-no-loader | 1 | 0 | 0 | 0 |
| identity-unification | 0 | 0 | 0 | 1 |
| vuln-localized | 1 | 1 | 0 | 0 |

## Mode C — sound-refinement counterfactuals (combined tree)

| refinement | achieved fab | achieved validator | violations | net reduction |
|---|---|---|---|---|
| SR-vm-known-globals | 0/16 | 0/102 | 0 | 0.00% |
| SR-subpath-exports-narrowing | 0/16 | 0/102 | 0 | 0.00% |
| SR-import-condition-resolution | 0/16 | 0/102 | 0 | 0.00% |
| SR-cross-module-wrapper | 0/16 | 0/102 | 0 | 0.00% |

### SR-vm-known-globals asserts

- vm-injected-loader (`{ require }` context) still fully retained: **yes (correct)**
- vm-no-loader:deadNoLoader reclaimed on the **combined tree**: no
- vm-no-loader:deadNoLoader reclaimed in **isolation**: no

## Mode D — gate-off counterfactuals (UNSOUND-DIAGNOSTIC, exempt from the gate)

Upper bounds only, each conditional on every other gate remaining conservative (ADR-0006). Never a rescue by itself.

| gate | achieved-fab Δ | achieved-validator Δ | net reduction |
|---|---|---|---|
| dynamic-property-access | +0 | +0 | 0.00% |
| escaped-loader | +0 | +0 | 0.00% |
| generated-source-unknown | +0 | +0 | 0.00% |
| module-identity-unresolved | +0 | +0 | 0.00% |
| native-boundary | +0 | +0 | 0.00% |
| require-cache-mutation | +0 | +0 | 0.00% |
| unbounded-loader-target | +0 | +0 | 0.00% |
| unsupported-syntax | +0 | +0 | 0.00% |
| value-escaped | +0 | +0 | 0.00% |
| vm-conservative | +0 | +0 | 0.00% |
| wasm-boundary | +0 | +0 | 0.00% |
| wrapper-unprovable | +0 | +0 | 0.00% |

### Top pairwise combinations (among the top 5 single gates)

| gates | achieved-fab Δ | achieved-validator Δ |
|---|---|---|
| dynamic-property-access + escaped-loader | +0 | +0 |
| dynamic-property-access + generated-source-unknown | +0 | +0 |
| dynamic-property-access + module-identity-unresolved | +0 | +0 |
| dynamic-property-access + native-boundary | +0 | +0 |
| escaped-loader + generated-source-unknown | +0 | +0 |
| escaped-loader + module-identity-unresolved | +0 | +0 |
| escaped-loader + native-boundary | +0 | +0 |
| generated-source-unknown + module-identity-unresolved | +0 | +0 |
| generated-source-unknown + native-boundary | +0 | +0 |
| module-identity-unresolved + native-boundary | +0 | +0 |

---
Analysis wall time: 515.5s.
