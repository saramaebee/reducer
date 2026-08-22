import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixture } from './helpers.ts';

const { manifest, outDir } = await buildFixture('__probe-mapleak');
console.log('transformations:', manifest.transformations.map((t) => `${t.file}#${t.symbol}`));
const mapPath = path.join(outDir, 'node_modules/textlib/maps/index.js.map');
console.log('original map shipped:', existsSync(mapPath));
if (existsSync(mapPath)) {
  const map = readFileSync(mapPath, 'utf8');
  console.log('removed body recoverable (invalid LDAP URL in map):', map.includes('invalid LDAP URL'));
}
const transformed = readFileSync(path.join(outDir, 'node_modules/textlib/index.js'), 'utf8');
console.log('transformed file still stubbed:', transformed.includes('ReducerReachabilityViolation'));
console.log('transformed file references maps/index.js.map:', transformed.includes('maps/index.js.map'));
console.log('outDir:', outDir);
