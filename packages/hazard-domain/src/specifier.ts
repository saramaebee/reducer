/**
 * Specifier-domain evaluation (CONTEXT.md "specifier domain").
 *
 * SOUNDNESS: the lattice is `exact ⊑ finite ⊑ package ⊑ unbounded` and every
 * function here is a *proof attempt*. A domain narrower than `unbounded` is
 * returned only when the specifier's complete value set is established from
 * syntax alone; every unproven case falls through to `unbounded`. There is no
 * path in this file that narrows a domain, so composing the helpers can only
 * widen — which is the required monotone direction.
 */
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { GateTag, SpecifierDomain } from './types.ts';

/** Beyond this the set is no longer a useful bound; widening stays sound. */
const MAX_SET = 64;
/** Guards against pathological const-alias / concat chains (precision only). */
const MAX_DEPTH = 8;

export function unbounded(gates: GateTag[] = ['unbounded-loader-target']): SpecifierDomain {
  return { tier: 'unbounded', gates };
}

export function domainFromStrings(values: string[]): SpecifierDomain {
  const set = [...new Set(values)].sort();
  // An empty set would claim "this sink can load nothing" — only provable by
  // enumerating callers, which is not what this function did. Widen instead.
  if (set.length === 0 || set.length > MAX_SET) return unbounded();
  if (set.length === 1) return { tier: 'exact', specifiers: [set[0]] };
  return { tier: 'finite', specifiers: set };
}

function cross(as: string[], bs: string[]): string[] | null {
  if (as.length * bs.length > MAX_SET) return null;
  const out: string[] = [];
  for (const a of as) for (const b of bs) out.push(a + b);
  return out;
}

/**
 * The complete constant string-value set of an expression, or null when it
 * cannot be proven constant. Null is the fail-closed answer: callers widen.
 */
export function constantStrings(
  p: NodePath<t.Node> | null | undefined,
  depth = 0,
): string[] | null {
  if (!p || !p.node || depth > MAX_DEPTH) return null;
  const n = p.node;

  if (t.isStringLiteral(n)) return [n.value];

  if (t.isTemplateLiteral(n)) {
    const tp = p as NodePath<t.TemplateLiteral>;
    const exprs = tp.get('expressions');
    let acc: string[] = [n.quasis[0].value.cooked ?? ''];
    for (let i = 0; i < exprs.length; i++) {
      const parts = constantStrings(exprs[i] as NodePath<t.Node>, depth + 1);
      if (!parts) return null;
      const joined = cross(acc, parts);
      if (!joined) return null;
      const tail = n.quasis[i + 1].value.cooked ?? '';
      acc = joined.map((s) => s + tail);
    }
    return acc;
  }

  if (t.isBinaryExpression(n) && n.operator === '+') {
    const bp = p as NodePath<t.BinaryExpression>;
    const left = constantStrings(bp.get('left') as NodePath<t.Node>, depth + 1);
    if (!left) return null;
    const right = constantStrings(bp.get('right'), depth + 1);
    if (!right) return null;
    return cross(left, right);
  }

  if (t.isConditionalExpression(n)) {
    const cp = p as NodePath<t.ConditionalExpression>;
    const a = constantStrings(cp.get('consequent'), depth + 1);
    if (!a) return null;
    const b = constantStrings(cp.get('alternate'), depth + 1);
    if (!b) return null;
    return [...a, ...b];
  }

  if (t.isArrayExpression(n)) {
    const ap = p as NodePath<t.ArrayExpression>;
    const out: string[] = [];
    for (const el of ap.get('elements')) {
      if (!el.node) return null; // hole
      const v = constantStrings(el as NodePath<t.Node>, depth + 1);
      if (!v) return null;
      out.push(...v);
    }
    return out;
  }

  if (t.isIdentifier(n)) {
    // SOUNDNESS: only a `const` binding with zero constantViolations whose
    // initializer is itself constant. `let`/`var` are refused even with zero
    // violations — hoisting/TDZ make their value at the sink site a temporal
    // question this syntactic check does not answer.
    const binding = p.scope.getBinding(n.name);
    if (!binding) return null;
    if (binding.kind !== 'const' || binding.constantViolations.length > 0) return null;
    if (!binding.path.isVariableDeclarator()) return null;
    const init = binding.path.get('init');
    if (!init.node) return null;
    return constantStrings(init as NodePath<t.Node>, depth + 1);
  }

  return null;
}

