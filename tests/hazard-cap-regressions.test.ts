/**
 * CAP-* soundness regressions (ADR-0006 defect ledger).
 *
 * Every fixture in `fixtures/hazard-cap-regressions/` is a RUNNABLE app whose
 * "victim" package provably executes under node — each `app.cjs` prints the
 * victim's output. Before the fix the strict analyzer predicted that code
 * removable; each test below asserts the WIDENING that replaced the wrong
 * answer: the file/symbol is not predicted-removable, and the blocking set
 * names the gate responsible.
 *
 * These are one-directional on purpose. A hazard-domain fix may only widen, so
 * the failure mode worth locking down is a future change that narrows one of
 * these back. Asserting `toContain` on the blocking set (rather than an exact
 * set) keeps the test sensitive to the disappearance of its gate while letting
 * an unrelated, additional widening pass.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  analyzePrepared,
  prepareHazardDomain,
  type FilePrediction,
  type HazardDomainReport,
  type PreparedApp,
} from '../packages/hazard-domain/src/index.ts';
import { extractModuleFacts } from '../packages/hazard-domain/src/facts.ts';
import type { GateTag, LoadSink, ModuleFacts } from '../packages/hazard-domain/src/types.ts';

const FIX = path.resolve(import.meta.dirname, '..', 'fixtures', 'hazard-cap-regressions');

const APPS = [
  'cap-f1-eval-free-identifier',
  'cap-f1-eval-projection',
  'cap-f2-global-object',
  'cap-f3-process-computed',
  'cap-f3-process-destructured',
  'cap-f4-named-fnexpr',
  'cap-f4-arguments-callee',
  'cap-f5-with-statement',
  'cap-f6-pattern-init',
  'cap-f7-cjs-this',
  'cap-f12-wrapper-arguments',
  'cap-f13-module-unbounded-surface',
] as const;

const preps = new Map<string, PreparedApp>();
const reports = new Map<string, HazardDomainReport>();

beforeAll(async () => {
  await Promise.all(
    APPS.map(async (app) => {
      const p = await prepareHazardDomain({ app, entry: path.join(FIX, app, 'app.cjs') });
      preps.set(app, p);
      reports.set(app, await analyzePrepared(p));
    }),
  );
});

const report = (app: string): HazardDomainReport => {
  const r = reports.get(app);
  if (!r) throw new Error(`no report for ${app}`);
  return r;
};

/** The prediction for one universe file, asserted to exist. */
function file(app: string, rel: string): FilePrediction {
  const r = report(app);
  const f = r.files.find((x) => x.rel === rel);
  if (!f) throw new Error(`no prediction for ${rel} in ${app}; have ${r.files.map((x) => x.rel).join(', ')}`);
  return f;
}

/** The file is retained, and `gate` is one of the reasons it had to be. */
function retainedBecause(app: string, rel: string, gate: GateTag): void {
  const f = file(app, rel);
  expect(f.state).not.toBe('predicted-removable-file');
  expect(f.blockingSet).toContain(gate);
}

/** The symbol is not predicted stubbable, and `gate` is one of the reasons. */
function symbolRetainedBecause(app: string, rel: string, symbol: string, gate: GateTag): void {
  const f = file(app, rel);
  const s = f.stubPredictions.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`no stub prediction for ${symbol} in ${app}/${rel}`);
  expect(s.predicted).toBe(false);
  expect(s.blockingSet).toContain(gate);
}

/** Per-module facts for a fixture source file, for the sink-level assertions. */
function facts(app: string, rel: string): ModuleFacts {
  const abs = path.join(FIX, app, rel);
  return extractModuleFacts(readFileSync(abs, 'utf8'), abs, `${app}/${rel}`, false, null);
}
const loadSinks = (f: ModuleFacts): LoadSink[] => f.sinks.filter((s) => s.effect === 'load');
const gatesOf = (s: LoadSink): GateTag[] => (s.specifier.tier === 'unbounded' ? s.specifier.gates : []);

