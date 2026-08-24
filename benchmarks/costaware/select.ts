/**
 * The cost-aware selector — ONE implementation, used verbatim by the generic
 * arm and the semantic arm.
 *
 * Experiment 4 budgeted every arm in FILE bytes and found that file bytes are
 * not what the substrate pays: at an identical 45.8 MB file-byte budget on
 * strapi, G1 prewarmed in 12.7 s and R1 in 22.6 s, and the ten-second admission
 * delay cost R1 the primary metric despite perfect long-tail coverage. This
 * module replaces the currency with measured prewarm milliseconds and lets each
 * strategy spend them.
 *
 * ─── the three pieces, and which of them differs between arms ───────────────
 *
 *   behavioural value   DIFFERS. It is the arm's own frozen experiment-4
 *                       ranking, read through one shared, parameter-free
 *                       transform. This is the only thing that differs.
 *   retrieval units     IDENTICAL. Derived from the image both arms mount.
 *   cost model          IDENTICAL. One calibrated (fixed, α, β) triple, from
 *                       `calibrate.ts`, fitted on neutral manifests.
 *   selection rule      IDENTICAL. One sort, one greedy fill.
 *
 * ─── value ──────────────────────────────────────────────────────────────────
 *
 * Each strategy already emits a TOTAL RANKING of the universe. A ranking is an
 * ordinal claim ("rank i is at least as likely to be needed as rank j > i"), so
 * it is turned into a value by the standard rank prior and nothing else:
 *
 *     value(f) = 1 / (1 + rank(f))
 *
 * There is no fitted constant, no per-app constant, and no per-arm constant in
 * that expression, which is what makes "identical machinery" checkable rather
 * than asserted. Its shape does the right thing at both ends: the head of a
 * ranking is bought at almost any price (Σ over the first k ranks grows like
 * ln k, so the first few hundred files carry a large share of all value), and
 * deep in the speculative tail — where consecutive ranks differ in value by a
 * factor of (1 + 1/i) — physical cheapness decides. That is exactly the
 * trade-off the experiment exists to test, and it is applied to both arms.
 *
 * ─── retrieval units ────────────────────────────────────────────────────────
 *
 * The blob's chunks are contiguous in chunk-index order (measured, zero gaps —
 * `physical.ts`), so the chunk axis is partitioned into consecutive UNITS whose
 * compressed span does not exceed the substrate's own `merging_size`. A unit is
 * therefore exactly what nydusd coalesces into one backend range request. The
 * partition depends only on the image, so both arms see the same units.
 *
 * Selecting whole units, rather than individual files, is the point: it is what
 * turns "many small scattered files" — the thing that cost experiment 4's R1
 * ten seconds — into "few large contiguous reads". A file inside an
 * already-selected unit is free, which is the marginal-cost behaviour the
 * design requires, and chunk-level deduplication (22 870 of strapi's 75 245
 * chunks back more than one file) is accounted for automatically because value
 * accrues to the chunk's unit however many files reference it.
 */
import type { LongtailPlan } from '../longtail/plan.ts';
import type { Ranking } from '../longtail/strategies.ts';
import { rangesOf, type PhysicalMap } from './physical.ts';
import type { CostModel } from './calibrate.ts';

export interface Units {
  /** unit index → [firstChunk, lastChunk] inclusive */
  span: [number, number][];
  /** unit index → compressed bytes covered, first chunk start to last chunk end */
  bytes: number[];
  /** chunk index → unit index */
  unitOf: Int32Array;
}

/**
 * Partition the chunk axis into consecutive units, each one backend request's
 * worth of contiguous content: a maximal run of consecutive chunks whose
 * COMPRESSED span fits `maxRange` and whose DECOMPRESSED span fits `maxURange`.
 *
 * Both bounds are needed and the decompressed one binds far more often. RAFS
 * gives every small file its own 4 KiB-aligned decompressed slot, so a 128 KB
 * compressed region holding hundreds of tiny files spans megabytes
 * decompressed, and nydusd splits it into many requests. Partitioning on the
 * compressed axis alone under-counted requests by roughly 15× — DESIGN.md
 * amendment A1.
 *
 * Deterministic, image-only, arm-independent.
 */
export function buildUnits(m: PhysicalMap, maxRange: number, maxURange: number): Units {
  const span: [number, number][] = [];
  const bytes: number[] = [];
  const unitOf = new Int32Array(m.offset.length);
  let start = 0;
  for (let i = 0; i < m.offset.length; i++) {
    const end = m.offset[i]! + m.size[i]!;
    const uend = (m.uoffset?.[i] ?? 0) + (m.usize?.[i] ?? 0);
    const tooWide = end - m.offset[start]! > maxRange;
    const tooWideU = uend - (m.uoffset?.[start] ?? 0) > maxURange;
    if (i > start && (tooWide || tooWideU)) {
      span.push([start, i - 1]);
      bytes.push(m.offset[i - 1]! + m.size[i - 1]! - m.offset[start]!);
      start = i;
    }
    unitOf[i] = span.length;
  }
  if (start < m.offset.length) {
    const last = m.offset.length - 1;
    span.push([start, last]);
    bytes.push(m.offset[last]! + m.size[last]! - m.offset[start]!);
  }
  return { span, bytes, unitOf };
}

