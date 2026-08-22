// side-effect-only import: module init must survive
import 'sideify';
// name imported through an `export * from './impl.js'` barrel
import { alpha } from 'restar';
// module object accessed via string-literal computed member
import lib from 'proplib';

export function run(x) {
  return {
    a: alpha(x),
    p: lib['used'](x),
    side: globalThis.__SIDEIFY_ARMED__,
  };
}
