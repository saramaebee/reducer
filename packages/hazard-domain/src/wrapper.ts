/**
 * Demand-driven loader-wrapper propagation (design §5, ADR-0002's "shallow,
 * non-escaping wrappers with enumerable callers only").
 *
 * A sink whose specifier is a parameter of an enclosing function F may take the
 * union of F's call-site argument domains ONLY under the full precondition set
 * below. This is the one place the analyzer narrows a domain it could not read
 * syntactically, so each precondition is a real proof obligation:
 *
 *   1. the param is a plain positional Identifier, never reassigned;
 *   2. F has a single statically-known definition (FunctionDeclaration, or a
 *      const-bound function/arrow) and its binding is never reassigned;
 *   3. F's value never escapes — every reference is a direct callee;
 *   4. every call site is in THIS module (cross-module callers are not
 *      enumerable from per-module facts — that is SR-cross-module-wrapper,
 *      NOT strict, so it widens here and is recorded as evidence instead);
 *   5. at least one call site exists (zero callers would let us claim an empty
 *      domain; proving "never called" needs the whole universe, not this file);
 *   6. the argument→sink flow is a direct identifier use.
 *
 * Any violation ⇒ unbounded with gate `wrapper-unprovable`; running out of
 * depth ⇒ unbounded with gate `wrapper-depth`. Depth affects precision only.
 */
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { SpecifierDomain, WrapperEvidence } from './types.ts';
import { evaluateSpecifierDomain, findParamRoot, unbounded, unionDomains } from './specifier.ts';

const MAX_WRAPPER_DEPTH = 3;

export interface WrapperResult {
  domain: SpecifierDomain;
  evidence: WrapperEvidence;
}

/** Export plumbing shapes — a reference here means callers live in other modules. */
function isExportRef(ref: NodePath): boolean {
  if (ref.isExportNamedDeclaration()) return true;
  const parent = ref.parentPath;
  if (!parent) return false;
  if (parent.isExportSpecifier() || parent.isExportDefaultDeclaration()) return true;
  // CJS: `module.exports = fn`, `exports.x = fn`, `module.exports = { x: fn }`
  if (parent.isAssignmentExpression() && parent.node.right === ref.node) {
    const left = parent.node.left;
    if (t.isIdentifier(left, { name: 'exports' })) return true;
    if (t.isMemberExpression(left)) {
      const root = t.isMemberExpression(left.object) ? left.object.object : left.object;
      if (t.isIdentifier(root, { name: 'exports' }) || t.isIdentifier(root, { name: 'module' })) {
        return true;
      }
    }
    return false;
  }
  if (parent.isObjectProperty() && parent.node.value === ref.node) {
    const assign = parent.parentPath?.parentPath;
    return !!assign && assign.isAssignmentExpression() && isExportRef(parent);
  }
  return false;
}

function fail(
  depth: number,
  fn: string,
  why: string,
  gate: 'wrapper-unprovable' | 'wrapper-depth',
  callSiteDomains: SpecifierDomain[] = [],
  crossModuleOnly = false,
): WrapperResult {
  return {
    domain: unbounded([gate]),
    evidence: { depth, resolved: false, fn, callSiteDomains, crossModuleOnly, why },
  };
}

/**
 * Attempt wrapper propagation for a sink specifier expression.
 * Returns null when the expression is not parameter-shaped at all (nothing to
 * say — the caller keeps whatever domain it already had).
 */
