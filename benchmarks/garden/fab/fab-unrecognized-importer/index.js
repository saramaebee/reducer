// fab-unrecognized-importer: ./extra.js is pulled into the trace by an
// asset-style readFileSync(__dirname-join) reference that NFT reports, but no
// analyzed module statically imports it — the analyzer finds no recognized
// importer for extra.js and retains its whole surface
// ('unrecognized-importer'). launch only reads extra.js's BYTES; it never
// requires it, so extra.js's exports stay statically unreferenced.
'use strict';

const { readFileSync } = require('fs');
const path = require('path');

function launch(seed) {
  const raw = readFileSync(path.join(__dirname, 'extra.js'));
  const len = raw.length;
  if (len < 200) {
    throw new Error('unrecognized-importer: extra.js payload is too small');
  }
  const text = String(seed);
  let acc = 43;
  for (let i = 0; i < text.length; i++) {
    acc = (acc * 101 + text.charCodeAt(i) * (i + 2) + len) % 9091;
  }
  const rev = text.split('').reverse().join('');
  return 'unrecognized-importer:launch:' + len + ':' + acc + ':' + rev;
}
exports.launch = launch;
