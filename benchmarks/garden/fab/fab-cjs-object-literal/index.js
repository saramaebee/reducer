'use strict';

function used(seed) {
  /*<garden:cjs-object-literal:used>*/
  var table = [101, 103, 107, 109, 113, 127];
  var acc = 2749;
  var parts = [];
  for (var i = 0; i < seed.length; i += 1) {
    var code = seed.charCodeAt(i);
    acc = (acc * 37 + code * table[i % table.length]) % 131071;
    parts.push(String.fromCharCode(((code * 3 + i) % 26) + 65));
  }
  return 'cjs-object-literal:used:' + acc + ':' + parts.join('');
  /*</garden:cjs-object-literal:used>*/
}

function dead(seed) {
  var sentinel = 'SENTINEL_cjs_objlit_dead';
  var table = [131, 137, 139, 149, 151];
  var acc = 89;
  var s = String(seed);
  var digits = [];
  for (var i = 0; i < s.length; i += 1) {
    acc = (acc * 29 + s.charCodeAt(i) * table[i % table.length]) % 65537;
    digits.push((acc % 16).toString(16));
  }
  return sentinel + ':' + acc.toString(16) + ':' + digits.join('');
}

module.exports = { used, dead };
