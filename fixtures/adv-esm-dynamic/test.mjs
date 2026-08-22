import assert from 'node:assert/strict';
import { run } from './app.mjs';

// Adversarial: app reaches dynlib only through a literal dynamic import and
// only calls lib.used(). unusedDyn is never referenced by traced code, but a
// dynamic import retains the entire target — it must survive intact.
assert.deepEqual(await run(), { total: 55, evens: 2, count: 5 });

const lib = await import('dynlib');
const r = lib.unusedDyn();
assert.equal(r.size, 4);
assert.equal(r.spread, r.max - r.min);
assert.deepEqual(lib.used(), { total: 55, evens: 2, count: 5 });

console.log('fixture-adv-esm-dynamic: ok');
