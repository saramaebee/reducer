import assert from 'node:assert/strict';
import { readValue } from './app.mjs';

// Importing app.mjs pulls in sidelib, whose top-level init must still run
// on the reduced tree: registration side effect + init-time activate() call.
assert.ok(Array.isArray(globalThis.__sideReg), '__sideReg exists');
assert.ok(globalThis.__sideReg.includes('sidelib'), 'module registered itself');
assert.ok(globalThis.__sideReg.includes('sidelib:activated'), 'activate() ran at init');

// getValue depends on activation having happened (returns -1 otherwise).
const expected = ['s', 'i', 'd', 'e'].reduce((a, c) => a * 31 + c.charCodeAt(0), 0);
assert.equal(readValue(), expected);

console.log('fixture-adv-esm-sideeffect: ok');
