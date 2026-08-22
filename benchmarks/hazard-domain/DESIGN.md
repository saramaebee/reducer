# Hazard-domain analyzer — design contract (v1 strict)

Non-transforming. Grants no deletion authority. Predicts removability under
explicit proof models; uncertainty widens, never narrows. ADR-0006 metric.

## Package layout

- `packages/hazard-domain/src/` — new package `@reducer/hazard-domain`.
  Depends on @babel/*, `@reducer/tracer` (NFT positive evidence),
  `@reducer/transformer` (in-memory stub byte simulation ONLY — never writes),
  `@reducer/analyzer` (reuse of `analyzeModuleSource` patterns where sound).
  Never modifies existing packages' behavior.
- `benchmarks/hazard-domain/` — garden-conformance.ts, run-corpus.ts,
  cve-feasibility.ts, summarize.ts, first-run/ (committed results).

## Pipeline

1. **Universe** (`universe.ts`): walk app base (findBase semantics), realpath-
   aware package ownership (nearest package.json with "name" walking up),
   third-party = owning package name@version ∈ frozen production population
   (corpus: benchmarks/cve-population/corpus-packages.json; garden/fallback:
   lockfile dev-boundary like build.ts). D = Σ raw bytes of third-party
   .js/.cjs/.mjs files, physical files counted once (realpath dedup;
   symlinked store trees do not double-count).

2. **Module facts** (`facts.ts`): babel-parse every universe JS file
   (sourceType unambiguous, errorRecovery false). Parse failure ⇒ module
   opaque: retained, and if module-reachable it contributes an Unbounded
   active sink (gate `unsupported-syntax`). Facts per module: format; export
   surface (names, backing local, transformer-stubbable shape, surface-closed
   confidence + reasons — reuse existing recognition rules verbatim incl.
   duplicate-write widening); static edges (import/require/export-from with
   exact specifiers); load sinks; capability events; generated-source sites;
   vm sites (with evidence record); module-object/result usage tracking
   (trackObjectBinding semantics); `require.resolve`-style file-retention
   sinks.

3. **Capabilities** (`capability.ts`):
   kinds: `lexical-require`, `module-require`, `createRequire-result`,
   `getBuiltinModule` (factory), `node:module` namespace (factory),
   `dynamic-import` (ambient — every module has it), `vm-injected`.
   Flow: alias chains, destructuring, params/returns within the wrapper rules,
   closure capture, container storage. Any flow crossing a boundary we do not
   model ⇒ that module records `escaped-loader` (module gains an Unbounded
   active sink when reachable). Factories stay chained, never collapsed.

4. **Specifier domains** (`specifier.ts`): Exact | Finite(set) |
   Package(pkg) | ResolverScope | Unbounded. Sound constant-set evaluation:
   string literals; fully-constant templates/concats; never-reassigned const
   string bindings (single init, same scope resolution as babel bindings);
   ternary/array-of-constants; constant-prefix concat pinning a package ⇒
   Package(pkg). Anything else ⇒ Unbounded. Widening is monotone.

5. **Wrappers** (`wrapper.ts`): demand-driven, depth ≤ 3. A sink fed by a
   parameter may take the union of call-site argument domains only if: single
   known definition; binding never reassigned; function value non-escaping
   (references are direct callees only); every call site in a parsed universe
   module; arg→sink flow is a direct identifier use. Any violation ⇒
   Unbounded with gate `wrapper-unprovable`. Depth exhaustion ⇒ Unbounded,
   gate `wrapper-depth`.

6. **Generated source** (`generated.ts`): constant-source direct eval
   inherits lexical capability env; constant-source indirect eval / Function /
   new Function get global-only env (dynamic import + getBuiltinModule chains
   still available per ADR-0002). Recursively analyze constant source,
   depth ≤ 2; exhaustion ⇒ Unbounded sink, gate `generated-source-depth`.
   Non-constant source ⇒ Unbounded sink, gate `generated-source-unknown`.

7. **VM** (`vm.ts`): strict model = maximally loader-capable: any vm API use
   ⇒ Unbounded sink, gate `vm-conservative`. Record per-site evidence:
   {api, contextArgKind (none|object-literal|identifier|unknown),
   literalKeys?, injectsRequireLike?, codeIsConstant?} for SR-vm headroom.

8. **Resolution** (`resolve.ts`): Exact/Finite specifiers resolved from the
   importer with createRequire(importer).resolve; builtins ⇒ no universe
   contribution. For import-sinks into packages whose exports field has
   distinct import/require conditions on the resolved path ⇒ widen owning
   package, gate `import-condition-divergence`. Unresolvable bare specifier
   whose package is absent from the universe ⇒ empty contribution (cannot
   load what does not exist) BUT only when the specifier is Exact and bare;
   otherwise gate `unresolved-specifier` ⇒ Unbounded. Package(pkg) domain ⇒
   every JS file in that package (exports-map narrowing is SR, not strict).
   ResolverScope/Unbounded ⇒ all universe JS.

9. **Fixpoint** (`fixpoint.ts`): module-init reachability. Seeds: entry
   closure + NFT-traced JS files (positive evidence widens). Active sinks =
   sinks of reachable modules (strict: no function-level gating). Edges carry
   attribution {sinkId, gates[]}. Config = set of suppressed gate tags /
   refinement admission predicates; counterfactual runs re-run the fixpoint
   with a config (rerun is the mechanism — no in-run speculation).
   Once an Unbounded sink activates, all universe modules are reachable
   (short-circuit, attributed to that sink's gates).

10. **Export/property projection** (`projection.ts`): per reachable
    third-party module, union usage across ALL load paths (module-identity
    unification): static importer names/all + sink-result projections.
    Sink-result flow classes: `projected(names)` | `escaped` | `unused`.
    Unbounded-target sink with finite projection {foo} projects foo onto
    EVERY module in its domain. Escaped result ⇒ full surface of every
    domain module. Narrowing requires: surface-closed AND every load path
    accounted. Symbol predicted-stubbable iff transformer-shape stubbable,
    not in projected/static usage, all aliases (incl. default) unreachable —
    existing shared-implementation rule.

11. **Bytes** (`bytes.ts`): E_predicted = Σ retained third-party JS bytes
    − Σ (file bytes of predicted-removable files) + Σ (in-memory
    stubFunctions output size delta for predicted stubs, incl. sourceMappingURL
    line, matching build.ts emit exactly). Two proof models, labeled:
    `module-unreachable` (file-level, predicted absent) and
    `function-body-stub` (ADR-0004 semantics). Negative net allowed. Also
    report implementation-bytes-eliminable (Σ original body spans) separately.

12. **Blocking sets** (`report.ts`): per file and per symbol, the COMPLETE
    set of gates blocking its removal — attribution collected during the
    fixpoint + local reasons, not first-gate-only. Vocabulary: existing
    Reason strings where semantics match, new gates:
    `unbounded-loader-target`, `escaped-loader`, `generated-source-unknown`,
    `generated-source-depth`, `vm-conservative`, `wrapper-unprovable`,
    `wrapper-depth`, `import-condition-divergence`, `unresolved-specifier`,
    `package-domain-whole`, plus existing (`export-object-mutation`,
    `dynamic-property-access`, `value-escaped`, `native-boundary`,
    `wasm-boundary`, `unsupported-syntax`, `shared-implementation`, ...).

13. **Counterfactuals**: gate-off configs (single + top pairwise chosen by
    single-delta ranking and blocking-set co-occurrence) = upper bounds,
    labeled diagnostic. Sound-refinement configs admit only evidenced cases:
    - SR-vm-known-globals: suppress vm sinks only where evidence shows
      object-literal context without loader-like injection and constant code.
    - SR-subpath-exports-narrowing: Package domains narrowed to exports-map
      targets.
    - SR-import-condition-resolution: implement real import-condition
      resolution (suppresses import-condition-divergence only).
    - SR-cross-module-wrapper: wrapper preconditions extended across module
      boundary, depth+1, only where all callers enumerable.
    Each documented: name, proof obligations, admitted/widened counts,
    tractability, headroom.

## API

```ts
export interface HazardDomainOptions {
  entry: string;                    // absolute
  frozenPackages?: {name: string; version: string}[]; // semantic third-party set
  config?: AnalysisConfig;          // gate suppressions / SR admissions
  nft?: boolean;                    // default true
}
export interface AnalysisConfig { suppressGates?: GateTag[]; refinements?: RefinementName[] }
export function analyzeHazardDomain(opts: HazardDomainOptions): Promise<HazardDomainReport>
```

`HazardDomainReport` (machine-readable, one per app per config):
app metadata; D; E_predicted; netReduction; implBytesEliminable;
per-file states + blocking sets; per-symbol stub predictions + blocking
sets; sink inventory {capability, domain tier, result flow, gates} +
distributions; vm evidence; capability-site counts; export-surface
confidence distribution; widened/unsupported case log (each with why);
analysisMs; analyzer version + content hash.

## Soundness discipline

Every widening is monotone and recorded. Depth limits affect precision only.
No metric may improve by assuming away uncertainty. Garden MUST_RETAIN and
MUST_RETAIN_CONSERVATIVELY must never be predicted-removable; violations are
soundness defects fixed before corpus measurement, each with a regression
fixture.

## Pre-registered Garden conformance gate (decided before any analyzer code ran)

Gate = combined-tree strict run + the four SR configs + the 47-package
isolation sweep: zero MUST_RETAIN / MUST_RETAIN_CONSERVATIVELY symbols
predicted-removable. Gate-off configs are exempt (labeled unsound
diagnostics). Ground truth is never modified.

Star-overbreadth finding predicate (pre-registered): an isolation-mode
violation on a `starPackages` CARRIER symbol is recorded as a spec FINDING
rather than a soundness failure iff (1) the symbol belongs to the fab carrier
package while the manifest mechanism targets a nested package, (2) the
carrier's export surface is statically closed, (3) the carrier module object
does not escape in the entry, and (4) no route/import references the symbol.
Known candidates identified before implementation: `identity-unification:ledger`,
`destructure-rest:pick`, `unrecognized-importer:launch`. Any other violation
is a soundness defect: fixed before corpus measurement, with a regression
fixture.
