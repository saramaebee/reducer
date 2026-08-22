/**
 * Conservative module/export/reachability analysis over the NFT-traced file set.
 *
 * Core invariant: a symbol is `proven-unreachable` ONLY when every gate below
 * passes. Any gate failure widens retention — it never narrows it.
 *
 * Gates for stubbing an exported function F of third-party module M:
 *   1. No global hazard anywhere in the traced JS set (eval, new Function,
 *      non-literal require/import, require.cache/extensions, parse failure).
 *   2. M parsed cleanly and its full export surface was statically recognized
 *      (no computed/conditional/mutated exports).
 *   3. M's package contains no native/wasm boundary.
 *   4. Every NFT-reported importer of M is a file we parsed AND whose
 *      imports of M we recognized statically (workers/asset refs fail this).
 *   5. No importer lets M's module object escape (namespace/default/require
 *      object used only via static property access; no aliasing we can't
 *      follow, no reassignment, no computed access, no rest destructuring).
 *   6. F's name is not in the union of statically used property/import names.
 *   7. F is a top-level FunctionDeclaration with zero references inside M
 *      other than exact-shape export plumbing (see isExportPlumbingRef; a
 *      reference inside another export's initializer is internal use).
 *   8. Every export name backed by F's local binding is itself proven
 *      unreachable — a reachable or merely-retained alias (incl. `default`)
 *      blocks removal of the shared implementation.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath, Binding } from '@babel/traverse';
import * as t from '@babel/types';
import type { TraceResult, TracedFile } from '@reducer/tracer';
import type { Confidence, Reason, SymbolVerdict } from '@reducer/manifest';

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

export interface ExportInfo {
  exportName: string;
  localName: string | null;
  /** top-level FunctionDeclaration with no non-export internal references */
  stubbable: boolean;
  /** why it is not stubbable (when it isn't) */
  retainReasons: Reason[];
}

interface DepUsage {
  source: string;
  resolvedAbs: string | null;
  names: Set<string>;
  all: boolean;
  reasons: Set<Reason>;
}

export interface ModuleAnalysis {
  abs: string;
  format: 'esm' | 'cjs';
  exports: Map<string, ExportInfo>;
  /** non-empty => the export surface could not be fully recognized */
  exportSurfaceUnknown: Reason[];
  deps: DepUsage[];
  hazards: Reason[];
  topLevelFunctionCount: number;
}

export interface StubCandidate {
  file: TracedFile;
  symbol: string;
  localName: string;
}

export interface Analysis {
  modules: Map<string, ModuleAnalysis | null>; // keyed by abs path; null = parse failure
  verdicts: SymbolVerdict[];
  candidates: StubCandidate[];
  globalHazards: Reason[];
  /** Non-fatal integrity warnings (e.g. resolver/NFT trace disagreement). */
  warnings: string[];
  stats: {
    jsFilesParsed: number;
    parseFailures: number;
    exportsSeen: number;
    functionsSeen: number;
  };
}

// ---------------------------------------------------------------------------
// Per-module parsing
// ---------------------------------------------------------------------------

function isUnbound(p: NodePath, name: string): boolean {
  return !p.scope.getBinding(name);
}

function patternNames(pattern: t.ObjectPattern, dep: DepUsage): void {
  for (const prop of pattern.properties) {
    if (t.isRestElement(prop)) {
      dep.all = true;
      dep.reasons.add('destructure-rest');
      return;
    }
    if (prop.computed) {
      dep.all = true;
      dep.reasons.add('dynamic-property-access');
      return;
    }
    if (t.isIdentifier(prop.key)) dep.names.add(prop.key.name);
    else if (t.isStringLiteral(prop.key)) dep.names.add(prop.key.value);
    else {
      dep.all = true;
      dep.reasons.add('dynamic-property-access');
    }
  }
}

/**
 * Track every use of a binding that holds a module object (namespace import,
 * default import of a CJS module, or `const x = require(...)`). Static
 * property reads narrow usage to named exports; anything else escapes.
 */
