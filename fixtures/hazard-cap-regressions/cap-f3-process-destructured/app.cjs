// r1/a06b: `getBuiltinModule` destructured off `process` — a capability
// factory that used to vanish at the destructuring.
const { getBuiltinModule } = process;
console.log(getBuiltinModule('module').createRequire(__filename)('victim').v());
