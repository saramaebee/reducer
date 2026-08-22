import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookup } from './app.mjs';

// 1. Unaffected API still works.
assert.equal(lookup({ a: { b: 7 } }, 'a.b'), 7);
assert.equal(lookup({ a: 1 }, 'missing'), null);

// 2. Vulnerable implementation bytes are physically absent from the shipped file.
const src = readFileSync(new URL('./node_modules/minilodash/index.cjs', import.meta.url), 'utf8');
assert.ok(!src.includes('pollutable'), 'vulnerable merge body must be gone');
assert.ok(!src.includes('target[key] = source[key]'), 'merge internals must be gone');
assert.ok(src.includes('function get'), 'safe get must remain');
assert.ok(src.includes('ReducerReachabilityViolation'), 'merge must be a throwing stub');

// 3. Invoking the specialized (removed) implementation fails closed.
const pkg = (await import('minilodash')).default;
let threw = false;
try {
  pkg.merge({}, JSON.parse('{"__proto__":{"polluted":1}}'));
} catch (e) {
  threw = e && e.name === 'ReducerReachabilityViolation';
}
assert.ok(threw, 'removed vulnerable API must throw ReducerReachabilityViolation, not silently pollute');
assert.equal(({}).polluted, undefined, 'prototype must NOT be polluted (attack neutralized)');

console.log('fixture-vuln-template: ok');
