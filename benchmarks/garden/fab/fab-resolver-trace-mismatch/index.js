// fab-resolver-trace-mismatch: rtm-dual's exports map resolves the "import"
// condition to esm.mjs (what Node's ESM loader — and NFT — actually load) and
// the "require" condition to cjs.cjs (what the analyzer's
// createRequire().resolve() lands on). The two files carry DIFFERENT
// implementations of `entry`, so the divergence is real: the analyzer must
// notice its resolution is absent from the trace and mark rtm-dual opaque
// ('resolver-trace-mismatch').

import { entry } from 'rtm-dual';

export function probe(seed) {
  const text = String(seed).trim();
  const first = entry(text);
  if (typeof first !== 'string' || first.length === 0) {
    throw new Error('resolver-trace-mismatch: entry produced an empty value');
  }
  const parts = first.split(':').length;
  const rev = text.split('').reverse().join('');
  return first + '#' + parts + '#' + rev;
}
