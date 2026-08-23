// PROJ-EXACT. A package-tier domain with a bounded `.describe` projection —
// the garden's `require-pkgscoped` shape. Projecting `{describe}` onto every
// module of the package made the co-located `spare` passengers look removable
// while node can reach them. With more than one candidate module a property
// read cannot be attributed as the COMPLETE reachable surface of any one of
// them, so the full surface of every domain module is retained.
const name = process.env.W;
module.exports = require('scopedtarget/' + name).describe('seed');
