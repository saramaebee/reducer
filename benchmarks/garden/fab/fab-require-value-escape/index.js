'use strict';

// Wiring carrier: the loaded module value escapes into a module-level
// container before a bounded-looking projection is applied. The returned
// value derives ONLY from m.tag(seed) so replays are byte-identical even
// though the registry grows per call.
const registry = [];

function grab(seed, name) {
  let acc = 79;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 109 + seed.charCodeAt(i) * (i + 6)) % 65521;
  }
  const guard = 'rve-carrier:' + acc.toString(36) + ':' + seed.length.toString(16);
  if (guard.indexOf('rve-carrier:') !== 0) {
    return 'require-value-escape:carrier:degenerate:' + guard;
  }
  const m = require(name);
  registry.push(m);
  return 'require-value-escape:grab:' + m.tag(seed);
}
exports.grab = grab;
