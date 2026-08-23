/**
 * Capability seeding and capability flow (ADR-0002, CONTEXT.md "capability",
 * "capability factory", "capability flow", "escaped-loader", "load sink").
 *
 * Danger is measured by the capability a value holds, never by syntax. A value
 * is tracked while every step of its flow is one we can model — aliasing,
 * destructuring from a known container, closure capture, and storage in a
 * non-escaping container. The instant a capability-bearing value reaches a
 * position we cannot model (call argument, export, property write, return,
 * assignment) the module records `escaped-loader`: a flow STATE, not a
 * capability, which the engine turns into an Unbounded active sink.
 *
 * Capability factories stay chained and are never collapsed:
 *   process.getBuiltinModule → node:module namespace → createRequire → loader.
 *
 * MODEL BOUNDARY (ADR-0002, deliberate): capability flow ACROSS module
 * boundaries — a loader returned from another module's export — is not modeled.
 * ADR-0002 explicitly excludes whole-program interprocedural taint; the strict
 * model's answer for an unknown target set is already reach-any.
 */
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { CapabilityKind, GateTag, ResultFlow, SpecifierDomain, VmSiteEvidence } from './types.ts';
import { constantStrings, evaluateSpecifierDomain, unbounded } from './specifier.ts';
import { resolveWrapperDomain } from './wrapper.ts';
import { addSink, handleGeneratedSite, widen, type CapContext } from './generated.ts';

export type { CapContext };
export { addSink, widen };

// ---------------------------------------------------------------------------
// Tracked capability values
// ---------------------------------------------------------------------------

type CapValue =
  | { role: 'loader'; kind: CapabilityKind }      // callable: specifier → module
  | { role: 'module-namespace' }                  // factory: node:module
  | { role: 'getBuiltinModule' }                  // factory: process.getBuiltinModule
  | { role: 'createRequire' }                     // factory: the createRequire function
  | { role: 'vm-namespace' }                      // the vm module
  | { role: 'vm-api'; api: string }               // one vm entry point
  | { role: 'process' }                           // CAP-F3: the process object (factory host)
  | { role: 'global-object' }                     // CAP-F2: globalThis/global/self/window
  | { role: 'resolver'; kind: CapabilityKind };   // require.resolve / import.meta.resolve

/** CAP-F2: the ambient names that denote the global object itself. */
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global', 'self', 'window']);

/**
 * CAP-F3: `process` members that ARE loading channels. Everything else on
 * `process` is metadata (env, argv, platform, …) and grants nothing — the same
 * split the member-read path has always used, now applied to destructuring too.
 */
const PROCESS_LOADING_CHANNELS = new Set(['mainModule', 'binding', 'dlopen']);

const capKey = (c: CapValue): string =>
  c.role === 'loader' || c.role === 'resolver' ? `${c.role}:${c.kind}` : c.role === 'vm-api' ? `vm-api:${c.api}` : c.role;

/** node:module members that cannot produce a loader. Everything else widens. */
const MODULE_BENIGN = new Set([
  'builtinModules', 'isBuiltin', 'syncBuiltinESMExports', 'findPackageJSON',
  'getCompileCacheDir', 'enableCompileCache', 'constants', 'globalPaths', 'stripTypeScriptTypes',
]);

/** `module` members that are metadata, not loading power. */
const MODULE_OBJ_BENIGN = new Set([
  'exports', 'id', 'filename', 'loaded', 'children', 'paths', 'path', 'isPreloading',
]);

/** vm API → [code arg index | null, context arg index | null]. Unknown ⇒ 'unknown'. */
const VM_APIS: Record<string, { code: number | null; ctx: number | null }> = {
  runInNewContext: { code: 0, ctx: 1 },
  runInContext: { code: 0, ctx: 1 },
  runInThisContext: { code: 0, ctx: null },
  createContext: { code: null, ctx: 0 },
  compileFunction: { code: 0, ctx: null },
  Script: { code: 0, ctx: null },
  SourceTextModule: { code: 0, ctx: null },
  SyntheticModule: { code: null, ctx: null },
  measureMemory: { code: null, ctx: null },
};

// ---------------------------------------------------------------------------
// Module-object usage tracking (ported from analyzer trackObjectBinding /
// patternNames — same semantics, gate tags instead of Reasons)
// ---------------------------------------------------------------------------

export interface UsageSink {
  names: Set<string>;
  all: boolean;
  gates: Set<GateTag>;
}

