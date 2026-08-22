export function makeAndRun(seed) {
  const table = [4, 8, 15, 16, 23, 42];
  let acc = 11;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 27 + c * table[i % table.length]) % 7823;
  }
  const src = 'return ' + JSON.stringify(seed) + ".split('').reverse().join('')";
  const reversed = new Function(src)();
  return 'newfunction-runtime:makeAndRun:' + reversed + ':' + acc;
}

export function passenger(seed) {
  const table = [18, 30, 44, 58, 66];
  let acc = 61;
  let out = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc + (c * 13 ^ table[i % table.length])) % 8837;
    out += String.fromCharCode(65 + ((c * 5 + acc) % 26));
  }
  return `newfunction-runtime:passenger:${acc}:${out}`;
}
