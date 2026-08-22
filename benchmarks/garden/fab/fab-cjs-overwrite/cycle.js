'use strict';

// Requires index.js back mid-initialization: at this moment exports.x is
// still f1 (the first write), because the second write has not run yet.
var idx = require('./index.js');
var seen = typeof idx.x === 'function' ? idx.x('cycle') : 'x-missing';
exports.observed = 'cycle-saw:' + seen;
