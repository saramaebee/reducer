// RES-F8. A package-tier domain. Switching off `package-domain-whole` must
// demote it to the package's own exports-map target set, never to nothing.
const name = process.env.PLUGIN;
module.exports = require('pkg/lib/' + name);
