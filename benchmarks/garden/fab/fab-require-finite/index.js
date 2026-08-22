'use strict';

// Wiring carrier: finite two-literal ternary specifier domain {rf-a, rf-b}.
function run(seed) {
  let acc = 13;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 37 + seed.charCodeAt(i) * (i + 1)) % 65521;
  }
  const guard = 'rf-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rf-carrier:') !== 0) {
    return 'require-finite:carrier:degenerate:' + guard;
  }
  const m = require(seed.length % 2 === 0 ? 'rf-a' : 'rf-b');
  return m.run(seed);
}
exports.run = run;