/**
 * The prewarm manifest for a chunk set: one covering file per distinct chunk,
 * in ascending chunk order.
 *
 * nydusd's prefetch worker builds ONE descriptor per (file, chunk) pair from
 * the list and merges that stream. Deduplication makes many files share a
 * chunk, so listing every file that lives in a region emits the same chunk
 * several times at scattered positions, the stream stops being monotone, and
 * merging collapses. Measured on strapi's first 500 chunks, same chunks and the
 * same 2.9 MB of backend traffic either way:
 *
 *     1 237-file listing   164 backend requests   3 832 ms
 *       496-file cover      13 backend requests     593 ms
 *
 * The cover is a pure win — identical residency, strictly fewer descriptors —
 * so it is applied to EVERY arm, cost-aware or not. Withholding it from one
 * side would be a straw man, and giving it to both keeps the only difference
 * between the arms the thing under test.
 *
 * Candidates are restricted to files entirely inside the chunk set, so a cover
 * can never pull in a chunk the selection did not buy.
 */
export function coverManifest(chunks: Set<number>, m: PhysicalMap, byFile: Map<string, number[]>): string[] {
  const candidates = new Map<number, string[]>();
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length === 0) continue;
    let inside = true;
    for (const c of cs) {
      if (!chunks.has(c)) {
        inside = false;
        break;
      }
    }
    if (!inside) continue;
    for (const c of cs) {
      let l = candidates.get(c);
      if (!l) candidates.set(c, (l = []));
      l.push(rel);
    }
  }
  const covered = new Set<number>();
  const out: string[] = [];
  for (const c of [...chunks].sort((a, b) => a - b)) {
    if (covered.has(c)) continue;
    let best: string | null = null;
    let bestN = -1;
    for (const f of candidates.get(c) ?? []) {
      let n = 0;
      for (const x of byFile.get(f) ?? []) if (!covered.has(x)) n++;
      if (n > bestN) {
        bestN = n;
        best = f;
      }
    }
    if (best === null) continue; // a chunk no whole file covers: nothing to list
    out.push(best);
    for (const x of byFile.get(best) ?? []) covered.add(x);
  }
  return out;
}

/** fixedMs + α·requests + β·bytes, over a set of chunk indexes. */
export function predictCostMs(chunks: Iterable<number>, m: PhysicalMap, model: CostModel): number {
  const r = rangesOf(chunks, m, model.gapBridge, model.maxRange, model.maxURange);
  return model.fixedMs + model.perRequestMs * r.requests + model.perByteMs * r.bytes;
}

export interface Selection {
  /** the prefetch manifest handed to nydusd: a minimal chunk cover */
  files: string[];
  /** every file the manifest actually makes resident (all of its chunks bought) */
  residentFiles: number;
  residentFileBytes: number;
  units: number[];
  predictedMs: number;
  /** what the model says this manifest costs, decomposed */
  predicted: { requests: number; bytes: number; chunkBytes: number };
  fileBytes: number;
  /** ranks actually bought, for the record */
  valueTaken: number;
  valueTotal: number;
}

/**
 * Cost-aware selection under a PREWARM-TIME budget.
 *
 * One sort by value density, one greedy fill. Because a unit's cost does not
 * depend on which other units are selected (the units partition the axis and
 * each is one backend request), the marginal cost of a unit is its cost, the
 * marginal cost of a file inside an already-taken unit is zero, and the greedy
 * needs no iteration to see that.
 */
