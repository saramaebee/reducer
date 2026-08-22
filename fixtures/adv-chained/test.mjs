import assert from 'node:assert/strict';
import { run } from './app.mjs';

// Regression: `exports.a = exports.b = real` hides export `b` inside a
// "recognized" export statement. The app only touches `b`; `a`/`c` looked
// unreachable and stubbing them removed real(), which `b` still points at.
assert.equal(run(), 7);
const pkg = (await import('chainlib')).default;
assert.equal(pkg.a(), 7);
assert.equal(pkg.c(), 7);
console.log('fixture-adv-chained: ok');
