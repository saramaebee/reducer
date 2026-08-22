'use strict';

function carrierImpl(seed) {
  var table = [257, 263, 269, 271, 277, 281];
  var acc = 9973;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 59 + c * table[i % table.length]) % 151121;
    out.push(String.fromCharCode(((c * 5 + i) % 26) + 65));
  }
  return 'cjs-computed-export:carrier:' + acc + ':' + out.join('');
}

function passengerImpl(seed) {
  var table = [283, 293, 307, 311, 313, 317];
  var acc = 10007;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 61 + c * table[i % table.length]) % 160117;
    out.push(((c * 17 + i * 9) % 10).toString());
  }
  return 'cjs-computed-export:passenger:' + acc + ':' + out.join('');
}

// Non-literal keys computed at runtime: the export surface is not statically
// enumerable, so the whole surface must be retained conservatively.
var carrierKey = ['car', 'ri', 'er'].join('');
var passengerKey = ['pas', 'sen', 'ger'].join('');
exports[carrierKey] = carrierImpl;
exports[passengerKey] = passengerImpl;
