// r1/a13: inside `with (o)`, `s` resolves to o.s at runtime, but babel still
// reports the outer const binding.
const o = { s: 'victim' };
const s = 'decoy';
with (o) { console.log(require(s).v()); }
