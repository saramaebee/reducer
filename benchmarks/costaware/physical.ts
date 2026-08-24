/**
 * The PHYSICAL retrieval-unit model of a nydus RAFS v6 image.
 *
 * Experiment 4 charged every arm in FILE bytes and discovered that file bytes
 * are not the cost the substrate pays (`../longtail/run-1/FINDINGS.md` §6):
 * strapi's R1 and G1 prewarmed the identical 45.8 MB of file bytes and took
 * 22.6 s and 12.7 s respectively. This module replaces that currency with what
 * the backend actually fetches.
 *
 * What Nydus actually exposes, verified on the preserved images and NOT
 * invented (`nydus-image check -v <bootstrap>` dumps every inode and every
 * chunk):
 *
 *   file  → an ordered list of CHUNK INDEXES
 *   chunk → (blob_index, compressed_offset, compressed_size)
 *
 * Three properties of the preserved images, measured rather than assumed
 * (`run-1/physical/<app>.json` records them per app):
 *
 *   1. ONE blob per image (blob_index is 0 everywhere), so a chunk index is a
 *      total order over the blob's bytes.
 *   2. Chunks are laid out CONTIGUOUSLY in index order — zero gaps and zero
 *      overlaps between chunk i's end and chunk i+1's start, over all 75 245
 *      strapi chunks. So "adjacent in the blob" is exactly "consecutive index",
 *      and a set of chunk indexes maps to a set of byte ranges with no lookup.
 *   3. Chunks are DEDUPLICATED across files: strapi's 123 474 files reference
 *      only 75 245 distinct chunks, 22 870 of which back more than one file.
 *      A second file with identical content is therefore physically free. No
 *      strategy in experiment 4 could see that.
 *
 * The retrieval unit is the merged RANGE: nydusd's prefetch worker sorts the
 * requested chunks by blob offset and coalesces neighbours into one backend
 * HTTP Range request, bounded by `merging_size` (131 072 B in every arm's
 * mount configuration). The exact coalescing rule — whether it bridges a gap of
 * unrequested bytes, and at what width it stops — is MEASURED in `calibrate.ts`
 * against real nydusd fetches, never guessed, and the measured rule is what
 * this module's `rangesOf` implements.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { RUNNER_IMAGE } from '../lazy-oci/images.ts';

export const WORK_ROOT = '/Users/sara/.cache/reducer-costaware-v1';
/** where experiment 4's frozen bootstraps live — read only, never rebuilt */
export const LONGTAIL_WORK = '/Users/sara/.cache/reducer-longtail-v1';

/** nydusd mount configuration in every arm of experiment 4 and of this one. */
export const MERGING_SIZE = 131_072;

export interface PhysicalMap {
  app: string;
  blobId: string;
  /** compressed offset of chunk i, in blob order (chunks[i] === offsets[i]) */
  offset: number[];
  size: number[];
  /** DECOMPRESSED offset/size of chunk i. RAFS addresses decompressed data in a
   *  sparse, 4 KiB-aligned space — a 52-byte file still occupies a 4 KiB slot —
   *  and nydusd's request coalescing is bounded on THIS axis, not the compressed
   *  one. Measured, not assumed: see `calibrate.ts:fitMergeRule`. */
  uoffset: number[];
  usize: number[];
  /** universe-relative path → its chunk indexes, ascending */
  fileChunks: [string, number[]][];
  totals: {
    files: number;
    filesWithNoChunk: number;
    chunks: number;
    sharedChunks: number;
    compressedBytes: number;
    /** layout facts, asserted at build time and preserved as evidence */
    layoutGaps: number;
    layoutOverlaps: number;
    blobIndexes: number[];
  };
}

const mapPath = (app: string): string => path.join(WORK_ROOT, 'physical', `${app}.json.gz`);

const bootstrapDir = (app: string): string => path.join(LONGTAIL_WORK, 'images', app, 'base');

/**
 * Dump the RAFS metadata of experiment 4's frozen bootstrap and parse it.
 *
 * The bootstrap is read-only input: this experiment builds no image, so the
 * blob every arm mounts is byte-for-byte the object experiment 4 measured and
 * the registry still holds.
 */
