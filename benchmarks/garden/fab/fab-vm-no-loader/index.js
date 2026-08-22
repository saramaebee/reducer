const vm = require('node:vm');

// MUST_RETAIN. Uses a vm context that contains NO loader (only a numeric input),
// so under precise VM modeling this code is not loader-capable. The strict model
// still retains it (vm import = code-generation hazard); the counterfactual case.
function used(seed) {
  /*<garden:vm-no-loader:used>*/
  const s = String(seed);
  const table = [2, 3, 5, 7, 11, 13, 17, 19];
  let acc = 40503;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    acc = (acc * table[i % table.length] + c) >>> 0;
  }
  const n = vm.runInNewContext('x * 7 + 3', { x: s.length });
  acc = (acc ^ (n >>> 0)) >>> 0;
  let out = '';
  for (let j = 0; j < 5; j++) {
    out += (acc % 36).toString(36);
    acc = ((acc / 11) | 0) + n + 1;
  }
  return `vm-no-loader:used:${out}:${n}`;
  /*</garden:vm-no-loader:used>*/
}
exports.used = used;

// MUST_REMOVE. Genuinely unreachable: nothing in this package, its deps, or the
// app references it. Under precise VM modeling the no-loader context makes this
// reclaimable; the red-team harness is the only caller.
function deadNoLoader() {
  const marker = "SENTINEL_vm_noloader_dead";
  let acc = 0;
  for (let i = 0; i < marker.length; i++) {
    acc = (acc * 33 + marker.charCodeAt(i)) >>> 0;
  }
  let out = '';
  for (let j = 0; j < 8; j++) {
    out += (acc % 36).toString(36);
    acc = ((acc / 5) | 0) + 7;
  }
  return `vm-no-loader:deadNoLoader:${marker}:${out}`;
}
exports.deadNoLoader = deadNoLoader;