/**
 * The constant text a specifier expression is *guaranteed to start with*, when
 * its tail is unknown: `'pkg/' + x`, `` `pkg/${x}` ``, `'a' + 'b/' + x`.
 */
function leadingConstantPrefix(p: NodePath<t.Node>, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  const n = p.node;
  if (t.isBinaryExpression(n) && n.operator === '+') {
    const left = (p as NodePath<t.BinaryExpression>).get('left') as NodePath<t.Node>;
    const constant = constantStrings(left);
    if (constant && constant.length === 1) return constant[0];
    return leadingConstantPrefix(left, depth + 1);
  }
  if (t.isTemplateLiteral(n) && n.expressions.length > 0) {
    return n.quasis[0].value.cooked ?? null;
  }
  return null;
}

/**
 * The package a constant prefix pins, or null.
 *
 * SOUNDNESS: the prefix must extend strictly past the *complete* package name
 * and land on the `/` that separates name from subpath. `'lodash' + x` is NOT
 * package-scoped — it also spans `lodash-es`, `lodashy`, … — and neither is
 * `'@scope/' + x`, whose package name is still incomplete.
 */
export function packageOfPrefix(prefix: string): string | null {
  if (!prefix || prefix.startsWith('.') || prefix.startsWith('/')) return null;
  if (prefix.includes('..') || prefix.includes('\0')) return null;
  const parts = prefix.split('/');
  const nameParts = prefix.startsWith('@') ? 2 : 1;
  if (parts.length <= nameParts) return null; // prefix stops at/inside the name
  if (parts.slice(0, nameParts).some((s) => s.length === 0)) return null;
  const name = parts.slice(0, nameParts).join('/');
  return prefix.startsWith(name + '/') ? name : null;
}

/**
 * The specifier domain of a load sink's specifier expression. `scope` is
 * accepted for call-site symmetry; binding resolution always uses the
 * expression path's own scope, which is the scope that actually governs it.
 */
export function evaluateSpecifierDomain(
  exprPath: NodePath<t.Node> | null | undefined,
  _scope?: unknown,
): SpecifierDomain {
  if (!exprPath || !exprPath.node) return unbounded();
  const consts = constantStrings(exprPath);
  if (consts) return domainFromStrings(consts);
  const prefix = leadingConstantPrefix(exprPath);
  if (prefix) {
    const pkg = packageOfPrefix(prefix);
    if (pkg) return { tier: 'package', pkg, note: `constant prefix ${JSON.stringify(prefix)}` };
  }
  return unbounded();
}

/**
 * Walk a const-alias chain down to the parameter identifier that feeds it, so
 * the wrapper analysis can decide whether call-site domains may be substituted.
 * Returns null when the expression is not (a chain of) a bare identifier.
 */
export function findParamRoot(
  p: NodePath<t.Node> | null | undefined,
  depth = 0,
): NodePath<t.Identifier> | null {
  if (!p || !p.node || depth > MAX_DEPTH) return null;
  if (!t.isIdentifier(p.node)) return null;
  const binding = p.scope.getBinding(p.node.name);
  if (!binding) return null;
  if (binding.kind === 'param') return p as NodePath<t.Identifier>;
  // `const s = n; require(s)` — one hop through an immutable local alias.
  if (
    binding.kind === 'const' &&
    binding.constantViolations.length === 0 &&
    binding.path.isVariableDeclarator()
  ) {
    const init = binding.path.get('init');
    if (init.node) return findParamRoot(init as NodePath<t.Node>, depth + 1);
  }
  return null;
}

/** Least upper bound of a set of domains. Any doubt lands on unbounded. */
export function unionDomains(domains: SpecifierDomain[]): SpecifierDomain {
  if (domains.length === 0) return unbounded();
  const gates: GateTag[] = [];
  const strings: string[] = [];
  const pkgs = new Set<string>();
  for (const d of domains) {
    if (d.tier === 'unbounded') gates.push(...d.gates);
    else if (d.tier === 'package') pkgs.add(d.pkg);
    else strings.push(...d.specifiers);
  }
  if (gates.length > 0) return unbounded([...new Set(gates)]);
  if (pkgs.size === 0) return domainFromStrings(strings);
  // A package tier and anything else do not join below unbounded: a package
  // domain is an unknown subpath set, which no finite set covers.
  if (pkgs.size === 1 && strings.length === 0) {
    return { tier: 'package', pkg: [...pkgs][0] };
  }
  return unbounded();
}