export function selectCostAware(
  ranking: Ranking,
  plan: LongtailPlan,
  m: PhysicalMap,
  units: Units,
  model: CostModel,
  budgetMs: number,
): Selection {
  const byFile = new Map(m.fileChunks);
  const size = new Map(plan.files);

  // value(f) = 1/(1+rank), spread evenly over the units the file's chunks touch
  const unitValue = new Float64Array(units.span.length);
  let valueTotal = 0;
  for (let rank = 0; rank < ranking.order.length; rank++) {
    const rel = ranking.order[rank]!;
    const cs = byFile.get(rel);
    if (!cs || cs.length === 0) continue; // empty file: no bytes to retrieve
    const v = 1 / (1 + rank);
    valueTotal += v;
    const us = new Set<number>();
    for (const c of cs) us.add(units.unitOf[c]!);
    const share = v / us.size;
    for (const u of us) unitValue[u]! += share;
  }

  const cost = (u: number): number => model.perRequestMs + model.perByteMs * units.bytes[u]!;
  const order = Array.from(units.span.keys()).sort((a, b) => {
    const da = unitValue[a]! / cost(a);
    const db = unitValue[b]! / cost(b);
    return db - da || a - b;
  });

  const taken = new Set<number>();
  let spend = model.fixedMs;
  let valueTaken = 0;
  for (const u of order) {
    if (unitValue[u] === 0) break; // nothing in this unit is wanted by anyone
    const c = cost(u);
    if (spend + c > budgetMs) continue; // skip-and-continue, as experiment 4's truncate
    taken.add(u);
    spend += c;
    valueTaken += unitValue[u]!;
  }

  // what the taken units make resident: every file entirely inside them. Their
  // chunks are contiguous within each unit, which is what makes the predicted
  // cost the contiguous-read case the calibration measured most precisely.
  const chunks = new Set<number>();
  let residentFiles = 0;
  let fileBytes = 0;
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length === 0) continue;
    let all = true;
    for (const c of cs) {
      if (!taken.has(units.unitOf[c]!)) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    residentFiles++;
    fileBytes += size.get(rel) ?? 0;
    for (const c of cs) chunks.add(c);
  }
  const predicted = rangesOf(chunks, m, model.gapBridge, model.maxRange, model.maxURange);
  return {
    files: coverManifest(chunks, m, byFile),
    residentFiles,
    residentFileBytes: fileBytes,
    units: [...taken].sort((a, b) => a - b),
    predictedMs: model.fixedMs + model.perRequestMs * predicted.requests + model.perByteMs * predicted.bytes,
    predicted,
    fileBytes,
    valueTaken,
    valueTotal,
  };
}

/**
 * The control: the SAME behavioural ranking, budgeted in the SAME prewarm
 * milliseconds by the SAME cost model — but with no cost-aware reordering at
 * all. It is the arm's own order, cut where the clock runs out, and it is what
 * isolates *what the optimiser changed* from *what merely changing the budget
 * currency changed*.
 *
 * The manifest is the longest PREFIX of the ranking whose predicted cost fits.
 * Predicted cost is monotone non-decreasing in prefix length (adding a file can
 * only add chunks), so the longest fitting prefix is found exactly by binary
 * search. Experiment 4's byte-budget rule skipped an oversized file and
 * continued, because a single large file could otherwise discard a whole byte
 * budget; under a time budget the boundary is set by thousands of small
 * requests rather than by one file, so the prefix rule cannot be dominated by
 * one item and the simpler exact rule is used.
 */
export function truncateByCost(
  ranking: Ranking,
  plan: LongtailPlan,
  m: PhysicalMap,
  model: CostModel,
  budgetMs: number,
): Selection {
  const byFile = new Map(m.fileChunks);
  const size = new Map(plan.files);
  const N = ranking.order.length;

  const chunksOfPrefix = (k: number): Set<number> => {
    const s = new Set<number>();
    for (let i = 0; i < k; i++) for (const c of byFile.get(ranking.order[i]!) ?? []) s.add(c);
    return s;
  };
  const costOfPrefix = (k: number): { ms: number; r: { requests: number; bytes: number; chunkBytes: number } } => {
    const r = rangesOf(chunksOfPrefix(k), m, model.gapBridge, model.maxRange, model.maxURange);
    return { ms: model.fixedMs + model.perRequestMs * r.requests + model.perByteMs * r.bytes, r };
  };

  // largest k in [0, N] whose prefix cost fits
  let lo = 0;
  let hi = N;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (costOfPrefix(mid).ms <= budgetMs) lo = mid;
    else hi = mid - 1;
  }
  const k = lo;
  const { ms, r } = costOfPrefix(k);
  const chunks = chunksOfPrefix(k);
  const chosen = ranking.order.slice(0, k).filter((rel) => (byFile.get(rel)?.length ?? 0) > 0);
  let fileBytes = 0;
  for (const rel of chosen) fileBytes += size.get(rel) ?? 0;
  // every file whose chunks are all bought becomes resident, whether or not the
  // ranking asked for it — counted the same way as for the cost-aware arms
  let residentFiles = 0;
  let residentFileBytes = 0;
  for (const [rel, cs] of m.fileChunks) {
    if (cs.length === 0) continue;
    let all = true;
    for (const c of cs) {
      if (!chunks.has(c)) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    residentFiles++;
    residentFileBytes += size.get(rel) ?? 0;
  }
  let valueTaken = 0;
  let valueTotal = 0;
  for (let rank = 0; rank < N; rank++) {
    if ((byFile.get(ranking.order[rank]!)?.length ?? 0) === 0) continue;
    const v = 1 / (1 + rank);
    valueTotal += v;
    if (rank < k) valueTaken += v;
  }
  return {
    files: coverManifest(chunks, m, byFile),
    residentFiles,
    residentFileBytes,
    units: [],
    predictedMs: ms,
    predicted: r,
    fileBytes,
    valueTaken,
    valueTotal,
  };
}
