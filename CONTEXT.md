# Reducer

Node.js dependency research: a completed conservative production-linker
experiment (proving third-party code unreachable; ADR-0001–0006) and a
completed dependency-virtualization direction (predicting a recoverable local
working set; ADR-0007, experiments 1–5, performance wedge closed 2026-08-24).
The capability vocabulary below was built for the conservative branch but
describes shared analysis primitives — it feeds both future planners and the
dormant sound-island probe (FE-1). The chronology is in
`docs/RESEARCH-NARRATIVE.md`; the product framing behind experiments 3–5 is in
`docs/PROBLEM-CONTEXT.md`.

## Language

### Working-set virtualization (ADR-0007)

**Placement**:
Whether a production-universe file is locally materialized (**HOT**) or
recoverable byte-for-byte from immutable storage (**COLD**). Placement is what
prediction decides; availability is what it must never decide.

**Hydration miss**:
A runtime request for a COLD file: the exact original bytes are materialized,
then stock Node semantics proceed. The cost of a wrong prediction — latency,
never semantic divergence.
_Avoid_: cache miss (ambiguous), failure (it isn't one)

**Forced-hot**:
A file HOT for a stated reason (positive evidence, entrypoint, resolver
metadata, an unsafe-to-virtualize boundary, a hazard signal) rather than by
prediction confidence.

**Candidate-cold**:
A file the planner predicts is not in the initial working set. Explicitly not
a reachability claim — the conservative branch retired those at whole-app
scope.

**Hydration curve**:
Hot-set fraction as a workload progresses (initial → startup → common
requests → full workload). The decision metric for building a real recovery
runtime.

### Traffic-warm experimentation (ADR-0007 experiments 3–5)

Experiments 3 (`benchmarks/lazy-oci/`), 4 (`benchmarks/longtail/`) and 5
(`benchmarks/costaware/`) measured whether semantic placement makes a new
replica serve production traffic sooner than commodity lazy loading. The
vocabulary below is theirs; the formal definitions are in each experiment's
`DESIGN.md` (sections cited). The product reason the metric is *time to
traffic-warm* rather than image size is recorded in `docs/PROBLEM-CONTEXT.md`.

**Wedge** (two senses — always qualify which):
1. *Vulnerability-removal / VEX wedge* (ADR-0004, ADR-0006, FE-1): soundly
   neutralizing one specific vulnerable code path so a VEX
   `vulnerable_code_not_present` claim is demonstrable. Status: unresolved at
   the per-vulnerability unit (FE-1); dead at the whole-app unit.
2. *Semantic-prewarming performance wedge* (experiments 3–5): Node semantics
   causing materially faster traffic readiness than generic trace locality.
   Status: **closed** (experiment 5, ADR-0007 §Decision).
_Avoid_: "the wedge" unqualified.

**Lazy OCI / lazy artifact**:
A container image whose files are fetched from an immutable blob on demand
(Nydus, eStargz, SOCI) rather than pulled in full before start. Experiments
3–5 use Nydus because its prefetch input is an arbitrary ordered file list —
the shape of a placement plan — and it exposes per-file telemetry. The
complete image is always present; only *residency* varies.

**Prefetch / prewarm**:
Fetching a chosen set of files from the immutable blob into local residency
before or while the application starts. "Prewarm" is the experiment-4/5 term;
"prefetch" is the substrate's. Same operation.

**Arm**:
One experimental condition — a fixed placement/prefetch strategy deployed on
the otherwise content-identical image. Arm labels are experiment-specific and
are reused with different meanings; see the concordance below.

**Eager / eager reference (B0, E0)**:
The `docker pull`-then-run analogue: prefetch everything, admit traffic only
when the whole image is resident. The baseline every lazy arm is compared to,
and the source of the steady-state band.

**Timeline** (`longtail/DESIGN.md` §5):
```text
T0          container start — the instant the image is asked for
t_proc      the application process is exec'd
t_ready     the application's own readiness predicate passes (Kubernetes Ready)
t_prewarm   the substrate reports the arm's permitted prewarm complete
T_traffic   = max(t_ready, t_prewarm)   — traffic is admitted here
T_steady    steady-state latency established (below)
```
The application process starts concurrently with prewarm, as a kubelet does.

**Time to traffic-warm / primary metric**:
`T_steady − T0`, in seconds. Not `t_ready − T0`: a strategy that reports
Ready earlier by pushing work onto production requests has not won.
`t_ready` is recorded as a diagnostic only.

**Steady-state `BAND`** (`longtail/DESIGN.md` §8.3):
A p99 latency threshold in milliseconds, derived from measurement rather than
chosen: the worst rolling-window p99 (window 100 requests, step 20) that a
fully-warm eager pod produced on its *second* pass, across all eager families.
`T_steady` is the completion time of the earliest window after which every
later window's p99 stays ≤ BAND. Sensitivity variant `BAND'` = median + 3×MAD.
Frozen from eager trials before any strategy trial was analysed.

**Traffic-warm** (`longtail/DESIGN.md` §8.4, preregistered):
An arm is traffic-warm at a budget iff *every* post-admission window's p99 is
≤ BAND — equivalently `T_steady = T_traffic`, warm on arrival. Measured, this
target was unreachable by the eager arm itself (cold-pass V8 warm-up), which
is why the eager-matched criterion was added.

**Eager-matched** (`longtail/DESIGN.md` Amendment A4, added post-trial and
recorded as such):
An arm is eager-matched at a budget iff its median worst post-admission
window p99 is ≤ the worst such value the eager arm itself produced across its
families. The answerable form of traffic-warm; both are reported.

**Prewarm budget**:
How much an arm is allowed to prefetch before admission. Experiment 4 charged
budgets in **universe file bytes** (5 / 10 / 20 / 40 %); experiment 5 charged
them in **measured prewarm seconds** because an equal byte budget proved not
to be an equal time budget.

**Budget rung** (`costaware/DESIGN.md` §8.1):
One point on experiment 5's preregistered per-app ladder of prewarm-time
budgets, e.g. strapi 2 / 4 / 8 / 14 / 22 s. "Rising to 1.00 within three
rungs" means by the third budget level.

**Retrieval unit** (`costaware/DESIGN.md` §4.1):
A maximal run of consecutive chunks in the image blob whose compressed span
does not exceed nydusd's `merging_size` — exactly what the substrate turns
into one backend HTTP Range request. Units partition the chunk axis, depend
only on the image, and are identical for every arm. Median compressed chunk
≈ 500 B, so one unit holds tens of files.

**Minimal chunk cover** (`costaware/DESIGN.md` §7.3):
The prefetch manifest form used by every experiment-5 arm: one covering file
per distinct chunk, in ascending chunk order. Avoids nydusd emitting a
descriptor per (file, chunk) pair, which breaks range merging (measured:
164 requests / 3,832 ms vs 13 requests / 593 ms for the same bytes).

**Physical retrieval cost** (`costaware/DESIGN.md` §5):
`prewarm ms ≈ fixedMs + α·backend requests + β·backend bytes`, with requests
and bytes derived from a chunk set via `gapBridge` and `maxRange`. All five
parameters fitted from probes on the deployed images (R² 0.998, 11 % MAPE),
never chosen. Requests, not bytes, dominate.

**Cost-aware ranking (G1C, R1C)** (`costaware/DESIGN.md` §7.1):
Greedy selection of whole retrieval units by `unitValue / unitCost`, where a
file's value is `1 / (1 + rank)` in the arm's frozen ranking. Converts "many
small scattered files" into "few large contiguous reads" identically for
either prediction source.

**Cost-unaware ranking (G1, R1 in experiment 5)** (`costaware/DESIGN.md` §7.2):
The longest prefix of the same ranking whose predicted cost fits the same
time budget. Same value, same cost model, no reordering — the control that
isolates what cost-awareness changed.

**Physical oracle (O)** (`costaware/DESIGN.md` §10.3):
The held-out TEST workload's first-touch set, mapped onto chunks and priced
with the cost model. Analysis only, never deployed. Separates minimum
*logical* bytes from minimum *physical* cost — and showed exact prediction
costing more than contiguous overfetch.

**Overfetch**:
Content prefetched that the workload never touches. Under the cost model,
cheap contiguous overfetch is frequently better than exact scattered
retrieval ("precision is a liability").

**Resident set**:
The files actually present locally after prewarm — every file all of whose
chunks were fetched. The resident-set Jaccard overlap between two arms is how
experiment 5 showed the generic and semantic plans converging.

**Traffic-ready working set**:
The resident set an arm needs so that admitted traffic meets the steady-state
criterion. The quantity experiments 4–5 asked semantics to predict better than
a trace; it did not.

**TRAIN / TEST workloads**:
TRAIN is the workload whose filesystem-access trace generic arms may learn
from. TEST (held-out / long-tail) is never visible to any deployable arm;
only the oracle sees it.

#### Arm concordance

Labels are per-experiment. A "ranking" is a total order over the universe
that a budget truncates; a "set" is fixed.

| exp | arm | what it is | knows TRAIN? | knows Node semantics? |
| --- | --- | --- | --- | --- |
| 3 | **A1** | full eager universe, all files present | — | — |
| 3 | **A2** | closed `@vercel/nft`-traced slim artifact — files outside the trace *do not exist*; the Next.js `output:"standalone"` strategy | — | — |
| 3 | **A3** | complete lazy image whose initial residency is exactly the A2 set; same placement, recoverable | — | — |
| 3 | **B0** | eager: `prefetch_all`, start blocked until everything is resident | — | — |
| 3 | **B1** | generic lazy: no prefetch at all, substrate default | — | — |
| 3 | **B2** | generic trace prefetch: TRAIN content-read files, first-access order | ✓ | — |
| 3 | **B2d** | B2 plus one-level (non-recursive) directory expansion, TRAIN order | ✓ | — |
| 3 | **B3a** | static Reducer: the Plan B HOT set (NFT-positive ∪ entrypoint ∪ every `package.json` ∪ opaque-boundary packages), NFT-graph depth-first order | — | ✓ |
| 3 | **B3b** | Reducer + TRAIN: TRAIN files ∪ every `package.json` ∪ NFT-positive files of packages TRAIN touched; package-major order | ✓ | ✓ |
| 4 | **E0** | eager reference (as B0) | — | — |
| 4 | **G1** | ranking: TRAIN trace in first-access order, then everything else lexicographic (no further signal by design) | ✓ | — |
| 4 | **G2** | ranking: TRAIN trace, then every other file by directory-tree distance to the nearest TRAIN-touched directory, anchor time, ascending size. Distance 0 = B2d. The strongest generic widening | ✓ | — |
| 4 | **R1** | ranking, no workload evidence: entrypoint → every `package.json` → NFT-positive files (graph order) → Plan B opaque boundaries → rest of graph-live packages → declared-dependency hops → remainder. B3a's set re-expressed as a total order | — | ✓ |
| 4 | **R2** | ranking: TRAIN trace → every `package.json` → NFT-positive files of TRAIN-touched packages → rest of those packages → NFT-positive files of other packages → declared-dependency hops → remainder. B3b's idea as a total order | ✓ | ✓ |
| 4 | **O** | oracle: the TEST first-touch set, analysis only | (TEST) | — |
| 5 | **E0** | eager reference (as above) | — | — |
| 5 | **G1** | generic, cost-**unaware**: experiment 4's frozen **G2** ranking (not G1's — G1's remainder carries no signal), longest prefix fitting the time budget | ✓ | — |
| 5 | **G1C** | generic, cost-**aware**: same G2 ranking, cost-aware unit selection | ✓ | — |
| 5 | **R1** | semantic, cost-**unaware**: experiment 4's frozen **R1** ranking, longest prefix fitting the time budget | — | ✓ |
| 5 | **R1C** | semantic, cost-**aware**: same R1 ranking, cost-aware unit selection | — | ✓ |
| 5 | **O** | physical oracle: TEST first-touch set priced with the cost model, analysis only | (TEST) | — |

Reuse across experiments: experiment 4's R1 ranking is experiment 3's B3a
placement made total; experiment 5 loads experiment 4's preserved `R1` and
`G2` rankings verbatim as its semantic and generic value inputs. Experiment
5's "G1" is therefore experiment 4's G2 by content, and experiment 5's "R1"
is experiment 4's R1. Headline comparisons: exp 3 `B3b vs max(B2, B2d)`;
exp 4 `R2 vs best(G1, G2)` (R1 reported because it needs no training); exp 5
`R1C vs G1C`.

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
