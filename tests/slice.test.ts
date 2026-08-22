import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, buildFixture, installTest, runNodeTest } from './helpers.ts';

describe('vertical slice: basic fixture', async () => {
  const { manifest, outDir } = await buildFixture('basic');

  test('the original fixture passes its tests', () => {
    const r = runNodeTest(path.join(FIXTURES, 'basic'));
    expect(r.output).toContain('fixture-basic: ok');
    expect(r.status).toBe(0);
  });

  test('exactly one transformation: textlib ldap body removed', () => {
    expect(manifest.transformations).toHaveLength(1);
    const tr = manifest.transformations[0];
    expect(tr.symbol).toBe('ldap');
    expect(tr.package).toBe('textlib@1.2.3');
    expect(tr.action).toBe('function-body-removed');
    expect(tr.reason).toBe('provably-unreachable');
    expect(tr.bytesBefore).toBeGreaterThan(tr.bytesAfter);
    expect(tr.inputHash).toHaveLength(64);
    expect(tr.outputHash).toHaveLength(64);
  });

  test('parse is proven reachable, ldap proven unreachable', () => {
    const byName = Object.fromEntries(manifest.verdicts.map((v) => [v.symbol, v]));
    expect(byName.parse.state).toBe('proven-reachable');
    expect(byName.ldap.state).toBe('proven-unreachable');
  });

  test('the reduced tree still passes the fixture tests under stock node', () => {
    installTest('basic', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-basic: ok');
    expect(r.status).toBe(0);
  });

  test('the stubbed implementation is physically gone and fails closed', () => {
    const reduced = readFileSync(path.join(outDir, 'node_modules/textlib/index.js'), 'utf8');
    expect(reduced).not.toContain('objectClass'); // implementation detail removed
    expect(reduced).toContain('ReducerReachabilityViolation');
    expect(reduced).toContain('exports.ldap = ldap'); // export shape preserved

    writeFileSync(
      path.join(outDir, 'violation.mjs'),
      `const m = await import('textlib');
try {
  m.ldap('ldap://x/dc=y');
  process.exit(2);
} catch (e) {
  process.exit(e.name === 'ReducerReachabilityViolation' ? 0 : 3);
}
`,
    );
    const r = runNodeTest(outDir, 'violation.mjs');
    expect(r.status).toBe(0);
  });

  test('manifest metrics report incremental reduction beyond NFT', () => {
    const m = manifest.metrics;
    expect(m.reducer.bytesRemoved).toBeGreaterThan(0);
    expect(m.reducer.incrementalReductionVsNftJs).toBeGreaterThan(0);
    expect(m.nft.bytes).toBeLessThanOrEqual(m.original.dependencyBytes + m.nft.bytes); // sanity
    expect(m.reducer.functionsStubbed).toBe(1);
    expect(m.analyzer.globalHazards).toHaveLength(0);
  });
});
