# Reducer

A conservative Node.js production linker. It proves third-party code
unreachable and physically removes it, never guessing: proven reachable,
possibly reachable, and unknown all mean KEEP; only proven-unreachable may be
removed. Its analysis is organized around *which module-loading capabilities
can flow to which reachable code, with what target and property domains* —
not around dangerous-looking syntax.

## Language

### Capability analysis

**Capability**:
A concrete module-loading power a piece of code can hold — CJS lexical
`require`, `module` / `module.require`, `createRequire`, `process.getBuiltinModule`,
loader internals, dynamic `import()`, or a loader injected into a `vm` context.
Danger is measured by capability held, not by syntax used.
_Avoid_: hazard-type, dangerous-call

**Capability factory**:
A capability that yields another capability rather than loading directly, e.g.
`process.getBuiltinModule` → `node:module` → `createRequire` → a loader. The
chain is kept visible; it is never collapsed to a single boolean.

**Execution context**:
The scope a piece of code runs in, which determines the capabilities it starts
with or can acquire. CJS module scope holds `require`/`module`; direct `eval`
inherits its caller's lexical capabilities; `Function`/indirect eval hold no
lexical `require` but retain global capabilities (so unknown generated source
is reach-any); a `vm` context holds only what the host supplied.

**Capability flow**:
The monotonic taint tracking of a capability-bearing value through aliasing,
destructuring, arguments, returns, closure capture, and container storage.
Distinct from module-object escape tracking, though it reuses that framework.

**Escaped-loader**:
A flow *state*, not a capability: a loader-capable value has crossed a boundary
the analyzer cannot model, so its subsequent use is unbounded.

**Load sink**:
A site that turns a capability plus a specifier into a loaded module —
`require(x)`, `import(x)`, a reconstructed require, `createRequire()(x)`, etc.
_Avoid_: require-call, import-site

**Specifier domain**:
The static domain of a load sink's *specifier expression*:
`exact ⊑ finite ⊑ package-scoped ⊑ unbounded`. Widens monotonically on any
doubt.

**Resolved-target domain**:
The specifier domain after resolving to actual module *identities*, unifying
specifiers that Node's require cache would resolve to the same instance.

### Reachability

**Module reachability**:
Whether a module's initialization can run. An unbounded load sink proves
modules *may* initialize — it does not by itself prove any particular export is
invoked.

**Export reachability**:
Whether a specific exported value can be invoked. Narrowable below module
reachability only for a statically closed export surface whose module identity
is accounted for across all load sites.

**Property projection**:
The observable property read applied to a loaded module value (`require(x).foo`).
It authorizes narrow export reachability only under ordinary property
semantics; a Proxy, getter, `setPrototypeOf`, computed key, deferred write, or
escape defeats it.

**Export-surface confidence**:
Whether a module's export surface is statically closed (every export name and
backing value known) and therefore safe to reason about at symbol granularity.

**Module-identity unification**:
The requirement that all load sites resolving to the same cached module
instance be reasoned about together; a broad use at one site invalidates a
narrow conclusion drawn at another.

### Artifact model

**Production universe**:
The complete production application filesystem Reducer considers: app runtime
files plus every installed package the lockfile does not mark dev-only. The
set of files *eligible to exist* in the output. Within it, omission requires
proof.

**Known reachable set**:
Positive reachability evidence — NFT-traced files plus Reducer's own
analysis. Evidence that a file *must* ship, never evidence that another file
may be dropped.

**Proven unreachable set**:
Files/code for which Reducer holds an explicit unreachability proof. The only
set physical removal may draw from: `output = production universe − proven
unreachable`. NFT omission is not a proof.
_Avoid_: untraced, not-needed

### Measurement

**Net size reduction**:
The primary size metric: the net change in executable third-party JS bytes
between the production universe and the emitted artifact, relative to the
universe. May go negative (a fail-closed stub larger than the body it
replaced counts against it). Distinct from *implementation bytes eliminated*,
the security/precision quantity. NFT-relative deltas are context, never the
metric.
_Avoid_: bytes removed, Δ-vs-NFT (as the metric)

**Strict predicted ceiling**:
The net universe-relative size reduction the non-transforming analyzer
predicts under the current, fully-conservative model. The go/no-go metric,
decided on the median over target-category corpus apps.

**Gate-off counterfactual**:
The additional reduction that becomes possible if one conservative gate (or a
pair) is switched off while all others stay conservative. A *diagnostic upper
bound conditional on the other gates remaining conservative* — because gates
interact, two single-gate zeros can coexist with a large pairwise gain. Can
disfavor or kill an investment; can never rescue the thesis.
_Avoid_: relaxed approximation (as a rescue)

**Sound refinement counterfactual**:
The predicted ceiling under a *named* refinement with stated proof
obligations (e.g. VM contexts with statically known globals; closed export
surface plus known property projection). The only counterfactual that can
rescue the thesis, and only when the refinement is single, localized,
soundly-definable, and plausibly implementable. Its number is an upper bound
until the refinement is implemented: a strict 0% that a qualifying refinement
lifts to 25% means "implement that refinement," not "stop."

**Blocking-set**:
The set of approximations jointly responsible for retaining one symbol, e.g.
`{dynamic-loader, vm, open-export-surface}`.

**Hazard-domain analyzer**:
The non-transforming tool that computes capabilities, domains, and reachability
and reports the strict ceiling, marginal headroom, and blocking-sets — without
removing anything.

### Oracle

**Reducer Oracle / Torture Garden**:
A real HTTP service that is an executable specification of the semantic model:
every capability, domain tier, reachability case, safety gate, retention
reason, and vulnerability-removal case has an endpoint, with ground truth
declared by construction.
_Avoid_: test app, fixture server

**MUST_RETAIN / MUST_REMOVE / MUST_RETAIN_CONSERVATIVELY**:
By-construction ground-truth labels on every oracle symbol. The third means
the symbol is possibly reachable and must be kept *even though no test invokes
it*, because static evidence is insufficient.

**Mutation-sensitivity**:
The check that an endpoint actually detects a symbol's semantics — mutate the
symbol in the original app and confirm the endpoint fails. Without it, a
passing reduced-app test proves nothing.

**Attack surface**:
A named set of exported functions carrying a known vulnerability. Not a removal
primitive — the removable unit stays the exported function; the set is an
aggregation reported in the manifest and VEX evidence.
