// r4/N17. A module-level unbounded sink (here: an escaped loader) is not just
// "some module may initialize" — the unmodeled holder of that loader can
// require anything and then call ANY export on the value it gets back. The
// fixture proves it: `passenger` is named at no load site the analyzer can
// see, yet it runs. Before the fix the file was retained while `passenger`
// was still predicted stubbable.
const container = { r: require };
globalThis.stash = container;
const v = require('victim');
console.log(v.v());
console.log(globalThis.stash.r('victim').passenger());
