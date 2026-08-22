/**
 * Function-body stubbing: physically removes a proven-unreachable
 * implementation while preserving declaration identity, arity, exports,
 * object shape, and module-initialization behavior.
 */
import { parse as babelParse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;
const generate: typeof _generate = (_generate as any).default ?? _generate;

export interface StubSpec {
  symbol: string; // export name (for the message)
  localName: string; // top-level FunctionDeclaration id
}

export interface StubbedFunction {
  symbol: string;
  localName: string;
  sourceRange: { start: number; end: number };
}

export interface StubResult {
  code: string;
  map: object | null;
  stubbed: StubbedFunction[];
}

function violationBody(symbol: string): t.BlockStatement {
  // throw Object.assign(new Error("..."), { name: "ReducerReachabilityViolation" });
  const err = t.callExpression(
    t.memberExpression(t.identifier('Object'), t.identifier('assign')),
    [
      t.newExpression(t.identifier('Error'), [
        t.stringLiteral(
          `"${symbol}" was proven unreachable at build time and its implementation was removed by reducer. ` +
            'Execution entering this stub is a reachability-analysis violation — please report it.',
        ),
      ]),
      t.objectExpression([
        t.objectProperty(t.identifier('name'), t.stringLiteral('ReducerReachabilityViolation')),
      ]),
    ],
  );
  return t.blockStatement([t.throwStatement(err)]);
}

export function stubFunctions(code: string, fileName: string, specs: StubSpec[]): StubResult {
  const ast = babelParse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
  });

  const wanted = new Map(specs.map((s) => [s.localName, s]));
  const stubbed: StubbedFunction[] = [];

  traverse(ast, {
    FunctionDeclaration(p) {
      const atTopLevel = p.parentPath.isProgram() || p.parentPath.isExportNamedDeclaration();
      if (!atTopLevel || !p.node.id) return;
      const spec = wanted.get(p.node.id.name);
      if (!spec) return;
      stubbed.push({
        symbol: spec.symbol,
        localName: spec.localName,
        sourceRange: { start: p.node.start ?? 0, end: p.node.end ?? 0 },
      });
      p.node.body = violationBody(spec.symbol);
    },
  });

  if (stubbed.length !== specs.length) {
    const missing = specs.filter((s) => !stubbed.some((x) => x.localName === s.localName));
    throw new Error(
      `transformer: could not locate top-level function(s) ${missing
        .map((m) => m.localName)
        .join(', ')} in ${fileName}; refusing to transform`,
    );
  }

  // Drop the original file's sourceMappingURL comments (AST-level, so string
  // literals are never touched): an inline data:-URI map would ship the
  // removed implementation base64-encoded inside the transformed file, and an
  // external reference would point at a stale map. The build appends a fresh
  // comment for the map generated below.
  const isMapComment = (c: t.Comment) => /^[#@]\s?sourceMappingURL=/.test(c.value.trim());
  if (ast.comments) ast.comments = ast.comments.filter((c) => !isMapComment(c));
  t.traverseFast(ast, (node) => {
    for (const key of ['leadingComments', 'trailingComments', 'innerComments'] as const) {
      const comments = node[key];
      if (comments) (node as any)[key] = comments.filter((c) => !isMapComment(c));
    }
  });

  const out = generate(ast, { sourceMaps: true, sourceFileName: fileName }, code);
  // Physical-absence semantics: the map's sourcesContent would ship the
  // ORIGINAL implementation (including every removed body), contradicting any
  // "vulnerable_code_not_present" claim about the artifact. Omit it entirely;
  // the mappings stay valid against the on-disk original.
  const map = out.map ? { ...out.map, sourcesContent: undefined } : null;
  return { code: out.code, map, stubbed };
}
