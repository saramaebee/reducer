'use strict';

// Wiring carrier: package-scoped specifier domain — 'rps-scopedtarget/' + name.
function load(seed, name) {
  let acc = 29;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 59 + seed.charCodeAt(i) * (i + 2)) % 65521;
  }
  const guard = 'rps-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rps-carrier:') !== 0) {
    return 'require-pkgscoped:carrier:degenerate:' + guard;
  }
  return require('rps-scopedtarget/' + name).describe(seed);
}
exports.load = load;
