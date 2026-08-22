import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-shared: ESM shared implementation via export alias', async () => {
  const { manifest } = await buildFixture('adv-esm-shared');

  test('nothing is stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
  });

  test('format is proven-reachable', () => {
    const format = manifest.verdicts.find(
      (v) => v.module.includes('sharedlib') && v.symbol === 'format',
    );
    expect(format?.state).toBe('proven-reachable');
  });

  test('fmt is retained as possibly-reachable with reason shared-implementation', () => {
    const fmt = manifest.verdicts.find(
      (v) => v.module.includes('sharedlib') && v.symbol === 'fmt',
    );
    expect(fmt?.state).toBe('possibly-reachable');
    expect(fmt?.reasons).toContain('shared-implementation');
  });
});
