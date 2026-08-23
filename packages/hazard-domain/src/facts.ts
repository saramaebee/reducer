/**
 * Per-module facts: export surface, static edges, load sinks (design §2).
 *
 * The export-surface and static-edge recognition here is a deliberate PORT of
 * `packages/analyzer/src/index.ts` — not a re-derivation. Every rule carries a
 * citation to the analyzer line that established it, because several are
 * hard-won regression fixes (the CJS duplicate-write widening and the
 * `mentionsExportMachinery` temporal-aliasing rule each fix a confirmed
 * unsoundness; `isExportPlumbingRef` is deliberately an exact-shape test and
 * NOT an ancestor scan). Behaviour must stay identical; the only additions are
 * `bodySpan` (byte prediction needs a symbol's extent, which the analyzer never
 * recorded) and the capability/load-sink pass.
 *
 * The analyzer's per-module *hazard* flags are intentionally NOT ported: they
 * are the flat syntax model ADR-0002 replaces with capabilities.
 */
import { createRequire } from 'node:module';
import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import type { Reason } from '@reducer/manifest';
import type { ExportFact, ModuleFacts, StaticEdge } from './types.ts';
import {
  analyzeCapabilities,
  newUsage,
  patternNames,
  trackValueBinding,
  type CapContext,
  type UsageSink,
} from './capability.ts';

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

interface EdgeDraft {
  source: string;
  resolvedAbs: string | null;
  u: UsageSink;
}

