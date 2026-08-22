'use strict';

// CJS require + alias chain: const a = require(...); const b = a; b.fn()
const a = require('aliaslib');
const b = a;
exports.callFnB = function callFnB() {
  return b.fnB();
};

// Property READ through the alias, called later via a plain local — a hole
// if the analyzer only records call-site property names.
const grabbed = b.fnC;
exports.callFnC = function callFnC() {
  return grabbed();
};

// Destructuring with rest: two() is only reachable through the rest object.
const { one, ...rest } = require('restlib');
exports.restOne = function restOne() {
  return one();
};
exports.restTwo = function restTwo() {
  return rest.two();
};
