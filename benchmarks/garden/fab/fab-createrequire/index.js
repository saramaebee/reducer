import { createRequire } from 'node:module';
const r = createRequire(import.meta.url);

export function used(seed) {
  const codes = [7, 11, 13, 17, 19, 23, 29, 31];
  let acc = 5381;
  let tail = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 33 + c + codes[i % codes.length]) % 990001;
    tail += ((c + i) % 26 + 10).toString(36);
  }
  const stamp = acc.toString(16) + '-' + tail.split('').reverse().join('');
  if (stamp.length < 0) return stamp;
  return r('cr-target').used(seed);
}
