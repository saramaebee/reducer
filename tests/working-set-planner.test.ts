/**
 * The working-set planner's one non-negotiable property: it PLACES every
 * production-universe file, it never removes one. Hot ∪ cold must equal the
 * universe exactly; NFT-positive files and known-unsafe boundaries are forced
 * hot; and losing positive evidence widens the hot set to everything instead
 * of making any prediction.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { buildUniverse } from '@reducer/production-universe';
import { opaquePackages } from '@reducer/hazard-domain';
import { trace } from '@reducer/tracer';
import { planWorkingSet } from '@reducer/working-set-planner';
import { FIXTURES } from './helpers.ts';

async function planFixture(name: string) {
  const entry = path.join(FIXTURES, name, 'app.mjs');
  const universe = buildUniverse({ entry, root: path.join(FIXTURES, name) });
  const traced = await trace([entry], universe.root);
  const nft = new Set<string>();
  for (const f of traced.files) if (universe.byRel.has(f.rel)) nft.add(f.rel);
  // `.own`, not `.all`: ancestor propagation is conservative export-surface
  // semantics, not a virtualization constraint (see PlanInput.opaquePkgDirs).
  const opaque = opaquePackages(universe, []);
  return { universe, nft, plan: planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()) }) };
}

describe('working-set planner (naive, ADR-0007 experiment 1)', () => {
  test('placement partitions the universe exactly — nothing added, nothing removed', async () => {
    const { universe, plan } = await planFixture('basic');
    expect(plan.placements.length).toBe(universe.files.length);
    const planned = new Set(plan.placements.map((p) => p.file));
    for (const f of universe.files) expect(planned.has(f.rel)).toBe(true);
    expect(plan.bytes.forcedHot + plan.bytes.candidateCold).toBe(plan.bytes.universe);
    expect(plan.bytes.universe).toBe(universe.files.reduce((a, f) => a + f.bytes, 0));
  });

  test('positive evidence, the entrypoint, and resolver metadata are forced hot', async () => {
    const { nft, plan } = await planFixture('basic');
    const byFile = new Map(plan.placements.map((p) => [p.file, p]));
    for (const rel of nft) expect(byFile.get(rel)?.placement).toBe('hot');
    expect(byFile.get('app.mjs')?.reasons).toContain('entrypoint');
    for (const p of plan.placements) {
      if (p.file.endsWith('package.json')) expect(p.placement).toBe('hot');
      if (p.placement === 'cold') expect(p.reasons).toEqual([]);
      if (p.placement === 'hot') expect(p.reasons.length).toBeGreaterThan(0);
    }
  });

  test('a cold candidate exists under a successful trace', async () => {
    // In fixtures/basic the only untraced file is the fixture's own test.mjs
    // (textlib/index.js is statically imported, so at whole-file granularity
    // it is NFT-positive). Still proves cold placement under a real trace.
    const { plan } = await planFixture('basic');
    const cold = plan.placements.filter((p) => p.placement === 'cold');
    expect(cold.length).toBeGreaterThan(0);
    expect(plan.bytes.coldFraction).toBeGreaterThan(0);
  });

  test('CASE B: absence from a SUCCESSFUL trace means candidate COLD, not fail-safe hot', async () => {
    // fixtures/nft-blind loads hidden-cjs/hidden-esm through computed
    // specifiers that are invisible to @vercel/nft BY CONSTRUCTION. Under the
    // old conservative model that absence forced retention; under ADR-0007 it
    // is exactly what makes the files candidate COLD — a runtime request for
    // them is the recoverable hydration miss the experiment measures.
    const { nft, plan } = await planFixture('nft-blind');
    const byFile = new Map(plan.placements.map((p) => [p.file, p]));
    for (const rel of [
      'node_modules/hidden-cjs/index.js',
      'node_modules/hidden-esm/index.js',
      'node_modules/asset-carrier/data.txt',
    ]) {
      expect(nft.has(rel)).toBe(false); // premise: the trace really is blind here
      expect(byFile.get(rel)?.placement).toBe('cold');
      expect(byFile.get(rel)?.reasons).toEqual([]);
    }
    // …while the statically-visible loader stays hot on positive evidence.
    expect(byFile.get('node_modules/blind-loader/index.js')?.placement).toBe('hot');
  });

  test('no positive evidence ⇒ everything hot, prediction refused not files dropped', async () => {
    const entry = path.join(FIXTURES, 'basic', 'app.mjs');
    const universe = buildUniverse({ entry, root: path.join(FIXTURES, 'basic') });
    const plan = planWorkingSet({ universe, nft: null });
    expect(plan.placements.every((p) => p.placement === 'hot')).toBe(true);
    expect(plan.bytes.candidateCold).toBe(0);
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});
