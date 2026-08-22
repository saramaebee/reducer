export async function callUsed(seed) {
  const table = ['g', 'a', 'r', 'd', 'e', 'n'];
  let acc = 7;
  let mix = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 29 + c) % 6007;
    mix += table[(c + acc) % table.length];
  }
  const m = await import('dil-target');
  return m.used(seed) + ':' + acc + ':' + mix;
}
