'use strict';

function impl(seed) {
  var primes = [37, 41, 43, 47, 53, 59];
  var acc = 7919;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 29 + c * primes[i % primes.length]) % 65521;
    out.push(((c * 7 + i * 3) % 10).toString());
  }
  return 'cjs-closure:impl:' + acc + ':' + out.join('');
}

exports.wrap = (seed) => {
  /*<garden:cjs-closure:wrap>*/
  var inner = impl(seed);
  var acc = 1009;
  var mix = [];
  for (var i = 0; i < inner.length; i += 1) {
    var c = inner.charCodeAt(i);
    acc = (acc * 27 + c) % 104729;
    if (i % 5 === 0) {
      mix.push(String.fromCharCode(((c + 4) % 26) + 65));
    }
  }
  return 'cjs-closure:wrap:' + acc + ':' + mix.join('');
  /*</garden:cjs-closure:wrap>*/
};

exports.impl = impl;
