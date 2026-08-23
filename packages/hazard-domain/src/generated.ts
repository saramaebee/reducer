/**
 * Generated source and the execution-context model (ADR-0002, design §6).
 *
 * The capability question for generated code is *which execution context it
 * runs in*, never which syntax produced it:
 *
 *   - direct `eval(s)` runs in the CALLER's lexical scope, so inside a CJS
 *     module it holds the lexical `require` capability;
 *   - indirect eval `(0, eval)(s)`, `Function(s)` and `new Function(s)` run in
 *     the global scope: an unbound `require` there is a runtime ReferenceError
 *     and grants nothing — but `import()`, `process.getBuiltinModule` and
 *     `node:module` are global and remain fully available, which is exactly why
 *     ADR-0002 records `new Function` as NOT capability-free on Node 24.
 *
 * Constant source is re-analyzed in the right context; non-constant source is
 * reach-any regardless of which construct produced it (gate
 * `generated-source-unknown`), and depth exhaustion widens the same way
 * (`generated-source-depth`).
 */
import type { NodePath } from '@babel/traverse';
import _traverse from '@babel/traverse';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import type { CapabilityKind, GateTag, LoadSink, SpecifierDomain, ResultFlow } from './types.ts';
import { constantStrings } from './specifier.ts';

const traverse: typeof _traverse = (_traverse as any).default ?? _traverse;

/** design §6: depth ≤ 2. Exhaustion widens, so this bounds precision only. */
const MAX_GENERATED_DEPTH = 2;
/** A constant source *set* (from a ternary) beyond this widens instead. */
const MAX_GENERATED_ALTERNATIVES = 4;

/**
 * The mutable per-execution-context record every capability pass writes into.
 * `env` is the execution context in ADR-0002's sense: `lexical` means a CJS
 * module scope holding `require`/`module`, `global` means global scope only.
 */
export interface CapContext {
  /** universe-relative path of the *hosting* module (generated code has none) */
  file: string;
  env: 'lexical' | 'global';
  format: 'esm' | 'cjs';
  /** 0 = real source, 1+ = inside generated source */
  generatedDepth: number;
  /** shared across nested contexts so sink ids stay unique per module */
  counter: { n: number };
  sinks: LoadSink[];
  moduleGates: GateTag[];
  widened: { where: string; why: string }[];
  escapedLoader: boolean;
}

export function addSink(
  ctx: CapContext,
  s: {
    capability: CapabilityKind;
    effect?: 'load' | 'resolve';
    specifier: SpecifierDomain;
    result: ResultFlow;
    node: t.Node | null;
    vmEvidence?: LoadSink['vmEvidence'];
    wrapperEvidence?: LoadSink['wrapperEvidence'];
  },
): LoadSink {
  const loc = s.node?.loc?.start ?? { line: 0, column: 0 };
  const sink: LoadSink = {
    id: `${ctx.file}#${ctx.counter.n++}`,
    file: ctx.file,
    capability: s.capability,
    effect: s.effect ?? 'load',
    specifier: s.specifier,
    result: s.result,
    generatedDepth: ctx.generatedDepth,
    loc: { line: loc.line, column: loc.column },
    ...(s.vmEvidence ? { vmEvidence: s.vmEvidence } : {}),
    ...(s.wrapperEvidence ? { wrapperEvidence: s.wrapperEvidence } : {}),
  };
  ctx.sinks.push(sink);
  return sink;
}

/** Record a conservative widening. Every widening in this package logs one. */
export function widen(ctx: CapContext, node: t.Node | null, why: string): void {
  const loc = node?.loc?.start;
  ctx.widened.push({
    where: `${ctx.file}:${loc ? `${loc.line}:${loc.column}` : '?'}${ctx.generatedDepth > 0 ? ` (generated d${ctx.generatedDepth})` : ''}`,
    why,
  });
}

export type RecurseFn = (program: NodePath<t.Program>, ctx: CapContext) => void;

/** An unknown generated source can do anything an ambient capability can do. */
function unknownSourceSink(ctx: CapContext, node: t.Node | null, gate: GateTag, why: string): void {
  widen(ctx, node, why);
  addSink(ctx, {
    // `import()` is ambient in EVERY execution context (ADR-0002), so it is the
    // honest capability label for source we cannot read; the unbounded domain
    // and escaped result already make this reach-any.
    capability: 'dynamic-import',
    specifier: { tier: 'unbounded', gates: [gate] },
    result: { kind: 'escaped', gates: [gate] },
    node,
  });
}

