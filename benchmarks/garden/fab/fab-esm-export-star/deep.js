export function deepOrbit(seed) {
  const comets = ['halley', 'encke', 'borrelly', 'tempel', 'wild', 'hartley'];
  let acc = 67;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 97 + seed.charCodeAt(i)) % 94219;
  }
  const trail = [];
  for (let j = 0; j < 4; j++) {
    trail.push(comets[(acc + j * 7) % comets.length] + ((acc >> (j * 2)) & 63));
  }
  return `esm-export-star:deepOrbit:${acc}-${trail.join('^')}`;
}
