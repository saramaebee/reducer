import assert from 'node:assert/strict';
import { run } from './app.mjs';
// Regression: `exports.x = f1; require(cycle reads .x -> f1); exports.x = f2; exports.legacy = f1`.
// The overwritten key made f1 look reachable only via the unused `legacy` alias,
// so f1 was stubbed — but the require cycle calls f1 through exports.x at load.
const r = run();
assert.equal(r[0], 'f2:506:83');
assert.equal(r[1], 'f1:382:16');
// legacy alias still callable (never stubbed)
const lib = (await import('cyclib')).default;
assert.equal(lib.legacy(), 'f1:382:16');
console.log('fixture-adv-cjs-overwrite: ok');
