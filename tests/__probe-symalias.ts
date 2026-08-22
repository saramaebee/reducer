import { existsSync, lstatSync, readFileSync, readlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from '@reducer/cli';

const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');
const outDir = mkdtempSync(path.join(tmpdir(), 'reducer-probe-symalias-'));
const result = await run({
  entry: path.join(FIXTURES, '__probe-symalias', 'app.mjs'),
  outDir,
  write: true,
});

console.log('outDir:', outDir);
console.log('transformations:', JSON.stringify(result.manifest.transformations.map((t: any) => ({ file: t.file, symbol: t.symbol, type: t.type }))));

const alias = path.join(outDir, 'node_modules/minilodash-alias.mjs');
console.log('alias exists in artifact:', existsSync(alias));
if (existsSync(alias)) {
  console.log('alias is symlink:', lstatSync(alias).isSymbolicLink());
  console.log('alias target:', readlinkSync(alias));
  const viaAlias = readFileSync(alias, 'utf8');
  console.log('via-alias content has vuln marker:', viaAlias.includes('VULNERABLE-IMPLEMENTATION-MARKER'));
}
const direct = path.join(outDir, 'node_modules/minilodash/index.js');
const directSrc = readFileSync(direct, 'utf8');
console.log('direct artifact copy has vuln marker:', directSrc.includes('VULNERABLE-IMPLEMENTATION-MARKER'));

// Run the removed implementation from inside the artifact under stock node.
const script = `
import * as m from '${alias}';
const out = m.template('x<%= it %>y')({ it: 42 });
console.log('TEMPLATE-EXECUTED:', out);
`;
try {
  const r = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' });
  console.log('node run:', r.trim());
} catch (e: any) {
  console.log('node run FAILED:', (e.stderr || e.message).toString().slice(0, 500));
}
console.log('warnings:', JSON.stringify(result.manifest.warnings));
