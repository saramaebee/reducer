function load(name) {
  name = name + '/index.js';
  return require(name);
}
load('lodash');
