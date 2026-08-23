// RES-F2. `mid` is ESM and statically imports `dual`. Node resolves that edge
// under IMPORT conditions (dual/esm.mjs); createRequire().resolve answers the
// require branch (dual/cjs.js), and the divergence gate was never consulted for
// static edges at all — so esm.mjs, the file that really runs, looked dead.
require('mid-loader');
