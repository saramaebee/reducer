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
The analyzer answers it without the cost and risk of building a transform, and
the marginal-headroom ranking says exactly which approximation (VM, unbounded
specifiers, escaped surfaces, generated source) to engineer next.

The kill decision is **not** the strict ceiling alone. Report the strict
predicted ceiling **and the best soundly-defined counterfactual ceiling**, and
decide on both:

- Strict ceiling **≥ ~10–15%** median incremental reduction → proceed.
- Strict **below** threshold **and** no sound counterfactual clears it → drop
  the whole-app size thesis (the vulnerability-removal wedge continues
  regardless).
- Strict **below** threshold **but** a *single localized, soundly-definable*
  approximation restores large headroom (e.g. strict 0% but precise VM modeling
  or the module-vs-export-projection rescue restores 25%) → that means
  **"implement and test that approximation," not "stop."** A deliberately
  pessimistic default (VM modeled as maximally loader-capable, etc.) must never
  silently kill the thesis; that is exactly why each approximation's blocked
  reduction is measured separately.

Only a low strict ceiling with no sound counterfactual headroom retires the
size thesis.
