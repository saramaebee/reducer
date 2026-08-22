# Non-transforming hazard-domain analyzer first, gated by a kill criterion

The next build is a hazard-domain analyzer that transforms *nothing*: it
computes capabilities, resolved-target and property domains, and
module-vs-export reachability, and reports the **strict predicted ceiling**
(the incremental reduction achievable under the fully-conservative model),
the **counterfactual marginal headroom** per approximation (single-relaxation
and top pairwise deltas — marginal, not causal, because approximations
interact), and per-symbol **blocking-sets**.

We chose measure-before-transform because the calibration returned 0% on real
apps and the open question is whether *sound* capability scoping can lift that.
The analyzer answers it without the cost and risk of building a transform:
if the strict ceiling stays below ~10–15% median incremental reduction, the
whole-app size thesis is dropped (the vulnerability-removal wedge continues
regardless); if it clears, the marginal-headroom ranking says exactly which
approximation (VM, unbounded specifiers, escaped surfaces, generated source) to
engineer next. Each coarse approximation (VM especially) is modeled as
maximally loader-capable but with its blocked reduction measured separately, so
a deliberately pessimistic default cannot silently kill the thesis.
