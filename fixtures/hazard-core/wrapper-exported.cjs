function load(name) {
  return require(name);
}
load('lodash');
module.exports = load;
