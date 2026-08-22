import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { FIXTURES, buildFixture, installTest, runNodeTest } from './helpers.ts';

/**
 * Every fixtures/adv-* directory is an adversarial case (several were
 * authored by attack agents, three are regressions for confirmed
 * unsoundness bugs). The universal soundness property: the fixture's own
 * test suite must pass on the REDUCED tree under stock node.
 */
const advFixtures = readdirSync(FIXTURES).filter((d) => d.startsWith('adv-'));

describe('adversarial fixtures stay sound end-to-end', () => {
  for (const name of advFixtures) {
    test(name, async () => {
      const original = runNodeTest(path.join(FIXTURES, name));
      expect(original.output).toContain(`fixture-${name}: ok`);
      expect(original.status).toBe(0);

      const { outDir } = await buildFixture(name);
      installTest(name, outDir);
      const reduced = runNodeTest(outDir);
      expect(reduced.output).toContain(`fixture-${name}: ok`);
      expect(reduced.status).toBe(0);
    });
  }
});

describe('regression: aliased exports share one implementation', async () => {
  const { manifest } = await buildFixture('adv-aliasexport');

  test('fn body is never stubbed while any alias is reachable', () => {
    expect(manifest.transformations).toHaveLength(0);
  });

  test('the unreachable alias is demoted with an explicit reason', () => {
    const b = manifest.verdicts.find((v) => v.module.includes('aliasexp') && v.symbol === 'b');
    expect(b?.state).toBe('possibly-reachable');
    expect(b?.reasons).toContain('shared-implementation');
    const a = manifest.verdicts.find((v) => v.module.includes('aliasexp') && v.symbol === 'a');
    expect(a?.state).toBe('proven-reachable');
  });
});

describe('regression: require used as a value', async () => {
  const { manifest } = await buildFixture('adv-requirevalue');

  test('aliased require is a global hazard; nothing is stubbed', () => {
    expect(manifest.metrics.analyzer.globalHazards).toContain('dynamic-require');
    expect(manifest.transformations).toHaveLength(0);
  });
});

describe('regression: chained export assignment', async () => {
  const { manifest } = await buildFixture('adv-chained');

  test('chained exports.a = exports.b = fn refuses recognition; nothing stubbed', () => {
    expect(manifest.transformations).toHaveLength(0);
    const chainlib = manifest.verdicts.filter((v) => v.module.includes('chainlib'));
    expect(chainlib.length).toBeGreaterThan(0);
    for (const v of chainlib) {
      expect(v.state).not.toBe('proven-unreachable');
    }
    expect(chainlib.some((v) => v.reasons.includes('export-object-mutation'))).toBe(true);
  });
});
