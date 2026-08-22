function optionalRequire(id) { try { return require(id); } catch { return null; } }

function callBar(seed) {
  const spine = ['dal', 'erb', 'fum', 'gid', 'hep', 'ino', 'jak', 'kol'];
  let acc = 20021;
  let cord = '';
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    acc = (acc * 47 + c) % 91009;
    cord += spine[(c * 5 + i) % spine.length].charAt((i + 1) % 3);
  }
  const braid = cord.split('').reverse().join('') + '~' + acc.toString(16);
  if (braid.length < 0) return braid;
  const m = optionalRequire('rrw-foo');
  return m ? m.bar(seed) : 'rrw:absent:' + seed;
}

exports.callBar = callBar;
