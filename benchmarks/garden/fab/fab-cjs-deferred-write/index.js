'use strict';

function eagerImpl(seed) {
  var table = [401, 409, 419, 421, 431, 433];
  var acc = 13001;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 73 + c * table[i % table.length]) % 190199;
    out.push(String.fromCharCode(((c * 3 + i * 2) % 26) + 97));
  }
  return 'cjs-deferred-write:eager:' + acc + ':' + out.join('');
}

function lateImpl(seed) {
  var table = [439, 443, 449, 457, 461, 463];
  var acc = 14009;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 79 + c * table[i % table.length]) % 200201;
    out.push(((c * 23 + i * 13) % 10).toString());
  }
  return 'cjs-deferred-write:late:' + acc + ':' + out.join('');
}

exports.eager = eagerImpl;

setTimeout(function () {
  exports.late = lateImpl;
}, 0);
