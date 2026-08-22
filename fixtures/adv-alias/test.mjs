import assert from 'node:assert/strict';
import {
  viaAliasChain,
  viaCjsAlias,
  viaGrabbedRef,
  viaRestOne,
  viaRestTwo,
  viaPatched,
  viaDynamicKnown,
  viaDynamicComputed,
} from './app.mjs';

// Alias chains
assert.equal(viaAliasChain(), 'A');
assert.equal(viaCjsAlias(), 'B');
assert.equal(viaGrabbedRef(), 'C');

// Destructuring with rest
assert.equal(viaRestOne(), 1);
assert.equal(viaRestTwo(), 2);

// Monkey-patch wrapping the original implementation
assert.equal(viaPatched('sara'), 'hello sara!');

// Module object passed to a helper doing dynamic property access
assert.equal(viaDynamicKnown(), 42);
assert.equal(viaDynamicComputed(), 'other');

console.log('fixture-adv-alias: ok');
