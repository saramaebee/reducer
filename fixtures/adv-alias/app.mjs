import aliasDefault from 'aliaslib';
import patchlib from 'patchlib';
import * as dyn from 'dynlib';
import helper from './helper.cjs';

// --- Attack 1: ESM default-import alias chain -------------------------------
const a1 = aliasDefault;
const a2 = a1;
export function viaAliasChain() {
  return a2.fnA();
}

// CJS alias chain + rest destructuring live in helper.cjs.
export const viaCjsAlias = helper.callFnB;
export const viaGrabbedRef = helper.callFnC;
export const viaRestOne = helper.restOne;
export const viaRestTwo = helper.restTwo;

// --- Attack 2: monkey-patch that wraps the ORIGINAL implementation ----------
const origGreet = patchlib.greet;
patchlib.greet = function patched(name) {
  return origGreet(name) + '!';
};
export function viaPatched(name) {
  return patchlib.greet(name);
}

// --- Attack 3: module object escapes into a helper with dynamic access ------
function callProp(mod, name) {
  return mod[name]();
}
export function viaDynamicKnown() {
  return callProp(dyn, 'compute');
}
export function viaDynamicComputed() {
  const key = 'ot' + 'her'; // not a static literal at the access site
  return callProp(dyn, key);
}