export function resolveWrapperDomain(
  expr: NodePath<t.Node> | null | undefined,
  depth = 0,
): WrapperResult | null {
  const root = findParamRoot(expr);
  if (!root) return null;
  if (depth >= MAX_WRAPPER_DEPTH) {
    return fail(depth, '<depth>', `wrapper nesting exceeded ${MAX_WRAPPER_DEPTH}`, 'wrapper-depth');
  }

  const name = root.node.name;
  const binding = root.scope.getBinding(name);
  if (!binding || binding.kind !== 'param') return fail(depth, name, 'not a parameter', 'wrapper-unprovable');
  // (1) a reassigned parameter no longer carries the call-site argument.
  if (binding.constantViolations.length > 0) {
    return fail(depth, name, `parameter "${name}" is reassigned`, 'wrapper-unprovable');
  }

  const fnPath = binding.scope.path;
  if (!fnPath.isFunction()) return fail(depth, name, 'parameter outside a function', 'wrapper-unprovable');
  const params = fnPath.node.params;
  const idx = params.findIndex((pp) => t.isIdentifier(pp) && pp.name === name);
  // Defaults (AssignmentPattern), rest and destructuring all fail this test:
  // for those the call-site argument is not the parameter's value.
  if (idx < 0) return fail(depth, name, 'non-plain parameter shape', 'wrapper-unprovable');

  // (2) a single statically-known definition with a stable name.
  let fnName = '<anonymous>';
  let fnBinding: Binding | undefined;
  if (fnPath.isFunctionDeclaration() && fnPath.node.id) {
    fnName = fnPath.node.id.name;
    fnBinding = fnPath.scope.parent?.getBinding(fnName) ?? fnPath.scope.getBinding(fnName);
  } else {
    const decl = fnPath.parentPath;
    if (
      decl?.isVariableDeclarator() &&
      decl.node.init === fnPath.node &&
      t.isIdentifier(decl.node.id)
    ) {
      fnName = decl.node.id.name;
      fnBinding = decl.scope.getBinding(fnName);
      if (fnBinding && fnBinding.kind !== 'const') {
        return fail(depth, fnName, 'wrapper binding is not const', 'wrapper-unprovable');
      }
    }
  }
  if (!fnBinding) {
    return fail(depth, fnName, 'wrapper has no statically-known named definition', 'wrapper-unprovable');
  }
  if (fnBinding.constantViolations.length > 0) {
    return fail(depth, fnName, 'wrapper binding is reassigned', 'wrapper-unprovable');
  }

  // (3)+(4) every reference must be a direct callee in this module.
  const callSites: NodePath<t.CallExpression>[] = [];
  let escaped = false;
  let exportedOnly = true;
  for (const ref of fnBinding.referencePaths) {
    const parent = ref.parentPath;
    if (parent?.isCallExpression() && parent.node.callee === ref.node) {
      callSites.push(parent);
      continue;
    }
    escaped = true;
    if (!isExportRef(ref)) exportedOnly = false;
  }

  const callSiteDomains: SpecifierDomain[] = [];
  for (const call of callSites) {
    const args = call.get('arguments');
    const arg = args[idx];
    if (!arg || !arg.node || arg.isSpreadElement()) {
      callSiteDomains.push(unbounded(['wrapper-unprovable']));
      continue;
    }
    let d = evaluateSpecifierDomain(arg as NodePath<t.Node>);
    if (d.tier === 'unbounded') {
      const nested = resolveWrapperDomain(arg as NodePath<t.Node>, depth + 1);
      if (nested) d = nested.domain;
    }
    callSiteDomains.push(d);
  }

  if (escaped) {
    // The value crossed a boundary we cannot enumerate. When it did so ONLY by
    // being exported, the in-module call-site domains are still recorded: that
    // is exactly the SR-cross-module-wrapper admission evidence.
    return fail(
      depth,
      fnName,
      exportedOnly ? 'wrapper is exported; callers are cross-module' : 'wrapper value escapes',
      'wrapper-unprovable',
      callSiteDomains,
      exportedOnly,
    );
  }
  // (5) zero enumerable callers is not a proof of an empty domain.
  if (callSiteDomains.length === 0) {
    return fail(depth, fnName, 'no call sites in this module', 'wrapper-unprovable');
  }

  const domain = unionDomains(callSiteDomains);
  if (domain.tier === 'unbounded') {
    return {
      domain,
      evidence: {
        depth,
        resolved: false,
        fn: fnName,
        callSiteDomains,
        crossModuleOnly: false,
        why: 'a call-site argument domain is unbounded',
      },
    };
  }
  return {
    domain,
    evidence: { depth, resolved: true, fn: fnName, callSiteDomains, crossModuleOnly: false },
  };
}
