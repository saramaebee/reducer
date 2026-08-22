import pkg from 'minilodash';
const { get } = pkg;

export function lookup(obj, path) {
  return get(obj, path, null);
}
