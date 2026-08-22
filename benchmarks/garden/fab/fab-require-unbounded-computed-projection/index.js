'use strict';

// Wiring carrier: unbounded specifier AND computed property projection.
function call(seed, name, k) {
  let acc = 61;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 97 + seed.charCodeAt(i) * (i + 5)) % 65521;
  }
  const guard = 'rucp-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rucp-carrier:') !== 0) {
    return 'require-unbounded-computed-projection:carrier:degenerate:' + guard;
  }
  return require(name)[k](seed);
}
exports.call = call;
