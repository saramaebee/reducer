// SR-F6. Constant code, object-literal context, no loader-like key — the exact
// evidence SR-vm-known-globals was defined to admit — and it loads `victim`
// anyway: the context object is a HOST-realm object, so `this.constructor` is
// the host `Object` and `Object.constructor` is the host `Function`.
// The refinement is withdrawn as not-soundly-definable; it must admit nothing.
const vm = require('vm');
const out = vm.runInNewContext(
  "const P = this.constructor.constructor('return process')();" +
    "const M = P.getBuiltinModule('module');" +
    "const req = M.createRequire(P.cwd() + '/app.cjs');" +
    "req('victim').run();",
  { safe: 1 },
);
console.log('loaded victim ->', out);