export function buildPhysicalMap(app: string): PhysicalMap {
  const dir = bootstrapDir(app);
  if (!existsSync(path.join(dir, 'boot.img'))) throw new Error(`[${app}] no frozen bootstrap at ${dir}`);
  const dump = execFileSync(
    'docker',
    [
      'run', '--rm', '--platform', 'linux/arm64',
      '-v', `${dir}:/b:ro`,
      RUNNER_IMAGE,
      'nydus-image', 'check', '-v', '/b/boot.img',
    ],
    { encoding: 'utf8', maxBuffer: 1 << 30 },
  );

  const offset: number[] = [];
  const size: number[] = [];
  const uoffset: number[] = [];
  const usize: number[] = [];
  const fileChunks: [string, number[]][] = [];
  const refCount = new Map<number, number>();
  const blobIndexes = new Set<number>();
  let cur: number[] | null = null;

  for (const line of dump.split('\n')) {
    if (line.startsWith('inode: ')) {
      // inode: file "/a/b": index 0 ino 128 ...
      const kind = line.slice(7, line.indexOf(' ', 7));
      const q0 = line.indexOf('"');
      const q1 = line.lastIndexOf('": index ');
      if (q0 < 0 || q1 < 0) {
        cur = null;
        continue;
      }
      if (kind !== 'file') {
        cur = null;
        continue;
      }
      const abs = line.slice(q0 + 1, q1);
      cur = [];
      fileChunks.push([abs.startsWith('/') ? abs.slice(1) : abs, cur]);
      continue;
    }
    const c = line.indexOf('chunk: id ');
    if (c < 0) continue;
    // \t chunk: id <hex>, index N, blob_index N, file_offset N, compressed O/S, uncompressed O/S, crc32 ..
    const m = /index (\d+), blob_index (\d+), file_offset \d+, compressed (\d+)\/(\d+), uncompressed (\d+)\/(\d+)/.exec(line);
    if (!m) continue;
    const idx = Number(m[1]);
    blobIndexes.add(Number(m[2]));
    const co = Number(m[3]);
    const cs = Number(m[4]);
    if (offset[idx] === undefined) {
      offset[idx] = co;
      size[idx] = cs;
      uoffset[idx] = Number(m[5]);
      usize[idx] = Number(m[6]);
    } else if (offset[idx] !== co || size[idx] !== cs) {
      throw new Error(`[${app}] chunk ${idx} reported with two different extents`);
    }
    refCount.set(idx, (refCount.get(idx) ?? 0) + 1);
    cur?.push(idx);
  }

  // layout facts — asserted, then preserved
  let gaps = 0;
  let overlaps = 0;
  let compressedBytes = 0;
  for (let i = 0; i < offset.length; i++) {
    if (offset[i] === undefined) throw new Error(`[${app}] chunk index ${i} missing from the dump`);
    compressedBytes += size[i]!;
    if (i === 0) continue;
    const prevEnd = offset[i - 1]! + size[i - 1]!;
    if (offset[i]! > prevEnd) gaps++;
    else if (offset[i]! < prevEnd) overlaps++;
  }

  const m: PhysicalMap = {
    app,
    blobId: '',
    offset,
    size,
    uoffset,
    usize,
    fileChunks,
    totals: {
      files: fileChunks.length,
      filesWithNoChunk: fileChunks.filter(([, cs]) => cs.length === 0).length,
      chunks: offset.length,
      sharedChunks: [...refCount.values()].filter((n) => n > 1).length,
      compressedBytes,
      layoutGaps: gaps,
      layoutOverlaps: overlaps,
      blobIndexes: [...blobIndexes].sort(),
    },
  };
  const blob = /blob id: ([0-9a-f]{64})/.exec(dump)?.[1];
  m.blobId = blob ?? '';
  return m;
}

export function loadPhysicalMap(app: string): PhysicalMap {
  const p = mapPath(app);
  if (!existsSync(p)) throw new Error(`[${app}] no physical map — run: bun benchmarks/costaware/physical.ts --app ${app}`);
  return JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
}

