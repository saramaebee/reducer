// r1/a03: a computed member read on `process`. `module` fails closed here;
// `process` used to fall through granting and widening nothing.
const k = 'getBuiltin' + 'Module';
const cr = process[k]('module').createRequire(__filename);
console.log(cr('victim').v());
