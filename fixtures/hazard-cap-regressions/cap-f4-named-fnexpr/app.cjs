// r1/a04: `inner` is a DIFFERENT binding from `load`, so its recursive call
// site was missing from the call-site union.
const load = function inner(s) {
  if (s === 'decoy') return inner('victim');
  return require(s);
};
console.log(load('decoy').v());