function trackObjectBinding(
  binding: Binding | undefined,
  dep: DepUsage,
  seen: Set<Binding>,
): void {
  if (!binding) {
    dep.all = true;
    dep.reasons.add('value-escaped');
    return;
  }
  if (seen.has(binding)) return;
  seen.add(binding);

  if (binding.constantViolations.length > 0) {
    dep.all = true;
    dep.reasons.add('binding-reassigned');
    return;
  }

  for (const ref of binding.referencePaths) {
    const parent = ref.parentPath;
    if (!parent) {
      dep.all = true;
      dep.reasons.add('value-escaped');
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
        dep.all = true;
        dep.reasons.add('export-object-mutation');
        continue;
      }
      if (!computed && t.isIdentifier(property)) dep.names.add(property.name);
      else if (computed && t.isStringLiteral(property)) dep.names.add(property.value);
      else {
        dep.all = true;
        dep.reasons.add('dynamic-property-access');
      }
      continue;
    }

    if (parent.isVariableDeclarator() && parent.node.init === ref.node) {
      const id = parent.node.id;
      if (t.isIdentifier(id)) {
        trackObjectBinding(parent.scope.getBinding(id.name), dep, seen);
        continue;
      }
      if (t.isObjectPattern(id)) {
        patternNames(id, dep);
        continue;
      }
    }

    // Any other use: call argument, return, spread, export, comparison, ...
    dep.all = true;
    dep.reasons.add('value-escaped');
  }
}

