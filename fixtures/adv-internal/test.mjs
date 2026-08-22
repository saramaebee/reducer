import assert from 'node:assert/strict';
import { main, slug } from './app.mjs';
import * as ns from 'innerlib';

// Case 1 (warmCache at init) + Case 2 (greet -> normalize).
assert.equal(main('  Sara  '), 'hello, sara');

// Case 4: kebab alias of slugify; slugify body must be live.
assert.equal(slug('Hello Big World'), 'hello-big-world');

// Case 3: conditionally assigned export must exist and work.
const lib = ns.default ?? ns;
assert.equal(typeof lib.debugDump, 'function');
assert.equal(lib.debugDump({ a: 1 }), '{"a":1}');

console.log('fixture-adv-internal: ok');
