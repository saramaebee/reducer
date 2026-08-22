import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('regression: ESM named imports produce positive reduction', async () => {
  const { manifest } = await buildFixture('adv-esm-named');

  test('unusedBig is stubbed (guards the export-declaration false-conservatism fix)', () => {
    const t = manifest.transformations.find(
      (t) => t.file.includes('esmnamed') && t.symbol === 'unusedBig',
    );
    expect(t).toBeDefined();
    expect(t?.action).toBe('function-body-removed');
    expect(t?.reason).toBe('provably-unreachable');
    const v = manifest.verdicts.find((v) => v.module.includes('esmnamed') && v.symbol === 'unusedBig');
    expect(v?.state).toBe('proven-unreachable');
    expect(v?.reasons).toContain('not-imported-anywhere');
  });

  test('used and aliased alsoUsed stay proven-reachable', () => {
    for (const symbol of ['used', 'alsoUsed']) {
      const v = manifest.verdicts.find((v) => v.module.includes('esmnamed') && v.symbol === symbol);
      expect(v?.state).toBe('proven-reachable');
    }
    expect(manifest.transformations).toHaveLength(1);
  });
});
