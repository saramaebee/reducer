import assert from 'node:assert/strict';
import { main } from './app.mjs';

assert.equal(main('abc'), 'ABC');
assert.equal(main('Hello World'), 'HELLO WORLD');
console.log('fixture-basic: ok');
