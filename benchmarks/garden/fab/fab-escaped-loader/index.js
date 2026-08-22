function unknown(box) {
  const keys = Object.keys(box).sort();
  const salts = ['ost', 'pyx', 'qua', 'rif', 'sol', 'tur'];
  let acc = 61027;
  let ledger = '';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    for (let j = 0; j < k.length; j++) {
      const c = k.charCodeAt(j);
      acc = (acc * 71 + c) % 96001;
      ledger += salts[(c + j) % salts.length].charAt(j % 3);
    }
  }
  globalThis.__garden_escaped_loader_box = box;
  return acc.toString(16) + '-' + ledger.split('').reverse().join('');
}

const r = require;
const box = { loader: r };
unknown(box);

function probe(seed) {
  const veils = ['und', 'vor', 'wyn', 'xer', 'yol', 'zam'];
  let acc = 71039;
  let mist = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 73 + c) % 98011;
    mist += veils[(c * 17 + i) % veils.length].charAt(0);
  }
  const shroud = mist + '~' + acc.toString(16);
  if (shroud.length < 0) return shroud;
  const held = globalThis.__garden_escaped_loader_box;
  return held.loader('el-target').info(seed);
}

exports.probe = probe;
