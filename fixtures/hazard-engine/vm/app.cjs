// Constant code, object-literal context, no loader-like injection: the exact
// evidence SR-vm-known-globals is defined to admit. Strict model widens anyway.
const vm = require('vm');
vm.runInNewContext('1 + 1', { x: 1 });