export function analyzeModuleSource(code: string, abs: string): ModuleAnalysis | null {
  let ast: t.File;
  try {
    ast = babelParse(code, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
    });
  } catch {
    return null;
  }

  const format: 'esm' | 'cjs' = ast.program.sourceType === 'module' ? 'esm' : 'cjs';
  const out: ModuleAnalysis = {
    abs,
    format,
    exports: new Map(),
    exportSurfaceUnknown: [],
    deps: [],
    hazards: [],
    topLevelFunctionCount: 0,
  };

  const req = createRequire(abs);
  const resolveDep = (source: string): string | null => {
    try {
      return req.resolve(source);
    } catch {
      return null;
    }
  };
  const depMap = new Map<string, DepUsage>();
  const depFor = (source: string): DepUsage => {
    let d = depMap.get(source);
    if (!d) {
      d = { source, resolvedAbs: resolveDep(source), names: new Set(), all: false, reasons: new Set() };
      depMap.set(source, d);
      out.deps.push(d);
    }
    return d;
  };

  /** AST nodes that ARE recognized export plumbing; references inside them
   *  don't count as "internal use" of an exported function. */
  const recognizedExportNodes = new Set<t.Node>();
  /** exportName -> localName|null, filled during traversal, refined after. */
  const rawExports = new Map<string, string | null>();

  let programPath: NodePath<t.Program> | null = null;
  const objectBindingSeen = new Set<Binding>();

  const handleRequireSite = (callPath: NodePath<t.CallExpression>, dep: DepUsage) => {
    const parent = callPath.parentPath;
    if (parent.isVariableDeclarator() && parent.node.init === callPath.node) {
      const id = parent.node.id;
      if (t.isIdentifier(id)) {
        // Binding may not be resolvable until traversal completes; defer.
        deferredBindings.push({ scopePath: parent, name: id.name, dep });
        return;
      }
      if (t.isObjectPattern(id)) {
        patternNames(id, dep);
        return;
      }
      dep.all = true;
      dep.reasons.add('value-escaped');
      return;
    }
    if (parent.isMemberExpression() && parent.node.object === callPath.node) {
      const { property, computed } = parent.node;
      if (!computed && t.isIdentifier(property)) dep.names.add(property.name);
      else if (computed && t.isStringLiteral(property)) dep.names.add(property.value);
      else {
        dep.all = true;
        dep.reasons.add('dynamic-property-access');
      }
      return;
    }
    if (parent.isExpressionStatement()) return; // side-effect-only require
    dep.all = true;
    dep.reasons.add('value-escaped');
  };

  const deferredBindings: { scopePath: NodePath; name: string; dep: DepUsage }[] = [];
  const deferredImportBindings: { name: string; dep: DepUsage }[] = [];

  traverse(ast, {
    Program(p) {
      programPath = p;
    },
    ImportDeclaration(p) {
      const dep = depFor(p.node.source.value);
      for (const spec of p.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const imported = spec.imported;
          dep.names.add(t.isIdentifier(imported) ? imported.name : imported.value);
        } else if (t.isImportDefaultSpecifier(spec)) {
          // For an ESM target this is just the default export; for a CJS
          // target it's the whole exports object. Handle both conservatively.
          dep.names.add('default');
          deferredImportBindings.push({ name: spec.local.name, dep });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          deferredImportBindings.push({ name: spec.local.name, dep });
        }
      }
    },
    ExportNamedDeclaration(p) {
      if (p.node.source) {
        const dep = depFor(p.node.source.value);
        for (const spec of p.node.specifiers) {
          if (t.isExportSpecifier(spec)) {
            dep.names.add(t.isIdentifier(spec.local) ? spec.local.name : (spec.local as any).value);
          } else {
            dep.all = true;
            dep.reasons.add('reexport-namespace');
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
          else out.exportSurfaceUnknown.push('unsupported-export-kind');
        }
      } else if (t.isClassDeclaration(decl) && decl.id) {
        rawExports.set(decl.id.name, decl.id.name);
      } else if (decl) {
        out.exportSurfaceUnknown.push('unsupported-export-kind');
      }
      for (const spec of p.node.specifiers) {
        if (t.isExportSpecifier(spec)) {
          const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          rawExports.set(exported, t.isIdentifier(spec.local) ? spec.local.name : null);
        } else {
          out.exportSurfaceUnknown.push('unsupported-export-kind');
        }
      }
    },
    ExportDefaultDeclaration(p) {
      recognizedExportNodes.add(p.node);
      // Record which local implementation backs `default` so the
      // shared-implementation rule protects it; `default` itself is never a
      // stub candidate in the slice (forced non-stubbable in finalize).
      const d = p.node.declaration;
      let local: string | null = null;
      if (t.isIdentifier(d)) local = d.name;
      else if ((t.isFunctionDeclaration(d) || t.isClassDeclaration(d)) && d.id) local = d.id.name;
      rawExports.set('default', local);
    },
    ExportAllDeclaration(p) {
      recognizedExportNodes.add(p.node);
      const dep = depFor(p.node.source.value);
      dep.all = true;
      dep.reasons.add('export-star');
      out.exportSurfaceUnknown.push('export-star');
    },
    CallExpression(p) {
      const callee = p.node.callee;
      if (t.isImport(callee)) {
        const arg = p.node.arguments[0];
        if (t.isStringLiteral(arg)) {
          const dep = depFor(arg.value);
          dep.all = true;
          dep.reasons.add('dynamic-import');
        } else {
          out.hazards.push('dynamic-import-nonliteral');
        }
        return;
      }
      if (t.isIdentifier(callee, { name: 'require' }) && isUnbound(p, 'require')) {
        const arg = p.node.arguments[0];
        if (t.isStringLiteral(arg) && p.node.arguments.length === 1) {
          handleRequireSite(p, depFor(arg.value));
        } else {
          out.hazards.push('dynamic-require');
        }
        return;
      }
    },
    // Any reference to eval/Function/require BEYOND the recognized forms is a
    // hidden code-loading channel: aliased require (`const r = require`),
    // require passed as an argument, indirect eval `(0, eval)`, etc.
    Identifier(p) {
      const name = p.node.name;
      if (name !== 'eval' && name !== 'Function' && name !== 'require') return;
      if (!p.isReferencedIdentifier()) return;
      if (p.scope.getBinding(name)) return;
      if (name === 'eval' || name === 'Function') {
        out.hazards.push('runtime-code-generation');
        return;
      }
      const parent = p.parentPath;
      const isDirectCallee = parent?.isCallExpression() && parent.node.callee === p.node;
      const isMemberObject = parent?.isMemberExpression() && parent.node.object === p.node;
      if (!isDirectCallee && !isMemberObject) out.hazards.push('dynamic-require');
    },
    MemberExpression(p) {
      const { object, property, computed } = p.node;
      if (!t.isIdentifier(object, { name: 'require' }) || !isUnbound(p, 'require')) return;
      if (computed) {
        out.hazards.push('dynamic-require'); // require[expr]
        return;
      }
      if (
        t.isIdentifier(property) &&
        (property.name === 'cache' || property.name === 'extensions')
      ) {
        out.hazards.push('require-cache-mutation');
      }
    },
  });

  if (!programPath) return null;
  const program: NodePath<t.Program> = programPath;

  // Importing Node's module-customization / code-loading builtins gives the
  // module an arbitrary loading channel we cannot follow.
  for (const source of depMap.keys()) {
    const bare = source.startsWith('node:') ? source.slice(5) : source;
    if (bare === 'module') out.hazards.push('dynamic-require');
    if (bare === 'vm') out.hazards.push('runtime-code-generation');
  }

  // Deferred module-object bindings (scopes are complete now).
  for (const { name, dep } of deferredImportBindings) {
    trackObjectBinding(program.scope.getBinding(name), dep, objectBindingSeen);
  }
  for (const { scopePath, name, dep } of deferredBindings) {
    trackObjectBinding(scopePath.scope.getBinding(name), dep, objectBindingSeen);
  }

  // -------------------------------------------------------------------------
  // CJS export recognition (top-level statements only; anything else that
  // touches `exports`/`module` marks the surface unknown).
  // -------------------------------------------------------------------------
  if (format === 'cjs') {
    // A right-hand side that itself mentions exports/module (chained
    // assignments like `exports.a = exports.b = fn`, deferred writers like
    // `exports.init = function () { exports.helper = h }`) hides export
    // writes inside a "recognized" node — refuse to recognize it.
    const mentionsExportMachinery = (node: t.Node): boolean => {
      let found = false;
      t.traverseFast(node, (n) => {
        if (t.isIdentifier(n) && (n.name === 'exports' || n.name === 'module')) found = true;
      });
      return found;
    };

    // An export name written more than once has observable intermediate
    // values (a require cycle can read `exports.x` between the writes), so its
    // final static value is not a sound proxy for what was reachable. Any
    // duplicate write widens the whole surface. (adv regression: cjs-overwrite-cycle)
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

      // exports.X = ...  |  module.exports.X = ...
      if (
        t.isMemberExpression(left) &&
        !left.computed &&
        t.isIdentifier(left.property) &&
        isExportsRoot(left.object)
      ) {
        if (mentionsExportMachinery(expr.right)) {
          out.exportSurfaceUnknown.push('export-object-mutation');
          continue;
        }
        if (seenExportKeys.has(left.property.name)) {
          out.exportSurfaceUnknown.push('export-object-mutation'); // overwritten key
          continue;
        }
        seenExportKeys.add(left.property.name);
        rawExports.set(
          left.property.name,
          t.isIdentifier(expr.right) ? expr.right.name : null,
        );
        recognizedExportNodes.add(expr);
        continue;
      }

      // module.exports = { a, b: fn, ... }
      if (isExportsRoot(left)) {
        if (mentionsExportMachinery(expr.right)) {
          out.exportSurfaceUnknown.push('export-object-mutation');
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
        out.exportSurfaceUnknown.push('export-object-mutation');
        continue;
      }
    }

    // Any OTHER reference to the CJS export machinery => unknown surface.
    program.traverse({
      Identifier(p) {
        const name = p.node.name;
        if (name !== 'exports' && name !== 'module') return;
        if (!p.isReferencedIdentifier()) return;
        if (p.scope.getBinding(name)) return; // user-shadowed, not the CJS global
        const insideRecognized =
          recognizedExportNodes.has(p.node) ||
          !!p.findParent((a) => recognizedExportNodes.has(a.node));
        if (!insideRecognized) out.exportSurfaceUnknown.push('export-object-mutation');
      },
    });
  }

  // A binding reference is export *plumbing* only in these exact shapes.
  // Anything else — including references inside another export's initializer
  // (`export const wrapped = () => impl()`, `exports.wrap = () => impl()`) —
  // is a real internal use and forces retention. An ancestor scan is NOT
  // sound here: it would classify those closure references as plumbing.
  const isExportPlumbingRef = (ref: NodePath): boolean => {
    // `export function foo() {}` — Babel registers the ExportNamedDeclaration
    // itself as the reference.
    if (ref.isExportNamedDeclaration()) return true;
    const parent = ref.parentPath;
    if (!parent) return false;
    if (parent.isExportSpecifier()) return true; // export { foo } / { foo as bar }
    if (parent.isExportDefaultDeclaration()) return true; // export default foo
    // CJS: `exports.x = foo` — foo must be EXACTLY the right-hand side of a
    // recognized export assignment.
    if (
      parent.isAssignmentExpression() &&
      recognizedExportNodes.has(parent.node) &&
      parent.node.right === ref.node
    ) {
      return true;
    }
    // CJS: `module.exports = { x: foo }` — foo must be EXACTLY a property
    // value of the recognized object literal.
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

  // -------------------------------------------------------------------------
  // Finalize exports: stubbable iff top-level FunctionDeclaration whose only
  // references are recognized export plumbing.
  // -------------------------------------------------------------------------
  for (const [exportName, localName] of rawExports) {
    const info: ExportInfo = { exportName, localName, stubbable: false, retainReasons: [] };
    if (!localName) {
      info.retainReasons.push('unsupported-export-kind');
    } else {
      const binding = program.scope.getBinding(localName);
      // Must be the exact shape the transformer will accept: a declaration
      // whose parent is the Program (or an export declaration). Anything
      // else (e.g. Annex-B labeled functions) is retained, never a crash.
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
    }
    // `default` is never a stub candidate in the slice, but keeps its
    // localName so the shared-implementation rule protects the backing fn.
    if (exportName === 'default' && !info.retainReasons.length) {
      info.retainReasons.push('unsupported-export-kind');
      info.stubbable = false;
    }
    out.exports.set(exportName, info);
  }

  program.traverse({
    FunctionDeclaration(p) {
      if (p.parentPath.isProgram() || p.parentPath.isExportNamedDeclaration()) {
        out.topLevelFunctionCount++;
      }
    },
  });

  return out;
}

