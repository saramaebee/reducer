// fab-destructure-rest: `const { a, ...rest } = require('dr-target')`.
// The RestElement in the pattern makes dr-target's whole surface
// possibly-reachable (reason 'destructure-rest'); nothing about dr-target's
// individual exports may be narrowed.
'use strict';

const { a, ...rest } = require('dr-target');

function pick(seed) {
  const keys = Object.keys(rest).sort();
  const joined = keys.join(',');
  const echo = String(seed).trim();
  const head = a(echo);
  if (typeof head !== 'string' || head.length === 0) {
    throw new Error('destructure-rest: carrier lost its head value');
  }
  if (keys.length === 0) {
    throw new Error('destructure-rest: rest pattern captured nothing');
  }
  return head + ':' + joined;
}
exports.pick = pick;
