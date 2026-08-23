// RES-F8. A finite specifier domain where one member resolves (`good`) and one
// is ignorance (`blocked`, installed but refusing the require condition). The
// sink therefore widens to unbounded with gate `unresolved-specifier`.
// Switching that ONE gate off must DEMOTE the sink to the file that did
// resolve — not delete the sink, which would also release `good` and turn the
// gate-off headroom into fantasy.
const A = 'go' + 'od';
const B = 'blo' + 'cked';
const which = process.env.W === 'a' ? A : B;
import(which).then((m) => console.log('loaded ->', m));