// ---------------------------------------------------------------------------
// Whole-trace analysis
// ---------------------------------------------------------------------------

function pkgLabel(f: TracedFile): string | null {
  return f.pkg ? `${f.pkg.name}@${f.pkg.version}` : null;
}

/**
 * Expand NFT parents: a package.json parent is resolution metadata, not an
 * importer — substitute its own parents transitively so the check compares
 * against real importing files.
 */
function expandParents(rel: string, byRel: Map<string, TracedFile>, seen = new Set<string>()): string[] {
  if (seen.has(rel)) return [];
  seen.add(rel);
  const tf = byRel.get(rel);
  if (!tf) return [rel];
  const outp: string[] = [];
  for (const parent of tf.nftParents) {
    if (path.posix.basename(parent) === 'package.json') outp.push(...expandParents(parent, byRel, seen));
    else outp.push(parent);
  }
  return outp;
}

export function analyzeTrace(traceResult: TraceResult): Analysis {
  const { files, byRel, base } = traceResult;
  const jsFiles = files.filter((f) => f.kind === 'js');

  const modules = new Map<string, ModuleAnalysis | null>();
  for (const f of jsFiles) {
    let code: string;
    try {
      code = readFileSync(f.abs, 'utf8');
    } catch {
      modules.set(f.abs, null);
      continue;
    }
    modules.set(f.abs, analyzeModuleSource(code, f.abs));
  }

  // ---- global hazards: any unanalyzable behavior anywhere widens everything.
  const globalHazards: Reason[] = [];
  for (const [abs, m] of modules) {
    if (m === null) globalHazards.push('unsupported-syntax');
    else globalHazards.push(...m.hazards);
  }
  // NFT warnings signal unresolved dynamic behavior. A warning must never
  // lead to more deletion — so it leads to none at all.
  if (traceResult.warnings.length > 0) globalHazards.push('nft-warning');
  const uniqueHazards = [...new Set(globalHazards)];

  // ---- packages with native/wasm boundaries are opaque.
  const opaquePkgDirs = new Set<string>();
  const opaquePkgReason = new Map<string, Reason>();
  for (const f of files) {
    if ((f.kind === 'node' || f.kind === 'wasm') && f.pkg) {
      opaquePkgDirs.add(f.pkg.dir);
      opaquePkgReason.set(f.pkg.dir, f.kind === 'wasm' ? 'wasm-boundary' : 'native-boundary');
    }
  }

  // ---- resolution/trace consistency. NFT's traced set is our source of
  // truth for what Node actually loads. The analyzer resolves specifiers with
  // createRequire().resolve() (require conditions) even for ESM `import`s; if
  // that lands on a file NFT did NOT trace, our resolution disagrees with
  // Node's ESM loader (e.g. an `exports` map whose import/require conditions
  // differ, adv: interop-condition-divergence). We cannot trust usage
  // attribution for the package involved, so we make its whole owning package
  // opaque and warn. This also surfaces NFT under-tracing (a resolvable dep
  // absent from the deploy tree) instead of shipping a silently broken tree.
  const analyzerWarnings: string[] = [];
  const tracedAbs = new Set(files.map((f) => f.abs));
  // Realpath variants too: NFT keys and createRequire().resolve() can differ
  // purely by symlink resolution (pnpm stores, hoisted links). A path-only
  // mismatch there is NOT a real resolver/loader disagreement, so comparing
  // realpaths avoids marking half a pnpm tree spuriously opaque.
  const realOf = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const tracedReal = new Set([...tracedAbs].map(realOf));
  const pkgDirs = [...new Set(files.map((f) => f.pkg?.dir).filter((d): d is string => !!d))];
  for (const [, m] of modules) {
    if (!m) continue;
    for (const dep of m.deps) {
      if (!dep.resolvedAbs || tracedAbs.has(dep.resolvedAbs)) continue;
      // Builtins (`node:module`, `fs`) resolve to the specifier itself, not a
      // filesystem path — never a trace target.
      if (!path.isAbsolute(dep.resolvedAbs)) continue;
      if (tracedReal.has(realOf(dep.resolvedAbs))) continue; // symlink-equal, not a divergence
      // A resolvable specifier whose target NFT never traced.
      analyzerWarnings.push(
        `resolver/NFT disagreement: "${dep.source}" resolved to ${path.relative(base, dep.resolvedAbs)} which is absent from the NFT trace; retaining its owning package`,
      );
      // Widen the traced package that owns the mis-resolved target (its true
      // sibling — e.g. the ESM-condition file — is in this same package).
      const owner = pkgDirs.find((d) => dep.resolvedAbs!.startsWith(d + path.sep));
      if (owner) {
        opaquePkgDirs.add(owner);
        opaquePkgReason.set(owner, 'resolver-trace-mismatch');
      }
    }
  }

  // ---- merge usage per target module across all analyzed importers.
  const recognizedImporters = new Map<string, Set<string>>(); // target abs -> importer abs
  const usage = new Map<string, { names: Set<string>; all: boolean; reasons: Set<Reason> }>();
  for (const [importerAbs, m] of modules) {
    if (!m) continue;
    for (const dep of m.deps) {
      if (!dep.resolvedAbs) continue;
      let real = dep.resolvedAbs;
      let importers = recognizedImporters.get(real);
      if (!importers) recognizedImporters.set(real, (importers = new Set()));
      importers.add(importerAbs);
      let u = usage.get(real);
      if (!u) usage.set(real, (u = { names: new Set(), all: false, reasons: new Set() }));
      for (const n of dep.names) u.names.add(n);
      if (dep.all) {
        u.all = true;
        for (const r of dep.reasons) u.reasons.add(r);
      }
    }
  }

  // ---- verdicts for third-party modules.
  const verdicts: SymbolVerdict[] = [];
  const candidates: StubCandidate[] = [];
  let exportsSeen = 0;
  let functionsSeen = 0;

  for (const m of modules.values()) {
    if (m) functionsSeen += m.topLevelFunctionCount;
  }

  for (const f of jsFiles) {
    if (!f.pkg) continue; // never transform app code in the slice
    const m = modules.get(f.abs) ?? null;
    const label = pkgLabel(f);

    const allExportsAs = (state: Confidence, reasons: Reason[]) => {
      const names = m && m.exports.size > 0 ? [...m.exports.keys()] : ['*'];
      for (const symbol of names) {
        verdicts.push({ module: f.rel, pkg: label, symbol, state, reasons });
      }
    };

    // Stats first: exportsSeen must reflect what was discovered even when a
    // global hazard forces blanket retention (metrics only, no verdict impact).
    if (m) exportsSeen += m.exports.size;
    if (uniqueHazards.length > 0) {
      // Prefixed so retention accounting can separate "this module is fine
      // but a hazard elsewhere widened everything" from local causes.
      allExportsAs('unknown', uniqueHazards.map((h): Reason => `global-hazard:${h}`));
      continue;
    }
    if (!m) {
      allExportsAs('unknown', ['unsupported-syntax']);
      continue;
    }
    if (opaquePkgDirs.has(f.pkg.dir)) {
      allExportsAs('unknown', [opaquePkgReason.get(f.pkg.dir) ?? 'native-boundary']);
      continue;
    }
    if (m.exportSurfaceUnknown.length > 0) {
      allExportsAs('unknown', [...new Set(m.exportSurfaceUnknown)]);
      continue;
    }

    // Gate 4: every NFT-reported importer must be an analyzed, recognized importer.
    const nftImporters = expandParents(f.rel, byRel).map((rel) => path.join(base, rel));
    const recognized = recognizedImporters.get(f.abs) ?? new Set<string>();
    const unrecognized = nftImporters.filter(
      (abs) => !recognized.has(abs) || !modules.get(abs),
    );
    if (unrecognized.length > 0) {
      allExportsAs('unknown', ['unrecognized-importer']);
      continue;
    }
    const u = usage.get(f.abs);
    if (!u) {
      allExportsAs('unknown', ['unrecognized-importer']);
      continue;
    }
    if (u.all) {
      allExportsAs('possibly-reachable', [...u.reasons]);
      continue;
    }

    // One implementation can back several export names. Its body may only
    // be removed when EVERY export name pointing at it is itself proven
    // unreachable (unused AND stubbable). An alias that is merely retained
    // (e.g. `default`, an unsupported export kind) is possibly-reachable,
    // which must block removal of the shared implementation.
    const localBlocked = new Set<string>();
    for (const [symbol, info] of m.exports) {
      if (info.localName && (u.names.has(symbol) || !info.stubbable)) {
        localBlocked.add(info.localName);
      }
    }

    for (const [symbol, info] of m.exports) {
      if (u.names.has(symbol)) {
        verdicts.push({ module: f.rel, pkg: label, symbol, state: 'proven-reachable', reasons: ['static-import'] });
      } else if (info.stubbable && info.localName && localBlocked.has(info.localName)) {
        verdicts.push({
          module: f.rel,
          pkg: label,
          symbol,
          state: 'possibly-reachable',
          reasons: ['shared-implementation'],
        });
      } else if (info.stubbable && info.localName) {
        verdicts.push({
          module: f.rel,
          pkg: label,
          symbol,
          state: 'proven-unreachable',
          reasons: ['not-imported-anywhere'],
        });
        candidates.push({ file: f, symbol, localName: info.localName });
      } else {
        verdicts.push({
          module: f.rel,
          pkg: label,
          symbol,
          state: 'possibly-reachable',
          reasons: info.retainReasons.length ? info.retainReasons : ['unsupported-export-kind'],
        });
      }
    }
  }

  return {
    modules,
    verdicts,
    candidates,
    globalHazards: uniqueHazards,
    warnings: analyzerWarnings,
    stats: {
      jsFilesParsed: [...modules.values()].filter(Boolean).length,
      parseFailures: [...modules.values()].filter((m) => m === null).length,
      exportsSeen,
      functionsSeen,
    },
  };
}
