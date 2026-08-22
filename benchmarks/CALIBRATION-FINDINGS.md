# Reducer — 5-project calibration findings (2026-08-22)

Real-world validation of the conservative production-linker thesis: *after
NFT-style tracing, how much additional third-party JS can be **proven**
unreachable and physically removed without optimistic assumptions?*

## Headline

**0.0% median incremental reduction beyond NFT across all 5 calibration
projects.** Zero functions stubbed on every real app. Zero crashes, zero
reducer errors, zero semantic regressions. 100% of surviving third-party code
is retained by **global hazards** (Gate 1) — never by the escape / dynamic-
property / shared-implementation reasons the analyzer was built to reason about.

| project | fw | modules | prod deps | NFT JS | strongest bundle | reducer JS | Δ vs NFT | stubbed | triggering hazards |
|---|---|---|---|---|---|---|---|---|---|
| express-realworld | express | mixed | 11 | 4300 KB | 942 KB (esm) | 4300 KB | 0.0% | 0 | dynamic-require, runtime-code-generation, nft-warning |
| fastify-demo | fastify | mixed | 23 | 1329 KB | 592 KB (esm) | 1329 KB | 0.0% | 0 | dynamic-import-nonliteral, dynamic-require, require-cache-mutation, runtime-code-generation |
| node-express-boilerplate | express | cjs | 24 | 8276 KB | 4702 KB (esm) | 8276 KB | 0.0% | 0 | dynamic-require, runtime-code-generation, nft-warning |
| json-server | — | mixed | 13 | 456 KB | 191 KB (esm) | 456 KB | 0.0% | 0 | runtime-code-generation, unsupported-syntax |
| uptime-kuma | express | mixed | 84 | 26593 KB | **FAILED** | 26593 KB | 0.0% | 0 | dynamic-require, runtime-code-generation, dynamic-import-nonliteral, nft-warning |

Bundler (C) passed on 4/5 (esbuild failed on uptime-kuma: `.html` in
`@mapbox/node-pre-gyp`, a native-addon dynamic-require). Where it passed it
produced 2–4× smaller *single-file* artifacts, but that number is not
comparable to the reducer's package-preserving tree and is not the metric.

## Why 0% — the retention data is unambiguous

Every surviving symbol is blocked by a **global** hazard. Once any traced
module contains `eval` / `new Function` / a non-literal `require`/`import()` /
`require.cache` mutation / a parse failure / an NFT warning, the invariant
widens the **entire** tree to `unknown`. On real trees that condition is
always met.

The triggering sites, characterized in the express-boilerplate traced set
(1187 prod JS files, 8 with `new Function`, 5 with `eval`, plus express's
`require(mod)` view loader), fall into two classes:

1. **Constant, provably-incapable generated source (analyzable, carve-out-able
   only after proving incapability — see correction below):**
   - `Function('return this')` — the ubiquitous global-object probe (lodash,
     bson, …). Constant source; returns `globalThis`, acquires no loader.
   - `depd` — `eval('(function (' + args + ') {…})')` builds a deprecation
     wrapper. Note this string is *not* constant (built from arity) and depd is
     *direct* `eval`, so it inherits lexical `require` — see correction.
   - `bluebird` — `new Function` closure/promisify templates; generated source
     references promise internals.

2. **Reach-any-module (fatal to any sound unreachability proof):**
   - `optional-require` (pulled by `mongodb`) and `require-at`: literally
     `var xrequire = eval("require")`, with the source comment *"Using eval to
     avoid tripping bundlers like webpack."*
   - `express/lib/view.js`: `require(mod)` where `mod` is a runtime template
     engine name.
   - `sift`: compiles a MongoDB query to a function at runtime.

> **Correction (design review, supersedes the naïve Class-1 read above).** An
> earlier draft claimed `new Function` "cannot reach the module system" and was
> therefore always safe to ignore. That is **wrong on Node 24**: code running in
> the global scope can still call `process.getBuiltinModule('module')` →
> `createRequire()` to reconstruct a working `require`, and `import()` is always
> available. So **`new Function` with a non-constant argument is reach-any**, not
> benign. The sound carve-out is narrower than "it's `new Function`": *only*
> generated source that is a compile-time constant **and** can be parsed and
> proven incapable of acquiring/using a load capability (e.g.
> `Function('return this')`) may be cleared. `depd` in particular is *direct*
> `eval` (inherits lexical `require`) with a *non-constant* string — squarely
> reach-any. This narrows the code-gen carve-out and shifts the rescue weight
> onto the module-vs-export-reachability analysis (see
> [ADR-0002](../docs/adr/0002-capability-based-hazard-model.md) and
> [CONTEXT.md](../CONTEXT.md)).

Class 2 is the crux. **Production dependency trees routinely contain modules
that reconstruct `require` (or call it with a runtime string) specifically to
load packages by name at runtime.** When such a module is in the traced graph,
a sound analysis genuinely *cannot* prove any third-party export unreachable —
the reconstructed `require('anything').anyExport()` is a real, if opaque, call
path. The global widening is therefore **well-founded, not merely
conservative.**

## Soundness bugs found and fixed (adversarial round)

Two confirmed soundness defects, both **pre-existing** in the spike, surfaced by
adversarial attack agents and fixed with regression fixtures:

