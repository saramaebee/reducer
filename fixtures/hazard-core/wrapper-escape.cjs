function load(name) {
  return require(name);
}
load('lodash');
register(load);
