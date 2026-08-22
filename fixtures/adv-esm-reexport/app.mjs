import { alpha } from 'midlib';
import { gamma } from 'starlib';

export function run(x) {
  return { a: alpha(x), g: gamma(x) };
}