function analyzeGeneratedSource(
  ctx: CapContext,
  site: t.Node,
  sources: string[],
  env: 'lexical' | 'global',
  recurse: RecurseFn,
): void {
  if (ctx.generatedDepth >= MAX_GENERATED_DEPTH) {
    unknownSourceSink(ctx, site, 'generated-source-depth', `generated-source nesting exceeded ${MAX_GENERATED_DEPTH}`);
    return;
  }
  if (sources.length > MAX_GENERATED_ALTERNATIVES) {
    unknownSourceSink(ctx, site, 'generated-source-unknown', `${sources.length} constant source alternatives exceeds ${MAX_GENERATED_ALTERNATIVES}`);
    return;
  }
  for (const src of sources) {
    let ast: t.File;
    try {
      ast = babelParse(src, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true, // a Function body may `return`
        errorRecovery: false,
      });
    } catch {
      unknownSourceSink(ctx, site, 'generated-source-unknown', 'generated source failed to parse');
      continue;
    }
    let program: NodePath<t.Program> | null = null;
    traverse(ast, {
      Program(p) {
        program = p;
        p.stop();
      },
    });
    if (!program) {
      unknownSourceSink(ctx, site, 'generated-source-unknown', 'generated source has no program');
      continue;
    }
    const sub: CapContext = {
      file: ctx.file,
      env,
      // Generated source is script-like; only the ENV decides capabilities, and
      // `format` gates nothing but the CJS `require`/`module` seeds, which the
      // env check below already guards.
      format: 'cjs',
      generatedDepth: ctx.generatedDepth + 1,
      counter: ctx.counter,
      sinks: [],
      moduleGates: [],
      widened: [],
      escapedLoader: false,
    };
    recurse(program, sub);
    // Sinks found in generated source belong to the HOST module and are
    // attributed to the eval site — the generated source has no location a
    // report could point at.
    const siteLoc = site.loc?.start ?? { line: 0, column: 0 };
    for (const s of sub.sinks) {
      s.loc = { line: siteLoc.line, column: siteLoc.column };
      ctx.sinks.push(s);
    }
    ctx.moduleGates.push(...sub.moduleGates);
    ctx.widened.push(...sub.widened);
    if (sub.escapedLoader) ctx.escapedLoader = true;
  }
}

/**
 * Handle an unbound reference to `eval` or `Function`.
 * Every shape ends in either a recursive analysis of constant source or an
 * unbounded sink — the reference is never simply ignored.
 */
export function handleGeneratedSite(
  ref: NodePath<t.Identifier>,
  ctx: CapContext,
  recurse: RecurseFn,
): void {
  const name = ref.node.name;
  const parent = ref.parentPath;

  if (name === 'eval') {
    // Direct eval: callee position of a call, nothing between. Inherits the
    // caller's execution context, so a CJS module hands it lexical `require`.
    if (parent?.isCallExpression() && parent.node.callee === ref.node) {
      const args = parent.get('arguments');
      const src = args.length > 0 ? constantStrings(args[0] as NodePath<t.Node>) : null;
      if (!src) {
        unknownSourceSink(ctx, parent.node, 'generated-source-unknown', 'direct eval of non-constant source');
        return;
      }
      analyzeGeneratedSource(ctx, parent.node, src, ctx.env, recurse);
      return;
    }
    // Indirect eval `(0, eval)(s)` — global execution context.
    if (parent?.isSequenceExpression()) {
      const seq = parent.node.expressions;
      const call = parent.parentPath;
      if (
        seq[seq.length - 1] === ref.node &&
        call?.isCallExpression() &&
        call.node.callee === parent.node
      ) {
        const args = call.get('arguments');
        const src = args.length > 0 ? constantStrings(args[0] as NodePath<t.Node>) : null;
        if (!src) {
          unknownSourceSink(ctx, call.node, 'generated-source-unknown', 'indirect eval of non-constant source');
          return;
        }
        analyzeGeneratedSource(ctx, call.node, src, 'global', recurse);
        return;
      }
    }
    unknownSourceSink(ctx, ref.node, 'generated-source-unknown', 'eval referenced as a value');
    return;
  }

  // `Function(...)` / `new Function(...)` — global execution context.
  const isCall =
    (parent?.isCallExpression() || parent?.isNewExpression()) && parent.node.callee === ref.node;
  if (!isCall) {
    unknownSourceSink(ctx, ref.node, 'generated-source-unknown', 'Function referenced as a value');
    return;
  }
  const args = (parent as NodePath<t.CallExpression | t.NewExpression>).get('arguments');
  if (args.length === 0) return; // `new Function()` — empty body, no capability
  const constants = args.map((a) => constantStrings(a as NodePath<t.Node>));
  if (constants.some((c) => c === null)) {
    unknownSourceSink(ctx, parent.node, 'generated-source-unknown', 'Function with non-constant arguments');
    return;
  }
  const body = constants[constants.length - 1] as string[];
  analyzeGeneratedSource(ctx, parent.node, body, 'global', recurse);
}