export function newUsage(): UsageSink {
  return { names: new Set(), all: false, gates: new Set() };
}

/** analyzer:95 patternNames — destructuring a module object. */
export function patternNames(pattern: t.ObjectPattern, u: UsageSink): void {
  for (const prop of pattern.properties) {
    if (t.isRestElement(prop)) {
      u.all = true;
      u.gates.add('destructure-rest');
      return;
    }
    if (prop.computed) {
      u.all = true;
      u.gates.add('dynamic-property-access');
      return;
    }
    if (t.isIdentifier(prop.key)) u.names.add(prop.key.name);
    else if (t.isStringLiteral(prop.key)) u.names.add(prop.key.value);
    else {
      u.all = true;
      u.gates.add('dynamic-property-access');
    }
  }
}

/**
 * analyzer:121 trackObjectBinding — property projection over a binding holding
 * a module object. Static property reads narrow usage to named exports;
 * anything else escapes to the full observable surface.
 */
export function trackValueBinding(
  binding: Binding | undefined,
  u: UsageSink,
  seen: Set<Binding> = new Set(),
): void {
  if (!binding) {
    u.all = true;
    u.gates.add('value-escaped');
    return;
  }
  if (seen.has(binding)) return;
  seen.add(binding);

  if (binding.constantViolations.length > 0) {
    u.all = true;
    u.gates.add('binding-reassigned');
    return;
  }

  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath;
    if (!parent) {
      u.all = true;
      u.gates.add('value-escaped');
      continue;
    }

    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === ref.node
    ) {
      const { property, computed } = parent.node;
      // Writing through the module object monkey-patches exports.
      const gp = parent.parentPath;
      if (gp?.isAssignmentExpression() && gp.node.left === parent.node) {
        u.all = true;
        u.gates.add('export-object-mutation');
        continue;
      }
      if (!computed && t.isIdentifier(property)) u.names.add(property.name);
      else if (computed && t.isStringLiteral(property)) u.names.add(property.value);
      else {
        u.all = true;
        u.gates.add('dynamic-property-access');
      }
      continue;
    }

    if (parent.isVariableDeclarator() && parent.node.init === ref.node) {
      const id = parent.node.id;
      if (t.isIdentifier(id)) {
        trackValueBinding(parent.scope.getBinding(id.name), u, seen);
        continue;
      }
      if (t.isObjectPattern(id)) {
        patternNames(id, u);
        continue;
      }
    }

    // Any other use: call argument, return, spread, export, comparison, ...
    u.all = true;
    u.gates.add('value-escaped');
  }
}

export function usageToFlow(u: UsageSink): ResultFlow {
  if (u.all) return { kind: 'escaped', gates: [...u.gates] };
  return { kind: 'projected', names: [...u.names].sort() };
}

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

function propName(m: NodePath<t.MemberExpression | t.OptionalMemberExpression>): string | null {
  const { property, computed } = m.node;
  if (!computed && t.isIdentifier(property)) return property.name;
  if (computed && t.isStringLiteral(property)) return property.value;
  return null;
}

/**
 * Positions whose result is a primitive the operand cannot leak through, so a
 * capability appearing there grants nothing. `typeof require`, `x === module`
 * and friends are extremely common and would otherwise widen every UMD file.
 * SOUNDNESS: none of these operators can invoke the operand with a specifier.
 */
function isNonLeaking(p: NodePath): boolean {
  const parent = p.parentPath;
  if (!parent) return false;
  if (parent.isUnaryExpression() && (parent.node.operator === 'typeof' || parent.node.operator === '!')) {
    return true;
  }
  if (parent.isBinaryExpression()) {
    const op = parent.node.operator;
    return op === '===' || op === '!==' || op === '==' || op === '!=';
  }
  return false;
}

const rootIdentifier = (n: t.Node): string | null => {
  let cur: t.Node = n;
  while (t.isMemberExpression(cur) || t.isOptionalMemberExpression(cur)) cur = cur.object;
  return t.isIdentifier(cur) ? cur.name : null;
};

// ---------------------------------------------------------------------------
// The capability pass
// ---------------------------------------------------------------------------

