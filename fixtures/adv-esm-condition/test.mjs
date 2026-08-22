import assert from 'node:assert/strict';
import { runAlpha, runBeta } from './app.mjs';
// Regression: divlib/extra resolves to real.js under ESM import conditions but
// other.js under require conditions. The analyzer's require-condition resolver
// attributed `beta` usage to other.js, so real.js's beta looked unused and was
// stubbed — but Node's ESM loader runs real.js. beta must survive.
assert.equal(runAlpha(3).kind, 'alpha');
assert.equal(runBeta(4).kind, 'beta');
assert.equal(runBeta(4).total, 160);
console.log('fixture-adv-esm-condition: ok');
