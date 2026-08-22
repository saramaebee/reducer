import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixture, installTest, runNodeTest } from './helpers.ts';

describe('retention: dynamic property access', async () => {
  const { manifest, outDir } = await buildFixture('dynamic-access');

  test('nothing is transformed', () => {
    expect(manifest.transformations).toHaveLength(0);
    expect(manifest.metrics.reducer.functionsStubbed).toBe(0);
  });

  test('all multilib exports retained with an explicit reason', () => {
    const multilib = manifest.verdicts.filter((v) => v.module.includes('multilib'));
    expect(multilib.length).toBeGreaterThanOrEqual(2);
    for (const v of multilib) {
      expect(v.state).not.toBe('proven-unreachable');
    }
    expect(multilib.some((v) => v.reasons.includes('dynamic-property-access'))).toBe(true);
  });

  test('reduced tree byte-identical for the library and fully functional', () => {
    const orig = readFileSync(
      path.resolve(import.meta.dirname, '../fixtures/dynamic-access/node_modules/multilib/index.js'),
      'utf8',
    );
    const reduced = readFileSync(path.join(outDir, 'node_modules/multilib/index.js'), 'utf8');
    expect(reduced).toBe(orig);

    installTest('dynamic-access', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-dynamic-access: ok');
    expect(r.status).toBe(0);
  });
});

describe('retention: namespace escape', async () => {
  const { manifest, outDir } = await buildFixture('escape');

  test('nothing is transformed', () => {
    expect(manifest.transformations).toHaveLength(0);
  });

  test('esclib exports retained due to value escape', () => {
    const esclib = manifest.verdicts.filter((v) => v.module.includes('esclib'));
    expect(esclib.length).toBeGreaterThanOrEqual(2);
    for (const v of esclib) {
      expect(v.state).not.toBe('proven-unreachable');
    }
    expect(esclib.some((v) => v.reasons.includes('value-escaped'))).toBe(true);
  });

  test('reduced tree passes, including the never-imported export', () => {
    installTest('escape', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-escape: ok');
    expect(r.status).toBe(0);
  });
});
