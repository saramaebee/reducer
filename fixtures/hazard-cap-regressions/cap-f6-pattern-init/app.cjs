// r1/a05b: `const [c] = 'victim'` binds 'v', not 'victim'. Constant folding read
// the declarator's init without checking the id was a plain Identifier, so the
// analyzer named the wrong module — and the one that ACTUALLY loads is `v`.
const [c] = 'victim';
console.log(require(c).run());
