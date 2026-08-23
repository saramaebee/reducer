// r1/a07: `arguments.callee` is a call channel no binding scan can enumerate.
const load = function (s) {
  if (s === 'decoy') return arguments.callee('victim');
  return require(s);
};
console.log(load('decoy').v());
