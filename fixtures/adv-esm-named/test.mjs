import assert from 'node:assert/strict';
import { describeNumber, sumNumbers } from './app.mjs';

// Positive-reduction regression: ESM named imports (one aliased) keep `used`
// and `alsoUsed` live while `unusedBig` is proven unreachable and stubbed.
// Only reachable paths are exercised here.
assert.equal(describeNumber(21), 'used:42');
assert.equal(sumNumbers([1, 2, 3, 'nope', 4]), 10);

const lib = await import('esmnamed');
assert.equal(lib.used(5).value, 10);
assert.equal(lib.alsoUsed([7, 8]).count, 2);

console.log('fixture-adv-esm-named: ok');
