# @reducer/conservative-runtime-guard

Never implemented — deliberately (Phase 13 said "only after the static spike
works"), and retired with the conservative-linker branch (ADR-0007) before
that condition was met. Kept because the `module.registerHooks()` sketch below
is the natural interception point if the dependency-virtualization experiment
ever needs runtime hydration.

Planned shape:

- `node --import @reducer/runtime dist/server.js`
- Uses stock Node `module.registerHooks()` to verify each resolved module
  against `reducer-manifest.json`.
- Fails closed on any module load not present in the analyzed runtime graph.
- Never fetches or restores deleted code.
- Optional: reduced artifacts must remain runnable with stock `node`
  (verified today by the fixture tests, which run under plain `node`).
