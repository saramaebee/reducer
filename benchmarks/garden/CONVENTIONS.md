# Garden build conventions (binding for all fabricated packages)

Fabricated packages live at `benchmarks/garden/fab/fab-<id>/` and are copied
verbatim into `benchmarks/garden/app/node_modules/` by `tools/setup.ts`.
`MANIFEST.json` is the source of truth; these conventions make the packages
uniform enough for the generator, mutation harness, and scorer to operate on.

## Package shape

- `package.json`: `{ "name": "fab-<id>", "version": "1.0.0" }` plus
  `"type": "module"` for ESM packages and `"main"` pointing at the entry.
  **No `"exports"` field** (deep imports must stay possible for the red-team
  harness) — except where a mechanism explicitly requires an exports map
  (`resolver-trace-mismatch`).
- Nested dependency targets required by a mechanism live at
  `fab-<id>/node_modules/<name>/` with their own `package.json`. Nested
  package names must be globally unique across the garden — prefix them
  (e.g. `rl-target` inside `fab-require-literal`), because the reducer labels
  transformations by nearest-package name.
- No exports beyond the manifest's symbols plus wiring exports explicitly
  allowed by the package's build note. Every extra export pollutes the export
  surface under test.

## Function bodies

- **Every** function body ≥ 200 bytes between its braces, made of real,
  deterministic computation (string/arith transforms of the input). Never
  `Date`, `Math.random`, timers-for-values, locale, or env-dependent output.
- `MUST_RETAIN` symbols take one string argument (`seed`) and return a
  deterministic string derived from it, distinct per symbol (the endpoint body
  must depend on the real body — mutation sensitivity relies on this).
  Body is wrapped in mutation markers **inside** the braces:

  ```js
  export function used(seed) {
    /*<garden:static-basic:used>*/
    // ... >=200 bytes of deterministic computation ...
    return `static-basic:used:${acc}`;
    /*</garden:static-basic:used>*/
  }
  ```

  The mutation harness replaces everything between (and including) the marker
  pair with `throw new Error("GARDEN_MUTATED:<id>:<symbol>");`. Marker keys
  must be unique across the whole garden; exactly one pair per marked symbol.
- `MUST_REMOVE` symbols embed their manifest `sentinel` string **verbatim** as
  a string literal inside the body and use it in the (never-observed) return
  value. They must be genuinely unreachable by construction: no reference from
  any other code in the package, its nested deps, or the app.
- `MUST_RETAIN_CONSERVATIVELY` symbols need no markers and need not be invoked
  by any endpoint; they must be *possibly-reachable/unknown by the stated
  mechanism* — never invoke them via a plain static call that would make them
  trivially reachable and never reference them beyond what the mechanism
  states.

## Wiring contract (what each package hands the app generator)

For each package the builder reports (as structured output, not files):

- `importStmt`: the exact ESM import line for `app/server.mjs`, aliasing all
  imported names with a per-package prefix (e.g.
  `import { used as staticBasic_used } from 'fab-static-basic';`), or a
  side-effect import (`import 'fab-cjs-deferred-write';`) when nothing may be
  statically named.
- `routes`: for every `MUST_RETAIN` symbol, `GET /fab/<id>/<symbol>` with a
  synchronous or awaited expression producing its deterministic value from
  seed `"garden"`. Mechanism-driven exercise routes for conservative symbols
  are allowed **only** when the invocation goes through the stated mechanism
  and adds no static evidence beyond it.
- `mutationTargets`: file (repo-relative) + marker key per `MUST_RETAIN`
  symbol.
- `forceTargets`: per `MUST_REMOVE` symbol, an import specifier resolvable
  from the app root (deep imports into `node_modules` allowed) + export name,
  for the injected red-team module. The analyzed tree itself must never
  reference these.

## Runtime constraints

- The service (and thus every package's import-time behavior) must boot and
  respond deterministically under stock `node`, offline, no external services.
- Mechanisms that load modules dynamically at runtime must succeed in the
  ORIGINAL tree (targets exist); whether they survive reduction is exactly
  what the garden measures — never pre-widen or "help" the reducer.
