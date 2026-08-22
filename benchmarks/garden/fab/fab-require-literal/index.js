'use strict';

// Wiring carrier: the load sink is the exact-literal require below with a
// bounded `.used` member projection. The manifest symbols live in rl-target.
function used(seed) {
  let acc = 7;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 33 + seed.charCodeAt(i)) % 65521;
  }
  const guard = 'rl-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rl-carrier:') !== 0) {
    return 'require-literal:carrier:degenerate:' + guard;
  }
  return require('rl-target').used(seed);
}
exports.used = used;
