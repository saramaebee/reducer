'use strict';

function ownImpl(seed) {
  var table = [467, 479, 487, 491, 499, 503];
  var acc = 15013;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 83 + c * table[i % table.length]) % 210211;
    out.push(String.fromCharCode(((c + i * 6) % 26) + 65));
  }
  return 'cjs-setprototypeof:own:' + acc + ':' + out.join('');
}

function inheritedImpl(seed) {
  var table = [509, 521, 523, 541, 547, 557];
  var acc = 16033;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 89 + c * table[i % table.length]) % 220223;
    out.push(((c * 29 + i * 15) % 10).toString());
  }
  return 'cjs-setprototypeof:inherited:' + acc + ':' + out.join('');
}

function passengerImpl(seed) {
  var table = [563, 569, 571, 577, 587, 593];
  var acc = 17011;
  var out = [];
  for (var i = 0; i < seed.length; i += 1) {
    var c = seed.charCodeAt(i);
    acc = (acc * 97 + c * table[i % table.length]) % 230233;
    out.push(String.fromCharCode(((c * 7 + i * 8) % 26) + 97));
  }
  return 'cjs-setprototypeof:passenger:' + acc + ':' + out.join('');
}

var base = { inherited: inheritedImpl, passenger: passengerImpl };

exports.own = ownImpl;
Object.setPrototypeOf(exports, base);
