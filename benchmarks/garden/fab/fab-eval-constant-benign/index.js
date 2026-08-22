export function usedGlobal(seed) {
  /*<garden:eval-constant-benign:usedGlobal>*/
  const g = Function('return this')();
  const tag = typeof g;
  const table = [7, 11, 13, 17, 19, 23];
  let acc = 0;
  let out = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc + c * table[i % table.length]) % 8191;
    out += String.fromCharCode(97 + ((c + acc) % 26));
  }
  return `eval-constant-benign:usedGlobal:${tag}:${acc}:${out}`;
  /*</garden:eval-constant-benign:usedGlobal>*/
}

export function deadDead(seed) {
  const sentinel = 'SENTINEL_eval_benign_dead';
  const table = ['x', 'y', 'z', 'w'];
  let acc = 1;
  let out = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 33 + c) % 7919;
    out += table[(c * 3 + i) % table.length];
  }
  return `${sentinel}:${acc}:${out}`;
}
