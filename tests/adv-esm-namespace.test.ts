import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('adv-esm-namespace: clean namespace access vs escaped namespace', async () => {
  const { manifest } = await buildFixture('adv-esm-namespace');

  test('nslib.unusedNs is the only stub', () => {
    expect(manifest.transformations).toHaveLength(1);
    const tr = manifest.transformations[0];
    expect(tr.package).toContain('nslib');
    expect(tr.symbol).toBe('unusedNs');
  });

  test('nslib verdicts: used reachable, unusedNs proven-unreachable', () => {
    const used = manifest.verdicts.find((v) => v.module.includes('nslib') && v.symbol === 'used');
    expect(used?.state).toBe('proven-reachable');
    const unused = manifest.verdicts.find((v) => v.module.includes('nslib') && v.symbol === 'unusedNs');
    expect(unused?.state).toBe('proven-unreachable');
  });

  test('escns escaped: both exports retained as value-escaped, nothing stubbed', () => {
    const escns = manifest.verdicts.filter((v) => v.module.includes('escns'));
    expect(escns.map((v) => v.symbol).sort()).toEqual(['a', 'b']);
    for (const v of escns) {
      expect(v.state).toBe('possibly-reachable');
      expect(v.reasons).toContain('value-escaped');
    }
    expect(manifest.transformations.some((tr) => tr.file.includes('escns'))).toBe(false);
  });
});
