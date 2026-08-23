const m = process.getBuiltinModule('node:module');
const req = m.createRequire('/tmp/x.js');
req('chalk');