export function extractModuleFacts(
  code: string,
  abs: string,
  rel: string,
  thirdParty: boolean,
  pkg: { name: string; version: string; dir: string } | null,
): ModuleFacts {
  const bytes = Buffer.byteLength(code);
  const base: Omit<ModuleFacts, 'format' | 'parseFailed'> = {
    rel,
    abs,
    bytes,
    thirdParty,
    pkg,
    exports: new Map(),
    surfaceOpen: [],
    staticEdges: [],
    sinks: [],
    escapedLoader: false,
    moduleGates: [],
    widened: [],
  };

  let ast: t.File;
  try {
    // analyzer:190 — identical parser options. errorRecovery:false so a parse
    // failure is a hard "opaque module", never a partial (unsound) AST.
    ast = babelParse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
    });
  } catch {
    return {
      ...base,
      format: 'cjs',
      parseFailed: true,
      surfaceOpen: ['unsupported-syntax'],
      widened: [{ where: rel, why: 'babel parse failure: module is opaque' }],
    };
  }

  const format: 'esm' | 'cjs' = ast.program.sourceType === 'module' ? 'esm' : 'cjs';
  const surfaceOpen: Reason[] = [];

  const req = createRequire(abs);
  const resolveDep = (source: string): string | null => {
    try {
      return req.resolve(source);
    } catch {
      return null;
    }
  };
  const edgeMap = new Map<string, EdgeDraft>();
  const edgeFor = (source: string): EdgeDraft => {
    let d = edgeMap.get(source);
    if (!d) {
      d = { source, resolvedAbs: resolveDep(source), u: newUsage() };
      edgeMap.set(source, d);
    }
    return d;
  };

  /** analyzer:231 — nodes that ARE recognized export plumbing. */
  const recognizedExportNodes = new Set<t.Node>();
  const rawExports = new Map<string, string | null>();

  let programPath: NodePath<t.Program> | null = null;
  const objectBindingSeen = new Set<Binding>();
  const deferredBindings: { scopePath: NodePath; name: string; u: UsageSink }[] = [];
  const deferredImportBindings: { name: string; u: UsageSink }[] = [];

  /** analyzer:238 handleRequireSite. */
  const handleRequireSite = (callPath: NodePath<t.CallExpression>, u: UsageSink) => {
    const parent = callPath.parentPath;
    if (parent.isVariableDeclarator() && parent.node.init === callPath.node) {
      const id = parent.node.id;
      if (t.isIdentifier(id)) {
        deferredBindings.push({ scopePath: parent, name: id.name, u });
        return;
      }
      if (t.isObjectPattern(id)) {
        patternNames(id, u);
        return;
      }
      u.all = true;
      u.gates.add('value-escaped');
      return;
    }
    if (parent.isMemberExpression() && parent.node.object === callPath.node) {
      const { property, computed } = parent.node;
      if (!computed && t.isIdentifier(property)) u.names.add(property.name);
      else if (computed && t.isStringLiteral(property)) u.names.add(property.value);
      else {
        u.all = true;
        u.gates.add('dynamic-property-access');
      }
      return;
    }
    if (parent.isExpressionStatement()) return; // side-effect-only require
    u.all = true;
    u.gates.add('value-escaped');
  };

  traverse(ast, {
    Program(p) {
      programPath = p;
    },
    ImportDeclaration(p) {
      const edge = edgeFor(p.node.source.value);
      for (const spec of p.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const imported = spec.imported;
          edge.u.names.add(t.isIdentifier(imported) ? imported.name : imported.value);
        } else if (t.isImportDefaultSpecifier(spec)) {
          // analyzer:283 — default of an ESM target, whole object for a CJS one.
          edge.u.names.add('default');
          deferredImportBindings.push({ name: spec.local.name, u: edge.u });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          deferredImportBindings.push({ name: spec.local.name, u: edge.u });
        }
      }
    },
    ExportNamedDeclaration(p) {
      if (p.node.source) {
        const edge = edgeFor(p.node.source.value);
        for (const spec of p.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
            edge.u.names.add(t.isIdentifier(spec.local) ? spec.local.name : (spec.local as any).value);
          } else {
            edge.u.all = true;
            edge.u.gates.add('reexport-namespace');
          }
        }
        recognizedExportNodes.add(p.node);
        return; // re-export: surface belongs to the source module
      }
      recognizedExportNodes.add(p.node);
      const decl = p.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) {
        rawExports.set(decl.id.name, decl.id.name);
      } else if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (t.isIdentifier(d.id)) rawExports.set(d.id.name, d.id.name);
          else surfaceOpen.push('unsupported-export-kind');
        }
      } else if (t.isClassDeclaration(decl) && decl.id) {
        rawExports.set(decl.id.name, decl.id.name);
      } else if (decl) {
        surfaceOpen.push('unsupported-export-kind');
      }
      for (const spec of p.node.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          rawExports.set(exported, t.isIdentifier(spec.local) ? spec.local.name : null);
        } else {
          surfaceOpen.push('unsupported-export-kind');
        }
      }
    },
    ExportDefaultDeclaration(p) {
      recognizedExportNodes.add(p.node);
      // analyzer:332 — record the backing local so the shared-implementation
      // rule protects it; `default` itself is forced non-stubbable below.
      const d = p.node.declaration;
      let local: string | null = null;
      if (t.isIdentifier(d)) local = d.name;
      else if ((t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) && d.id) local = d.id.name;
      rawExports.set('default', local);
    },
    ExportAllDeclaration(p) {
      recognizedExportNodes.add(p.node);
      const edge = edgeFor(p.node.source.value);
      edge.u.all = true;
      edge.u.gates.add('export-star');
      surfaceOpen.push('export-star');
    },
    CallExpression(p) {
      const callee = p.node.callee;
      if (t.isImport(callee)) {
        const arg = p.node.arguments[0];
        if (t.isStringLiteral(arg)) {
          // analyzer:352 — a literal dynamic import is a static edge whose
          // surface use is unknown. (The capability pass ALSO records it as a
          // load sink; the two agree on the target and are not double-counted
          // by the engine, which keys edges by resolved target.)
          const edge = edgeFor(arg.value);
          edge.u.all = true;
          edge.u.gates.add('dynamic-import');
        }
        return;
      }
      if (
        t.isIdentifier(callee, { name: 'require' }) &&
        !p.scope.getBinding('require') &&
        t.isStringLiteral(p.node.arguments[0]) &&
        p.node.arguments.length === 1
      ) {
        handleRequireSite(p, edgeFor((p.node.arguments[0] as t.StringLiteral).value).u);
      }
    },
  });

  if (!programPath) {
    return {
      ...base,
      format,
      parseFailed: true,
      surfaceOpen: ['unsupported-syntax'],
      widened: [{ where: rel, why: 'no Program node: module is opaque' }],
    };
  }
  const program: NodePath<t.Program> = programPath;

  // Deferred module-object bindings (analyzer:415 — scopes are complete now).
  for (const { name, u } of deferredImportBindings) {
    trackValueBinding(program.scope.getBinding(name), u, objectBindingSeen);
  }
  for (const { scopePath, name, u } of deferredBindings) {
    trackValueBinding(scopePath.scope.getBinding(name), u, objectBindingSeen);
  }

  // -------------------------------------------------------------------------
  // CJS export recognition — analyzer:427-531, ported verbatim.
  // -------------------------------------------------------------------------
  if (format === 'cjs') {
    // analyzer:432 — a right-hand side that itself mentions exports/module
    // (`exports.a = exports.b = fn`, `exports.init = function(){ exports.h = h }`)
    // hides export writes inside a "recognized" node. Refuse to recognize it.
    const mentionsExportMachinery = (node: t.Node): boolean => {
      let found = false;
      t.traverseFast(node, (n) => {
        if (t.isIdentifier(n) && (n.name === 'exports' || n.name === 'module')) found = true;
      });
      return found;
    };

    // analyzer:444 — an export name written more than once has observable
    // intermediate values (a require cycle can read `exports.x` between the
    // writes), so its final static value is not a sound proxy for what was
    // reachable. Any duplicate write widens the whole surface.
    const seenExportKeys = new Set<string>();

    const isExportsRoot = (node: t.Node): boolean =>
      t.isIdentifier(node, { name: 'exports' }) ||
      (t.isMemberExpression(node) &&
        !node.computed &&
        t.isIdentifier(node.object, { name: 'module' }) &&
        t.isIdentifier(node.property, { name: 'exports' }));

    for (const stmt of program.node.body) {
      if (!t.isExpressionStatement(stmt)) continue;
      const expr = stmt.expression;
      if (!t.isAssignmentExpression(expr) || expr.operator !== '=') continue;
      const left = expr.left;

      if (
        t.isMemberExpression(left) &&
        !left.computed &&
        t.isIdentifier(left.property) &&
        isExportsRoot(left.object)
      ) {
        if (mentionsExportMachinery(expr.right)) {
          surfaceOpen.push('export-object-mutation');
          continue;
        }
        if (seenExportKeys.has(left.property.name)) {
          surfaceOpen.push('export-object-mutation'); // overwritten key
          continue;
        }
        seenExportKeys.add(left.property.name);
        rawExports.set(left.property.name, t.isIdentifier(expr.right) ? expr.right.name : null);
        recognizedExportNodes.add(expr);
        continue;
      }

      if (isExportsRoot(left)) {
        if (mentionsExportMachinery(expr.right)) {
          surfaceOpen.push('export-object-mutation');
          continue;
        }
        if (t.isObjectExpression(expr.right)) {
          let ok = true;
          for (const prop of expr.right.properties) {
            if (!t.isObjectProperty(prop) || prop.computed) {
              ok = false;
              break;
            }
            const key = t.isIdentifier(prop.key)
              ? prop.key.name
              : t.isStringLiteral(prop.key)
                ? prop.key.value
                : null;
            if (key === null || seenExportKeys.has(key)) {
              ok = false;
              break;
            }
            seenExportKeys.add(key);
            rawExports.set(key, t.isIdentifier(prop.value) ? prop.value.name : null);
          }
          if (ok) {
            recognizedExportNodes.add(expr);
            continue;
          }
        }
        surfaceOpen.push('export-object-mutation');
        continue;
      }
    }

    // analyzer:519 — any OTHER reference to the CJS export machinery.
    program.traverse({
      Identifier(p) {
        const name = p.node.name;
        if (name !== 'exports' && name !== 'module') return;
        if (!p.isReferencedIdentifier()) return;
        if (p.scope.getBinding(name)) return; // user-shadowed, not the CJS global
        const insideRecognized =
          recognizedExportNodes.has(p.node) ||
          !!p.findParent((a) => recognizedExportNodes.has(a.node));
        if (!insideRecognized) surfaceOpen.push('export-object-mutation');
      },
    });
  }

  // analyzer:538 — export plumbing in these EXACT shapes only. An ancestor scan
  // is NOT sound: it would classify a closure reference inside another export's
  // initializer as plumbing.
  const isExportPlumbingRef = (ref: NodePath): boolean => {
    if (ref.isExportNamedDeclaration()) return true;
    const parent = ref.parentPath;
    if (!parent) return false;
    if (parent.isExportSpecifier()) return true;
    if (parent.isExportDefaultDeclaration()) return true;
    if (
      parent.isAssignmentExpression() &&
      recognizedExportNodes.has(parent.node) &&
      parent.node.right === ref.node
    ) {
      return true;
    }
    if (
      parent.isObjectProperty() &&
      parent.node.value === ref.node &&
      parent.parentPath?.isObjectExpression() &&
      parent.parentPath.parentPath?.isAssignmentExpression() &&
      recognizedExportNodes.has(parent.parentPath.parentPath.node)
    ) {
      return true;
    }
    return false;
  };

  // analyzer:573 — finalize exports. Stubbable iff a top-level
  // FunctionDeclaration whose only references are recognized export plumbing.
  const exports = new Map<string, ExportFact>();
  for (const [exportName, localName] of rawExports) {
    const info: ExportFact = { exportName, localName, stubbable: false, retainReasons: [] };
    if (!localName) {
      info.retainReasons.push('unsupported-export-kind');
    } else {
      const binding = program.scope.getBinding(localName);
      const isPlainTopLevelFn =
        !!binding &&
        binding.path.isFunctionDeclaration() &&
        (binding.path.parentPath?.isProgram() ||
          binding.path.parentPath?.isExportNamedDeclaration());
      if (!binding || !isPlainTopLevelFn) {
        info.retainReasons.push('unsupported-export-kind');
      } else if (binding.constantViolations.length > 0) {
        info.retainReasons.push('binding-reassigned');
      } else {
        const internalRefs = binding.referencePaths.filter((ref) => !isExportPlumbingRef(ref));
        if (internalRefs.length > 0) info.retainReasons.push('internal-reference');
        else info.stubbable = true;
      }
      // NEW (not in the analyzer): the body span, so byte prediction can size a
      // stub without running the transformer.
      if (isPlainTopLevelFn) {
        const body = (binding.path.node as t.FunctionDeclaration).body;
        if (typeof body.start === 'number' && typeof body.end === 'number') {
          info.bodySpan = { start: body.start, end: body.end };
        }
      }
    }
    // analyzer:599 — `default` is never a stub candidate, but keeps its
    // localName so the shared-implementation rule protects the backing fn.
    if (exportName === 'default' && !info.retainReasons.length) {
      info.retainReasons.push('unsupported-export-kind');
      info.stubbable = false;
    }
    exports.set(exportName, info);
  }

  // -------------------------------------------------------------------------
  // Capabilities and load sinks.
  // -------------------------------------------------------------------------
  const ctx: CapContext = {
    file: rel,
    env: 'lexical',
    format,
    generatedDepth: 0,
    counter: { n: 0 },
    sinks: [],
    moduleGates: [],
    widened: [],
    escapedLoader: false,
  };
  analyzeCapabilities(program, ctx);

  const staticEdges: StaticEdge[] = [...edgeMap.values()].map((d) => ({
    source: d.source,
    resolvedAbs: d.resolvedAbs,
    names: d.u.names,
    all: d.u.all,
    reasons: [...d.u.gates] as Reason[],
  }));

  return {
    rel,
    abs,
    bytes,
    format,
    thirdParty,
    pkg,
    exports,
    surfaceOpen: [...new Set(surfaceOpen)],
    staticEdges,
    sinks: ctx.sinks,
    escapedLoader: ctx.escapedLoader,
    moduleGates: [...new Set(ctx.moduleGates)],
    widened: ctx.widened,
    parseFailed: false,
  };
}
