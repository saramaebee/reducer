if (typeof require === 'function' && require.main === module) {
  run();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { run };
}
function run() { return 1; }
