export async function load(seed, which) {
  const table = [2, 3, 5, 7, 11, 13];
  let acc = 19;
  let mix = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 41 + c * table[i % table.length]) % 8191;
    mix += String.fromCharCode(97 + ((c + acc) % 26));
  }
  const m = await import('din-' + which);
  return m.describe(seed) + ':' + acc + ':' + mix;
}
