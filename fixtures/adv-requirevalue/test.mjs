import assert from 'node:assert/strict';
import { used, trigger } from './app.mjs';

// Regression: `const r = require; r('pkgb').helper()` is a hidden loading
// channel. pkgb.helper looked unimported and was stubbed while remaining
// reachable through the aliased require.
assert.equal(used(), 'u');
assert.equal(trigger(), 'h');
console.log('fixture-adv-requirevalue: ok');
