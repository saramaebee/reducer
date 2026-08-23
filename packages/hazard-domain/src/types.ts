/**
 * Hazard-domain analyzer — shared contract (ADR-0006).
 *
 * NON-TRANSFORMING. This package grants no deletion authority: it predicts
 * what could become removable under explicit proof models. reachable /
 * possibly-reachable / unknown → retained; only proven-unreachable →
 * predicted-removable; any analysis uncertainty widens, never narrows.
 *
 * Vocabulary follows CONTEXT.md (capability, capability factory, execution
 * context, capability flow, escaped-loader, load sink, specifier domain,
 * resolved-target domain, module/export reachability, property projection,
 * export-surface confidence, module-identity unification, blocking-set,
 * gate-off counterfactual, sound refinement counterfactual).
 */
import type { Reason } from '@reducer/manifest';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type CapabilityKind =
  | 'lexical-require'        // CJS module-scope require
  | 'module-require'         // module.require
  | 'createRequire-result'   // a loader produced by createRequire(...)
  | 'module-namespace'       // the node:module namespace/Module object (factory)
  | 'getBuiltinModule'       // process.getBuiltinModule (factory)
  | 'dynamic-import'         // import() — ambient in every execution context
  | 'import-meta-resolve'    // import.meta.resolve (retention-only sink source)
  | 'vm-injected';           // a loader-capable value inside a vm context

/** How a load sink retains its targets. */
export type SinkEffect =
  | 'load'      // initializes the target module (module reachability)
  | 'resolve';  // require.resolve / import.meta.resolve — retains file bytes only

// ---------------------------------------------------------------------------
// Specifier / resolved-target domains  (exact ⊑ finite ⊑ package ⊑ resolver-scope ⊑ unbounded)
// ---------------------------------------------------------------------------

export type SpecifierDomain =
  | { tier: 'exact'; specifiers: [string] }
  | { tier: 'finite'; specifiers: string[] }          // sorted, deduped, ≥1
  | { tier: 'package'; pkg: string; note?: string }   // constant package prefix, unknown subpath
  | { tier: 'unbounded'; gates: GateTag[] };          // why it widened

export type ResolvedTargetDomain =
  | { tier: 'exact' | 'finite'; files: string[]; builtins: string[]; missing: string[] }
  // every universe JS file of pkg; `gates` records WHY the package tier was
  // reached when it was not the specifier's own tier (e.g. a dynamic-import
  // sink widened by `import-condition-divergence`), so the blocking-set stays
  // complete and the right gate can be suppressed in a counterfactual.
  | { tier: 'package'; pkg: string; files: string[]; gates?: GateTag[] }
  | { tier: 'unbounded'; gates: GateTag[] };          // all universe JS

// ---------------------------------------------------------------------------
// Result-value flow (what happens to the loaded module value)
// ---------------------------------------------------------------------------

export type ResultFlow =
  | { kind: 'unused' }                       // side-effect load only
  | { kind: 'projected'; names: string[] }   // finite static property projection
  | { kind: 'escaped'; gates: GateTag[] };   // full observable surface reachable

// ---------------------------------------------------------------------------
// Gates — every conservative approximation that can block a proof. A gate tag
// appears in blocking-sets and can be suppressed in a gate-off counterfactual
// config. Reuse existing Reason strings where the semantics match.
// ---------------------------------------------------------------------------

export type GateTag =
  // sink/domain gates
  | 'unbounded-loader-target'      // specifier domain widened to unbounded
  | 'package-domain-whole'         // package tier retained whole (no subpath narrowing)
  | 'unresolved-specifier'
  | 'import-condition-divergence'
  | 'escaped-loader'               // capability value crossed an unmodeled boundary
  | 'wrapper-unprovable'           // loader wrapper preconditions failed
  | 'wrapper-depth'
  | 'generated-source-unknown'     // non-constant eval/Function source
  | 'generated-source-depth'
  | 'vm-conservative'              // strict model: vm maximally loader-capable
  | 'require-cache-mutation'       // cache/extensions mutation (universe-wide in strict model)
  | 'result-escaped'               // loaded value escaped → full surface of domain
  | 'dynamic-import'               // literal import() static edge: target surface use unknown
  | 'unsupported-syntax'           // parse failure → opaque module
  // surface/projection gates (module-local)
  | 'open-export-surface'          // surface not statically closed
  | 'export-object-mutation'
  | 'dynamic-property-access'
  | 'value-escaped'
  | 'destructure-rest'
  | 'binding-reassigned'
  | 'reexport-namespace'
  | 'export-star'
  | 'unsupported-export-kind'
  | 'internal-reference'
  | 'shared-implementation'
  | 'native-boundary'
  | 'wasm-boundary'
  | 'nft-positive-evidence'        // NFT traced it: known reachable (never suppressible)
  | 'resolve-sink-retained'        // require.resolve target: file bytes retained, module not initialized
  | 'static-import'                // statically imported name (never suppressible)
  | 'module-init-reachable'        // file retained because its module can initialize
  | 'entrypoint';

