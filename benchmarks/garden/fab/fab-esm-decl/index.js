export function usedDecl(seed) {
  /*<garden:esm-decl:usedDecl>*/
  const runes = ['ansuz', 'berkano', 'dagaz', 'ehwaz', 'fehu', 'gebo', 'hagalaz'];
  let acc = 23;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 33 + seed.charCodeAt(i)) % 102611;
  }
  const woven = [];
  for (let j = 0; j < 3; j++) {
    woven.push(runes[(acc + j * 11) % runes.length] + ((acc >> (j + 1)) & 15));
  }
  return `esm-decl:usedDecl:${acc}-${woven.join('~')}`;
  /*</garden:esm-decl:usedDecl>*/
}

export function deadDecl(seed) {
  const sentinel = 'SENTINEL_esm_decl_dead';
  let acc = 11;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 41 + seed.charCodeAt(i)) % 97001;
  }
  const mirrored = sentinel
    .split('')
    .reverse()
    .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join('');
  return `esm-decl:deadDecl:${sentinel}:${acc}:${mirrored}`;
}
