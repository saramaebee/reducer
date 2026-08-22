import { nodeFileTrace } from '@vercel/nft';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export interface TracedFile {
  abs: string;
  /** POSIX-style path relative to base (NFT's native key format). */
  rel: string;
  bytes: number;
  kind: 'js' | 'json' | 'node' | 'wasm' | 'other';
  /** Nearest enclosing package under node_modules, else null (app code). */
  pkg: { name: string; version: string; dir: string } | null;
  /** rel paths of the files NFT says caused this file's inclusion. */
  nftParents: string[];
}

export interface TraceResult {
  base: string;
  entrypoints: string[]; // rel
  files: TracedFile[];
  byRel: Map<string, TracedFile>;
  warnings: string[];
}

function kindOf(rel: string): TracedFile['kind'] {
  const ext = path.posix.extname(rel);
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.json') return 'json';
  if (ext === '.node') return 'node';
  if (ext === '.wasm') return 'wasm';
  return 'other';
}

const pkgCache = new Map<string, TracedFile['pkg']>();

function packageOf(abs: string, base: string): TracedFile['pkg'] {
  if (!abs.includes(`${path.sep}node_modules${path.sep}`)) return null;
  let dir = path.dirname(abs);
  while (dir.length >= base.length) {
    const cached = pkgCache.get(dir);
    if (cached !== undefined) return cached;
    // The package root is the nearest dir whose parent chain ends at node_modules
    // (handles scoped packages via the extra level).
    try {
      const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (typeof pj.name === 'string') {
        const info = { name: pj.name, version: String(pj.version ?? '0.0.0'), dir };
        pkgCache.set(dir, info);
        return info;
      }
    } catch {
      /* no package.json here; keep walking */
    }
    dir = path.dirname(dir);
  }
  return null;
}

export async function trace(entryAbsPaths: string[], base: string): Promise<TraceResult> {
  const result = await nodeFileTrace(entryAbsPaths, { base });

  const files: TracedFile[] = [];
  const byRel = new Map<string, TracedFile>();

  for (const rel of result.fileList) {
    const abs = path.join(base, rel);
    let bytes = 0;
    try {
      bytes = statSync(abs).size;
    } catch {
      continue; // dangling symlink etc. — nothing to copy or analyze
    }
    const reason = result.reasons.get(rel);
    const tf: TracedFile = {
      abs,
      rel,
      bytes,
      kind: kindOf(rel),
      pkg: packageOf(abs, base),
      nftParents: reason ? [...reason.parents] : [],
    };
    files.push(tf);
    byRel.set(rel, tf);
  }

  return {
    base,
    entrypoints: entryAbsPaths.map((e) => path.relative(base, e).split(path.sep).join('/')),
    files,
    byRel,
    warnings: [...result.warnings].map((w) => String(w.message ?? w)),
  };
}
