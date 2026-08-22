import assert from 'node:assert/strict';
import { useNs, escape } from './app.mjs';

// Static namespace access still works in the reduced tree.
assert.equal(useNs(), 'ns-used');
assert.equal(escape(), 'object');

// escns escaped via consume(e), so BOTH exports must be retained callable.
const esc = await import('escns');
assert.equal(esc.a(), `a:${'0:alpha/1:bravo/2:charlie/3:delta/4:echo/5:foxtrot'.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0)}`);
assert.match(esc.b(), /^b:\d+:/);

console.log('fixture-adv-esm-namespace: ok');
