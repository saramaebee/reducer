import assert from 'node:assert/strict';
import { run } from './app.mjs';

// Regression: CJS wrapper closure. `exports.wrap = () => impl()` closes over
// impl; only wrap is imported by the app. The closure reference inside wrap's
// RHS is NOT export plumbing, so impl must be retained (internal-reference).
const viaWrap = run();
assert.equal(viaWrap.count, 8);
assert.equal(typeof viaWrap.checksum, 'number');
assert.ok(viaWrap.joined.startsWith('seed:3:sq:9'));

const lib = await import('closurelib');
const direct = lib.default.impl();
assert.deepEqual(direct, viaWrap);
console.log('fixture-adv-cjs-closure: ok');
