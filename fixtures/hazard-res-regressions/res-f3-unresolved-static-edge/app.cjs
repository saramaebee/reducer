// RES-F3. `mid` statically imports `esmonly`, whose exports map has ONLY an
// `import` condition: createRequire().resolve throws, the edge's resolvedAbs was
// null, and the edge was dropped SILENTLY with no gate — so esmonly/index.js,
// which node really loads, was invisible to the fixpoint.
require('mid-loader');
