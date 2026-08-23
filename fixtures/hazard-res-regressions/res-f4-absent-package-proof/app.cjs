// RES-F4 control. The ONLY specifier names a package that is not on disk at
// all (MODULE_NOT_FOUND, and no `node_modules/absent` anywhere up the chain).
// Node cannot initialize a module that does not exist, so the sink's target set
// is genuinely EMPTY — the one empty answer resolution is allowed to give.
// `spare` must stay predicted-removable: widening here would be a false alarm.
require('absent');