/** Gates that may NEVER be suppressed, even diagnostically. */
export const UNSUPPRESSIBLE_GATES: readonly GateTag[] = [
  'nft-positive-evidence',
  'static-import',
  'entrypoint',
  'resolve-sink-retained',
];

/**
 * Runtime witness of the GateTag union. The per-module facts carry `Reason`
 * (an open string type from @reducer/manifest), so the engine must filter
 * rather than cast when it lifts a Reason into a blocking-set.
 */
export const KNOWN_GATES: readonly GateTag[] = [
  'unbounded-loader-target', 'package-domain-whole', 'unresolved-specifier',
  'import-condition-divergence', 'escaped-loader', 'wrapper-unprovable', 'wrapper-depth',
  'generated-source-unknown', 'generated-source-depth', 'vm-conservative',
  'require-cache-mutation', 'result-escaped', 'dynamic-import', 'unsupported-syntax',
  'open-export-surface', 'export-object-mutation', 'dynamic-property-access',
  'value-escaped', 'destructure-rest', 'binding-reassigned', 'reexport-namespace',
  'export-star', 'unsupported-export-kind', 'internal-reference', 'shared-implementation',
  'native-boundary', 'wasm-boundary', 'nft-positive-evidence', 'static-import',
  'module-init-reachable', 'entrypoint', 'resolve-sink-retained',
];

const GATE_SET: ReadonlySet<string> = new Set<string>(KNOWN_GATES);

/** Lift an open `Reason` (or any string) into a GateTag, or drop it. */
export function asGates(reasons: readonly string[]): GateTag[] {
  return reasons.filter((r): r is GateTag => GATE_SET.has(r));
}

export type RefinementName =
  | 'SR-vm-known-globals'            // vm sites w/ object-literal context, no loader-like key, constant code
  | 'SR-subpath-exports-narrowing'   // package tier narrowed to exports-map targets
  | 'SR-import-condition-resolution' // real import-condition resolver
  | 'SR-cross-module-wrapper';       // wrapper preconditions across module boundary, depth+1

export interface AnalysisConfig {
  /** Gate-off counterfactual: suppress these gates' widenings wholesale (UNSOUND, diagnostic). */
  suppressGates?: GateTag[];
  /** Sound-refinement counterfactual: admit only evidenced cases per refinement. */
  refinements?: RefinementName[];
  label?: string;
}

// ---------------------------------------------------------------------------
// Per-module facts (parse once; every config reuses)
// ---------------------------------------------------------------------------

export interface LoadSink {
  id: string;                    // stable: `${fileRel}#${index}`
  file: string;                  // universe-relative path of containing module
  capability: CapabilityKind;
  effect: SinkEffect;
  specifier: SpecifierDomain;
  result: ResultFlow;
  /** for vm sinks: evidence for SR-vm-known-globals headroom */
  vmEvidence?: VmSiteEvidence;
  /** for parameter-fed sinks: evidence for SR-cross-module-wrapper headroom */
  wrapperEvidence?: WrapperEvidence;
  /** generated-source recursion depth at which this sink was found (0 = source) */
  generatedDepth: number;
  loc: { line: number; column: number };
}

/**
 * Loader-wrapper propagation evidence (design §5 + SR-cross-module-wrapper).
 * `resolved` sinks took the union of call-site argument domains under the full
 * precondition set. An unresolved one widened; `crossModuleOnly` marks the sinks
 * that failed ONLY the same-module-callers condition, which is exactly the set
 * the SR-cross-module-wrapper counterfactual may admit.
 */
