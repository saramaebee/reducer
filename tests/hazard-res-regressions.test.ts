/**
 * RES-* / PROJ-EXACT / SR-* / REP-* soundness regressions (ADR-0006 defect
 * ledger), the resolution / fixpoint / projection / reporting half.
 *
 * Every fixture in `fixtures/hazard-res-regressions/` is a RUNNABLE app: run
 * `node app.cjs` inside it and the "victim" code prints. Before the fix the
 * strict analyzer predicted that code removable (or, for the metric items,
 * reported a number that could not be added up). Each test asserts the WIDENING
 * that replaced the wrong answer and names the gate responsible.
 *
 * Direction matters. This analyzer may only widen, so the failure worth locking
 * down is a future change that narrows one of these back. Blocking sets are
 * asserted with `toContain`, which stays sensitive to a gate disappearing while
 * tolerating an unrelated extra widening. The two CONTROL cases (a genuinely
 * absent package, and a gate-off demotion) assert the opposite direction, so a
 * "fix" that just widens everything cannot pass this file either.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  analyzePrepared,
  prepareHazardDomain,
  runFixpoint,
  buildUniverse,
  WITHDRAWN_REFINEMENTS,
  type AnalysisConfig,
  type FilePrediction,
  type HazardDomainReport,
  type ModuleFacts,
  type PreparedApp,
  type ResolvedTargetDomain,
} from '../packages/hazard-domain/src/index.ts';
import { hasImportConditionDivergence } from '../packages/hazard-domain/src/resolve.ts';

const FIX = path.resolve(import.meta.dirname, '..', 'fixtures', 'hazard-res-regressions');

const APPS = [
  'res-f1-condition-default',
  'res-f1-condition-node',
  'res-f2-esm-static-edge',
  'res-f3-unresolved-static-edge',
  'res-f4-missing-vs-blocked',
  'res-f4-absent-package-proof',
  'res-f8-resolve-sink',
  'res-f8-package-demote',
  'res-f8-unbounded-demote',
  'res-f9-native-loader',
  'res-f11-realpath-case',
  'proj-exact-package-tier',
  'sr-f6-vm-cross-realm',
  'sr-f7-cross-module-wrapper',
  'rep-f10-net-apportion',
] as const;

const preps = new Map<string, PreparedApp>();
const strict = new Map<string, HazardDomainReport>();

beforeAll(async () => {
  await Promise.all(
    APPS.map(async (app) => {
      const p = await prepareHazardDomain({ app, entry: path.join(FIX, app, 'app.cjs') });
      preps.set(app, p);
      strict.set(app, analyzePrepared(p));
    }),
  );
});

const report = (app: string): HazardDomainReport => {
  const r = strict.get(app);
  if (!r) throw new Error(`no report for ${app}`);
  return r;
};
const under = (app: string, config: AnalysisConfig): HazardDomainReport => {
  const p = preps.get(app);
  if (!p) throw new Error(`no prep for ${app}`);
  return analyzePrepared(p, config);
};
const file = (r: HazardDomainReport, rel: string): FilePrediction => {
  const f = r.files.find((x) => x.rel === rel);
  if (!f) throw new Error(`no prediction for ${rel}; have ${r.files.map((x) => x.rel).join(', ')}`);
  return f;
};
const removable = (r: HazardDomainReport): string[] =>
  r.files.filter((f) => f.state === 'predicted-removable-file').map((f) => f.rel).sort();
const symbol = (r: HazardDomainReport, rel: string, name: string) => {
  const s = file(r, rel).stubPredictions.find((x) => x.symbol === name);
  if (!s) throw new Error(`no stub prediction for ${rel}#${name}`);
  return s;
};

// ---------------------------------------------------------------------------
describe('RES-F1 — import-condition divergence is decided by evaluating both orders', () => {
  // The old test demanded a literal `import` AND a literal `require` key in the
  // same object. `{import,default}` and `{import,node}` have neither pair, yet
  // node loads esm.mjs while createRequire().resolve answers cjs.js.
  for (const [app, shape] of [
    ['res-f1-condition-default', '{import, default}'],
    ['res-f1-condition-node', '{import, node}'],
  ] as const) {
    test(`${shape} diverges and widens to the whole package`, () => {
      const r = report(app);
      for (const rel of ['node_modules/dual/cjs.js', 'node_modules/dual/esm.mjs']) {
        expect(file(r, rel).state).not.toBe('predicted-removable-file');
        expect(file(r, rel).blockingSet).toContain('import-condition-divergence');
      }
      // esm.mjs is the file node actually runs; it must not be predicted absent.
      expect(removable(r)).toEqual([]);
    });
  }

  test('the two-order evaluation itself: divergent shapes vs an agreeing one', () => {
    const dir = (app: string) => path.join(FIX, app, 'node_modules', 'dual');
    expect(hasImportConditionDivergence(dir('res-f1-condition-default'))).toBe(true);
    expect(hasImportConditionDivergence(dir('res-f1-condition-node'))).toBe(true);
    // Control: one target under every condition cannot diverge, and a package
    // with no exports map at all cannot either. Without these the rule could be
    // satisfied by answering `true` unconditionally.
    expect(hasImportConditionDivergence(path.join(FIX, 'res-f9-native-loader', 'node_modules', 'victim'))).toBe(false);
    expect(hasImportConditionDivergence(path.join(FIX, 'res-f8-package-demote', 'node_modules', 'pkg'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F2 — an ESM static edge is resolved under import conditions', () => {
  test('a static import into a divergent package widens to the whole package', () => {
    const r = report('res-f2-esm-static-edge');
    // `createRequire().resolve` answers cjs.js; node loads esm.mjs. Both stay.
    for (const rel of ['node_modules/dual/cjs.js', 'node_modules/dual/esm.mjs']) {
      expect(file(r, rel).state).not.toBe('predicted-removable-file');
      expect(file(r, rel).blockingSet).toContain('import-condition-divergence');
    }
    // The projection cannot attribute `hello` to either physical module, so the
    // whole surface of both is retained.
    expect(symbol(r, 'node_modules/dual/esm.mjs', 'hello').predicted).toBe(false);
    expect(r.widened.some((w) => w.why.includes('import conditions'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F3 — an unresolved static edge widens instead of vanishing', () => {
  test('an import-only exports map is ignorance, not proof', () => {
    const r = report('res-f3-unresolved-static-edge');
    const f = file(r, 'node_modules/esmonly/index.js');
    expect(f.state).not.toBe('predicted-removable-file');
    expect(f.blockingSet).toContain('unresolved-specifier');
    expect(symbol(r, 'node_modules/esmonly/index.js', 'hi').predicted).toBe(false);
    expect(r.widened.some((w) => w.why.includes('unresolved-specifier'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F4 — only a genuinely absent package contributes nothing', () => {
  test('installed but blocked under the require condition widens', () => {
    const r = report('res-f4-missing-vs-blocked');
    const f = file(r, 'node_modules/blocked/esm.mjs');
    expect(f.state).not.toBe('predicted-removable-file');
    expect(f.blockingSet).toContain('unresolved-specifier');
  });

  test('CONTROL: an absent package is still a real empty-contribution proof', () => {
    // The opposite direction. `require('absent')` names nothing on disk, so the
    // sink's target set is genuinely empty and `spare` stays removable. A "fix"
    // that widened on every resolution failure would break this.
    const r = report('res-f4-absent-package-proof');
    expect(removable(r)).toEqual(['node_modules/spare/index.js']);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F5 — a reachable module with no facts is opaque, never inert', () => {
  test('the fixpoint widens rather than treating a factless module as silent', () => {
    // A file can join the universe DURING the fixpoint (`pullIn`), i.e. after
    // prepare parsed everything. Reaching it with no ModuleFacts used to mean
    // "contributes no load sinks" — hiding a `require(x)` the module really has.
    const app = 'res-f4-absent-package-proof';
    const p = preps.get(app)!;
    const noFacts = new Map<string, ModuleFacts>(); // simulate the factless state
    const fx = runFixpoint({
      universe: p.universe,
      facts: noFacts,
      nft: null,
      resolveCache: new Map<string, ResolvedTargetDomain>(),
      opaque: p.opaque.own,
    });
    expect(fx.unboundedActive).toBe(true);
    expect(fx.unboundedGates).toContain('unsupported-syntax');
    expect(fx.reachable.has('node_modules/spare/index.js')).toBe(true);
  });

  test('a file pulled in mid-fixpoint is inside the mass-mark, not outside it', () => {
    // The `allJs` memo is keyed on the universe size, so a `pullIn` after the
    // first unbounded sink cannot leave the newcomer unmarked.
    const p = preps.get('res-f4-absent-package-proof')!;
    const u = buildUniverse({ entry: p.universe.entryAbs, root: p.universe.root });
    const before = u.files.length;
    const fx = runFixpoint({
      universe: u,
      facts: new Map<string, ModuleFacts>(),
      nft: null,
      resolveCache: new Map<string, ResolvedTargetDomain>(),
    });
    expect(u.files.length).toBe(before);
    for (const f of u.files) if (f.isJs) expect(fx.reachable.has(f.rel)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F8 — a gate-off counterfactual DEMOTES a sink, it never deletes one', () => {
  test('a resolve-effect sink is unsuppressible whatever is switched off', () => {
    const app = 'res-f8-resolve-sink';
    expect(file(report(app), 'node_modules/victim/big.js').blockingSet).toContain('resolve-sink-retained');
    const r = under(app, {
      suppressGates: [
        'unbounded-loader-target',
        'generated-source-unknown',
        'escaped-loader',
        'unresolved-specifier',
        'package-domain-whole',
        'dynamic-property-access',
        'value-escaped',
      ],
    });
    expect(removable(r)).toEqual([]);
    expect(r.E_predicted).toBe(r.D);
    expect(file(r, 'node_modules/victim/big.js').blockingSet).toContain('resolve-sink-retained');
  });

  test('package tier: switching off package-domain-whole demotes to the exports targets', () => {
    const app = 'res-f8-package-demote';
    expect(file(report(app), 'node_modules/pkg/lib/a.js').blockingSet).toContain('package-domain-whole');
    const r = under(app, { suppressGates: ['package-domain-whole'] });
    // Only the file the exports map names NOWHERE is released…
    expect(removable(r)).toEqual(['node_modules/pkg/unlisted.js']);
    // …the exports-map targets stay. If the sink had been deleted instead, all
    // four would be removable and the headroom number would be fantasy.
    for (const n of ['a', 'b', 'c']) {
      expect(file(r, `node_modules/pkg/lib/${n}.js`).state).toBe('retained-reachable');
    }
  });

  test('unbounded tier: switching off the gate demotes to the files that DID resolve', async () => {
    const app = 'res-f8-unbounded-demote';
    expect(file(report(app), 'node_modules/spare/index.js').blockingSet).toContain('unresolved-specifier');
    const r = under(app, { suppressGates: ['unresolved-specifier'] });
    // The universe-wide widening is off, so the bystander is released…
    expect(removable(r)).toEqual(['node_modules/spare/index.js']);
    expect(file(r, 'node_modules/good/index.js').state).toBe('retained-reachable');

    // …and `good` is retained by the DEMOTED SINK, not merely by the trace.
    // Asserted on the fixpoint with positive evidence switched off, because
    // NFT also reaches `good` and would mask a deleted sink entirely.
    const p = await prepareHazardDomain({ app, entry: path.join(FIX, app, 'app.cjs'), nft: false });
    const fx = runFixpoint(
      { universe: p.universe, facts: p.facts, nft: null, resolveCache: new Map<string, ResolvedTargetDomain>(), opaque: p.opaque.own },
      { suppressGates: ['unresolved-specifier'] },
    );
    expect(fx.reachable.has('node_modules/good/index.js')).toBe(true);
    expect(fx.reachable.has('node_modules/spare/index.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F9 — native/wasm loader symmetry', () => {
  test('a reachable module in an opaque package is an Unbounded sink', () => {
    // A `.node` addon runs in-realm and can reconstruct `require`; `vm`, a
    // weaker boundary, is already treated as maximally loader-capable.
    const r = report('res-f9-native-loader');
    const f = file(r, 'node_modules/victim/big.js');
    expect(f.state).not.toBe('predicted-removable-file');
    expect(f.blockingSet).toContain('native-boundary');
  });

  test('the gate is suppressible, so its cost is measurable', () => {
    const r = under('res-f9-native-loader', { suppressGates: ['native-boundary'] });
    expect(removable(r)).toEqual(['node_modules/victim/big.js']);
  });
});

// ---------------------------------------------------------------------------
describe('RES-F11 — physical identity is realpathSync.native', () => {
  test('one physical file is one universe record whatever the case of the spelling', () => {
    // `pkg/index.js` requires `./foo.js`; the file on disk is `Foo.js`. On a
    // case-insensitive filesystem those are ONE module and must not become two
    // records (which would double-count D and split one module's usage in half).
    const u = preps.get('res-f11-realpath-case')!.universe;
    const foos = u.files.filter((f) => f.rel.toLowerCase().endsWith('/foo.js'));
    expect(foos.length).toBe(1);
    expect(u.byReal.size).toBe(new Set(u.files.map((f) => f.real)).size);
    // Whichever way the filesystem behaves, the target is retained: resolved
    // onto the single record, or unresolved and therefore widened.
    expect(file(report('res-f11-realpath-case'), foos[0].rel).state).not.toBe('predicted-removable-file');
  });
});

// ---------------------------------------------------------------------------
describe('PROJ-EXACT — projection narrows only an EXACT-tier domain', () => {
  test('a package-tier domain retains the full surface of every domain module', () => {
    // The garden `require-pkgscoped` refutation: `require('scopedtarget/' + name)
    // .describe(x)` used to project `{describe}` onto every module of the
    // package, making the co-located passengers look removable.
    const r = report('proj-exact-package-tier');
    for (const [rel, spare] of [
      ['node_modules/scopedtarget/one.js', 'spareOne'],
      ['node_modules/scopedtarget/two.js', 'spareTwo'],
    ] as const) {
      expect(file(r, rel).state).not.toBe('predicted-removable-file');
      const s = symbol(r, rel, spare);
      expect(s.predicted).toBe(false);
      expect(s.blockingSet).toContain('module-identity-unresolved');
    }
    expect(r.E_predicted).toBe(r.D);
  });
});

// ---------------------------------------------------------------------------
describe('SR-F6 — SR-vm-known-globals is withdrawn as not-soundly-definable', () => {
  test('the refinement admits nothing and the run says why', () => {
    // `node app.cjs` in this fixture prints `loaded victim -> 42`: constant
    // code, object-literal context, no loader-like key — and it still loads the
    // victim, because the context object is a HOST-realm object.
    const app = 'sr-f6-vm-cross-realm';
    expect(file(report(app), 'node_modules/victim/big.js').blockingSet).toContain('vm-conservative');
    const r = under(app, { refinements: ['SR-vm-known-globals'] });
    expect(removable(r)).toEqual([]);
    expect(r.E_predicted).toBe(r.D);
    expect(r.warnings.some((w) => w.includes('SR-vm-known-globals') && w.includes('WITHDRAWN'))).toBe(true);
    expect(WITHDRAWN_REFINEMENTS['SR-vm-known-globals']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('SR-F7 — SR-cross-module-wrapper needs the universe-wide reference set', () => {
  test('the admitted domain is the union over ALL callers, not the in-module ones', () => {
    const app = 'sr-f7-cross-module-wrapper';
    expect(file(report(app), 'node_modules/victim/big.js').blockingSet).toContain('wrapper-unprovable');
    const r = under(app, { refinements: ['SR-cross-module-wrapper'] });
    // The in-module call site loads `safe`; the cross-module one loads
    // `victim`. Admitting on the in-module sites alone predicted `victim`
    // removable while node loads it.
    expect(removable(r)).toEqual([]);
    expect(file(r, 'node_modules/victim/big.js').state).toBe('retained-reachable');
    expect(file(r, 'node_modules/safe/big.js').state).toBe('retained-reachable');
    // The refinement still DID something: the wrapper gate is gone, replaced by
    // the union it proved. A refusal that simply widened would leave it.
    expect(file(r, 'node_modules/victim/big.js').blockingSet).not.toContain('wrapper-unprovable');
  });
});

// ---------------------------------------------------------------------------
describe('REP-F10 — per-symbol netBytes are apportioned, so they add up', () => {
  test('Σ netBytes over a file equals the file net exactly', () => {
    const r = report('rep-f10-net-apportion');
    const f = file(r, 'node_modules/tiny/index.js');
    const stubs = f.stubPredictions.filter((s) => s.predicted);
    expect(stubs.length).toBe(3);
    // One file, one denominator: E is the simulated emit and D the original.
    const fileNet = r.D - r.E_predicted;
    expect(stubs.reduce((n, s) => n + s.netBytes, 0)).toBe(fileNet);
    // The fail-closed throws are bigger than these bodies, and that counts
    // against the metric rather than being rounded away.
    expect(fileNet).toBeLessThan(0);
    expect(r.implBytesEliminable).toBe(stubs.reduce((n, s) => n + s.bodyBytes, 0));
  });
});
