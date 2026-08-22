// Module-identity unification: two specifiers resolve to the SAME cached module
// instance. Site A (callFoo) uses a narrow projection (.foo). Site B, below,
// pulls the SAME file through a different specifier and lets the module object
// escape into an unmodeled container — which invalidates A's narrow conclusion,
// so the whole iu-target surface must be retained ("*").

const registry = [];

// Site B: different specifier, same resolved file; the module object escapes as
// a call argument into an unmodeled container.
const escapedTarget = require('iu-target/index.js');
registry.push(escapedTarget);

// Site A carrier: narrow projection over the same cached module.
function callFoo(seed) {
  const s = String(seed);
  const primes = [2, 3, 5, 7, 11, 13, 17];
  let acc = 91;
  for (let i = 0; i < s.length; i++) {
    acc = (acc * primes[i % primes.length] + s.charCodeAt(i)) >>> 0;
  }
  const tag = acc.toString(16).slice(0, 8);
  const projected = require('iu-target').foo(seed);
  return `identity-unification:callFoo:${tag}:${projected}`;
}
exports.callFoo = callFoo;

// Passenger: unreferenced; retained by the identity-unification hazard.
function ledger(seed) {
  const s = String(seed);
  let a = 17;
  let b = 31;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = (a + c) % 65521;
    b = (b + a) % 65521;
  }
  const sum = ((b << 16) | a) >>> 0;
  return `identity-unification:ledger:${sum.toString(36)}`;
}
exports.ledger = ledger;
