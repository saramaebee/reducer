# reducer — conservative Node.js production-linker (technical spike)

Answers one question: **after NFT-style production tracing, how much additional
third-party JS can be *proven* unreachable and physically removed without
optimistic assumptions?**

```
Proven reachable   → KEEP
Possibly reachable → KEEP
Unknown            → KEEP
Proven unreachable → MAY REMOVE (function body → throwing stub)
```

A failure to discover a path is never treated as proof of unreachability.

## Usage

```bash
bun install
bun run reducer analyze fixtures/basic/app.mjs --verbose
bun run reducer build   fixtures/basic/app.mjs --out dist-reduced
bun test tests                 # pipeline + retention tests (fixtures run under stock node)
bun run bench basic            # A npm tree / B NFT / C esbuild / D reducer comparison
```

Options: `--format json`, `--verbose`, `--additional-root <file>`,
`--keep-package <name>` (both repeatable).

## Pipeline

```
entrypoints → @vercel/nft → traced file set → Babel AST module graph
→ conservative reachability verdicts → function-body stubbing
→ package-preserving deployment dir + reducer-manifest.json
```

Removal is **function-body stubbing only**: the body of a proven-unreachable
top-level function declaration is replaced with a throw of
`ReducerReachabilityViolation`. Declarations, exports, object shape and all
module-initialization side effects are preserved. Source maps are emitted for
transformed files. Every transformation is recorded in the manifest with
source range, reason and input/output hashes.

## What is proven safe (may lead to removal)

A third-party exported function is stubbed only when **all** gates pass
(see the header of `packages/analyzer/src/index.ts` for the authoritative list):

1. Zero global hazards across the entire traced JS set — any `eval`,
   `new Function`, non-literal `require()`/`import()`, **`require` (or
   `eval`/`Function`) referenced as a value** (`const r = require`),
   `require.cache` / `require.extensions`, an import of `node:module` /
   `node:vm`, an NFT warning, or a parse failure anywhere widens
   everything to `unknown`.
2. The module parsed cleanly and its full export surface was statically
   recognized (ESM static exports; CJS limited to top-level
   `exports.x = ident` / `module.exports.x = ident` /
   `module.exports = { literal keys }`). An export **name written more than
   once** (`exports.x = f1; …; exports.x = f2`) widens the surface — its
   intermediate value is observable through a require cycle.
3. The owning package contains no `.node` / `.wasm` boundary, and no
   dependency the analyzer resolved lands on a file NFT did not trace — a
   resolver/NFT disagreement (e.g. an `exports` map whose `import`/`require`
   conditions differ) retains the whole owning package (`resolver-trace-mismatch`)
   and emits a build warning.
4. Every importer NFT reports for the module is a file we parsed *and*
   whose imports of the module we recognized (workers and asset-style
   references fail this gate and force retention).
5. No importer lets the module object escape: namespace / default / require
   bindings may only be used via static property access or recognized
   destructuring; aliasing is followed; reassignment, computed access,
   rest-destructuring, mutation, or any other use ⇒ whole surface retained.
6. The function's name is not in the union of statically used names.
7. The function is a top-level `FunctionDeclaration` with no references
   inside its own module other than recognized export plumbing
   (internal calls, init-time calls ⇒ retained).
8. **Every** export name backed by the same local function is itself proven
   unreachable — one reachable *or merely-retained* alias (including
   `export default fn` / `export { fn as default }`) retains the shared
   implementation (`shared-implementation`). Chained writes
   (`exports.a = exports.b = fn`) are refused recognition entirely (gate 2
   fails). "Export plumbing" is an exact shape match (the
   `export function f() {}` declaration itself, `export { f }` specifiers,
   `export default f`, `exports.x = f` right-hand sides, and
   `module.exports = { x: f }` property values) — a reference *inside*
   another export's initializer (`export const wrapped = () => impl()`)
   counts as internal use and retains.

Every one of these gates exists because an adversarial fixture or review
demonstrated the unsound alternative; `fixtures/adv-*` are the regressions.

Note on metrics: for very small functions `bytesRemoved` can be negative —
the throwing stub is larger than the removed body. That is reported as-is.

## What is conservative (always retained, with a recorded reason)

Dynamic property access with non-literal keys, escaped module values,
re-exports (`export *`), namespace re-exports, computed/conditional/mutated
CJS exports, getters/`Object.defineProperty`, unused non-function exports,
default exports, class/const exports, packages with native or WASM files,
anything NFT includes for a reason we can't tie to a recognized static
importer, and *everything* when a global hazard exists. Reasons appear
per-symbol in `manifest.unknowns` / `manifest.verdicts`.

## What is unsupported (out of scope for the slice)

Whole-declaration/export deletion, interprocedural escape refinement,
constant-folded dynamic require paths (Phase 6), the runtime guard
(Phase 13 — see `packages/runtime-guard/README.md`), `--keep-file` globs,
TypeScript sources (compiled JS is the authoritative input).

## Assumptions

- Import specifiers are resolved with `createRequire(importer).resolve(...)`
  (Node's own resolver, not a reimplementation); a resolution mismatch with
  what NFT traced fails gate 4 and therefore retains.
- Metrics count executable JS bytes; emitted `.map` files are excluded from
  the primary metric.
- Analysis runs under bun; reduced artifacts are executed and tested under
  stock `node` (the target runtime).

## Layout

```
packages/{cli,tracer,analyzer,transformer,manifest,runtime-guard}
fixtures/    basic (reduction), dynamic-access + escape (retention), adv-* (adversarial)
benchmarks/  esbuild baseline comparison
tests/       bun test suite; fixture tests execute under stock node
```
