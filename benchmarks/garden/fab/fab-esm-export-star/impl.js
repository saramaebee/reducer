export function gamma(seed) {
  /*<garden:esm-export-star:gamma>*/
  const strata = ['gneiss', 'schist', 'basalt', 'shale', 'marble', 'slate'];
  let acc = 59;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 83 + seed.charCodeAt(i)) % 96001;
  }
  const layered = [];
  for (let j = 0; j < 4; j++) {
    layered.push(strata[(acc + j * 3) % strata.length] + ((acc >> (j + 2)) & 31));
  }
  return `esm-export-star:gamma:${acc}-${layered.join('#')}`;
  /*</garden:esm-export-star:gamma>*/
}

export function delta(seed) {
  const tides = ['spring', 'neap', 'ebb', 'flood', 'slack', 'rip'];
  let acc = 61;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 89 + seed.charCodeAt(i)) % 95111;
  }
  const surged = [];
  for (let j = 0; j < 4; j++) {
    surged.push(tides[(acc + j * 5) % tides.length] + ((acc >> j) & 15));
  }
  return `esm-export-star:delta:${acc}-${surged.join('%')}`;
}
