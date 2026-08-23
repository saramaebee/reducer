/**
 * Per-module semantic core of the hazard-domain analyzer.
 *
 * Every case asserts BOTH directions: that the intended narrowing happened
 * (a domain/projection is tighter than unbounded) AND that each unsupported
 * shape widened with the RIGHT gate. A test that only checks the happy path
 * cannot catch the failure mode that matters here — silently assuming away
 * uncertainty.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// Relative, not `@reducer/hazard-domain`: the path alias resolves a package to
// its src/index.ts, and this suite deliberately targets the per-module core.
import { extractModuleFacts } from '../packages/hazard-domain/src/facts.ts';
import type { GateTag, LoadSink, ModuleFacts } from '../packages/hazard-domain/src/types.ts';

const FIX = path.join(import.meta.dirname, '..', 'fixtures', 'hazard-core');

function facts(name: string): ModuleFacts {
  const abs = path.join(FIX, name);
  return extractModuleFacts(readFileSync(abs, 'utf8'), abs, `hazard-core/${name}`, false, null);
}

const specifiers = (s: LoadSink): string[] =>
  s.specifier.tier === 'exact' || s.specifier.tier === 'finite' ? [...s.specifier.specifiers] : [];

const gatesOf = (s: LoadSink): GateTag[] =>
  s.specifier.tier === 'unbounded' ? s.specifier.gates : [];

const loads = (f: ModuleFacts): LoadSink[] => f.sinks.filter((s) => s.effect === 'load');

/** The sink that loads `spec`, asserted to exist. */
function sinkFor(f: ModuleFacts, spec: string): LoadSink {
  const s = f.sinks.find((x) => specifiers(x).includes(spec));
  if (!s) throw new Error(`no sink for ${spec}; sinks=${JSON.stringify(f.sinks, null, 1)}`);
  return s;
}

/** The single unbounded load sink, asserted to exist. */
function unboundedSink(f: ModuleFacts): LoadSink {
  const s = f.sinks.find((x) => x.specifier.tier === 'unbounded');
  if (!s) throw new Error(`no unbounded sink; sinks=${JSON.stringify(f.sinks, null, 1)}`);
  return s;
}

