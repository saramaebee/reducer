import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-object: exported objects + computed property access', async () => {
  const { manifest } = await buildFixture('adv-esm-object');

  test('nothing is stubbed in either lib', () => {
    expect(manifest.transformations).toHaveLength(0);
    expect(manifest.metrics.reducer.functionsStubbed).toBe(0);
    for (const v of manifest.verdicts) {
      expect(v.state).not.toBe('proven-unreachable');
    }
  });

  test('objlib handlers is proven-reachable; impl (internal ref) has no stub verdict', () => {
    const handlers = manifest.verdicts.find(
      (v) => v.module.includes('objlib') && v.symbol === 'handlers',
    );
    expect(handlers?.state).toBe('proven-reachable');
    // impl is not an export; it must never appear as proven-unreachable.
    const impl = manifest.verdicts.find(
      (v) => v.module.includes('objlib') && v.symbol === 'impl',
    );
    expect(impl?.state ?? undefined).not.toBe('proven-unreachable');
  });

  test('computed access retains both keylib exports as possibly-reachable', () => {
    for (const name of ['first', 'second']) {
      const v = manifest.verdicts.find(
        (x) => x.module.includes('keylib') && x.symbol === name,
      );
      expect(v?.state).toBe('possibly-reachable');
      expect(v?.reasons).toContain('dynamic-property-access');
    }
  });
});
