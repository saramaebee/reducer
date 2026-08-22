import * as lib from 'esclib';

export function used() {
  return lib.alpha();
}

// The namespace object escapes into a call we do not analyze
// interprocedurally. A sound analyzer must retain ALL exports of esclib.
export function count() {
  return Object.keys(lib).length;
}
