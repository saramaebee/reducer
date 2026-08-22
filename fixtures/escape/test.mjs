import assert from 'node:assert/strict';
import { used, count } from './app.mjs';

assert.equal(used(), 'a');
assert.equal(count(), 2);
// beta was never statically imported, but the namespace escaped — it must
// still be fully functional.
const lib = await import('esclib');
assert.equal(lib.beta(), 'b');
console.log('fixture-escape: ok');
