const vm = require('vm');
vm.runInNewContext("1 + 1", { helper: 1 });
