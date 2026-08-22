import assert from 'node:assert/strict';
import { run } from './app.mjs';

assert.equal(run('alpha'), 'alpha-result');
assert.equal(run('beta'), 'beta-result');
console.log('fixture-dynamic-access: ok');
