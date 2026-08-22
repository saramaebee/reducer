import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-reexport: named re-export vs export *', async () => {
  const { manifest } = await buildFixture('adv-esm-reexport');

  test('midlib beta is the only stub (unreachable through the named re-export)', () => {
    expect(manifest.transformations).toHaveLength(1);
    const t = manifest.transformations[0];
    expect(t.package).toBe('midlib@1.0.0');
    expect(t.file).toBe('node_modules/midlib/impl.js');
    expect(t.symbol).toBe('beta');
    expect(t.action).toBe('function-body-removed');
    expect(t.reason).toBe('provably-unreachable');
  });

  test('midlib verdicts: alpha proven-reachable, beta proven-unreachable', () => {
    const alpha = manifest.verdicts.find((v) => v.module.includes('midlib') && v.symbol === 'alpha');
    expect(alpha?.state).toBe('proven-reachable');
    const beta = manifest.verdicts.find((v) => v.module.includes('midlib') && v.symbol === 'beta');
    expect(beta?.state).toBe('proven-unreachable');
  });

  test('starlib: export * widens everything; nothing from starlib is stubbed', () => {
    expect(manifest.transformations.some((t) => t.file.includes('starlib'))).toBe(false);
    const star = manifest.verdicts.filter((v) => v.module.includes('starlib'));
    expect(star.length).toBeGreaterThan(0);
    for (const v of star) {
      expect(v.state).not.toBe('proven-unreachable');
    }
    const delta = star.find((v) => v.symbol === 'delta');
    expect(delta?.state).toBe('possibly-reachable');
    expect(delta?.reasons).toContain('export-star');
  });
});
