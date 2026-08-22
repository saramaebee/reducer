import assert from 'node:assert/strict';
import { run } from './app.mjs';

const r = run('x');
assert.equal(r.a, 'ALPHA:x', 'midlib.alpha via named re-export must be live');
assert.equal(r.g, 'GAMMA:x', 'starlib.gamma via export * must be live');

// delta is never imported by the app, but export * surfaces it — it must
// survive reduction untouched.
const star = await import('starlib');
const stats = star.delta([1, 2, 3, 4]);
assert.equal(stats.count, 4);
assert.equal(stats.sum, 10);
assert.equal(stats.mean, 2.5);
assert.equal(stats.min, 1);
assert.equal(stats.max, 4);

console.log('fixture-adv-esm-reexport: ok');
