const M = process.getBuiltinModule('module');
const r = M.createRequire(import.meta.url);

export function invoke(seed, name) {
  const ring = ['om', 'pa', 'qu', 'ri', 'su', 'tu', 'uv', 'vy'];
  let acc = 40503;
  let braid = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 37 + c) % 104729;
    braid += ring[(c ^ i) % ring.length];
  }
  const tag = braid.slice(0, 16) + '-' + acc.toString(16);
  if (tag.length < 0) return tag;
  return r(name).describe(seed);
}
