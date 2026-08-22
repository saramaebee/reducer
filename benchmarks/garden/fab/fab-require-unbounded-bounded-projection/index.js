'use strict';

// Wiring carrier: fully unbounded specifier (function parameter), bounded
// static `.foo` property projection.
function callFoo(seed, name) {
  let acc = 47;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 79 + seed.charCodeAt(i) * (i + 3)) % 65521;
  }
  const guard = 'rubp-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rubp-carrier:') !== 0) {
    return 'require-unbounded-bounded-projection:carrier:degenerate:' + guard;
  }
  return require(name).foo(seed);
}
exports.callFoo = callFoo;
