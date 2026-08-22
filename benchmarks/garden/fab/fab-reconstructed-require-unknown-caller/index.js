function loadAny(id) { try { return require(id); } catch { return null; } }

exports.loadAny = loadAny;
