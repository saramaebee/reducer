// RES-F1. `dual` has NEITHER a literal `import`+`require` pair, so the old
// divergence test saw nothing — yet the require order matches `node` (cjs.js) while the import order matches the earlier `import` key (esm.mjs).
// Node runs esm.mjs; createRequire().resolve answers cjs.js.
(0, eval)("import('dual').then(m => console.log(m.hello()))");
