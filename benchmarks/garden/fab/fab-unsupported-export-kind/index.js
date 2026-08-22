// fab-unsupported-export-kind: the only export is a const object literal —
// not a top-level FunctionDeclaration — so the analyzer's finalize step
// retains it with reason 'unsupported-export-kind'. The app must import this
// package for side effects only: naming `obj` would add static-import
// evidence and mask the gate under test.

export const obj = {
  m(seed) {
    const table = ['crate', 'chest', 'coffer', 'casket', 'trunk'];
    const text = String(seed);
    let acc = 37;
    for (let i = 0; i < text.length; i++) {
      acc = (acc * 83 + text.charCodeAt(i) * (i + 2)) % 9203;
    }
    const tag = table[acc % table.length];
    const rev = text.split('').reverse().join('');
    return 'unsupported-export-kind:obj.m:' + tag + ':' + acc + ':' + rev;
  },
  helper(seed) {
    const table = ['latch', 'hinge', 'hasp', 'strap', 'clasp'];
    const text = String(seed);
    let acc = 89;
    for (let i = 0; i < text.length; i++) {
      acc = (acc * 97 + text.charCodeAt(i) * (i + 3)) % 9127;
    }
    const tag = table[acc % table.length];
    const upper = text.toUpperCase();
    return 'unsupported-export-kind:obj.helper:' + tag + ':' + acc + ':' + upper;
  },
};
