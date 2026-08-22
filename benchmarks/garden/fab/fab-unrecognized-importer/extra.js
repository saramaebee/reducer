// extra.js: a perfectly valid CJS module that nothing statically imports.
// It enters the trace only as an asset-style byte read from index.js, so the
// analyzer can tie no recognized importer to it. Both exports are retained
// conservatively; `hiddenPassenger` is the passenger nothing ever names.
'use strict';

function hiddenCore(seed) {
  const table = ['vault', 'annex', 'attic', 'cellar', 'shed'];
  const text = String(seed);
  let acc = 47;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 103 + text.charCodeAt(i) * (i + 2)) % 9049;
  }
  const tag = table[acc % table.length];
  const rev = text.split('').reverse().join('');
  return 'unrecognized-importer:hiddenCore:' + tag + ':' + acc + ':' + rev;
}
exports.hiddenCore = hiddenCore;

function hiddenPassenger(seed) {
  const table = ['stow', 'cargo', 'crate', 'berth', 'hold'];
  const text = String(seed);
  let acc = 59;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 107 + text.charCodeAt(i) * (i + 3)) % 8963;
  }
  const tag = table[acc % table.length];
  const upper = text.toUpperCase();
  return 'unrecognized-importer:hiddenPassenger:' + tag + ':' + acc + ':' + upper;
}
exports.hiddenPassenger = hiddenPassenger;
