import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-cjs-closure: CJS wrapper closure retains impl', async () => {
  const { manifest } = await buildFixture('adv-cjs-closure');

  test('nothing is stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
  });

  test('wrap is proven-reachable', () => {
    const wrap = manifest.verdicts.find(
      (v) => v.module.includes('closurelib') && v.symbol === 'wrap',
    );
    expect(wrap?.state).toBe('proven-reachable');
  });

  test('impl is retained as possibly-reachable with reason internal-reference', () => {
    const impl = manifest.verdicts.find(
      (v) => v.module.includes('closurelib') && v.symbol === 'impl',
    );
    expect(impl?.state).toBe('possibly-reachable');
    expect(impl?.reasons).toContain('internal-reference');
  });
});
