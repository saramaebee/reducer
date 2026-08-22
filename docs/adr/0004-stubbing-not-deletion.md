# Removal is function-body stubbing, not declaration deletion

A proven-unreachable function is removed by replacing its *body* with a throw of
`ReducerReachabilityViolation`, preserving the declaration, arity, export
surface, and object shape; we do not delete the declaration/export outright.

We chose stubbing over deletion despite deletion yielding marginally fewer bytes
because it is both safer and more valuable. Preserving object shape means no
downstream `TypeError` on a missing property if reachability was
mis-analyzed-conservatively elsewhere, and the throw *fails closed* — for the
vulnerability-removal wedge a named exception is forensic evidence that
something tried to reach a removed vulnerable API, and it is what makes the VEX
`vulnerable_code_not_present` claim demonstrable. Deletion trades that for a few
bytes and real shape-breakage risk.
