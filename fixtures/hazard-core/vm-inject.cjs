const vm = require('vm');
vm.runInNewContext(code, { require: require });
