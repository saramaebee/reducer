export function alpha(seed) {
  /*<garden:esm-reexport:alpha>*/
  const knots = ['bowline', 'clove', 'figure8', 'sheet', 'reef', 'surgeon'];
  let acc = 53;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 73 + seed.charCodeAt(i)) % 97213;
  }
  const tied = [];
  for (let j = 0; j < 4; j++) {
    tied.push(knots[(acc + j * 11) % knots.length] + ((acc >> j) & 63));
  }
  return `esm-reexport:alpha:${acc}-${tied.join('&')}`;
  /*</garden:esm-reexport:alpha>*/
}

export function beta(seed) {
  const sentinel = 'SENTINEL_esm_reexport_dead';
  let acc = 23;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 79 + seed.charCodeAt(i)) % 93077;
  }
  const spliced = sentinel
    .split('_')
    .map((w, i) => w.split('').reverse().join('') + String((acc >> i) & 255))
    .join('.');
  return `esm-reexport:beta:${sentinel}:${acc}:${spliced}`;
}
