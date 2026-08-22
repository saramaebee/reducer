export function used(seed) {
  /*<garden:esm-namespace-clean:used>*/
  const winds = ['boreas', 'eurus', 'notus', 'zephyrus', 'mistral', 'sirocco'];
  let acc = 41;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 59 + seed.charCodeAt(i)) % 100801;
  }
  const gusts = [];
  for (let j = 0; j < 4; j++) {
    gusts.push(winds[(acc + j * 9) % winds.length] + ((acc >> j) & 127));
  }
  return `esm-namespace-clean:used:${acc}-${gusts.join('|')}`;
  /*</garden:esm-namespace-clean:used>*/
}

export function deadNs(seed) {
  const sentinel = 'SENTINEL_esm_ns_dead';
  let acc = 19;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 61 + seed.charCodeAt(i)) % 94007;
  }
  const rotated = sentinel
    .split('')
    .map((c) => String.fromCharCode(((c.charCodeAt(0) - 32 + acc) % 95) + 32))
    .join('');
  return `esm-namespace-clean:deadNs:${sentinel}:${acc}:${rotated}`;
}
