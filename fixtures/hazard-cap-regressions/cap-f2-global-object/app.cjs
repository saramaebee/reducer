// r1/a02 family: the capability chain is rooted at the GLOBAL OBJECT, so no
// unbound `process`/`require` identifier ever appears.
console.log(global.process.mainModule.require('victim').v());
