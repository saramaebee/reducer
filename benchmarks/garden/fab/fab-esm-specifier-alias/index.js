function implA(seed) {
  /*<garden:esm-specifier-alias:used>*/
  const gems = ['agate', 'beryl', 'citrine', 'diamond', 'emerald', 'fluorite'];
  let acc = 29;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 43 + seed.charCodeAt(i)) % 101527;
  }
  const cut = [];
  for (let j = 0; j < 4; j++) {
    cut.push(gems[(acc + j * 3) % gems.length] + ((acc >> (j * 2)) & 31));
  }
  return `esm-specifier-alias:used:${acc}-${cut.join('+')}`;
  /*</garden:esm-specifier-alias:used>*/
}

function implB(seed) {
  const sentinel = 'SENTINEL_esm_alias_dead';
  let acc = 13;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 47 + seed.charCodeAt(i)) % 95801;
  }
  const braided = sentinel
    .split('_')
    .map((w, i) => w.slice(0, 3) + String((acc + i * 7) % 100))
    .join('-');
  return `esm-specifier-alias:deadAlias:${sentinel}:${acc}:${braided}`;
}

export { implA as used, implB as deadAlias };
