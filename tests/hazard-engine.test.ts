/**
 * Engine-level semantics of the hazard-domain analyzer: universe/D accounting,
 * the reachability fixpoint, projection, byte prediction, and the two kinds of
 * counterfactual.
 *
 * Every case asserts BOTH directions — that the intended prediction happened
 * AND that the conservative default did not. A test that only checked the
 * strict side could not catch a refinement that quietly admits more than its
 * proof obligation; a test that only checked the refinement side could not
 * catch a strict model that already assumed the uncertainty away.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  analyzePrepared,
  prepareHazardDomain,
  type AnalysisConfig,
  type FilePrediction,
  type HazardDomainReport,
  type PreparedApp,
} from '../packages/hazard-domain/src/index.ts';

const FIX = path.resolve(import.meta.dirname, '..', 'fixtures', 'hazard-engine');
const preps = new Map<string, PreparedApp>();

async function prep(app: string): Promise<PreparedApp> {
  let p = preps.get(app);
  if (!p) preps.set(app, (p = await prepareHazardDomain({ app, entry: path.join(FIX, app, 'app.cjs') })));
  return p;
}
async function report(app: string, config?: AnalysisConfig): Promise<HazardDomainReport> {
  return analyzePrepared(await prep(app), config);
}
const file = (r: HazardDomainReport, rel: string): FilePrediction => {
  const f = r.files.find((x) => x.rel === rel);
  if (!f) throw new Error(`no prediction for ${rel}; have ${r.files.map((x) => x.rel).join(', ')}`);
  return f;
};
const removable = (r: HazardDomainReport): string[] =>
  r.files.filter((f) => f.state === 'predicted-removable-file').map((f) => f.rel).sort();
const sizeOf = (app: string, rel: string): number => statSync(path.join(FIX, app, rel)).size;

beforeAll(async () => {
  await Promise.all(['base', 'projected', 'projected-exact', 'escaped', 'vm', 'wrapper'].map(prep));
});

// ---------------------------------------------------------------------------
describe('universe and D', () => {
  test('D is the sum of third-party executable JS bytes; app code is excluded', async () => {
    const r = await report('base');
    const thirdParty = [
      'node_modules/condpkg/cjs.js',
      'node_modules/condpkg/esm.mjs',
      'node_modules/condpkg/extra.js',
      'node_modules/exact-dyn/index.js',
      'node_modules/pkg-scoped/a.js',
      'node_modules/pkg-scoped/index.js',
      'node_modules/pkg-scoped/unlisted.js',
      'node_modules/unreached/index.js',
    ];
    expect(r.D).toBe(thirdParty.reduce((a, rel) => a + sizeOf('base', rel), 0));
    expect(r.files.map((f) => f.rel).sort()).toEqual(thirdParty);
    // app.cjs and local.cjs are first-party: analyzed, never counted in D.
    expect(r.stats.universeJsFiles).toBe(thirdParty.length + 2);
    expect(r.stats.thirdPartyJsFiles).toBe(thirdParty.length);
  });

  test('the analyzer is reproducible: a source hash and a version accompany every number', async () => {
    const r = await report('base');
    expect(r.analyzerSourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.configLabel).toBe('strict');
  });
});

// ---------------------------------------------------------------------------
describe('strict fixpoint', () => {
  test('an unreached package file is the only file-level removal prediction', async () => {
    const r = await report('base');
    expect(removable(r)).toEqual(['node_modules/unreached/index.js']);
    expect(file(r, 'node_modules/unreached/index.js').blockingSet).toEqual([]);
  });

  test('D − E is exactly the removed file bytes when nothing is stubbed', async () => {
    const r = await report('base');
    const removed = sizeOf('base', 'node_modules/unreached/index.js');
    expect(r.D - r.E_predicted).toBe(removed);
    expect(r.implBytesEliminable).toBe(removed);
    expect(r.netReduction).toBeCloseTo(removed / r.D, 12);
  });

  test('an exact dynamic require reaches its target without widening', async () => {
    const r = await report('base');
    expect(file(r, 'node_modules/exact-dyn/index.js').state).toBe('retained-reachable');
    expect(file(r, 'node_modules/exact-dyn/index.js').blockingSet).not.toContain('unbounded-loader-target');
  });

  test('a package-scoped sink retains every JS file of that package, and says so', async () => {
    const r = await report('base');
    for (const rel of ['index.js', 'a.js', 'unlisted.js']) {
      const f = file(r, `node_modules/pkg-scoped/${rel}`);
      expect(f.state).toBe('retained-reachable');
      expect(f.blockingSet).toContain('package-domain-whole');
    }
  });

  test('a dynamic import into divergent exports conditions widens to the whole package', async () => {
    const r = await report('base');
    const f = file(r, 'node_modules/condpkg/extra.js');
    expect(f.state).toBe('retained-reachable');
    expect(f.blockingSet).toContain('import-condition-divergence');
    expect(f.blockingSet).toContain('package-domain-whole');
  });

  test('an unbounded load sink makes every universe module reachable', async () => {
    const r = await report('projected');
    expect(removable(r)).toEqual([]);
    expect(file(r, 'node_modules/surface/index.js').blockingSet).toContain('unbounded-loader-target');
  });

  test('a retained file never has an empty blocking set', async () => {
    for (const app of ['base', 'projected', 'escaped', 'vm', 'wrapper']) {
      const r = await report(app);
      for (const f of r.files) {
        if (f.state === 'predicted-removable-file') expect(f.blockingSet).toEqual([]);
        else expect(f.blockingSet.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('property projection', () => {
  test('PROJ-EXACT: a projection narrows the surface only on an EXACT-tier domain', async () => {
    const r = await report('projected-exact');
    const f = file(r, 'node_modules/surface/index.js');
    const byName = new Map(f.stubPredictions.map((s) => [s.symbol, s]));
    // ONE specific, known module: `.foo` IS the complete reachable surface, so
    // the co-located sibling stays predictable.
    expect(byName.get('foo')!.predicted).toBe(false);
    expect(byName.get('foo')!.blockingSet).toEqual(['static-import']);
    expect(byName.get('notFoo')!.predicted).toBe(true);
    expect(byName.get('notFoo')!.blockingSet).toEqual([]);
    expect(byName.get('notFoo')!.proofModel).toBe('function-body-stub');
  });

  test('PROJ-EXACT: an open-domain projection narrows NOTHING (the rescue lever is not sound)', async () => {
    const r = await report('projected');
    const f = file(r, 'node_modules/surface/index.js');
    const byName = new Map(f.stubPredictions.map((s) => [s.symbol, s]));
    // `require(k).foo()` with an unbounded `k`: with more than one candidate
    // module, `.foo` cannot be attributed as the COMPLETE reachable surface of
    // any particular physical module (module-identity unification needs the
    // exact instance). Garden `require-pkgscoped` is the refutation.
    for (const symbol of ['foo', 'notFoo']) {
      expect(byName.get(symbol)!.predicted).toBe(false);
      expect(byName.get(symbol)!.blockingSet).toContain('module-identity-unresolved');
    }
    expect(r.E_predicted).toBe(r.D);
  });

  test('an escaped result defeats the narrowing for the whole domain', async () => {
    const r = await report('escaped');
    const f = file(r, 'node_modules/surface/index.js');
    expect(f.stubPredictions.some((s) => s.predicted)).toBe(false);
    // The FILE is retained because its module is reachable; the SYMBOLS are
    // retained because the loaded value escaped — two different questions.
    expect(f.blockingSet).toContain('unbounded-loader-target');
    for (const s of f.stubPredictions) expect(s.blockingSet).toContain('value-escaped');
    // No stub is predicted, so the file is emitted whole and E === D.
    expect(r.E_predicted).toBe(r.D);
    expect(r.netReduction).toBe(0);
  });

  test('a stub larger than the body it replaces counts AGAINST the metric', async () => {
    const r = await report('projected-exact');
    const f = file(r, 'node_modules/surface/index.js');
    const notFoo = f.stubPredictions.find((s) => s.symbol === 'notFoo')!;
    // `function notFoo() {}` — the fail-closed throw is far bigger than `{}`.
    expect(notFoo.bodyBytes).toBe(2);
    expect(notFoo.netBytes).toBeLessThan(0);
    // E is the simulated emit, so the whole-app net reduction goes negative.
    expect(f.bytes).toBe(r.D - notFoo.netBytes);
    expect(r.E_predicted).toBeGreaterThan(r.D);
    expect(r.netReduction).toBeLessThan(0);
    // The security quantity is measured separately and stays positive.
    expect(r.implBytesEliminable).toBe(notFoo.bodyBytes);
  });
});

// ---------------------------------------------------------------------------
describe('gate-off counterfactuals (diagnostic, unsound)', () => {
  test('switching off the unbounded-target gate flips every file to removable', async () => {
    const r = await report('projected', { suppressGates: ['unbounded-loader-target'], label: 'off' });
    expect(removable(r)).toEqual(['node_modules/surface/index.js']);
    expect(r.E_predicted).toBe(0);
    expect(r.netReduction).toBe(1);
  });

  test('RES-F8: switching off package-domain-whole DEMOTES the package tier, it does not delete it', async () => {
    const r = await report('base', { suppressGates: ['package-domain-whole'] });
    // The counterfactual asks "what if the package tier were narrowed exactly?",
    // so the sink demotes to the package's own exports-map target set. Deleting
    // the sink outright would answer the much more flattering "what if this
    // sink did not exist?" and inflate the ADR-0006 headroom into fantasy.
    expect(removable(r)).toEqual([
      'node_modules/pkg-scoped/unlisted.js',
      'node_modules/unreached/index.js',
    ]);
    expect(file(r, 'node_modules/pkg-scoped/index.js').state).toBe('retained-reachable');
    expect(file(r, 'node_modules/pkg-scoped/a.js').state).toBe('retained-reachable');
    // The divergence gate is independent and still retains condpkg/extra.js.
    expect(file(r, 'node_modules/condpkg/extra.js').blockingSet).toContain('import-condition-divergence');
  });

  test('positive evidence can never be suppressed', async () => {
    const r = await report('base', { suppressGates: ['nft-positive-evidence', 'static-import', 'entrypoint'] });
    expect(removable(r)).toEqual(['node_modules/unreached/index.js']);
    expect(file(r, 'node_modules/exact-dyn/index.js').blockingSet).toContain('nft-positive-evidence');
  });
});

// ---------------------------------------------------------------------------
describe('sound refinement counterfactuals', () => {
  test('SR-subpath-exports-narrowing narrows a package tier to its exports targets', async () => {
    const strict = await report('base');
    expect(file(strict, 'node_modules/pkg-scoped/unlisted.js').state).toBe('retained-reachable');

    const r = await report('base', { refinements: ['SR-subpath-exports-narrowing'] });
    expect(removable(r)).toContain('node_modules/pkg-scoped/unlisted.js');
    // The two files the exports map DOES name stay retained.
    expect(file(r, 'node_modules/pkg-scoped/index.js').state).toBe('retained-reachable');
    expect(file(r, 'node_modules/pkg-scoped/a.js').state).toBe('retained-reachable');
  });

  test('SR-import-condition-resolution suppresses only the divergence widening', async () => {
    const r = await report('base', { refinements: ['SR-import-condition-resolution'] });
    expect(removable(r)).toContain('node_modules/condpkg/extra.js');
    // pkg-scoped is blocked by a DIFFERENT gate and must be untouched.
    expect(file(r, 'node_modules/pkg-scoped/unlisted.js').blockingSet).toEqual(['package-domain-whole']);
  });

  test('SR-F6: SR-vm-known-globals is WITHDRAWN and reclaims nothing', async () => {
    const strict = await report('vm');
    expect(removable(strict)).toEqual([]);
    expect(file(strict, 'node_modules/unreached/index.js').blockingSet).toEqual(['vm-conservative']);
    // The evidence is still collected — it is what the withdrawal is ABOUT.
    expect(strict.vmEvidence).toEqual([
      { api: 'vm.runInNewContext', contextArg: 'object-literal', literalKeys: ['x'], injectsLoaderLike: false, codeConstant: true },
    ]);

    // A vm context object is a HOST-realm object, so
    // `this.constructor.constructor('return process')()` reaches the host
    // realm even with an object-literal context, no loader-like key, and
    // constant code — the refinement's whole premise. It admits nothing, and
    // the run says why rather than reporting the strict number as a result.
    const r = await report('vm', { refinements: ['SR-vm-known-globals'] });
    expect(removable(r)).toEqual([]);
    expect(r.warnings.some((w) => w.includes('SR-vm-known-globals') && w.includes('WITHDRAWN'))).toBe(true);
    // A different refinement must not touch the vm site.
    const other = await report('vm', { refinements: ['SR-subpath-exports-narrowing'] });
    expect(removable(other)).toEqual([]);
  });

  test('SR-cross-module-wrapper uses the recorded call-site domains', async () => {
    const strict = await report('wrapper');
    expect(removable(strict)).toEqual([]);
    expect(file(strict, 'node_modules/unreached/index.js').blockingSet).toEqual(['wrapper-unprovable']);

    const r = await report('wrapper', { refinements: ['SR-cross-module-wrapper'] });
    expect(removable(r)).toEqual(['node_modules/unreached/index.js']);
    // The domain the call sites actually name is still reached.
    expect(file(r, 'node_modules/wrapped-target/index.js').state).toBe('retained-reachable');
    expect(r.E_predicted).toBe(r.D - sizeOf('wrapper', 'node_modules/unreached/index.js'));
  });
});

// ---------------------------------------------------------------------------
describe('absent positive evidence widens', () => {
  test('without an NFT trace no file-level removal prediction is admissible', async () => {
    const p = await prepareHazardDomain({ app: 'base', entry: path.join(FIX, 'base', 'app.cjs'), nft: false });
    expect(p.fileRemovalAdmissible).toBe(false);
    const r = analyzePrepared(p);
    expect(removable(r)).toEqual([]);
    expect(r.E_predicted).toBe(r.D);
    expect(file(r, 'node_modules/unreached/index.js').blockingSet).toEqual(['nft-positive-evidence']);
    expect(r.warnings.some((w) => w.includes('no positive reachability evidence'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('a file pulled into the universe during resolution', () => {
  // Regression: `resolveDomain` can `pullIn` a file AFTER prepare has parsed the
  // universe (frozen mode, positive evidence for an undeclared package). Such a
  // file used to reach the fixpoint with no ModuleFacts at all, so its own load
  // sinks were invisible — a `require(anything)` the analyzer never saw. That is
  // the one direction soundness forbids, and it also made D depend on how many
  // configurations had already been run off the same prepared app.
  test('is parsed, so its own load sinks are seen', async () => {
    const p = await prepareHazardDomain({
      app: 'pullin',
      entry: path.join(FIX, 'pullin', 'app.cjs'),
      frozenPackages: [
        { name: 'declared', version: '1.0.0' },
        { name: 'spare', version: '1.0.0' },
      ],
      nft: false, // isolate the resolve-time pull-in from the trace-time one
    });
    const undeclared = 'node_modules/undeclared/index.js';
    // Not declared, so prepare left it out of the universe entirely.
    expect(p.universe.byRel.has(undeclared)).toBe(false);
    expect(p.facts.has(undeclared)).toBe(false);

    const r = analyzePrepared(p);
    expect(r.warnings.some((w) => w.includes('universe divergence') && w.includes(undeclared))).toBe(true);
    expect(p.facts.has(undeclared)).toBe(true); // …and it was parsed

    // The unbounded loader inside the pulled-in module is now an active sink, so
    // an unreferenced third-party module can no longer be called unreachable.
    expect(file(r, 'node_modules/spare/index.js').state).toBe('retained-reachable');
    expect(file(r, 'node_modules/spare/index.js').blockingSet).toContain('unbounded-loader-target');
  });
});
