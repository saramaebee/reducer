export function used(seed) {
  /*<garden:static-basic:used>*/
  const table = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  let acc = 17;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 31 + seed.charCodeAt(i)) % 104729;
  }
  const parts = [];
  for (let j = 0; j < 4; j++) {
    parts.push(table[(acc + j * 5) % table.length] + ((acc >> j) & 7));
  }
  return `static-basic:used:${acc}-${parts.join('.')}`;
  /*</garden:static-basic:used>*/
}

export function deadUnused(seed) {
  const sentinel = 'SENTINEL_static_basic_dead';
  let acc = 7;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 37 + seed.charCodeAt(i)) % 99991;
  }
  const folded = sentinel
    .split('')
    .map((c, i) => String.fromCharCode(((c.charCodeAt(0) - 65 + i) % 58) + 65))
    .join('');
  return `static-basic:deadUnused:${sentinel}:${acc}:${folded}`;
}
