// fab-require-cache-mutation: touching require.cache is a global hazard
// ('require-cache-mutation'). The carrier deliberately evicts rcm-target from
// the cache and re-requires it; rcm-target.stamp is PURE so replays are
// byte-identical even though the module re-initializes on every call.
'use strict';

function fresh(seed) {
  const key = require.resolve('rcm-target');
  if (typeof key !== 'string' || key.indexOf('rcm-target') === -1) {
    throw new Error('require-cache-mutation: resolve gave an unexpected key');
  }
  delete require.cache[key];
  if (require.cache[key] !== undefined) {
    throw new Error('require-cache-mutation: cache eviction did not take');
  }
  return require('rcm-target').stamp(seed);
}
exports.fresh = fresh;
