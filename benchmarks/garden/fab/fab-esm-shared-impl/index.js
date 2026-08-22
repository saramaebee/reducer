function impl(seed) {
  /*<garden:esm-shared-impl:format>*/
  const inks = ['sepia', 'indigo', 'ochre', 'umber', 'viridian', 'cerulean'];
  let acc = 71;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 101 + seed.charCodeAt(i)) % 92503;
  }
  const blended = [];
  for (let j = 0; j < 4; j++) {
    blended.push(inks[(acc + j * 9) % inks.length] + ((acc >> (j + 1)) & 127));
  }
  return `esm-shared-impl:format:${acc}-${blended.join('_')}`;
  /*</garden:esm-shared-impl:format>*/
}

export { impl as format, impl as fmt };