// ---------------------------------------------------------------------------
describe('CAP-F1 — generated source cannot bind its own free identifiers', () => {
  // r1/apps/a01-eval-lexical-alias. `const r = require; eval("r('victim')")`
  // runs and prints the victim; the generated program resolved `r` against its
  // own empty scope and saw nothing at all.
  test('a caller-scope alias inside direct eval is reach-any, not absent', () => {
    retainedBecause('cap-f1-eval-free-identifier', 'node_modules/victim/index.js', 'generated-source-unknown');
    symbolRetainedBecause(
      'cap-f1-eval-free-identifier', 'node_modules/victim/index.js', 'passenger', 'generated-source-unknown',
    );
  });

  test('the widening is an unbounded, escaped sink on the eval site', () => {
    const f = facts('cap-f1-eval-free-identifier', 'app.cjs');
    const s = loadSinks(f).find((x) => x.specifier.tier === 'unbounded');
    expect(s).toBeDefined();
    expect(gatesOf(s as LoadSink)).toEqual(['generated-source-unknown']);
    expect((s as LoadSink).result).toEqual({ kind: 'escaped', gates: ['generated-source-unknown'] });
    expect(f.widened.some((w) => w.why.includes('free identifier "r"'))).toBe(true);
  });

  // The complement: source whose every free identifier IS modeled still gets
  // analyzed, so the fix did not degenerate into "all eval is reach-any".
  test('a benign global in generated source does not widen', () => {
    const f = facts('cap-f1-eval-free-identifier', 'app.cjs');
    expect(extractModuleFacts('eval("console.log(Math.max(1,2))");', '/x/b.cjs', 'b.cjs', false, null).sinks)
      .toHaveLength(0);
    // …and the fixture's own widening is the free identifier, nothing broader.
    expect(f.widened.filter((w) => w.why.includes('free identifier'))).toHaveLength(1);
  });

  // garden fab-eval-constant-capable (`ecc-target`). Constant source, every free
  // identifier modeled — but the value loaded inside the generated program has a
  // load path the sub-analysis cannot account for: the completion value returns
  // into a caller scope it never saw.
  test('a value loaded inside generated source keeps its whole export surface', () => {
    const rel = 'node_modules/victim/index.js';
    retainedBecause('cap-f1-eval-projection', rel, 'module-init-reachable');
    symbolRetainedBecause('cap-f1-eval-projection', rel, 'passenger', 'result-escaped');
    symbolRetainedBecause('cap-f1-eval-projection', rel, 'go', 'result-escaped');
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F2 — globalThis-rooted ambient capability', () => {
  // r1/apps/a02 family. No unbound `process`/`require` identifier ever appears,
  // so every capability seed missed the chain entirely.
  test('a capability chain rooted at the global object widens', () => {
    retainedBecause('cap-f2-global-object', 'node_modules/victim/index.js', 'escaped-loader');
    symbolRetainedBecause('cap-f2-global-object', 'node_modules/victim/index.js', 'passenger', 'escaped-loader');
  });

  test('the global object routes its modeled members and escapes on everything else', () => {
    const probe = (src: string): ModuleFacts => extractModuleFacts(src, '/x/p.cjs', 'p.cjs', false, null);
    // routed: process → getBuiltinModule → node:module → createRequire → loader
    const chain = probe(`globalThis.process.getBuiltinModule('module').createRequire(__filename)('victim');`);
    expect(loadSinks(chain).some((s) => s.capability === 'createRequire-result')).toBe(true);
    // routed: member-rooted eval is INDIRECT (global scope), never direct
    expect(probe(`globalThis.eval(src);`).sinks).toHaveLength(1);
    // escaped: computed read, unmodeled read, and the object itself leaving
    expect(probe(`const k='eval'; globalThis[k]('x');`).escapedLoader).toBe(true);
    expect(probe(`send(globalThis);`).escapedLoader).toBe(true);
    expect(probe(`if (global.somethingUnmodeled) {}`).escapedLoader).toBe(true);
    // NOT widened: a plain write, and the ubiquitous UMD existence probe
    expect(probe(`globalThis.myFlag = 1;`).escapedLoader).toBe(false);
    expect(probe(`if (typeof globalThis !== 'undefined') {}`).escapedLoader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F3 — the process seed used to fail OPEN', () => {
  // r1/apps/a03. `module` fails closed on a computed read; `process` granted
  // nothing and widened nothing, so the whole chain vanished.
  test('a computed read on process escapes, as it always did on module', () => {
    retainedBecause('cap-f3-process-computed', 'node_modules/victim/index.js', 'escaped-loader');
    symbolRetainedBecause('cap-f3-process-computed', 'node_modules/victim/index.js', 'passenger', 'escaped-loader');
  });

  // r1/apps/a06b. Here the fix RESOLVES the chain rather than widening it: the
  // load becomes visible, which is what makes the victim reachable at all.
  test('getBuiltinModule destructured off process keeps the factory chain visible', () => {
    retainedBecause('cap-f3-process-destructured', 'node_modules/victim/index.js', 'module-init-reachable');
    const f = facts('cap-f3-process-destructured', 'app.cjs');
    const s = loadSinks(f).find((x) => x.capability === 'createRequire-result');
    expect(s).toBeDefined();
    expect((s as LoadSink).specifier).toEqual({ tier: 'exact', specifiers: ['victim'] });
  });

  test('process still grants nothing where it genuinely cannot leak a loader', () => {
    const probe = (src: string): ModuleFacts => extractModuleFacts(src, '/x/p.cjs', 'p.cjs', false, null);
    // ambient everywhere: handing it to a callee adds no capability
    expect(probe(`send(process);`).escapedLoader).toBe(false);
    expect(probe(`console.log(process.env.NODE_ENV, process.argv);`).escapedLoader).toBe(false);
    expect(probe(`const { env, argv } = process;`).escapedLoader).toBe(false);
    // but a rest pattern could carry getBuiltinModule out
    expect(probe(`const { env, ...rest } = process;`).escapedLoader).toBe(true);
    // and an alias keeps flowing
    expect(
      loadSinks(probe(`const p = process; p.getBuiltinModule('module').createRequire(__filename)('victim');`)),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F4 — wrapper self-reference channels', () => {
  // r1/apps/a04. `inner` is a different binding from `load`, so the recursive
  // call site was absent from the union and only `decoy` was in the domain.
  test("a named function expression's inner id is a call site too", () => {
    retainedBecause('cap-f4-named-fnexpr', 'node_modules/victim/index.js', 'module-init-reachable');
    const s = loadSinks(facts('cap-f4-named-fnexpr', 'app.cjs'))[0];
    expect(s.specifier).toEqual({ tier: 'finite', specifiers: ['decoy', 'victim'] });
  });

  // r1/apps/a07. `arguments.callee` touches no binding at all, so no scan over
  // bindings can enumerate the callers — the precondition simply fails.
  test('a body that can name `arguments` is wrapper-unprovable', () => {
    retainedBecause('cap-f4-arguments-callee', 'node_modules/victim/index.js', 'wrapper-unprovable');
    expect(gatesOf(loadSinks(facts('cap-f4-arguments-callee', 'app.cjs'))[0])).toEqual(['wrapper-unprovable']);
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F5 — a WithStatement makes every static binding a lie', () => {
  // r1/apps/a13. Inside `with (o)` the specifier `s` is `o.s` at runtime, but
  // babel still reports the outer `const s = 'decoy'` binding, so the analyzer
  // folded the wrong constant and named the wrong module.
  test('a module containing `with` is opaque', () => {
    retainedBecause('cap-f5-with-statement', 'node_modules/victim/index.js', 'unsupported-syntax');
    symbolRetainedBecause('cap-f5-with-statement', 'node_modules/victim/index.js', 'passenger', 'unsupported-syntax');
    const f = facts('cap-f5-with-statement', 'app.cjs');
    expect(f.parseFailed).toBe(true);
    expect(f.surfaceOpen).toEqual(['unsupported-syntax']);
    expect(f.sinks).toHaveLength(0); // no narrow conclusion survives
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F6 — a pattern declarator does not hold its initializer', () => {
  // r1/apps/a05b. `const [c] = 'victim'` binds 'v'. The app really loads `v`,
  // which the analyzer used to predict removable while naming `victim` instead.
  test('a destructured const is not a constant specifier', () => {
    retainedBecause('cap-f6-pattern-init', 'node_modules/v/index.js', 'unbounded-loader-target');
    expect(gatesOf(loadSinks(facts('cap-f6-pattern-init', 'app.cjs'))[0])).toEqual(['unbounded-loader-target']);
  });

  test('a plain const initializer still folds', () => {
    const f = extractModuleFacts(`const c = 'victim'; require(c);`, '/x/p.cjs', 'p.cjs', false, null);
    expect(loadSinks(f)[0].specifier).toEqual({ tier: 'exact', specifiers: ['victim'] });
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F7 — CJS top-level `this` is module.exports', () => {
  // r3/apps/C1, B3, B3b. `globalThis.__registry = this` hands the whole export
  // object to an unmodeled holder; the identifier scan for `exports`/`module`
  // cannot see this third spelling.
  test('a top-level `this` opens the export surface', () => {
    const rel = 'node_modules/victim/index.js';
    symbolRetainedBecause('cap-f7-cjs-this', rel, 'passenger', 'export-object-mutation');
    symbolRetainedBecause('cap-f7-cjs-this', rel, 'passenger', 'open-export-surface');
    expect(file('cap-f7-cjs-this', rel).blockingSet).toContain('export-object-mutation');
  });

  test('`this` inside a real function, and in ESM, is untouched', () => {
    const cjs = extractModuleFacts(
      `function f(){ return this.x; }\nexports.f = f;\n`, '/x/p.cjs', 'p.cjs', false, null,
    );
    expect(cjs.surfaceOpen).toEqual([]);
    const esm = extractModuleFacts(
      `export function f(){ return 1 }\nconsole.log(typeof this);\n`, '/x/p.mjs', 'p.mjs', false, null,
    );
    expect(esm.surfaceOpen).toEqual([]);
    // but an ARROW does not rebind `this`, so it is still module.exports
    const arrow = extractModuleFacts(
      `function f(){ return 1 }\nexports.f = f;\nconst g = () => this;\n`, '/x/q.cjs', 'q.cjs', false, null,
    );
    expect(arrow.surfaceOpen).toEqual(['export-object-mutation']);
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F12 — the CJS wrapper `arguments` object holds require', () => {
  // r3/B5. Node runs a CJS body inside
  // `function (exports, require, module, __filename, __dirname)`, so a
  // top-level `arguments[1]` IS the lexical loader. The seed scan only looked
  // at the names require/module/process/eval/Function/globalThis, so this
  // channel produced no capability at all and the victim — which the fixture
  // provably loads and runs — was predicted-removable with an EMPTY blocking
  // set. Found during independent verification, not in the original ledger.
  test('a top-level `arguments` reference escapes the loader', () => {
    retainedBecause('cap-f12-wrapper-arguments', 'node_modules/victim/index.js', 'escaped-loader');
    symbolRetainedBecause(
      'cap-f12-wrapper-arguments', 'node_modules/victim/index.js', 'passenger', 'escaped-loader',
    );
    const f = facts('cap-f12-wrapper-arguments', 'node_modules/loader/index.js');
    expect(f.escapedLoader).toBe(true);
    expect(f.widened.some((w) => w.why.includes('`arguments` object holds require/module'))).toBe(true);
  });

  test('an arrow does not rebind `arguments`, a real function does', () => {
    const arrow = extractModuleFacts(
      `const f = () => arguments[1]('victim'); f();`, '/x/a.cjs', 'a.cjs', false, null,
    );
    expect(arrow.escapedLoader).toBe(true);
    const fn = extractModuleFacts(
      `function f(){ return arguments[0]; }\nexports.f = f;\n`, '/x/b.cjs', 'b.cjs', false, null,
    );
    expect(fn.escapedLoader).toBe(false);
    // ESM has no wrapper: `arguments` there is not a capability.
    const esm = extractModuleFacts(
      `export const x = 1;\nconsole.log(typeof arguments);\n`, '/x/c.mjs', 'c.mjs', false, null,
    );
    expect(esm.escapedLoader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('CAP-F13 — a module-level unbounded sink opens export surfaces too', () => {
  // r4/N17, N19, N21. `escapedLoader`, `parseFailed`, `require-cache-mutation`
  // and the RES-F9 native/wasm boundary each synthesize a module-level
  // Unbounded sink. That sink went straight to the reachability mass-mark and
  // never entered `activeLoadSinks` — the ONLY thing the projection layer
  // reads — so every file was retained while their unnamed exports stayed
  // predicted-stubbable. The code behind such a sink is code this analysis
  // never saw AND it holds a loader: it can require any module and call any
  // export on the value it gets back, so its result escapes.
  test('an escaped loader forbids symbol narrowing universe-wide', () => {
    const rel = 'node_modules/victim/index.js';
    retainedBecause('cap-f13-module-unbounded-surface', rel, 'escaped-loader');
    symbolRetainedBecause('cap-f13-module-unbounded-surface', rel, 'passenger', 'escaped-loader');
  });

  test('without the escape the same surface still narrows', () => {
    // The control keeps the fix from degenerating into "never narrow".
    const f = file('cap-f4-named-fnexpr', 'node_modules/victim/index.js');
    expect(f.stubPredictions.length).toBeGreaterThan(0);
  });
});
