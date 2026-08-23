// SR-F7. `loader.load` is an exported wrapper. Its IN-module call site loads
// `safe`; the CROSS-module call site here loads `victim`. Admitting the
// refinement on the in-module call sites alone — the exact complement of "all
// callers enumerable" — predicted `victim` removable while node loads it.
// Admission now requires the UNIVERSE-WIDE reference set, whose union is
// {safe, victim}.
const { load } = require('loader');
module.exports = load('victim').run();
console.log('loaded victim ->', module.exports);
