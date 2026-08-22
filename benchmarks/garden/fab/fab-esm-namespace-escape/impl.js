export function a(seed) {
  const reefs = ['staghorn', 'brain', 'fan', 'pillar', 'elkhorn', 'table'];
  let acc = 43;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 67 + seed.charCodeAt(i)) % 99133;
  }
  const grown = [];
  for (let j = 0; j < 4; j++) {
    grown.push(reefs[(acc + j * 5) % reefs.length] + ((acc >> (j + 1)) & 15));
  }
  return `esm-namespace-escape:a:${acc}-${grown.join(',')}`;
}

export function b(seed) {
  const dunes = ['barchan', 'seif', 'star', 'parabolic', 'transverse', 'linear'];
  let acc = 47;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 71 + seed.charCodeAt(i)) % 98297;
  }
  const drifted = [];
  for (let j = 0; j < 4; j++) {
    drifted.push(dunes[(acc + j * 7) % dunes.length] + ((acc >> (j * 2)) & 31));
  }
  return `esm-namespace-escape:b:${acc}-${drifted.join(';')}`;
}
