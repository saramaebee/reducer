// r3/B5: Node runs a CJS module body inside the wrapper function
// `(exports, require, module, __filename, __dirname)`, so the module's
// top-level `arguments` object HOLDS the lexical loader. Before the fix
// `arguments[1]` was an untracked value and victim was predicted removable.
console.log(require('loader').boot('victim').v());
