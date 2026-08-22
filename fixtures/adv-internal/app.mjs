import { greet, kebab } from 'innerlib';

export function main(name) {
  return greet(name);
}

export function slug(s) {
  return kebab(s);
}
