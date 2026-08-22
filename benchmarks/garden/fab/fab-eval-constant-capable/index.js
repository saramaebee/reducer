'use strict';

function run() {
  const table = [9, 27, 81, 243];
  let acc = 13;
  let mix = '';
  const base = 'garden-fixed';
  for (let i = 0; i < base.length; i++) {
    const c = base.charCodeAt(i);
    acc = (acc * 31 + c * table[i % table.length]) % 9871;
    mix += String.fromCharCode(97 + ((c + acc) % 26));
  }
  const out = eval('require("ecc-target").go("garden-fixed")');
  return out + ':' + acc + ':' + mix;
}
exports.run = run;
