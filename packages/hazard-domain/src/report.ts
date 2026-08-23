/**
 * Report assembly (design §12): distributions, complete blocking-sets, the
 * widening log, and a content hash of the analyzer itself so a number can
 * always be traced back to the code that produced it.
 *
 * A blocking-set here is COMPLETE, never first-gate-only: it is the fixpoint's
 * accumulated attribution for the file (why its module can initialize, from
 * EVERY independently sufficient cause) unioned with the file's local gates.
 * A gate-off counterfactual that saw only the first cause would report
 * headroom that switching that gate off cannot actually deliver.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { REDUCER_VERSION, sha256 } from '@reducer/manifest';
import {
  asGates,
  type AnalysisConfig,
  type FilePrediction,
  type FileState,
  type GateTag,
  type HazardDomainReport,
  type ModuleFacts,
  type VmSiteEvidence,
} from './types.ts';
import type { FixpointResult } from './fixpoint.ts';
import type { SymbolDecision } from './projection.ts';
import type { BytesResult } from './bytes.ts';
import type { Universe } from './universe.ts';

let cachedHash: string | null = null;
/** sha256 over this package's sources — reproducibility of every number. */
export function analyzerSourceHash(): string {
  if (cachedHash) return cachedHash;
  try {
    const dir = import.meta.dirname;
    const parts = readdirSync(dir)
      .filter((n) => n.endsWith('.ts'))
      .sort()
      .map((n) => readFileSync(path.join(dir, n), 'utf8'));
    cachedHash = sha256(parts.join('\n'));
  } catch {
    cachedHash = 'unavailable';
  }
  return cachedHash;
}

export interface AssembleInput {
  app: string;
  universe: Universe;
  facts: Map<string, ModuleFacts>;
  fx: FixpointResult;
  decisions: Map<string, SymbolDecision[]>;
  bytes: BytesResult;
  nft: Set<string> | null;
  /** false ⇒ every retention also carries the absent-positive-evidence gate */
  fileRemovalAdmissible: boolean;
  config?: AnalysisConfig;
  warnings: string[];
  analysisMs: number;
}

export function assembleReport(input: AssembleInput): HazardDomainReport {
  const { universe: u, facts, fx, decisions, bytes } = input;

  const files: FilePrediction[] = [];
  const blockingSetCounts: Record<string, number> = {};
  for (const f of u.files) {
    if (!f.isJs || !f.thirdParty) continue;
    const b = bytes.byFile.get(f.rel);
    if (!b) continue;
    const m = facts.get(f.rel);
    const local: GateTag[] = m ? asGates(m.surfaceOpen) : [];
    const state: FileState = b.removable
      ? 'predicted-removable-file'
      : fx.reachable.has(f.rel)
        ? 'retained-reachable'
        : 'retained-uncertain';
    let blockingSet: GateTag[] = [];
    if (!b.removable) {
      const set = new Set<GateTag>([...(fx.attribution.get(f.rel) ?? []), ...local]);
      // Without a trace, the file is retained purely because the positive
      // evidence that would have justified a removal proof is missing.
      if (!input.fileRemovalAdmissible) set.add('nft-positive-evidence');
      // A retained file ALWAYS names at least one cause: an empty set is
      // reserved, by contract, for a predicted-removable file. Proven
      // module-init reachability is itself the cause when no gate is.
      if (set.size === 0) set.add('module-init-reachable');
      blockingSet = [...set].sort();
    }
    files.push({
      rel: f.rel,
      pkg: f.pkg ? `${f.pkg.name}@${f.pkg.version}` : null,
      bytes: b.emitted,
      state,
      blockingSet,
      stubPredictions: [
        ...b.stubs,
        ...(decisions.get(f.rel) ?? [])
          .filter((d) => !d.predicted && d.localName)
          .map((d) => ({
            symbol: d.symbol,
            localName: d.localName!,
            proofModel: 'function-body-stub' as const,
            bodyBytes: 0,
            netBytes: 0,
            blockingSet: d.blockingSet,
            predicted: false,
          })),
      ],
    });
    const key = blockingSet.length > 0 ? blockingSet.join('+') : '<none>';
    blockingSetCounts[key] = (blockingSetCounts[key] ?? 0) + 1;
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // ---- distributions
  const capabilityCounts: Record<string, number> = {};
  const domainTiers: Record<string, number> = {};
  const resultFlows: Record<string, number> = {};
  const openReasons: Record<string, number> = {};
  const vmEvidence: VmSiteEvidence[] = [];
  const widened: { where: string; why: string }[] = [...u.warnings.map((w) => ({ where: '<universe>', why: w }))];
  let closed = 0;
  let open = 0;
  let parsed = 0;
  let parseFailures = 0;
  let universeJsFiles = 0;
  let thirdPartyJsFiles = 0;

  for (const f of u.files) {
    if (!f.isJs) continue;
    universeJsFiles++;
    if (f.thirdParty) thirdPartyJsFiles++;
    const m = facts.get(f.rel);
    if (!m) continue;
    if (m.parseFailed) parseFailures++;
    else parsed++;
    if (m.surfaceOpen.length > 0) {
      open++;
      for (const r of m.surfaceOpen) openReasons[r] = (openReasons[r] ?? 0) + 1;
    } else {
      closed++;
    }
    for (const s of m.sinks) {
      capabilityCounts[s.capability] = (capabilityCounts[s.capability] ?? 0) + 1;
      domainTiers[s.specifier.tier] = (domainTiers[s.specifier.tier] ?? 0) + 1;
      resultFlows[s.result.kind] = (resultFlows[s.result.kind] ?? 0) + 1;
      if (s.vmEvidence) vmEvidence.push(s.vmEvidence);
    }
    widened.push(...m.widened);
  }
  widened.push(...fx.widened);

  return {
    app: input.app,
    entry: u.entryRel,
    configLabel: input.config?.label ?? 'strict',
    analyzerVersion: REDUCER_VERSION,
    analyzerSourceHash: analyzerSourceHash(),
    D: bytes.D,
    E_predicted: bytes.E,
    netReduction: bytes.netReduction,
    implBytesEliminable: bytes.implBytesEliminable,
    files,
    distributions: {
      capabilityCounts,
      domainTiers,
      resultFlows,
      exportSurface: { closed, open, openReasons },
      blockingSets: blockingSetCounts,
    },
    vmEvidence,
    widened,
    stats: {
      universeJsFiles,
      thirdPartyJsFiles,
      parsed,
      parseFailures,
      reachableModules: fx.reachable.size,
      activeSinks: fx.activeSinkCount,
      analysisMs: input.analysisMs,
    },
    warnings: [...input.warnings, ...u.warnings],
  };
}
