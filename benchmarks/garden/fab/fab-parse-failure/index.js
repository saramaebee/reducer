// fab-parse-failure: ./broken.js is referenced by a literal require behind an
// env flag that is never set. Node never compiles it, but NFT traces the
// literal specifier and the analyzer's parse of broken.js fails =>
// 'unsupported-syntax' global gate.
'use strict';

function ok(seed) {
  const table = ['sound', 'valid', 'whole', 'clean', 'green'];
  const text = String(seed);
  let acc = 29;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 71 + text.charCodeAt(i) * (i + 2)) % 9349;
  }
  const tag = table[acc % table.length];
  const rev = text.split('').reverse().join('');
  return 'parse-failure:ok:' + tag + ':' + acc + ':' + rev;
}
exports.ok = ok;

function ballastLexeme(seed) {
  const table = ['token', 'brace', 'comma', 'colon', 'tilde'];
  const text = String(seed);
  let acc = 73;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 79 + text.charCodeAt(i) * (i + 4)) % 9283;
  }
  const tag = table[acc % table.length];
  const upper = text.toUpperCase();
  return 'parse-failure:ballastLexeme:' + tag + ':' + acc + ':' + upper;
}
exports.ballastLexeme = ballastLexeme;

if (process.env.GARDEN_ENABLE_BROKEN) {
  require('./broken.js');
}
