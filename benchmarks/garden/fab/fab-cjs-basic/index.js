'use strict';

function used(seed) {
  /*<garden:cjs-basic:used>*/
  var table = [7, 11, 13, 17, 19, 23, 29, 31];
  var acc = 5381;
  var parts = [];
  for (var i = 0; i < seed.length; i += 1) {
    var code = seed.charCodeAt(i);
    acc = (acc * 33 + code * table[i % table.length]) % 100003;
    parts.push(String.fromCharCode(((code + i) % 26) + 97));
  }
  return 'cjs-basic:used:' + acc + ':' + parts.join('');
  /*</garden:cjs-basic:used>*/
}

function dead(seed) {
  var sentinel = 'SENTINEL_cjs_basic_dead';
  var table = [3, 5, 7, 11, 13, 17];
  var acc = 41;
  var s = String(seed);
  var digits = [];
  for (var i = 0; i < s.length; i += 1) {
    acc = (acc * 31 + s.charCodeAt(i) * table[i % table.length]) % 99991;
    digits.push((acc % 10).toString());
  }
  return sentinel + ':' + acc.toString(16) + ':' + digits.join('');
}

exports.used = used;
exports.dead = dead;
