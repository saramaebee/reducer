import assert from 'node:assert/strict';
import { run } from './app.mjs';

// Regression: `export default core; export { core as helper }` — the app
// imports only the default. `helper` is unreachable from the trace but is
// backed by the same implementation as the reachable default; stubbing
// core's body by way of "helper is unreachable" broke the default call.
assert.equal(run(), 42);
const lib = await import('defaultalias');
assert.equal(lib.default(), 42);
assert.equal(lib.helper(), 42);
console.log('fixture-adv-esm-defaultalias: ok');
