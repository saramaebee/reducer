// HAZARD-FREE by construction: no eval / Function / vm / dynamic import / require /
// require.cache anywhere. This is the package where removal must fire in isolation:
// the safe API (`get`) is used; the vulnerable API (`mergeVuln`) is dead.

// MUST_RETAIN. Safe deep-property getter: builds a fixed nested object seeded by
// the input and walks a fixed path. Ordinary property semantics only.
export function get(seed) {
  /*<garden:vuln-localized:get>*/
  const s = String(seed);
  let acc = 13;
  for (let i = 0; i < s.length; i++) {
    acc = (acc * 29 + s.charCodeAt(i)) >>> 0;
  }
  const tree = { root: { level: { leaf: { payload: '' } } } };
  let mark = '';
  for (let j = 0; j < 6; j++) {
    mark += (acc % 36).toString(36);
    acc = ((acc / 3) | 0) + 1;
  }
  tree.root.level.leaf.payload = mark;
  const pathKeys = ['root', 'level', 'leaf', 'payload'];
  let node = tree;
  for (const key of pathKeys) {
    node = node[key];
  }
  return `vuln-localized:get:${node}`;
  /*</garden:vuln-localized:get>*/
}

// MUST_REMOVE. Simulated prototype-pollution deep-merge (the vulnerable API for
// CVE-SIM-GARDEN-0001). Iterative (no self-reference) so it stays a stubbable
// top-level function. Deliberately copies __proto__/constructor keys. Never
// invoked by any live path — only the red-team harness reaches it.
export function mergeVuln(target, source) {
  const sentinel = "SENTINEL_vuln_merge_body";
  const out = target || {};
  const stack = [[out, source || {}]];
  while (stack.length) {
    const pair = stack.pop();
    const dst = pair[0];
    const src = pair[1];
    for (const key in src) {
      const val = src[key];
      if (key === '__proto__' || key === 'constructor') {
        dst[key] = val;
      } else if (val && typeof val === 'object') {
        if (!dst[key]) dst[key] = {};
        stack.push([dst[key], val]);
      } else {
        dst[key] = val;
      }
    }
  }
  return `vuln-localized:mergeVuln:${sentinel}:${Object.keys(out).length}`;
}
