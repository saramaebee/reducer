// exact dynamic require: no static edge (the arg is not a string literal), but
// the specifier domain is provably exact through a const binding.
const dyn = 'exact-dyn';
require(dyn);

// package-scoped: constant prefix pins the package, subpath unknown.
const which = process.env.W;
require('pkg-scoped/' + which);

// literal dynamic import into a package whose exports conditions diverge.
import('condpkg');

require('./local.cjs');
