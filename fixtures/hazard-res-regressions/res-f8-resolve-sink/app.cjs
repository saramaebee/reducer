// RES-F8. `require.resolve` retains the target's BYTES without initializing it.
// `resolve-sink-retained` is unsuppressible, so no gate-off configuration —
// not even one that switches off the gate that made the specifier unbounded —
// may release victim/big.js.
eval("const p = require.resolve(process.env.NAME); console.log(p);");
