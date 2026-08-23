// RES-F9 (loader symmetry). `native` ships a `.node` addon, which runs IN-REALM:
// it can reach `process`, rebuild `require`, and load anything. That is a
// strictly stronger boundary than `vm`, which the strict model already treats as
// maximally loader-capable — so a reachable module in an opaque package must
// contribute a module-level Unbounded sink too, gated on `native-boundary` so
// its cost stays measurable.
require('native');
