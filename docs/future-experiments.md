# Future experiments (pinned, not planned)

Durable pointers to experiments worth running later. Entries are *pins*, not
plans — no scope, tasks, or design until one is picked up.

## FE-1 — The sound-island hypothesis for the vulnerability-removal wedge

**Status:** open. Named by the ADR-0006 first-run decision
(`benchmarks/hazard-domain/first-run/DECISION.md`, 2026-08-23) as the single
next action with the highest information value. Not started.

**Motivation.** The hazard-domain first run retired the whole-app size thesis:
strict target median 0.0%, no sound-refinement or gate-off headroom, because one
reach-any-module capability anywhere in the reachable app conservatively widens
the whole production universe. The frozen CVE table inherited that saturation and
reported 0/24 removable — but it measured *whole-app* reachability, so 0/24 is a
foregone conclusion, not evidence about the wedge.

**Hypothesis.** A vulnerable symbol can sit in a *local reachable sub-closure
that is itself free of reach-any capabilities*, even when the app as a whole is
saturated by hazards elsewhere. Whole-app 0% is a property of a byte-sum metric
(one distant hazard poisons the total); reachability of one specific symbol is a
narrower question — a hazard only matters if capability flow or a load path
actually reaches that symbol. Most loading in the corpus is already exact-tier
(~294k of ~300k sinks); only a small set of reach-any sinks force the widening,
and their *conservative* "targets = all universe" default is not a proof they can
reach any given package.

**What it would decide.** Per frozen CVE symbol, scoped to that symbol's
neighborhood rather than the whole universe: (1) can any reach-any sink actually
resolve to its package under a real bound; (2) is it reached only via
exact/finite/static edges; (3) does its module value escape. A symbol clearing
all three is a sound island → strictly removable → a genuine VEX candidate
despite the app's 0%. Islands exist for a meaningful fraction → the wedge has a
technical future on the per-vulnerability unit (different product, same engine);
no islands → the wedge dies for the same reason the size thesis did. Either way
it is a clean answer.

**Constraints when picked up.** Non-transforming, read-only, sound
(uncertainty widens); reuse the existing capability-flow and resolved-target
machinery scoped to one symbol; frozen corpus/CVE/garden inputs immutable; if
run as a fresh measurement, follow the same preserve-before-refine chronology.
