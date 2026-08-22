'use strict';

function fooImpl(seed) {
  var table = [191, 193, 197, 199, 211, 223];
  var acc = 6151;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 43 + c * table[i % table.length]) % 131063;
    out.push(String.fromCharCode(((c + i * 2) % 26) + 97));
  }
  return 'cjs-getter:foo:' + acc + ':' + out.join('');
}

function barImpl(seed) {
  var table = [227, 229, 233, 239, 241, 251];
  var acc = 8237;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 47 + c * table[i % table.length]) % 141079;
    out.push(((c * 13 + i) % 10).toString());
  }
  return 'cjs-getter:bar:' + acc + ':' + out.join('');
}

Object.defineProperty(exports, 'foo', {
  enumerable: true,
  get: function () {
    var gate = 'cjs-getter-foo-gate-constant';
    var acc = 211;
    var checks = [];
    for (var i = 0; i < gate.length; i += 1) {
      acc = (acc * 37 + gate.charCodeAt(i) * (i + 1)) % 32749;
      checks.push(acc % 7);
    }
    var parity = checks.reduce(function (a, b) { return a + b; }, 0) % 2;
    void parity;
    return fooImpl;
  }
});

Object.defineProperty(exports, 'bar', {
  enumerable: true,
  get: function () {
    var gate = 'cjs-getter-bar-gate-constant';
    var acc = 419;
    var checks = [];
    for (var i = 0; i < gate.length; i += 1) {
      acc = (acc * 53 + gate.charCodeAt(i) * (i + 3)) % 46337;
      checks.push(acc % 5);
    }
    var parity = checks.reduce(function (a, b) { return a + b; }, 0) % 2;
    void parity;
    return barImpl;
  }
});
