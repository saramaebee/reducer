/**
 * E_predicted (design §11, ADR-0006).
 *
 * Two labelled proof models, and nothing else may reduce E:
 *   `module-unreachable`  — the file's module init is proven unable to run and
 *                           no positive evidence and no resolve sink retains it,
 *                           so it is predicted absent (0 bytes).
 *   `function-body-stub`  — ADR-0004 semantics: the body is replaced by a
 *                           fail-closed throw.
 *
 * Stub cost is SIMULATED, never estimated: `stubFunctions` is run in memory on
 * the real source and the emitted string is assembled exactly as
 * `cli/build.ts:349` assembles it (`code + "\n//# sourceMappingURL=<base>.map\n"`),
 * because a modelled stub size would understate the fail-closed throw and make
 * the metric look better than the transform could deliver. Net may be NEGATIVE
 * — that is the point of the metric, and it is counted against us.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stubFunctions } from '@reducer/transformer';
import type { ModuleFacts, StubPrediction } from './types.ts';
import type { FixpointResult } from './fixpoint.ts';
import type { SymbolDecision } from './projection.ts';
import type { Universe, UniverseFile } from './universe.ts';

export interface FileBytes {
  /** bytes predicted to be emitted for this file (0 when predicted absent) */
  emitted: number;
  removable: boolean;
  stubs: StubPrediction[];
  /** original implementation bytes eliminated (bodies + whole removed files) */
  implBytes: number;
}

/** Exactly cli/build.ts's emitted string for a transformed file. */
function emitOf(input: string, rel: string, specs: { symbol: string; localName: string }[]): string {
  const result = stubFunctions(input, rel, specs);
  return `${result.code}\n//# sourceMappingURL=${path.basename(rel)}.map\n`;
}

export function fileBytes(
  f: UniverseFile,
  m: ModuleFacts | undefined,
  decisions: SymbolDecision[] | undefined,
  retained: boolean,
): FileBytes {
  if (!retained) {
    return { emitted: 0, removable: true, stubs: [], implBytes: f.bytes };
  }
  const predicted = (decisions ?? []).filter((d) => d.predicted && d.localName);
  if (predicted.length === 0 || !m) {
    return { emitted: f.bytes, removable: false, stubs: [], implBytes: 0 };
  }

  let input: string;
  try {
    input = readFileSync(f.abs, 'utf8');
  } catch {
    return { emitted: f.bytes, removable: false, stubs: [], implBytes: 0 };
  }
  const original = Buffer.byteLength(input);

  // Several export names may share one implementation; the transformer stubs
  // each local function once (build.ts:342).
  const uniqueSpecs = [
    ...new Map(
      predicted.map((d) => [d.localName!, { symbol: d.symbol, localName: d.localName! }]),
    ).values(),
  ];

  let emitted: number;
  try {
    emitted = Buffer.byteLength(emitOf(input, f.rel, uniqueSpecs));
  } catch {
    // The transformer refused this file: no prediction may be claimed for it.
    return { emitted: f.bytes, removable: false, stubs: [], implBytes: 0 };
  }

  // REP-F10. The file's net delta is APPORTIONED across its predicted stubs by
  // bodyBytes, so Σ netBytes over a file's stubs == (original − emitted)
  // exactly. The old per-symbol figure re-ran the transform for one symbol at a
  // time, which recharged the whole fixed emit overhead to every symbol and
  // made Σ netBytes ≠ the file net — the number looked per-symbol but could not
  // be added up. It is not the marginal cost of stubbing one symbol alone.
  const fileNet = original - emitted;
  const bodyOf = (d: SymbolDecision): number =>
    d.bodySpan ? Buffer.byteLength(input.slice(d.bodySpan.start, d.bodySpan.end)) : 0;
  const totalBody = predicted.reduce((n, d) => n + bodyOf(d), 0);

  const stubs: StubPrediction[] = [];
  let implBytes = 0;
  let apportioned = 0;
  const bodyCounted = new Set<string>();
  predicted.forEach((d, i) => {
    const bodyBytes = bodyOf(d);
    // The last stub absorbs the rounding remainder so the sum is exact.
    const netBytes =
      i === predicted.length - 1
        ? fileNet - apportioned
        : totalBody > 0
          ? Math.round((fileNet * bodyBytes) / totalBody)
          : Math.round(fileNet / predicted.length);
    apportioned += netBytes;
    stubs.push({
      symbol: d.symbol,
      localName: d.localName!,
      proofModel: 'function-body-stub',
      bodyBytes,
      netBytes,
      blockingSet: [],
      predicted: true,
    });
    // Aliases of one implementation eliminate that implementation once.
    if (!bodyCounted.has(d.localName!)) {
      bodyCounted.add(d.localName!);
      implBytes += bodyBytes;
    }
  });
  return { emitted, removable: false, stubs, implBytes };
}

export interface BytesResult {
  D: number;
  E: number;
  netReduction: number;
  implBytesEliminable: number;
  byFile: Map<string, FileBytes>;
}

export function predictBytes(
  u: Universe,
  facts: Map<string, ModuleFacts>,
  fx: FixpointResult,
  decisions: Map<string, SymbolDecision[]>,
  nft: Set<string> | null,
  /** NFT unavailable ⇒ no file-level removal prediction is admissible at all */
  fileRemovalAdmissible: boolean,
): BytesResult {
  let E = 0;
  let impl = 0;
  const byFile = new Map<string, FileBytes>();
  for (const f of u.files) {
    if (!f.isJs || !f.thirdParty) continue;
    const retained =
      !fileRemovalAdmissible ||
      fx.reachable.has(f.rel) ||
      fx.resolveRetained.has(f.rel) ||
      !!nft?.has(f.rel);
    const r = fileBytes(f, facts.get(f.rel), decisions.get(f.rel), retained);
    byFile.set(f.rel, r);
    E += r.emitted;
    impl += r.implBytes;
  }
  return {
    D: u.D,
    E,
    netReduction: u.D > 0 ? (u.D - E) / u.D : 0,
    implBytesEliminable: impl,
    byFile,
  };
}
