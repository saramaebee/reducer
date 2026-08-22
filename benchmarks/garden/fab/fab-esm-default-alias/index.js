function core(seed) {
  /*<garden:esm-default-alias:default>*/
  const moons = ['callisto', 'europa', 'ganymede', 'io', 'titan', 'triton', 'phobos'];
  let acc = 37;
  for (let i = 0; i < seed.length; i++) {
    acc = (acc * 53 + seed.charCodeAt(i)) % 103991;
  }
  const orbit = [];
  for (let j = 0; j < 3; j++) {
    orbit.push(moons[(acc + j * 13) % moons.length] + ((acc >> (j + 2)) & 63));
  }
  return `esm-default-alias:default:${acc}-${orbit.join('/')}`;
  /*</garden:esm-default-alias:default>*/
}

export default core;
export { core as helper };
