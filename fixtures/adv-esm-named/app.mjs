import { used, alsoUsed as x } from 'esmnamed';

export function describeNumber(n) {
  return used(n).label;
}

export function sumNumbers(nums) {
  return x(nums).total;
}