// ---------------------------------------------------------------------------
describe('capability seeds', () => {
  test('lexical require, and an alias of it, are both loader capabilities', () => {
    const f = facts('cap-lexical.cjs');
    expect(sinkFor(f, 'lodash').capability).toBe('lexical-require');
    expect(sinkFor(f, 'semver').capability).toBe('lexical-require');
    expect(f.escapedLoader).toBe(false);
  });

  test('module.require is its own capability kind', () => {
    const f = facts('cap-module-require.cjs');
    expect(sinkFor(f, 'through').capability).toBe('module-require');
  });

  test('node:module -> createRequire -> loader keeps the factory chain visible', () => {
    const f = facts('cap-createrequire.mjs');
    expect(sinkFor(f, 'chalk').capability).toBe('createRequire-result');
  });

  test('process.getBuiltinModule("node:module") chains to a createRequire loader', () => {
    const f = facts('cap-getbuiltinmodule.cjs');
    expect(sinkFor(f, 'chalk').capability).toBe('createRequire-result');
    expect(f.escapedLoader).toBe(false);
  });

  test('getBuiltinModule with a non-constant argument widens to loader-capable', () => {
    const f = facts('cap-getbuiltin-dynamic.cjs');
    expect(sinkFor(f, 'chalk').capability).toBe('getBuiltinModule');
    expect(f.widened.some((w) => /non-constant argument/.test(w.why))).toBe(true);
  });

  test('import() is an ambient capability; a non-constant target widens', () => {
    const f = facts('cap-dynamic-import.mjs');
    const exact = sinkFor(f, 'lodash');
    expect(exact.capability).toBe('dynamic-import');
    expect(exact.result).toEqual({ kind: 'projected', names: ['map'] });
    expect(gatesOf(unboundedSink(f))).toEqual(['unbounded-loader-target']);
  });

  test('import.meta.resolve is a resolve-effect sink', () => {
    const f = facts('cap-import-meta-resolve.mjs');
    const s = sinkFor(f, './sibling.js');
    expect(s.capability).toBe('import-meta-resolve');
    expect(s.effect).toBe('resolve');
  });

  test('require.resolve is a resolve-effect sink on the lexical-require capability', () => {
    const f = facts('cap-require-resolve.cjs');
    const s = sinkFor(f, 'lodash');
    expect(s.effect).toBe('resolve');
    expect(s.capability).toBe('lexical-require');
    expect(loads(f)).toHaveLength(0);
  });

  test('require.cache records a sink-less universe-wide gate', () => {
    const f = facts('cap-require-cache.cjs');
    expect(f.moduleGates).toContain('require-cache-mutation');
    expect(sinkFor(f, 'lodash').effect).toBe('resolve');
  });

  test('primitive-yielding uses of a capability (typeof, ===) leak nothing', () => {
    // Without this rule the UMD preamble would set escaped-loader on a large
    // fraction of real third-party CJS and drown every other gate.
    const f = facts('idiom-umd.cjs');
    expect(f.escapedLoader).toBe(false);
    expect(f.widened).toEqual([]);
    expect(f.sinks).toHaveLength(0);
  });

  test('an unbound require in ESM is a ReferenceError, not a capability', () => {
    const f = facts('cap-esm-require-inert.mjs');
    expect(f.format).toBe('esm');
    expect(f.sinks).toHaveLength(0);
    expect(f.escapedLoader).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('capability flow', () => {
  test('alias flows; an aliased loader passed as an argument escapes', () => {
    const ok = facts('cap-lexical.cjs');
    expect(specifiers(sinkFor(ok, 'semver'))).toEqual(['semver']);

    const bad = facts('cap-alias-escape.cjs');
    expect(bad.escapedLoader).toBe(true);
    expect(bad.widened.some((w) => w.why.startsWith('escaped-loader:'))).toBe(true);
  });

  test('destructuring createRequire flows; destructuring a loader internal escapes', () => {
    const ok = facts('cap-destructure.cjs');
    expect(sinkFor(ok, 'semver').capability).toBe('createRequire-result');
    expect(ok.escapedLoader).toBe(false);

    const bad = facts('cap-destructure-escape.cjs');
    expect(bad.escapedLoader).toBe(true);
    expect(bad.sinks.some((s) => specifiers(s).includes('semver'))).toBe(false);
  });

  test('closure capture keeps the sink at module level (no reachability gating)', () => {
    const f = facts('cap-closure.cjs');
    expect(specifiers(sinkFor(f, 'lodash'))).toEqual(['lodash']);
    expect(f.escapedLoader).toBe(false);
  });

  test('container storage flows only while the container never escapes', () => {
    const ok = facts('cap-container.cjs');
    expect(sinkFor(ok, 'lodash').capability).toBe('lexical-require');
    expect(ok.escapedLoader).toBe(false);

    const bad = facts('cap-container-escape.cjs');
    expect(bad.escapedLoader).toBe(true);
    expect(loads(bad)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('specifier domains', () => {
  const f = facts('spec-domains.cjs');

  test('a never-reassigned const string binding is exact', () => {
    expect(sinkFor(f, 'lodash').specifier).toEqual({ tier: 'exact', specifiers: ['lodash'] });
  });

  test('a constant ternary is finite', () => {
    expect(sinkFor(f, 'alpha').specifier).toEqual({ tier: 'finite', specifiers: ['alpha', 'beta'] });
  });

  test('a constant prefix past the package name pins the package', () => {
    const pkgSinks = f.sinks.filter((s) => s.specifier.tier === 'package');
    expect(pkgSinks.map((s) => (s.specifier as { pkg: string }).pkg).sort()).toEqual([
      '@scope/pkg',
      'lodash',
    ]);
  });

  test("a prefix stopping inside the package name ('lodash'+x) is NOT package-scoped", () => {
    const unbounded = f.sinks.filter((s) => s.specifier.tier === 'unbounded');
    // `require('lodash' + part)` and `require(part)`
    expect(unbounded).toHaveLength(2);
    for (const s of unbounded) expect(gatesOf(s)).toEqual(['unbounded-loader-target']);
  });
});

// ---------------------------------------------------------------------------
describe('loader-wrapper propagation', () => {
  test('a non-escaping wrapper with enumerable callers takes the union of call-site domains', () => {
    const f = facts('wrapper-ok.cjs');
    const s = loads(f)[0];
    expect(s.specifier).toEqual({ tier: 'finite', specifiers: ['lodash', 'semver'] });
    expect(s.wrapperEvidence?.resolved).toBe(true);
    expect(s.wrapperEvidence?.fn).toBe('load');
  });

  test('a const arrow wrapper reached through a const alias resolves', () => {
    const s = loads(facts('wrapper-alias-ok.cjs'))[0];
    expect(s.specifier).toEqual({ tier: 'exact', specifiers: ['lodash'] });
    expect(s.wrapperEvidence?.resolved).toBe(true);
  });

  test('an exported wrapper widens but records the SR-cross-module evidence', () => {
    const s = loads(facts('wrapper-exported.cjs'))[0];
    expect(gatesOf(s)).toEqual(['wrapper-unprovable']);
    expect(s.wrapperEvidence?.crossModuleOnly).toBe(true);
    expect(s.wrapperEvidence?.callSiteDomains).toEqual([{ tier: 'exact', specifiers: ['lodash'] }]);
  });

  test('a wrapper value that escapes otherwise is not SR-admissible', () => {
    const s = loads(facts('wrapper-escape.cjs'))[0];
    expect(gatesOf(s)).toEqual(['wrapper-unprovable']);
    expect(s.wrapperEvidence?.crossModuleOnly).toBe(false);
  });

  test('a reassigned parameter breaks the arg->sink flow', () => {
    const s = loads(facts('wrapper-reassigned.cjs'))[0];
    expect(gatesOf(s)).toEqual(['wrapper-unprovable']);
    expect(s.wrapperEvidence?.why).toMatch(/reassigned/);
  });

  test('zero enumerable call sites is not a proof of an empty domain', () => {
    const s = loads(facts('wrapper-nocall.cjs'))[0];
    expect(gatesOf(s)).toEqual(['wrapper-unprovable']);
    expect(s.wrapperEvidence?.why).toMatch(/no call sites/);
  });

  test('exhausting wrapper depth widens with wrapper-depth', () => {
    const s = loads(facts('wrapper-depth.cjs'))[0];
    expect(gatesOf(s)).toEqual(['wrapper-depth']);
  });
});

// ---------------------------------------------------------------------------
describe('generated source: execution context decides the capabilities', () => {
  test('direct eval of constant source inherits the lexical require', () => {
    const f = facts('gen-direct-eval.cjs');
    const s = sinkFor(f, 'lodash');
    expect(s.capability).toBe('lexical-require');
    expect(s.generatedDepth).toBe(1);
  });

  test('the SAME source under new Function has no lexical require, but keeps global capabilities', () => {
    const f = facts('gen-function-global.cjs');
    // negative: the lexical `require` in the generated body is a ReferenceError
    expect(f.sinks.some((s) => specifiers(s).includes('lodash'))).toBe(false);
    // positive: import() and getBuiltinModule->createRequire remain available
    expect(sinkFor(f, 'semver').capability).toBe('dynamic-import');
    expect(sinkFor(f, 'chalk').capability).toBe('createRequire-result');
    for (const s of f.sinks) expect(s.generatedDepth).toBe(1);
  });

  test('indirect eval of require-only source yields nothing at all', () => {
    const f = facts('gen-indirect-eval.cjs');
    expect(f.sinks).toHaveLength(0);
    expect(f.escapedLoader).toBe(false);
  });

  test('non-constant source is reach-any', () => {
    const s = unboundedSink(facts('gen-nonconstant.cjs'));
    expect(gatesOf(s)).toEqual(['generated-source-unknown']);
    expect(s.result).toEqual({ kind: 'escaped', gates: ['generated-source-unknown'] });
  });

  test('eval referenced as a value is reach-any', () => {
    expect(gatesOf(unboundedSink(facts('gen-eval-value.cjs')))).toEqual(['generated-source-unknown']);
  });

  test('generated-source depth exhaustion widens with its own gate', () => {
    expect(gatesOf(unboundedSink(facts('gen-depth.cjs')))).toEqual(['generated-source-depth']);
  });
});

// ---------------------------------------------------------------------------
describe('vm sites', () => {
  test('an object-literal context without loader-like injection is recorded as such', () => {
    const f = facts('vm-literal.cjs');
    const vm = f.sinks.filter((s) => s.capability === 'vm-injected');
    expect(vm).toHaveLength(1);
    // strict model: still maximally loader-capable
    expect(gatesOf(vm[0])).toEqual(['vm-conservative']);
    expect(vm[0].vmEvidence).toEqual({
      api: 'vm.runInNewContext',
      contextArg: 'object-literal',
      literalKeys: ['helper'],
      injectsLoaderLike: false,
      codeConstant: true,
    });
  });

  test('a context injecting require is evidenced as loader-like', () => {
    const f = facts('vm-inject.cjs');
    const vm = f.sinks.filter((s) => s.capability === 'vm-injected');
    expect(vm[0].vmEvidence?.injectsLoaderLike).toBe(true);
    expect(vm[0].vmEvidence?.codeConstant).toBe(false);
    // the loader itself also left the module
    expect(f.escapedLoader).toBe(true);
  });

  test('an escaped vm namespace still produces one conservative sink', () => {
    const f = facts('vm-escaped.cjs');
    const vm = f.sinks.filter((s) => s.capability === 'vm-injected');
    expect(vm).toHaveLength(1);
    expect(vm[0].vmEvidence?.contextArg).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
describe('result flow', () => {
  test('static property reads project', () => {
    expect(sinkFor(facts('flow-projection.cjs'), 'lodash').result).toEqual({
      kind: 'projected',
      names: ['filter', 'map'],
    });
  });

  test('any other use escapes the whole surface', () => {
    expect(sinkFor(facts('flow-escape.cjs'), 'lodash').result).toEqual({
      kind: 'escaped',
      gates: ['value-escaped'],
    });
  });

  test('a side-effect-only load is unused', () => {
    expect(sinkFor(facts('flow-unused.cjs'), 'lodash').result).toEqual({ kind: 'unused' });
  });

  test('the simple .then(cb) case projects through the callback parameter', () => {
    expect(sinkFor(facts('flow-then.mjs'), 'lodash').result).toEqual({
      kind: 'projected',
      names: ['map'],
    });
  });
});

// ---------------------------------------------------------------------------
describe('export surface (ported analyzer rules)', () => {
  test('stubbable shape carries a body span; an internal reference blocks it', () => {
    const f = facts('exports-surface.cjs');
    const code = readFileSync(path.join(FIX, 'exports-surface.cjs'), 'utf8');
    expect(f.surfaceOpen).toEqual([]);

    const alpha = f.exports.get('alpha');
    expect(alpha?.stubbable).toBe(false);
    expect(alpha?.retainReasons).toEqual(['internal-reference']);

    const beta = f.exports.get('beta');
    expect(beta?.stubbable).toBe(true);
    expect(code.slice(beta!.bodySpan!.start, beta!.bodySpan!.end)).toBe('{ return alpha(); }');
  });

  test('a duplicate CJS export write widens the whole surface', () => {
    expect(facts('exports-dup.cjs').surfaceOpen).toContain('export-object-mutation');
  });

  test('a parse failure yields minimal, opaque facts', () => {
    const f = facts('parse-fail.cjs');
    expect(f.parseFailed).toBe(true);
    expect(f.surfaceOpen).toEqual(['unsupported-syntax']);
    expect(f.sinks).toHaveLength(0);
    expect(f.exports.size).toBe(0);
    expect(f.widened).toHaveLength(1);
  });
});
