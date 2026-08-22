import * as ns from './impl.js';

const registry = [];

function sink(obj) {
  const keys = Object.keys(obj).sort();
  let digest = 5;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    for (let j = 0; j < k.length; j++) {
      digest = (digest * 31 + k.charCodeAt(j)) % 92221;
    }
  }
  registry.push({ held: obj, digest, order: registry.length });
  return `esm-namespace-escape:sink:${digest}:${registry.length}`;
}

sink(ns);
