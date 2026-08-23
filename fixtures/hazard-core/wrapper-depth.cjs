function l0(a) { return require(a); }
function l1(a) { return l0(a); }
function l2(a) { return l1(a); }
function l3(a) { return l2(a); }
l3('lodash');
