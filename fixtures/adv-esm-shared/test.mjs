import assert from 'node:assert/strict';
import { describe } from './app.mjs';

// Regression: ESM `export function fmt(){}` + `export { fmt as format }` —
// the app imports only `format`. Symbol `fmt` is unreachable by name but
// shares its implementation with reachable `format`; stubbing fmt's body
// by way of "fmt is unreachable" would break format().
assert.equal(describe(3.14159), '3.14');
assert.equal(describe(['a ', ' b']), 'a, b');

// test.mjs is not traced, so it may exercise the retained-but-unused alias.
const lib = await import('sharedlib');
assert.equal(lib.fmt({ b: 2, a: 1 }), 'a=1, b=2');
assert.equal(lib.fmt, lib.format);

console.log('fixture-adv-esm-shared: ok');
