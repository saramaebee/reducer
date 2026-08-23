/**
 * Sanity checks the corpus numbers rest on. Each one exists because its
 * violation would silently move a reported percentage rather than crash:
 *
 *  1. every universe file appears exactly once per plan, hot or cold;
 *  2. hot + cold == the total, for EVERY denominator (not just the universe);
 *  3. plan B's hot set is a superset of plan A's;
 *  4. absence from a SUCCESSFUL trace can make a file candidate-COLD;
 *  5. `nft: null` stays distinguishable from successful-trace absence;
 *  6. plan B's opaque input is `.own`, never ancestor-propagated `.all`;
 *  7. realpath-deduplicated universe files are not byte-counted twice.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { opaquePackages } from '@reducer/hazard-domain';
import { buildUniverse, realpath } from '@reducer/production-universe';
import { trace } from '@reducer/tracer';
import { planWorkingSet } from '@reducer/working-set-planner';
import { DENOMINATORS, classifyOpaque, joinPlan, measurePlan } from '../benchmarks/working-set/measure.ts';
import { FIXTURES } from './helpers.ts';

async function plans(fixture: string, entryFile = 'app.mjs') {
  const root = path.join(FIXTURES, fixture);
  const entry = path.join(root, entryFile);
  const universe = buildUniverse({ entry, root });
  const traced = await trace([entry], universe.root);
  const nft = new Set<string>();
  for (const f of traced.files) if (universe.byRel.has(f.rel)) nft.add(f.rel);
  const opaque = opaquePackages(universe, []);
  const planA = planWorkingSet({ universe, nft, app: fixture });
  const planB = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()), app: fixture });
  return { universe, nft, opaque, planA, planB, root };
}

describe('working-set measurement', () => {
  test('1/2: each plan partitions the universe once, and hot+cold == total in every denominator', async () => {
    const { universe, planA, planB } = await plans('basic');
    for (const [label, plan] of [
      ['A', planA],
      ['B', planB],
    ] as const) {
      const m = measurePlan(universe, plan, label);
      expect(m.denominators.universe.files).toBe(universe.files.length);
      for (const d of DENOMINATORS) {
        const x = m.denominators[d];
        expect(x.hotBytes + x.coldBytes).toBe(x.bytes);
        expect(x.hotFiles + x.coldFiles).toBe(x.files);
      }
      expect(m.denominators.thirdPartyJs.bytes).toBe(universe.D);
      // attributed reasons charge every hot byte exactly once
      const attributed = Object.values(m.reasons.attributed).reduce((a, b) => a + b, 0);
      expect(attributed).toBe(m.denominators.universe.hotBytes);
    }
  });

  test('3: plan B hot ⊇ plan A hot, and B never has fewer cold bytes than A has', async () => {
    const { universe, planA, planB } = await plans('basic');
    const hotA = new Set(planA.placements.filter((p) => p.placement === 'hot').map((p) => p.file));
    for (const p of planB.placements) if (p.placement === 'cold') expect(hotA.has(p.file)).toBe(false);
    const a = measurePlan(universe, planA, 'A');
    const b = measurePlan(universe, planB, 'B');
    for (const d of DENOMINATORS) expect(b.denominators[d].coldBytes).toBeLessThanOrEqual(a.denominators[d].coldBytes);
  });

  test('4/5: successful-trace absence yields cold bytes; a missing trace does not', async () => {
    // fixtures/nft-blind hides two modules behind computed specifiers, so the
    // trace SUCCEEDS and legitimately does not reach them.
    const { universe, planA } = await plans('nft-blind');
    const succeeded = measurePlan(universe, planA, 'A');
    expect(succeeded.predictive).toBe(true);
    expect(succeeded.denominators.universe.coldBytes).toBeGreaterThan(0);

    const blind = measurePlan(universe, planWorkingSet({ universe, nft: null }), 'A');
    expect(blind.predictive).toBe(false);
    expect(blind.denominators.universe.coldBytes).toBe(0);
    // and the two are not confusable: a real 0% would still be `predictive`
    expect(blind.reasons.attributed['no-positive-evidence']).toBe(blind.denominators.universe.hotBytes);
  });

  test('6: plan B uses opaquePackages().own — ancestor-propagated .all is NOT a virtualization constraint', async () => {
    const root = path.join(FIXTURES, 'hazard-res-regressions', 'res-f9-native-loader');
    const universe = buildUniverse({ entry: path.join(root, 'app.cjs'), root });
    const opaque = opaquePackages(universe, []);
    // premise: the .node lives in node_modules/native, and `.all` propagates
    // that up to the ROOT package, which owns the app's own files.
    expect(opaque.own.has(path.join(root, 'node_modules', 'native'))).toBe(true);
    expect(opaque.own.has(root)).toBe(false);
    expect(opaque.all.has(root)).toBe(true);

    const nft = new Set(universe.files.map((f) => f.rel)); // irrelevant here; isolate the opaque input
    const own = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.own.keys()) });
    const all = planWorkingSet({ universe, nft, opaquePkgDirs: new Set(opaque.all.keys()) });
    const reasonsFor = (plan: typeof own, rel: string) => plan.placements.find((p) => p.file === rel)!.reasons;
    expect(reasonsFor(own, 'app.cjs')).not.toContain('opaque-boundary');
    expect(reasonsFor(all, 'app.cjs')).toContain('opaque-boundary');
  });

  test('opaque evidence follows the artifact past a nested manifest, as opaquePackages does', () => {
    // A wasm-bindgen-shaped package: the artifact lives under a subdirectory
    // that ships its OWN package.json, so the file's nearest-manifest owner is
    // the inner dir. `opaquePackages` still marks the outer package (its scan
    // only stops at nested node_modules), and the classifier must agree — or
    // the outer package shows up as "unexplained" in the evidence breakdown
    // the Plan A → Plan B conclusion rests on.
    // realpath'd: buildUniverse canonicalizes its root, and on macOS the temp
    // dir arrives as a /var -> /private/var symlink, so unrealpath'd keys miss.
    const root = realpath(mkdtempSync(path.join(tmpdir(), 'reducer-ws-opaque-')));
    const write = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    };
    write('package.json', JSON.stringify({ name: 'opaque-app', version: '1.0.0' }));
    write('app.mjs', "import 'outer';\n");
    write('node_modules/outer/package.json', JSON.stringify({ name: 'outer', version: '1.0.0' }));
    write('node_modules/outer/index.js', 'export const x = 1;\n');
    write('node_modules/outer/build/compiler/package.json', JSON.stringify({ name: 'compiler', version: '0.0.0' }));
    write('node_modules/outer/build/compiler/compiler_bg.wasm', '\0asm fake');

    const universe = buildUniverse({ entry: path.join(root, 'app.mjs'), root });
    const opaque = opaquePackages(universe, []);
    const outer = path.join(root, 'node_modules', 'outer');
    expect(opaque.own.has(outer)).toBe(true); // premise
    const evidence = classifyOpaque(universe, opaque.own.keys(), new Set());
    expect(evidence.get(outer)).toBe('wasm-artifact');
    // and the root app package, which reaches the artifact only through
    // node_modules, is not credited with it
    expect(evidence.get(root)).toBeUndefined();
  });

  test('7: a physical file reached through two paths is counted once', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'reducer-ws-dedup-'));
    const write = (rel: string, content: string) => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    };
    write('package.json', JSON.stringify({ name: 'dedup-app', version: '1.0.0' }));
    write('app.mjs', "import 'dup';\n");
    // A pnpm-shaped tree: the real package lives in the store, and
    // node_modules/dup is a symlink to it. One physical file, two paths.
    write('store/dup/package.json', JSON.stringify({ name: 'dup', version: '1.0.0', main: 'index.js' }));
    write('store/dup/index.js', `export const x = ${'"padding"'.repeat(64)};\n`);
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    symlinkSync(path.join(root, 'store', 'dup'), path.join(root, 'node_modules', 'dup'));

    const universe = buildUniverse({ entry: path.join(root, 'app.mjs'), root });
    const reals = universe.files.map((f) => f.real);
    expect(new Set(reals).size).toBe(reals.length);

    const plan = planWorkingSet({ universe, nft: new Set(['app.mjs']) });
    // joinPlan re-proves physical uniqueness on the plan itself, which is what
    // the corpus runner relies on for every app.
    expect(joinPlan(universe, plan).length).toBe(universe.files.length);
    const m = measurePlan(universe, plan, 'A');
    const indexJs = universe.files.filter((f) => f.rel.endsWith('dup/index.js'));
    expect(indexJs.length).toBe(1);
    expect(m.denominators.universe.bytes).toBe(universe.files.reduce((a, f) => a + f.bytes, 0));
  });
});
