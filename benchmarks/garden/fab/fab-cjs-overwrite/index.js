'use strict';

function f1(seed) {
  var primes = [61, 67, 71, 73, 79, 83];
  var acc = 3271;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 23 + c * primes[i % primes.length]) % 92221;
    out.push(String.fromCharCode(((c + i * 5) % 26) + 97));
  }
  return 'cjs-overwrite:f1:' + acc + ':' + out.join('');
}

function f2(seed) {
  /*<garden:cjs-overwrite:x>*/
  var primes = [157, 163, 167, 173, 179, 181];
  var acc = 4409;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 41 + c * primes[i % primes.length]) % 121001;
    out.push(((c * 11 + i * 7) % 10).toString());
  }
  return 'cjs-overwrite:x:' + acc + ':' + out.join('');
  /*</garden:cjs-overwrite:x>*/
}

exports.x = f1;
var cycle = require('./cycle.js');
exports.x = f2;
exports.legacy = f1;
exports.observedDuringCycle = cycle.observed;
