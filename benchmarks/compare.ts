/**
 * Phase-12 baseline comparison for a fixture:
 *   A. npm production dependency tree (node_modules bytes)
 *   B. NFT-only deployment
 *   C. esbuild production bundle
 *   D. Reducer (NFT + stubbing)
 */
import { build } from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { run } from '@reducer/cli';

const fixture = process.argv[2] ?? 'basic';
const dir = path.resolve(import.meta.dirname, '..', 'fixtures', fixture);
const entry = path.join(dir, 'app.mjs');

function dirBytes(d: string): number {
  if (!existsSync(d)) return 0;
  let bytes = 0;
  for (const e of readdirSync(d, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) bytes += statSync(path.join(e.parentPath, e.name)).size;
  }
  return bytes;
}

const { manifest } = await run({ entry, write: false });

let bundleBytes: number | null = null;
let bundleError: string | null = null;
try {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    minify: true,
    write: false,
    outdir: 'out',
    logLevel: 'silent',
  });
  bundleBytes = result.outputFiles.reduce((a, f) => a + f.contents.byteLength, 0);
} catch (e) {
  bundleError = e instanceof Error ? e.message : String(e);
}

const m = manifest.metrics;
const appBytes = statSync(entry).size;
const rows: [string, number | string][] = [
  ['A. npm production node_modules', dirBytes(path.join(dir, 'node_modules'))],
  ['B. NFT-only deployment', m.nft.bytes],
  ['C. esbuild bundle', bundleError ? `FAILED: ${bundleError}` : bundleBytes! ],
  ['D. Reducer (NFT + stubbing)', m.nft.bytes - m.reducer.bytesRemoved],
];

console.log(`fixture: ${fixture} (app entry ${appBytes} bytes)`);
for (const [label, v] of rows) console.log(`  ${label.padEnd(32)} ${v} ${typeof v === 'number' ? 'bytes' : ''}`);
console.log(`  incremental vs NFT: ${m.reducer.bytesRemoved} bytes (${(m.reducer.incrementalReductionVsNftJs * 100).toFixed(1)}% of traced JS)`);
if (typeof bundleBytes === 'number') {
  console.log(`  note: bundle removes packaging overhead the reducer intentionally preserves (package-preserving tree).`);
}
