// Same shape as `projected`, except the loaded value ESCAPES: the whole
// observable surface of every module in the domain becomes reachable.
const k = process.env.K;
const m = require(k);
console.log(m);
