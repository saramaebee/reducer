// fab-binding-reassigned: `export function foo(){}` whose binding is later
// reassigned at top level. The analyzer's finalize step sees
// binding.constantViolations.length > 0 => reason 'binding-reassigned'.
// foo is MUST_RETAIN_CONSERVATIVELY; nothing may statically name it from the
// app (side-effect import only).

export function foo(seed) {
  const table = ['granite', 'basalt', 'gneiss', 'schist', 'marble'];
  const text = String(seed);
  let acc = 17;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 31 + text.charCodeAt(i) * (i + 3)) % 9973;
  }
  const tag = table[acc % table.length];
  const rev = text.split('').reverse().join('');
  return 'binding-reassigned:foo:' + tag + ':' + acc + ':' + rev;
}

function altImpl(seed) {
  const table = ['ember', 'ash', 'cinder', 'soot', 'flint'];
  const text = String(seed);
  let acc = 41;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 37 + text.charCodeAt(i) * (i + 5)) % 7919;
  }
  const tag = table[acc % table.length];
  const upper = text.toUpperCase();
  return 'binding-reassigned:altImpl:' + tag + ':' + acc + ':' + upper;
}

// The mechanism: top-level reassignment of the exported declaration's binding.
foo = altImpl;
