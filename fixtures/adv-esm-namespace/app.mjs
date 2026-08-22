import * as ns from 'nslib';
import * as e from 'escns';

// Clean static namespace access: only ns.used is ever touched.
export function useNs() {
  return ns.used();
}

// The escns namespace object escapes into a local function; the analyzer
// cannot know what consume does with it, so ALL escns exports must survive.
function consume(namespace) {
  return typeof namespace;
}

export function escape() {
  return consume(e);
}
