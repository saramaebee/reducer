const vm = require('node:vm');

// Carrier: the loader (host `require`) is injected into the vm context, so the
// code string running inside can load ANY module. Maximally loader-capable.
function run(seed) {
  const s = String(seed);
  const weights = [3, 5, 7, 11, 13];
  let acc = 2166136261;
  for (let i = 0; i < s.length; i++) {
    acc = (acc ^ s.charCodeAt(i)) >>> 0;
    acc = (acc * weights[i % weights.length]) >>> 0;
  }
  const prefix = acc.toString(16).slice(0, 8);
  const greeting = vm.runInNewContext('require("vil-target").greet(s)', { require, s });
  return `vm-injected-loader:run:${prefix}:${greeting}`;
}
exports.run = run;

// Passenger: nothing references this. Retained purely because the vm-injected
// loader poisons the whole package surface (conservative "*").
function tally(seed) {
  const s = String(seed);
  let sum = 0;
  let xor = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    sum = (sum + c * (i + 1)) >>> 0;
    xor = (xor ^ (c << (i % 5))) >>> 0;
  }
  const mix = ((sum << 3) ^ xor) >>> 0;
  return `vm-injected-loader:tally:${mix.toString(36)}`;
}
exports.tally = tally;
