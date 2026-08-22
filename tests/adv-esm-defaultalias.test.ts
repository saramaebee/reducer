import { describe, expect, test } from 'bun:test';
import { buildFixture } from './helpers.ts';

describe('regression: default export aliasing a named export', async () => {
  const { manifest } = await buildFixture('adv-esm-defaultalias');

  test('core body is never stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
    const lib = manifest.transformations.filter((t) => t.file.includes('defaultalias'));
    expect(lib).toHaveLength(0);
  });

  test('helper is never proven-unreachable', () => {
    const helper = manifest.verdicts.find(
      (v) => v.module.includes('defaultalias') && v.symbol === 'helper',
    );
    expect(helper).toBeDefined();
    expect(helper?.state).not.toBe('proven-unreachable');
  });

  test('default is never proven-unreachable or stubbable', () => {
    const def = manifest.verdicts.find(
      (v) => v.module.includes('defaultalias') && v.symbol === 'default',
    );
    expect(def).toBeDefined();
    expect(def?.state).not.toBe('proven-unreachable');
  });
});
