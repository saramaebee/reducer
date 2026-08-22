import assert from 'node:assert/strict';
import { handle, dispatch } from './app.mjs';

// Exported object whose method is a non-exported impl: must survive.
assert.equal(handle('  Foo bar foo  '), 'handled(bar:1,foo:2)');

// Computed access through the app hits both keylib exports.
assert.equal(dispatch(4), 'first(4):4:even');
assert.equal(dispatch(3), 'second(3):len=8:last=1');

// Direct dynamic import: both keylib functions must be intact.
const keylib = await import('keylib');
assert.equal(keylib.first(12), 'first(12):5:odd');
assert.equal(keylib.second(6), 'second(6):len=9:last=1');

console.log('fixture-adv-esm-object: ok');
