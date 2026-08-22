import assert from 'node:assert/strict';
import { run } from './app.mjs';

// Regression: `exports.a = fn; exports.b = fn` — the app imports only `a`.
// Symbol `b` is unreachable but shares fn's implementation with reachable
// `a`; stubbing fn's body by way of "b is unreachable" broke a().
assert.equal(run(), 42);
const lib = await import('aliasexp');
assert.equal(lib.b(), 42);
console.log('fixture-adv-aliasexport: ok');
