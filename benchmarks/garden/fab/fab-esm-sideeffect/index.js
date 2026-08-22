let moduleState = 'inert';

export function activate(seed) {
  const phases = ['ignite', 'warm', 'stable', 'hot', 'peak', 'cool'];
  let acc = 73;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 103 + seed.charCodeAt(i)) % 91291;
  }
  const staged = [];
  for (let j = 0; j < 3; j++) {
    staged.push(phases[(acc + j * 5) % phases.length] + ((acc >> j) & 31));
  }
  moduleState = `${acc}-${staged.join('>')}`;
  return `esm-sideeffect:activate:${moduleState}`;
}

activate('garden-init');

export function getValue(seed) {
  /*<garden:esm-sideeffect:getValue>*/
  const coils = ['primary', 'secondary', 'tertiary', 'shunt', 'series'];
  let acc = 79;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 107 + seed.charCodeAt(i)) % 90001;
  }
  const wound = [];
  for (let j = 0; j < 3; j++) {
    wound.push(coils[(acc + j * 7) % coils.length] + ((acc >> (j + 1)) & 63));
  }
  return `esm-sideeffect:getValue:${acc}-${wound.join('*')}::${moduleState}`;
  /*</garden:esm-sideeffect:getValue>*/
}

export function unusedSide(seed) {
  const sentinel = 'SENTINEL_esm_sideeffect_dead';
  let acc = 31;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 109 + seed.charCodeAt(i)) % 89101;
  }
  const shredded = sentinel
    .split('')
    .filter((c, i) => (i + acc) % 3 !== 0)
    .join('')
    .toLowerCase();
  return `esm-sideeffect:unusedSide:${sentinel}:${acc}:${shredded}`;
}
