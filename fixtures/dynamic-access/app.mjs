import lib from 'multilib';

// The property name is only known at runtime. A sound analyzer must retain
// every export of multilib.
export function run(name) {
  return lib[name]();
}
