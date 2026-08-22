import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

/**
 * Regressions for two confirmed soundness bugs found by adversarial attack
 * agents during the calibration round. Both were pre-existing in the spike.
 * The generic end-to-end soundness (reduced tree passes under stock node) is
 * covered by adversarial.test.ts auto-discovery; these lock the *mechanism*.
 */

describe('regression: overwritten CJS export key (temporal aliasing via require cycle)', async () => {
  const { manifest } = await buildFixture('adv-cjs-overwrite');
  test('a re-written export key widens the surface; nothing stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
    const cyclib = manifest.verdicts.filter((v) => v.module.includes('cyclib'));
    expect(cyclib.length).toBeGreaterThan(0);
    for (const v of cyclib) expect(v.state).not.toBe('proven-unreachable');
    expect(cyclib.some((v) => v.reasons.includes('export-object-mutation'))).toBe(true);
  });
});

describe('regression: ESM import-condition vs require-condition divergence', async () => {
  const { manifest } = await buildFixture('adv-esm-condition');
  test('resolver/NFT disagreement retains the package and warns', () => {
    expect(manifest.transformations).toHaveLength(0);
    expect(manifest.warnings.some((w) => w.includes('resolver/NFT disagreement'))).toBe(true);
    const beta = manifest.verdicts.find((v) => v.module.includes('real.js') && v.symbol === 'beta');
    expect(beta?.state).not.toBe('proven-unreachable');
    expect(beta?.reasons).toContain('resolver-trace-mismatch');
  });
});
