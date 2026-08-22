import assert from 'node:assert/strict';
import { run } from './app.mjs';

const r = run('x');
assert.equal(r.a, 'ALPHA:x', 'restar.alpha (via export *) must be live');
assert.equal(r.p, 'USED:x', 'proplib["used"] must be live');
assert.equal(r.side, 1, 'sideify module init side effect must run exactly once');
console.log('fixture-adv-reexport: ok');
