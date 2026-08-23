// garden fab-eval-constant-capable: constant source, no unbindable free id,
// but the loaded value's use is decided inside a program whose completion
// value flows back to this scope.
const out = eval("require('victim').go()");
console.log(out);