export interface WrapperEvidence {
  /** wrapper nesting depth at which this was decided (0 = the sink's own function) */
  depth: number;
  resolved: boolean;
  /** wrapper function name, or '<anonymous>' */
  fn: string;
  /** in-module call-site argument domains (union basis / SR counterfactual input) */
  callSiteDomains: SpecifierDomain[];
  /** failed ONLY the same-module condition (the value escapes solely by export) */
  crossModuleOnly: boolean;
  /** why it widened, when it did */
  why?: string;
}

export interface VmSiteEvidence {
  api: string;                              // e.g. 'vm.runInNewContext'
  contextArg: 'none' | 'object-literal' | 'identifier' | 'unknown';
  literalKeys?: string[];
  injectsLoaderLike: boolean;               // a key holds a tracked capability value
  codeConstant: boolean;
}

export interface ExportFact {
  exportName: string;
  localName: string | null;
  /** transformer-shape stubbable (top-level FunctionDeclaration, existing rules) */
  stubbable: boolean;
  retainReasons: Reason[];
  /** source span of the backing function body, for byte prediction */
  bodySpan?: { start: number; end: number };
}

export interface ModuleFacts {
  rel: string;                   // universe-relative POSIX path
  abs: string;
  bytes: number;
  format: 'esm' | 'cjs';
  thirdParty: boolean;
  pkg: { name: string; version: string; dir: string } | null;
  exports: Map<string, ExportFact>;
  /** non-empty => surface not statically closed (existing recognition rules) */
  surfaceOpen: Reason[];
  /** static edges: specifier → resolved abs (or null) with per-target usage */
  staticEdges: StaticEdge[];
  sinks: LoadSink[];
  /** module records escaped-loader state (capability crossed unmodeled boundary) */
  escapedLoader: boolean;
  /**
   * Sink-less gates established by this module (e.g. require.cache mutation,
   * which is universe-wide in the strict model). The engine decides their blast
   * radius; facts only record that the module established them.
   */
  moduleGates: GateTag[];
  /** every conservative widening this module took, with its reason */
  widened: { where: string; why: string }[];
  parseFailed: boolean;
}

export interface StaticEdge {
  source: string;                // raw specifier
  resolvedAbs: string | null;
  names: Set<string>;            // statically used property/import names
  all: boolean;                  // whole surface used (escape/rest/…)
  reasons: Reason[];
}

// ---------------------------------------------------------------------------
// Verdicts and prediction
// ---------------------------------------------------------------------------

export type FileState =
  | 'retained-reachable'          // module can initialize (or NFT-traced)
  | 'retained-uncertain'          // kept by widening; blocking-set says why
  | 'predicted-removable-file';   // proof model: module-unreachable

export interface FilePrediction {
  rel: string;
  pkg: string | null;             // "name@version"
  bytes: number;
  state: FileState;
  blockingSet: GateTag[];         // complete, not first-gate-only; [] iff predicted removable
  /** predicted stubbable exports when the file itself is retained */
  stubPredictions: StubPrediction[];
}

export interface StubPrediction {
  symbol: string;
  localName: string;
  proofModel: 'function-body-stub';       // ADR-0004 semantics
  bodyBytes: number;                       // implementation bytes eliminated
  netBytes: number;                        // file-size delta incl. stub cost (may be negative)
  blockingSet: GateTag[];                  // [] iff predicted stubbable
  predicted: boolean;
}

export interface HazardDomainReport {
  app: string;
  entry: string;
  configLabel: string;
  analyzerVersion: string;
  /** sha256 over the hazard-domain source files, for reproducibility */
  analyzerSourceHash: string;
  D: number;                       // third-party executable JS bytes in the universe
  E_predicted: number;
  netReduction: number;            // (D - E)/D, may be negative
  implBytesEliminable: number;     // Σ bodyBytes over predicted stubs + removed file bytes
  files: FilePrediction[];
  distributions: {
    capabilityCounts: Record<string, number>;          // CapabilityKind → site count
    domainTiers: Record<string, number>;               // sink domain tier → count
    resultFlows: Record<string, number>;               // ResultFlow.kind → count
    exportSurface: { closed: number; open: number; openReasons: Record<string, number> };
    blockingSets: Record<string, number>;              // canonical "a+b+c" → file count
  };
  vmEvidence: VmSiteEvidence[];
  widened: { where: string; why: string }[];           // every conservative widening w/ reason
  stats: {
    universeJsFiles: number;
    thirdPartyJsFiles: number;
    parsed: number;
    parseFailures: number;
    reachableModules: number;
    activeSinks: number;
    analysisMs: number;
  };
  warnings: string[];
}
