# Capability-based hazard model, not syntax-based

Dynamic-loading danger is modeled by *which module-loading capabilities can
flow to which reachable code, with what target and property domains* — a
lattice of capabilities (lexical `require`, `module`/`module.require`,
`createRequire`, `process.getBuiltinModule`, loader internals, dynamic
`import()`, vm-injected loaders), a capability-flow taint analysis, resolved
specifier-target domains, and module-vs-export reachability — rather than a
flat list of dangerous syntax (`eval`, `new Function`, …).

We chose this because the syntax view is both unsound and too coarse. It is
unsound: on Node 24 `new Function` is *not* capability-free — global
`process.getBuiltinModule('module')` → `createRequire()` reconstructs a working
`require`, and `import()` is always available, so unknown generated source is
reach-any regardless of the absence of a lexical `require`. It is too coarse:
treating every dynamic site as globally reach-any forced 0% reduction on every
real app in the calibration, because one benign construct anywhere widened the
whole tree. The capability model lets a widening name the specific capability
and target/property domain that justifies it, which is the only basis on which
reduction can be both sound and non-trivial.

Deliberately excluded: a general whole-program call graph / interprocedural
taint. Propagation is demand-driven and shallow (non-escaping wrappers with
enumerable callers only); any doubt widens monotonically.
