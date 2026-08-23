// RES-F4. Two bare specifiers that both make `require.resolve` throw:
//   `blocked`  IS installed and merely refuses the subpath under REQUIRE
//              conditions (ERR_PACKAGE_PATH_NOT_EXPORTED) — ignorance, widen.
//   `absent`   is not on disk at all (MODULE_NOT_FOUND) — a real proof that the
//              sink's target set is empty, so it contributes nothing.
const which = process.env.W === 'a' ? 'blocked' : 'absent';
import(which).then((m) => console.log('loaded ->', m.hi()));