export function savePhysicalMap(m: PhysicalMap): void {
  mkdirSync(path.dirname(mapPath(m.app)), { recursive: true });
  writeFileSync(mapPath(m.app), gzipSync(Buffer.from(JSON.stringify(m)), { level: 6 }));
}

// ─────────────────────────────────────────────────────── the retrieval model

export interface Ranges {
  /** number of merged backend range requests */
  requests: number;
  /** bytes the backend actually transfers, INCLUDING bytes inside a merged
   *  range that nothing asked for */
  bytes: number;
  /** compressed bytes of the requested chunks alone (bytes − this = overfetch) */
  chunkBytes: number;
}

/**
 * Merge a set of chunk indexes into backend range requests.
 *
 * A request is a contiguous COMPRESSED byte range — that is what an HTTP Range
 * request is — but how far nydusd will extend one before starting another is
 * bounded on BOTH axes, and the decompressed one binds far more often:
 *
 *   gapBridge   two runs separated by fewer than this many bytes of unrequested
 *               blob are fetched as ONE request, which also transfers the bytes
 *               in between (so scatter costs bytes as well as requests).
 *   maxRange    cap on a request's COMPRESSED span.
 *   maxURange   cap on a request's DECOMPRESSED span.
 *
 * The decompressed cap is why "one 128 KB compressed region" is not one
 * request: RAFS gives every small file its own 4 KiB-aligned decompressed slot,
 * so a 128 KB compressed region holding 400 tiny files spans ~1.6 MB
 * decompressed and is fetched as ~13 requests, not one. Assuming otherwise
 * under-predicted request count by roughly 15× — see DESIGN.md amendment A1.
 *
 * All three parameters are grid-searched against nydus's own backend counters
 * on neutral manifests, and all three are identical for every arm.
 */
export function rangesOf(
  chunks: Iterable<number>,
  m: Pick<PhysicalMap, 'offset' | 'size' | 'uoffset' | 'usize'>,
  gapBridge: number,
  maxRange: number,
  maxURange = Number.MAX_SAFE_INTEGER,
): Ranges {
  const idx = [...chunks].sort((a, b) => a - b);
  let requests = 0;
  let bytes = 0;
  let chunkBytes = 0;
  let start = -1;
  let end = -1;
  let ustart = 0;
  let uend = 0;
  for (const i of idx) {
    const o = m.offset[i]!;
    const s = m.size[i]!;
    const uo = m.uoffset?.[i] ?? 0;
    const us = m.usize?.[i] ?? 0;
    chunkBytes += s;
    if (start < 0) {
      start = o;
      end = o + s;
      ustart = uo;
      uend = uo + us;
      continue;
    }
    if (o - end <= gapBridge && o + s - start <= maxRange && uo + us - ustart <= maxURange) {
      end = Math.max(end, o + s);
      uend = Math.max(uend, uo + us);
      continue;
    }
    requests++;
    bytes += end - start;
    start = o;
    end = o + s;
    ustart = uo;
    uend = uo + us;
  }
  if (start >= 0) {
    requests++;
    bytes += end - start;
  }
  void uend;
  return { requests, bytes, chunkBytes };
}

// ───────────────────────────────────────────────────────────────────── main

if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } }, strict: true });
  const { APPS } = await import('../longtail/apps.ts');
  const apps = values.all ? APPS.map((a) => a.name) : [values.app!];
  for (const app of apps) {
    const t0 = Date.now();
    const m = buildPhysicalMap(app);
    savePhysicalMap(m);
    const t = m.totals;
    console.log(
      `[${app}] ${t.files} files (${t.filesWithNoChunk} empty) → ${t.chunks} chunks ` +
        `(${t.sharedChunks} shared), ${(t.compressedBytes / 1e6).toFixed(1)} MB compressed, ` +
        `layout gaps=${t.layoutGaps} overlaps=${t.layoutOverlaps} blobs=${JSON.stringify(t.blobIndexes)} ` +
        `[${((Date.now() - t0) / 1000).toFixed(1)}s]`,
    );
  }
}
