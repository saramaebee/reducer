import { createHash } from 'node:crypto';

/**
 * The core invariant, encoded as a type:
 *   proven-reachable   -> KEEP
 *   possibly-reachable -> KEEP
 *   unknown            -> KEEP
 *   proven-unreachable -> MAY REMOVE
 */
export type Confidence =
  | 'proven-reachable'
  | 'possibly-reachable'
  | 'unknown'
  | 'proven-unreachable';

/** Machine-readable reasons attached to every non-trivial verdict. */
export type Reason =
  | 'entrypoint'
  | 'static-import'
  | 'module-side-effect'
  | 'internal-reference'
  | 'not-imported-anywhere'
  | 'dynamic-property-access'
  | 'value-escaped'
  | 'binding-reassigned'
  | 'destructure-rest'
  | 'dynamic-require'
  | 'dynamic-import'
  | 'dynamic-import-nonliteral'
  | 'export-star'
  | 'reexport-namespace'
  | 'export-object-mutation'
  | 'unsupported-syntax'
  | 'unsupported-export-kind'
  | 'unrecognized-importer'
  | 'unanalyzed-importer'
  | 'native-boundary'
  | 'wasm-boundary'
  | 'runtime-code-generation'
  | 'require-cache-mutation'
  | 'nft-warning'
  | 'resolver-trace-mismatch'
  | 'user-keep'
  | (string & {});

export interface SymbolVerdict {
  /** Path relative to the project base, e.g. node_modules/foo/index.js */
  module: string;
  /** name@version of the owning package, null for app code */
  pkg: string | null;
  symbol: string;
  state: Confidence;
  /** The terminal verdict's reasons (first applicable gate, unchanged semantics). */
  reasons: Reason[];
  /**
   * ALL independently-established blockers that apply to this retained symbol,
   * not just the gate that terminated evaluation. Diagnostic attribution only —
   * never used to decide the verdict. Present only on retained verdicts where
   * it adds information beyond `reasons`.
   */
  blockingReasons?: Reason[];
}

export interface Transformation {
  package: string | null;
  file: string;
  symbol: string;
  sourceRange: { start: number; end: number };
  action: 'function-body-removed';
  reason: 'provably-unreachable';
  proof: Reason[];
  inputHash: string;
  outputHash: string;
  bytesBefore: number;
  bytesAfter: number;
}

export interface ModuleRecord {
  file: string;
  pkg: string | null;
  kind: 'js' | 'json' | 'node' | 'wasm' | 'other';
  format: 'esm' | 'cjs' | 'opaque' | null;
  bytes: number;
}

/** Aggregated "why did code survive" accounting for one retention reason. */
export interface RetentionBucket {
  /** retained symbols carrying this reason */
  symbols: number;
  /** modules with at least one retained symbol carrying this reason */
  modules: number;
  /**
   * Estimate: each retained module's post-transform JS bytes split evenly
   * across the module's distinct retention reasons. Sums (approximately) to
   * the retained third-party JS bytes, so buckets are comparable.
   */
  estimatedJsBytes: number;
}

export interface Metrics {
  original: { dependencyBytes: number; dependencyFiles: number };
  nft: { bytes: number; files: number; jsBytes: number; jsFiles: number };
  reducer: {
    bytesRemoved: number;
    outputJsBytes: number;
    functionsStubbed: number;
    symbolsProvenUnreachable: number;
    symbolsProvenReachable: number;
    symbolsRetainedUncertain: number;
    /** Primary metric: fraction of NFT-traced executable JS bytes removed. */
    incrementalReductionVsNftJs: number;
  };
  analyzer: {
    jsFilesParsed: number;
    parseFailures: number;
    exportsSeen: number;
    functionsSeen: number;
    globalHazards: Reason[];
  };
  retention: { byReason: Record<string, RetentionBucket> };
}

/**
 * Per-file provenance for the emitted artifact. The core invariant:
 *
 *   NFT did not trace a file  !=  Reducer proved the file unreachable.
 *
 * NFT supplies POSITIVE reachability evidence only. Every file in the
 * production universe is emitted unless an explicit proof authorizes its
 * removal; "absent from the NFT trace" is never such a proof.
 */
export interface ArtifactFileRecord {
  file: string;
  state: 'retained' | 'removed';
  /** for retained files: why it exists */
  reasons?: ('nft-traced' | 'production-universe' | 'unknown-dynamic-reachability')[];
  /** for removed files: the explicit proof that authorized removal */
  proof?: 'proven-unreachable';
}

export interface ArtifactReport {
  /** files in the production universe (before any removal) */
  universeFiles: number;
  /** files with positive NFT reachability evidence */
  nftTracedFiles: number;
  /** lockfile-declared dev-only packages excluded from the production universe */
  devExcludedPackages: string[];
  files: ArtifactFileRecord[];
  removed: ArtifactFileRecord[];
}

export interface ReducerManifest {
  reducerVersion: string;
  entrypoints: string[];
  input: { base: string; node: string };
  modules: ModuleRecord[];
  transformations: Transformation[];
  unknowns: SymbolVerdict[];
  verdicts: SymbolVerdict[];
  warnings: string[];
  metrics: Metrics;
  artifact: ArtifactReport;
}

export const REDUCER_VERSION = '0.0.1';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
