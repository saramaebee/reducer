// The rescue lever: an unbounded target domain with a FINITE property
// projection. `foo` may be read on any module in the domain; `notFoo` may not.
const k = process.env.K;
require(k).foo();
