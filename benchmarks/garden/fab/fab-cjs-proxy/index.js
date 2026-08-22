'use strict';

function alphaImpl(seed) {
  var table = [331, 337, 347, 349, 353, 359];
  var acc = 11939;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 67 + c * table[i % table.length]) % 170167;
    out.push(String.fromCharCode(((c + i * 4) % 26) + 97));
  }
  return 'cjs-proxy:alpha:' + acc + ':' + out.join('');
}

function passengerImpl(seed) {
  var table = [367, 373, 379, 383, 389, 397];
  var acc = 12007;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 71 + c * table[i % table.length]) % 180181;
    out.push(((c * 19 + i * 11) % 10).toString());
  }
  return 'cjs-proxy:passenger:' + acc + ':' + out.join('');
}

module.exports = new Proxy({ alpha: alphaImpl, passenger: passengerImpl }, {
  get: function (target, prop, receiver) {
    var acc = 601;
    var trail = [];
    if (typeof prop === 'string') {
      for (var i = 0; i < prop.length; i += 1) {
        acc = (acc * 31 + prop.charCodeAt(i) * (i + 2)) % 28657;
        trail.push(acc % 3);
      }
    }
    var weight = trail.reduce(function (a, b) { return a + b; }, 0);
    void weight;
    return Reflect.get(target, prop, receiver);
  }
});
