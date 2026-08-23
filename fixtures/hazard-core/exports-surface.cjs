function alpha() { return 1; }
function beta() { return alpha(); }
exports.alpha = alpha;
exports.beta = beta;
