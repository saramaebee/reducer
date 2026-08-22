# @reducer/runtime-guard

Not implemented in the vertical slice — deliberately (Phase 13 says "only
after the static spike works").

Planned shape:

- `node --import @reducer/runtime dist/server.js`
- Uses stock Node `module.registerHooks()` to verify each resolved module
  against `reducer-manifest.json`.
- Fails closed on any module load not present in the analyzed runtime graph.
- Never fetches or restores deleted code.
- Optional: reduced artifacts must remain runnable with stock `node`
  (verified today by the fixture tests, which run under plain `node`).
