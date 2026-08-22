import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-dynamic: literal dynamic import retains the whole target', async () => {
  const { manifest } = await buildFixture('adv-esm-dynamic');

  test('nothing is stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
    expect(manifest.metrics.reducer.functionsStubbed).toBe(0);
  });

  test('every dynlib export is retained with reason dynamic-import', () => {
    for (const symbol of ['used', 'unusedDyn']) {
      const v = manifest.verdicts.find((v) => v.module.includes('dynlib') && v.symbol === symbol);
      expect(v?.state).toBe('possibly-reachable');
      expect(v?.reasons).toContain('dynamic-import');
    }
  });

  test('no global hazards — retention comes from the dynamic-import rule', () => {
    expect(manifest.metrics.analyzer.globalHazards).toHaveLength(0);
  });
});
