// r1/a01: the eval'd source calls an ALIASED loader. Resolved against the
// generated program's own (empty) scope, `r` is invisible.
const r = require;
const m = eval("r('victim')");
console.log(m.v());