export function analyzeCapabilities(program: NodePath<t.Program>, ctx: CapContext): void {
  const tracked = new Map<Binding, CapValue>();
  const queue: { binding: Binding; cap: CapValue }[] = [];
  const containersDone = new Set<string>();
  const seeds: (() => void)[] = [];

  const escape = (node: t.Node | null, why: string): void => {
    ctx.escapedLoader = true;
    widen(ctx, node, `escaped-loader: ${why}`);
  };

  const track = (binding: Binding | undefined, cap: CapValue, node: t.Node | null): void => {
    if (!binding) return escape(node, 'capability bound to an unresolvable binding');
    if (binding.constantViolations.length > 0) {
      return escape(node, `capability binding "${binding.identifier.name}" is reassigned`);
    }
    const prev = tracked.get(binding);
    if (prev) {
      if (capKey(prev) !== capKey(cap)) {
        escape(node, `binding "${binding.identifier.name}" holds two different capabilities`);
      }
      return;
    }
    tracked.set(binding, cap);
    queue.push({ binding, cap });
  };

  // -- vm -------------------------------------------------------------------

  function vmEvidenceOf(
    call: NodePath<t.CallExpression | t.NewExpression> | null,
    api: string,
    apiName: string | null,
  ): VmSiteEvidence {
    const shape = apiName ? VM_APIS[apiName] : undefined;
    if (!call || !shape) {
      return { api, contextArg: 'unknown', injectsLoaderLike: false, codeConstant: false };
    }
    const args = call.get('arguments') as NodePath<t.Node>[];
    const codeConstant =
      shape.code !== null && !!args[shape.code] && constantStrings(args[shape.code]) !== null;
    if (shape.ctx === null) {
      return { api, contextArg: 'none', injectsLoaderLike: false, codeConstant };
    }
    const ctxArg = args[shape.ctx];
    if (!ctxArg || !ctxArg.node) {
      return { api, contextArg: 'none', injectsLoaderLike: false, codeConstant };
    }
    if (ctxArg.isObjectExpression()) {
      const literalKeys: string[] = [];
      let injects = false;
      for (const prop of ctxArg.node.properties) {
        if (t.isSpreadElement(prop)) {
          injects = true; // unknown key set
          continue;
        }
        const key = !prop.computed
          ? t.isIdentifier(prop.key)
            ? prop.key.name
            : t.isStringLiteral(prop.key)
              ? prop.key.value
              : null
          : null;
        if (key === null) {
          injects = true; // computed key: could be `require`
          continue;
        }
        literalKeys.push(key);
        if (key === 'require' || key === 'module' || key === 'process') injects = true;
        if (t.isObjectProperty(prop)) {
          const v = prop.value as t.Node;
          const root = rootIdentifier(v);
          if (root === 'require' || root === 'module' || root === 'process') injects = true;
          if (t.isIdentifier(v)) {
            const b = ctxArg.scope.getBinding(v.name);
            if (b && tracked.has(b)) injects = true;
          }
        }
      }
      return { api, contextArg: 'object-literal', literalKeys, injectsLoaderLike: injects, codeConstant };
    }
    if (ctxArg.isIdentifier()) {
      return { api, contextArg: 'identifier', injectsLoaderLike: false, codeConstant };
    }
    return { api, contextArg: 'unknown', injectsLoaderLike: false, codeConstant };
  }

  function vmSink(
    call: NodePath<t.CallExpression | t.NewExpression> | null,
    api: string,
    apiName: string | null,
    node: t.Node | null,
  ): void {
    // Strict model (design §7): a vm context is maximally loader-capable. The
    // evidence record is what SR-vm-known-globals would later be admitted on;
    // it never narrows anything here.
    addSink(ctx, {
      capability: 'vm-injected',
      specifier: unbounded(['vm-conservative']),
      result: { kind: 'escaped', gates: ['vm-conservative'] },
      node,
      vmEvidence: vmEvidenceOf(call, api, apiName),
    });
    widen(ctx, node, `vm site ${api} modeled as maximally loader-capable`);
  }

  // -- load sinks -----------------------------------------------------------

  function classifyResultFlow(call: NodePath<t.CallExpression>): ResultFlow {
    let value: NodePath = call;
    if (value.parentPath?.isAwaitExpression()) value = value.parentPath;
    const parent = value.parentPath;
    if (!parent) return { kind: 'escaped', gates: ['value-escaped'] };
    if (parent.isExpressionStatement()) return { kind: 'unused' };

    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === value.node
    ) {
      const gp = parent.parentPath;
      if (gp?.isAssignmentExpression() && gp.node.left === parent.node) {
        return { kind: 'escaped', gates: ['export-object-mutation'] };
      }
      const name = propName(parent);
      if (name === null) return { kind: 'escaped', gates: ['dynamic-property-access'] };
      if (name === 'then') {
        // `import(x).then(m => m.foo)` — only the simple direct case: one
        // callback with one plain identifier parameter.
        if (gp?.isCallExpression() && gp.node.callee === parent.node && gp.node.arguments.length === 1) {
          const cb = gp.get('arguments')[0] as NodePath<t.Node>;
          if (
            (cb.isArrowFunctionExpression() || cb.isFunctionExpression()) &&
            cb.node.params.length === 1 &&
            t.isIdentifier(cb.node.params[0])
          ) {
            const u = newUsage();
            trackValueBinding(cb.scope.getBinding((cb.node.params[0] as t.Identifier).name), u);
            return usageToFlow(u);
          }
        }
        return { kind: 'escaped', gates: ['value-escaped'] };
      }
      return { kind: 'projected', names: [name] };
    }

    if (parent.isVariableDeclarator() && parent.node.init === value.node) {
      const id = parent.node.id;
      const u = newUsage();
      if (t.isIdentifier(id)) {
        trackValueBinding(parent.scope.getBinding(id.name), u);
        return usageToFlow(u);
      }
      if (t.isObjectPattern(id)) {
        patternNames(id, u);
        return usageToFlow(u);
      }
    }

    return { kind: 'escaped', gates: ['value-escaped'] };
  }

  function emitLoadSink(call: NodePath<t.CallExpression>, capability: CapabilityKind): void {
    const args = call.get('arguments') as NodePath<t.Node>[];
    const a0 = args[0];
    let specifier: SpecifierDomain;
    let wrapperEvidence;
    if (!a0 || !a0.node || a0.isSpreadElement()) {
      specifier = unbounded();
    } else {
      specifier = evaluateSpecifierDomain(a0);
      if (specifier.tier === 'unbounded') {
        // Demand-driven only: the wrapper analysis runs exactly where a domain
        // could not be read syntactically.
        const w = resolveWrapperDomain(a0, 0);
        if (w) {
          specifier = w.domain;
          wrapperEvidence = w.evidence;
        }
      }
    }
    if (specifier.tier === 'unbounded') {
      widen(ctx, call.node, `load sink specifier unbounded (${specifier.gates.join('+')})`);
    }
    addSink(ctx, {
      capability,
      specifier,
      result: classifyResultFlow(call),
      node: call.node,
      wrapperEvidence,
    });

    // Loading node:module / node:vm ACQUIRES a capability factory.
    const isModuleSpec = (s: string) => s === 'module' || s === 'node:module';
    const isVmSpec = (s: string) => s === 'vm' || s === 'node:vm';
    if (specifier.tier === 'exact') {
      const s = specifier.specifiers[0];
      if (isModuleSpec(s)) bindValue(call, { role: 'module-namespace' });
      else if (isVmSpec(s)) bindValue(call, { role: 'vm-namespace' });
    } else if (
      specifier.tier === 'finite' &&
      specifier.specifiers.some((s) => isModuleSpec(s) || isVmSpec(s))
    ) {
      escape(call.node, 'a finite load domain includes node:module/node:vm; the loaded value may be a loader factory');
    }
  }

  function emitResolveSink(call: NodePath<t.CallExpression>, capability: CapabilityKind): void {
    const a0 = (call.get('arguments') as NodePath<t.Node>[])[0];
    // A resolve sink retains file bytes only — it never initializes a module,
    // so it grants no export reachability and its result is not a module value.
    addSink(ctx, {
      capability,
      effect: 'resolve',
      specifier: a0 && a0.node ? evaluateSpecifierDomain(a0) : unbounded(),
      result: { kind: 'unused' },
      node: call.node,
    });
  }

  // -- capability flow ------------------------------------------------------

  function applyCap(cap: CapValue, call: NodePath<t.CallExpression | t.NewExpression>): void {
    switch (cap.role) {
      case 'loader':
        if (call.isNewExpression()) return escape(call.node, 'loader used as a constructor');
        return emitLoadSink(call as NodePath<t.CallExpression>, cap.kind);
      case 'resolver':
        if (call.isNewExpression()) return escape(call.node, 'resolver used as a constructor');
        return emitResolveSink(call as NodePath<t.CallExpression>, cap.kind);
      case 'createRequire':
        // The chain stays visible: createRequire yields a distinct loader kind.
        return bindValue(call, { role: 'loader', kind: 'createRequire-result' });
      case 'getBuiltinModule': {
        const a0 = (call.get('arguments') as NodePath<t.Node>[])[0];
        const consts = a0 && a0.node ? constantStrings(a0) : null;
        if (!consts) {
          // Unknown builtin: the result may be node:module, so it is treated as
          // loader-capable rather than assumed harmless.
          widen(ctx, call.node, 'process.getBuiltinModule with a non-constant argument treated as loader-capable');
          return bindValue(call, { role: 'loader', kind: 'getBuiltinModule' });
        }
        if (consts.some((s) => s === 'module' || s === 'node:module')) {
          return bindValue(call, { role: 'module-namespace' });
        }
        if (consts.some((s) => s === 'vm' || s === 'node:vm')) {
          return bindValue(call, { role: 'vm-namespace' });
        }
        return; // a constant non-loader builtin ('fs', 'path', …) grants nothing
      }
      case 'vm-namespace':
        return vmSink(call, 'vm(...)', null, call.node);
      case 'vm-api':
        return vmSink(call, cap.api, cap.api.replace(/^vm\./, ''), call.node);
      case 'module-namespace':
        return escape(call.node, 'node:module namespace called directly');
      case 'process':
        return; // `process(...)` is a TypeError, not a load
      case 'global-object':
        return escape(call.node, 'the global object called directly');
    }
  }

  function memberOfCap(
    cap: CapValue,
    member: NodePath<t.MemberExpression | t.OptionalMemberExpression>,
  ): void {
    const name = propName(member);
    if (cap.role === 'vm-namespace') {
      const parent = member.parentPath;
      if ((parent?.isCallExpression() || parent?.isNewExpression()) && parent.node.callee === member.node) {
        return vmSink(parent as NodePath<t.CallExpression | t.NewExpression>, `vm.${name ?? '?'}`, name, parent.node);
      }
      if (name && parent?.isVariableDeclarator() && parent.node.init === member.node) {
        const id = parent.node.id;
        if (t.isIdentifier(id)) return track(parent.scope.getBinding(id.name), { role: 'vm-api', api: `vm.${name}` }, member.node);
      }
      // An escaped/aliased vm entry point: one conservative sink, evidence unknown.
      return vmSink(null, `vm.${name ?? '?'}`, null, member.node);
    }
    if (cap.role === 'global-object') {
      // CAP-F2. The global object is a channel to every ambient capability, so
      // only the reads whose target we model stay narrow. A WRITE is exempt:
      // storing a value on the global object cannot EXTRACT a capability, and
      // storing a capability there already escaped at the value's own site.
      const gp = member.parentPath;
      if (gp?.isAssignmentExpression() && gp.node.left === member.node) return;
      if (name === null) {
        return escape(member.node, 'computed property read on the global object');
      }
      if (name === 'process') return bindValue(member, { role: 'process' });
      if (name === 'eval' || name === 'Function') {
        // Member-rooted: INDIRECT eval / global Function — global scope, and
        // ADR-0002 keeps import()/getBuiltinModule available there.
        return handleGeneratedSite(member, ctx, analyzeCapabilities, name, false);
      }
      if (name === 'require') return bindValue(member, { role: 'loader', kind: 'lexical-require' });
      if (GLOBAL_OBJECT_NAMES.has(name)) return bindValue(member, { role: 'global-object' });
      if (isNonLeaking(member)) return;
      return escape(member.node, `unmodeled property "${name}" read on the global object`);
    }
    if (name === null) {
      return escape(member.node, 'computed property read on a capability value');
    }
    switch (cap.role) {
      case 'loader':
        if (name === 'resolve') return bindValue(member, { role: 'resolver', kind: cap.kind });
        if (name === 'cache' || name === 'extensions') {
          // Sink-less, universe-wide gate: the engine decides its blast radius.
          if (!ctx.moduleGates.includes('require-cache-mutation')) ctx.moduleGates.push('require-cache-mutation');
          widen(ctx, member.node, `require.${name} touched`);
          return;
        }
        // `require.main` is a Module object — loader-capable. Nothing else on a
        // loader is known-benign, so everything else widens, unless the read
        // feeds a comparison whose result is a boolean (`require.main === module`).
        if (isNonLeaking(member)) return;
        return escape(member.node, `unmodeled property "${name}" read on a loader`);
      case 'module-namespace':
        if (name === 'createRequire') return bindValue(member, { role: 'createRequire' });
        if (MODULE_BENIGN.has(name)) return;
        return escape(member.node, `node:module member "${name}" may reconstruct a loader`);
      case 'process':
        // CAP-F3. Reached here only for a NAMED read: the computed case already
        // escaped above, which is the fail-closed behaviour `module` always had.
        if (name === 'getBuiltinModule') return bindValue(member, { role: 'getBuiltinModule' });
        if (PROCESS_LOADING_CHANNELS.has(name)) {
          return escape(member.node, `process.${name} is a loading channel`);
        }
        return; // env, argv, platform, … — metadata, not loading power
      default:
        if (isNonLeaking(member)) return;
        return escape(member.node, `property "${name}" read on a capability factory`);
    }
  }

  /**
   * A capability value crossing an unmodeled boundary. For vm the strict model
   * already has a maximal answer — one conservative vm site with unknown
   * evidence — so it stays on the `vm-conservative` gate instead of collapsing
   * into `escaped-loader`, which would blur the two counterfactuals.
   */
  function escapeCap(cap: CapValue, node: t.Node | null, why: string): void {
    if (cap.role === 'vm-namespace' || cap.role === 'vm-api') {
      return vmSink(null, cap.role === 'vm-api' ? cap.api : 'vm', null, node);
    }
    // CAP-F3 keeps the correct rule: `process` is ambient in every execution
    // context, so handing it to a callee grants that callee nothing it did not
    // already have. Only reads we cannot follow (computed / unmodeled
    // destructuring) widen.
    if (cap.role === 'process') return;
    escape(node, why);
  }

  /** Where a produced capability value goes next (call/member/binding chains). */
  function bindValue(valuePath: NodePath, cap: CapValue): void {
    let v = valuePath;
    if (v.parentPath?.isAwaitExpression()) v = v.parentPath;
    const parent = v.parentPath;
    if (!parent) return escape(v.node, 'capability value has no parent');
    if (parent.isExpressionStatement()) return; // produced and discarded
    if ((parent.isCallExpression() || parent.isNewExpression()) && parent.node.callee === v.node) {
      return applyCap(cap, parent as NodePath<t.CallExpression | t.NewExpression>);
    }
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === v.node
    ) {
      return memberOfCap(cap, parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>);
    }
    if (parent.isVariableDeclarator() && parent.node.init === v.node) {
      return bindPattern(parent, cap, v.node);
    }
    if (isNonLeaking(v)) return;
    return escapeCap(cap, v.node, `capability value used in an unmodeled position (${parent.node.type})`);
  }

  function bindPattern(decl: NodePath<t.VariableDeclarator>, cap: CapValue, node: t.Node | null): void {
    const id = decl.node.id;
    if (t.isIdentifier(id)) return track(decl.scope.getBinding(id.name), cap, node);
    if (t.isObjectPattern(id)) return destructureCap(decl, id, cap);
    return escapeCap(cap, node, 'capability bound by an unmodeled pattern');
  }

  /** Destructuring is sound only from containers whose member semantics we know. */
  function destructureCap(decl: NodePath<t.VariableDeclarator>, pattern: t.ObjectPattern, cap: CapValue): void {
    if (cap.role !== 'module-namespace' && cap.role !== 'vm-namespace' && cap.role !== 'process') {
      return escape(pattern, `destructuring a ${cap.role} value`);
    }
    for (const prop of pattern.properties) {
      if (t.isRestElement(prop)) return escape(pattern, 'rest-destructuring a capability factory');
      if (prop.computed || !t.isIdentifier(prop.value)) {
        return escape(pattern, 'computed/nested destructuring of a capability factory');
      }
      const key = t.isIdentifier(prop.key)
        ? prop.key.name
        : t.isStringLiteral(prop.key)
          ? prop.key.value
          : null;
      if (key === null) return escape(pattern, 'unrecognized destructuring key');
      const binding = decl.scope.getBinding(prop.value.name);
      if (cap.role === 'vm-namespace') {
        track(binding, { role: 'vm-api', api: `vm.${key}` }, prop);
      } else if (cap.role === 'process') {
        // CAP-F3: the same split as the member read, so `const {getBuiltinModule}
        // = process` keeps the factory chain visible instead of losing it.
        if (key === 'getBuiltinModule') track(binding, { role: 'getBuiltinModule' }, prop);
        else if (PROCESS_LOADING_CHANNELS.has(key)) escape(prop, `process.${key} is a loading channel`);
      } else if (key === 'createRequire') {
        track(binding, { role: 'createRequire' }, prop);
      } else if (!MODULE_BENIGN.has(key)) {
        escape(prop, `node:module member "${key}" may reconstruct a loader`);
      }
    }
  }

  /**
   * Storage in an object/array literal is modeled only when the container
   * binding itself never escapes — otherwise the capability left with it.
   */
  function storeInContainer(ref: NodePath, cap: CapValue): void {
    const prop = ref.parentPath;
    let key: string | null;
    let container: NodePath | null | undefined;
    if (prop?.isObjectProperty() && prop.node.value === ref.node) {
      if (prop.node.computed) return escape(ref.node, 'capability stored under a computed key');
      key = t.isIdentifier(prop.node.key)
        ? prop.node.key.name
        : t.isStringLiteral(prop.node.key)
          ? prop.node.key.value
          : null;
      if (key === null) return escape(ref.node, 'capability stored under an unrecognized key');
      container = prop.parentPath;
      if (!container?.isObjectExpression()) return escape(ref.node, 'capability stored in a non-literal object');
    } else if (prop?.isArrayExpression()) {
      key = null; // any element read may yield the capability
      container = prop;
    } else {
      return escape(ref.node, 'capability stored in an unmodeled container');
    }

    const decl = container.parentPath;
    if (!decl?.isVariableDeclarator() || decl.node.init !== container.node || !t.isIdentifier(decl.node.id)) {
      return escape(ref.node, 'capability container is not a simple local binding');
    }
    const binding = decl.scope.getBinding(decl.node.id.name);
    if (!binding || binding.constantViolations.length > 0) {
      return escape(ref.node, 'capability container binding is reassigned');
    }

    const tag = `${decl.node.id.name}|${key ?? '*'}|${decl.node.start ?? -1}`;
    if (containersDone.has(tag)) return;
    containersDone.add(tag);

    for (const cref of binding.referencePaths) {
      if (isNonLeaking(cref)) continue;
      const parent = cref.parentPath;
      if (
        (parent?.isMemberExpression() || parent?.isOptionalMemberExpression()) &&
        parent.node.object === cref.node
      ) {
        const read = propName(parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>);
        if (key === null) {
          bindValue(parent, cap);
        } else if (read === key) {
          bindValue(parent, cap);
        } else if (read === null) {
          escape(cref.node, 'computed read from a container holding a capability');
        }
        continue; // a different, non-capability property
      }
      escape(cref.node, 'container holding a capability escapes');
    }
  }

  function handleRef(ref: NodePath, cap: CapValue): void {
    if (isNonLeaking(ref)) return;
    const parent = ref.parentPath;
    if (!parent) return escape(ref.node, 'capability reference without a parent');
    if ((parent.isCallExpression() || parent.isNewExpression()) && parent.node.callee === ref.node) {
      return applyCap(cap, parent as NodePath<t.CallExpression | t.NewExpression>);
    }
    if (
      (parent.isMemberExpression() || parent.isOptionalMemberExpression()) &&
      parent.node.object === ref.node
    ) {
      return memberOfCap(cap, parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>);
    }
    if (parent.isVariableDeclarator() && parent.node.init === ref.node) {
      return bindPattern(parent, cap, ref.node);
    }
    if (parent.isObjectProperty() || parent.isArrayExpression()) {
      return storeInContainer(ref, cap);
    }
    // Call argument, return, export, assignment, property write, spread, …
    return escapeCap(cap, ref.node, `capability value used in an unmodeled position (${parent.node.type})`);
  }

  // -- seeds ----------------------------------------------------------------

  function seedModuleObject(ref: NodePath): void {
    const parent = ref.parentPath;
    if (
      (parent?.isMemberExpression() || parent?.isOptionalMemberExpression()) &&
      parent.node.object === ref.node
    ) {
      const name = propName(parent as NodePath<t.MemberExpression | t.OptionalMemberExpression>);
      if (name === 'require') return bindValue(parent, { role: 'loader', kind: 'module-require' });
      if (name !== null && MODULE_OBJ_BENIGN.has(name)) return;
      // `module.constructor` is the Module class → createRequire is reachable.
      return escape(ref.node, `unmodeled property "${name ?? '<computed>'}" read on the CJS module object`);
    }
    return escape(ref.node, 'the CJS module object escapes');
  }

  program.traverse({
    Identifier(p) {
      const name = p.node.name;
      if (
        name !== 'require' && name !== 'module' && name !== 'process' &&
        name !== 'eval' && name !== 'Function' && name !== 'arguments' &&
        !GLOBAL_OBJECT_NAMES.has(name)
      ) {
        return;
      }
      if (!p.isReferencedIdentifier()) return;
      if (p.scope.getBinding(name)) return; // shadowed: not the global/module scope one
      const ref = p as NodePath<t.Identifier>;
      seeds.push(() => {
        if (isNonLeaking(ref)) return;
        // CAP-F12: a CJS module body runs inside Node's wrapper function
        // `(exports, require, module, __filename, __dirname)`, so its top-level
        // `arguments` object HOLDS the lexical loader — `arguments[1]('victim')`
        // loads. Arrow functions do not rebind `arguments`, so the nearest
        // NON-arrow function ancestor decides whether this is the wrapper's.
        // The reads are index expressions we do not model, so this escapes.
        if (name === 'arguments') {
          if (ctx.env !== 'lexical' || ctx.format !== 'cjs') return;
          for (let a: NodePath | null = ref.parentPath; a; a = a.parentPath) {
            if (a.isProgram()) break;
            if (a.isFunction() && !a.isArrowFunctionExpression()) return; // its own `arguments`
          }
          return escape(ref.node, 'the CJS module wrapper `arguments` object holds require/module');
        }
        if (name === 'eval' || name === 'Function') {
          return handleGeneratedSite(ref, ctx, analyzeCapabilities, name, true);
        }
        // CAP-F2: an unbound globalThis/global/self/window IS the global object,
        // the root of every ambient capability chain.
        if (GLOBAL_OBJECT_NAMES.has(name)) return handleRef(ref, { role: 'global-object' });
        // CAP-F3: `process` flows like `module` does — through aliases and
        // destructuring — instead of only being read one member deep.
        if (name === 'process') return handleRef(ref, { role: 'process' });
        // SOUNDNESS: an unbound `require`/`module` is a capability ONLY in a CJS
        // execution context. In ESM, and in `Function`/indirect-eval generated
        // source, referencing them is a runtime ReferenceError — no capability.
        if (ctx.env !== 'lexical' || ctx.format !== 'cjs') return;
        if (name === 'require') return handleRef(ref, { role: 'loader', kind: 'lexical-require' });
        return seedModuleObject(ref);
      });
    },
    CallExpression(p) {
      if (!t.isImport(p.node.callee)) return;
      // `import()` is ambient in every execution context (ADR-0002).
      seeds.push(() => emitLoadSink(p, 'dynamic-import'));
    },
    MemberExpression(p) {
      if (!t.isMetaProperty(p.node.object)) return;
      if (propName(p) !== 'resolve') return;
      seeds.push(() => {
        const parent = p.parentPath;
        if (parent?.isCallExpression() && parent.node.callee === p.node) {
          return emitResolveSink(parent, 'import-meta-resolve');
        }
        widen(ctx, p.node, 'import.meta.resolve referenced as a value');
        addSink(ctx, {
          capability: 'import-meta-resolve',
          effect: 'resolve',
          specifier: unbounded(),
          result: { kind: 'unused' },
          node: p.node,
        });
      });
    },
    ImportDeclaration(p) {
      const src = p.node.source.value;
      const bare = src.startsWith('node:') ? src.slice(5) : src;
      if (bare !== 'module' && bare !== 'vm') return;
      seeds.push(() => {
        for (const spec of p.node.specifiers) {
          const binding = p.scope.getBinding(spec.local.name);
          if (t.isImportDefaultSpecifier(spec) || t.isImportNamespaceSpecifier(spec)) {
            track(binding, bare === 'module' ? { role: 'module-namespace' } : { role: 'vm-namespace' }, spec);
            continue;
          }
          if (!t.isImportSpecifier(spec)) continue;
          const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          if (bare === 'vm') track(binding, { role: 'vm-api', api: `vm.${imported}` }, spec);
          else if (imported === 'createRequire') track(binding, { role: 'createRequire' }, spec);
          else if (!MODULE_BENIGN.has(imported)) {
            escape(spec, `node:module named import "${imported}" may reconstruct a loader`);
          }
        }
      });
    },
  });

  // Bindings and scopes are complete only after the traversal finishes
  // (analyzer:419 defers for the same reason).
  for (const seed of seeds) seed();
  while (queue.length > 0) {
    const item = queue.shift() as { binding: Binding; cap: CapValue };
    for (const ref of item.binding.referencePaths) handleRef(ref, item.cap);
  }
}
