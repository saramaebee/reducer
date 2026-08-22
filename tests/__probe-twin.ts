import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '@reducer/cli';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const outDir = mkdtempSync(path.join(tmpdir(), 'reducer-probe-twin-'));
const result = await run({
  entry: path.join(FIXTURES, 'vuln-template', 'app.mjs'),
  outDir,
  write: true,
});

const twin = path.join(outDir, 'node_modules/minilodash/index.js');
console.log('outDir:', outDir);
console.log('twin exists:', existsSync(twin));
if (existsSync(twin)) {
  const src = readFileSync(twin, 'utf8');
  console.log('twin has marker:', src.includes('VULNERABLE-IMPLEMENTATION-MARKER-CVE-2021-23337-CLASS'));
  console.log('twin has full merge impl:', src.includes('export function merge'));
}
console.log('transformations:', JSON.stringify(result.manifest.transformations.map((t: any) => ({ file: t.file, symbol: t.symbol }))));
const mergeVerdicts = result.manifest.verdicts.filter((v: any) => v.symbol === 'merge');
console.log('merge verdicts:', JSON.stringify(mergeVerdicts.map((v: any) => ({ file: v.file, state: v.state }))));
const files = result.manifest.artifact?.files?.filter((f: any) => f.file.includes('minilodash'));
console.log('artifact minilodash provenance:', JSON.stringify(files, null, 1));