1. **Overwritten CJS export key** (`fixtures/adv-cjs-overwrite`):
   `exports.x = f1; require(cycle reads .x → f1); exports.x = f2; exports.legacy = f1`.
   The `rawExports` map collapsed `x` to its last value, so `f1` looked
   reachable only through the unused `legacy` alias and was stubbed — but a
   require cycle observed `exports.x === f1` at load and called it. Fix: any
   export name written more than once widens the surface (its intermediate
   value is observable through a cycle).

2. **ESM import-condition / require-condition divergence**
   (`fixtures/adv-esm-condition`): the analyzer resolves *all* specifiers,
   including ESM `import`s, with `createRequire().resolve()` (require
   conditions). For an `exports` map whose `./sub` differs by condition, usage
   was attributed to the require-condition file while Node's ESM loader ran the
   import-condition file, so a statically-imported, runtime-executed function
   was stubbed. Fix: a **resolution/trace consistency check** — NFT's traced
   set is the source of truth for what Node loads; any analyzer-resolved target
   NFT did not trace (compared on realpath, to ignore pnpm symlinks) retains
   the whole owning package (`resolver-trace-mismatch`) and emits a build
   warning. This also surfaces NFT under-tracing (a resolvable dep absent from
   the deploy tree) instead of silently shipping a broken tree.

The ESM false-conservatism fix itself (Step 2) is real: on a clean hazard-free
ESM fixture (`fixtures/adv-esm-named`) it takes an `export function` that was
previously un-stubbable to **41.6% incremental reduction vs NFT JS**. The
technique works — it is simply dominated by Gate 1 on real trees.

## Vulnerability-removal experiment (`fixtures/vuln-template`)

A prototype-pollution deep-merge (lodash-CVE class), localized to one API, in a
package that must remain. The full fail-closed chain holds:

- package `minilodash` stays in the deployment;
- the unaffected `get` API still works;
- `merge`'s implementation bytes are physically absent (throwing stub);
- invoking `merge` throws `ReducerReachabilityViolation` (fails closed) —
  the prototype is **not** polluted;
- the manifest + `benchmarks/vex.ts` emit a VEX `not_affected /
  vulnerable_code_not_present` record with source range and input/output hashes.

**Caveat:** this works only because the fixture tree is hazard-free. In a real
tree containing a Class-2 hazard (e.g. `optional-require`), the same vulnerable
function would be retained — the security angle is gated by the *same* global
hazard problem, not independent of it. A code-gen vulnerability like lodash
`template` is doubly blocked: its own `new Function` is itself a global hazard.

## Assessment against the decision criteria

- Strong signal (≥20% median incremental vs NFT): **not met** (0%).
- Conditional signal (10–20% + strong security evidence): **not met** —
  reduction is 0% and the security evidence is gated by the same hazard.
- **Negative signal: met.** <10–15% median incremental reduction beyond NFT,
  and useful reduction would require either unsafe assumptions or solving the
  dynamic-module-loading problem the invariant explicitly refuses to guess at.

The 0% is close to a **semantic ceiling** for whole-application conservative
stubbing, not an engineering gap — because real trees contain modules that can
load arbitrary packages by name at runtime.

## Highest-information-value next investment

A subsequent design session (captured in [CONTEXT.md](../CONTEXT.md) and
[docs/adr/0002](../docs/adr/0002-capability-based-hazard-model.md),
[0003](../docs/adr/0003-non-transforming-analyzer-first.md)) generalized the
"constant-foldability" idea below into a **capability-based hazard-domain
analyzer**, and that is the committed next build.

The original framing — *measure the static constant-foldability of the
reach-any-module sites (the deferred "Phase 6"): for every `require(<expr>)`,
`eval("require")`, and non-literal `import()`, can its targets be soundly bounded
to an enumerable set?* — remains the core question, but three corrections from
the design review reshape it:

1. **Model capabilities, not syntax.** A site is dangerous by what
   module-loading capability its execution context can obtain and flow to a load
   sink, not by being `eval`/`Function`. On Node 24 even global-scope generated
   code reaches `process.getBuiltinModule → createRequire`, so the naïve
   `new Function` carve-out is unsound (see the correction above).

2. **Separate module reachability from export reachability.** An unbounded
   `require(x)` proves modules *may* initialize; it does **not** prove every
   export is invoked. If the returned value's property projection is statically
   bounded and its export surface is closed (no Proxy/getter/computed/escape,
   with module identity unified across all sites), symbol-level reduction may be
   recoverable *even when the target module domain stays broad*. This is now the
   primary rescue lever — potentially removing the need to solve dynamic module
   resolution perfectly.

3. **Measure before transforming, with counterfactual marginal headroom.** The
   analyzer transforms nothing; it reports the strict predicted ceiling (the
   kill metric), per-approximation and pairwise marginal headroom (approximations
   interact, so this is not causal attribution), and per-symbol blocking-sets —
   so the go/no-go and the what-to-build-next both read off data before any
   transform exists.

Kill criterion unchanged: if the strict ceiling stays below ~10–15% median
incremental reduction, the whole-app size thesis is dropped; the
vulnerability-removal wedge continues regardless (subject to the same hazard
analysis, per the caveat above). Ground truth for the whole model will be the
Reducer Oracle / Torture Garden.
