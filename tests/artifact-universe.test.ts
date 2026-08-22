import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '@reducer/cli';
import { FIXTURES, buildFixture, installTest, runNodeTest } from './helpers.ts';

/**
 * Artifact-level soundness: the output is the production universe minus
 * proven-unreachable files — never the NFT trace. The critical invariant:
 *
 *   nftTrace.has(file) === false  does NOT imply  proven-unreachable.
 *
 * NFT omission must never authorize deletion.
 */
describe('nft-blind: zero transformations, NFT-invisible files still ship', async () => {
  const { manifest, trace, outDir } = await buildFixture('nft-blind');
  const blind = [
    'node_modules/hidden-cjs/index.js',
    'node_modules/hidden-esm/index.js',
    'node_modules/asset-carrier/data.txt',
  ];

  test('premise: NFT genuinely cannot trace the dynamic targets', () => {
    // If this fails, NFT learned to trace these — strengthen the fixture so
    // the invariant below keeps testing a real omission.
    for (const rel of blind) expect(trace.byRel.has(rel)).toBe(false);
  });

  test('zero transformations under the induced global hazards', () => {
    expect(manifest.transformations).toHaveLength(0);
    expect(manifest.metrics.analyzer.globalHazards.length).toBeGreaterThan(0);
  });

  test('NFT omission does not authorize deletion: untraced files are emitted', () => {
    for (const rel of blind) expect(existsSync(path.join(outDir, rel))).toBe(true);
  });

  test('provenance: untraced universe files carry unknown-dynamic-reachability; nothing removed', () => {
    const byFile = new Map(manifest.artifact.files.map((f) => [f.file, f]));
    for (const rel of blind) {
      expect(byFile.get(rel)?.state).toBe('retained');
      expect(byFile.get(rel)?.reasons).toContain('unknown-dynamic-reachability');
    }
    expect(manifest.artifact.removed).toHaveLength(0);
  });

  test('reduced tree behaves identically under stock node', () => {
    installTest('nft-blind', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-nft-blind: ok');
    expect(r.status).toBe(0);
  });
});

describe('dev-boundary: lockfile dev-only exclusion, positive evidence widens', async () => {
  const { manifest, outDir } = await buildFixture('dev-boundary');

  test('dev-only package is outside the production universe; prod dep ships', () => {
    expect(existsSync(path.join(outDir, 'node_modules/prodlib/index.js'))).toBe(true);
    expect(existsSync(path.join(outDir, 'node_modules/devonly'))).toBe(false);
    expect(manifest.artifact.devExcludedPackages).toContain('node_modules/devonly');
  });

  test('reduced tree behaves identically under stock node', () => {
    installTest('dev-boundary', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-dev-boundary: ok');
    expect(r.status).toBe(0);
  });

  test('an NFT-traced "dev" package is retained in full (positive evidence widens)', async () => {
    const out2 = mkdtempSync(path.join(tmpdir(), 'reducer-dev-traced-'));
    const { manifest: m2, outDir: dir2 } = await run({
      entry: path.join(FIXTURES, 'dev-boundary', 'app-uses-dev.mjs'),
      outDir: out2,
      write: true,
    });
    expect(existsSync(path.join(dir2!, 'node_modules/devonly/index.js'))).toBe(true);
    expect(m2.artifact.devExcludedPackages).not.toContain('node_modules/devonly');
    expect(m2.warnings.join('\n')).toContain('node_modules/devonly');
  });
});
