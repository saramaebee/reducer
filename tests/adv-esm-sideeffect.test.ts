import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-sideeffect: side-effectful ESM module init', async () => {
  const { manifest } = await buildFixture('adv-esm-sideeffect');

  test('only unusedSide is stubbed', () => {
    expect(manifest.transformations).toHaveLength(1);
    const tr = manifest.transformations[0];
    expect(tr.symbol).toBe('unusedSide');
    expect(tr.package).toBe('sidelib@1.0.0');
    expect(tr.action).toBe('function-body-removed');
    expect(tr.bytesBefore).toBeGreaterThan(tr.bytesAfter);
  });

  test('activate is retained via internal-reference (init-time call)', () => {
    const activate = manifest.verdicts.find(
      (v) => v.module.includes('sidelib') && v.symbol === 'activate',
    );
    expect(activate?.state).toBe('possibly-reachable');
    expect(activate?.reasons).toContain('internal-reference');
  });

  test('getValue is proven reachable, unusedSide proven unreachable', () => {
    const byName = Object.fromEntries(
      manifest.verdicts
        .filter((v) => v.module.includes('sidelib'))
        .map((v) => [v.symbol, v]),
    );
    expect(byName.getValue.state).toBe('proven-reachable');
    expect(byName.unusedSide.state).toBe('proven-unreachable');
  });
});
