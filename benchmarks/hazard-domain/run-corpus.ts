/**
 * The frozen 19-app hazard-domain corpus runner (ADR-0006).
 *
 * Per app: `prepareHazardDomain` ONCE (the expensive half — universe walk +
 * parse), then re-run the CHEAP half (`analyzePrepared`, which just reruns the
 * fixpoint/projection/byte-prediction) once per configuration: strict, one
 * gate-off per suppressible gate the strict run actually blocked something
 * with, the top-5-by-delta pairwise gate-offs, and the four named
 * sound-refinement counterfactuals. Gate-off numbers are UNSOUND diagnostics
 * (upper bounds conditional on every other gate staying conservative) — they
 * can disfavor the thesis but never rescue it; only the SR configs can rescue.
 *
 * This script transforms nothing and writes nothing but its own JSON report:
 * it only calls the hazard-domain package's public API.
 *
 * Usage:
 *   bun benchmarks/hazard-domain/run-corpus.ts --app <name>
 *   bun benchmarks/hazard-domain/run-corpus.ts --all
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  UNSUPPRESSIBLE_GATES,
  analyzePrepared,
  prepareHazardDomain,
  runFixpoint,
  type ActiveSink,
  type FixpointResult,
  type GateTag,
  type HazardDomainReport,
  type RefinementName,
} from '@reducer/hazard-domain';
import {
  ENTRY_DEVIATIONS,
  SR_REFINEMENTS,
  cloneDir,
  loadCorpusApps,
  loadFrozenPackages,
  verifyHead,
} from './corpus-apps.ts';

const OUT_DIR = path.join(import.meta.dirname, 'first-run', 'corpus');

interface ConfigSummary {
  label: string;
  D: number;
  E: number;
  netReduction: number;
  implBytesEliminable: number;
  /** top 5 blocking-set combinations by file count, under THIS config */
  dominantBlockingSets: [string, number][];
  analysisMs: number;
}

interface RefinementSummary extends ConfigSummary {
  /** active load sinks this refinement's proof obligation could apply to */
  candidates: number;
  /** of those, how many the refinement actually admitted (contributed nothing / narrowed) */
  admitted: number;
  widened: number;
}

function summarizeConfig(report: HazardDomainReport): ConfigSummary {
  return {
    label: report.configLabel,
    D: report.D,
    E: report.E_predicted,
    netReduction: report.netReduction,
    implBytesEliminable: report.implBytesEliminable,
    dominantBlockingSets: Object.entries(report.distributions.blockingSets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
    analysisMs: report.stats.analysisMs,
  };
}

/** Whether an active sink is the kind of site the named refinement's proof obligation covers at all. */
function isCandidateSink(name: RefinementName, a: ActiveSink): boolean {
  if (name === 'SR-vm-known-globals') return a.sink.capability === 'vm-injected';
  if (name === 'SR-cross-module-wrapper') {
    const w = a.sink.wrapperEvidence;
    return !!w && !w.resolved && w.crossModuleOnly;
  }
  if (name === 'SR-import-condition-resolution') return a.gates.includes('import-condition-divergence');
  return a.domain.tier === 'package'; // SR-subpath-exports-narrowing
}

function domainFileCount(d: ActiveSink['domain']): number {
  return d.tier === 'unbounded' ? Number.POSITIVE_INFINITY : d.files.length;
}

/**
 * Admitted/widened counts for one refinement (design §13): among the sinks its
 * proof obligation could apply to (`candidates`), how many did it actually
 * relieve — dropped from the active set entirely (vm / cross-module-wrapper),
 * lost the gate it was named for (import-condition), or had its resolved
 * domain shrink (subpath-exports-narrowing). The rest are `widened`: evidenced
 * candidates the refinement's stated proof obligation still could not clear.
 */
function refinementDiagnostics(
  base: FixpointResult,
  refined: FixpointResult,
  name: RefinementName,
): { candidates: number; admitted: number; widened: number } {
  const refinedById = new Map(refined.activeLoadSinks.map((a) => [a.sink.id, a] as const));
  let candidates = 0;
  let admitted = 0;
  for (const a of base.activeLoadSinks) {
    if (!isCandidateSink(name, a)) continue;
    candidates++;
    const r = refinedById.get(a.sink.id);
    if (!r) {
      admitted++;
      continue;
    }
    if (name === 'SR-import-condition-resolution' && !r.gates.includes('import-condition-divergence')) admitted++;
    else if (name === 'SR-subpath-exports-narrowing' && domainFileCount(r.domain) < domainFileCount(a.domain))
      admitted++;
  }
  return { candidates, admitted, widened: candidates - admitted };
}

const pairs = <T>(xs: T[]): [T, T][] => {
  const out: [T, T][] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) out.push([xs[i]!, xs[j]!]);
  return out;
};

async function runApp(name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${name}.json`);
  const writeError = (error: string) => {
    console.error(`[${name}] ${error}`);
    writeFileSync(outFile, JSON.stringify({ app: name, error }, null, 2));
  };

  const head = verifyHead(name);
  if (!head.ok) return writeError(head.error);

  const meta = loadCorpusApps().find((c) => c.app === name)!;
  const root = cloneDir(name);
  const entry = path.join(root, meta.entryRel);
  const frozenPackages = loadFrozenPackages(name);

  const t0 = Date.now();
  try {
    const prep = await prepareHazardDomain({ app: name, entry, root, frozenPackages, nft: true });
    const strict = analyzePrepared(prep);

    // ---- single-gate-off: every suppressible gate present in ANY strict blocking-set
    const presentGates = new Set<GateTag>();
    for (const f of strict.files) for (const g of f.blockingSet) presentGates.add(g);
    for (const g of UNSUPPRESSIBLE_GATES) presentGates.delete(g);
    const suppressible = [...presentGates].sort();

    let gateOffMs = 0;
    const gateOff: Record<string, ConfigSummary> = {};
    for (const g of suppressible) {
      const t = Date.now();
      const rep = analyzePrepared(prep, { suppressGates: [g], label: `gate-off:${g}` });
      gateOffMs += Date.now() - t;
      gateOff[g] = summarizeConfig(rep);
    }

    // ---- top-5 single-delta gates -> all C(5,2) pairwise gate-offs
    const ranked = suppressible
      .map((g) => ({ g, delta: gateOff[g]!.netReduction - strict.netReduction }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 5)
      .map((x) => x.g);

    let pairwiseMs = 0;
    const pairwise: Record<string, ConfigSummary> = {};
    for (const [a, b] of pairs(ranked)) {
      const label = [a, b].sort().join('+');
      const t = Date.now();
      const rep = analyzePrepared(prep, { suppressGates: [a, b], label: `gate-off:${label}` });
      pairwiseMs += Date.now() - t;
      pairwise[label] = summarizeConfig(rep);
    }

    // ---- the four named sound-refinement counterfactuals
    const fxInput = { universe: prep.universe, facts: prep.facts, nft: prep.nft, resolveCache: prep.resolveCache };
    const baseFx = runFixpoint(fxInput);
    let refinementsMs = 0;
    const refinements: Record<string, RefinementSummary> = {};
    for (const r of SR_REFINEMENTS) {
      const t = Date.now();
      const rep = analyzePrepared(prep, { refinements: [r], label: r });
      const refinedFx = runFixpoint(fxInput, { refinements: [r] });
      refinementsMs += Date.now() - t;
      refinements[r] = { ...summarizeConfig(rep), ...refinementDiagnostics(baseFx, refinedFx, r) };
    }

    const deviation = ENTRY_DEVIATIONS[name];
    const out = {
      app: name,
      category: meta.category,
      sha: head.sha,
      entry: meta.entryRel,
      D: strict.D,
      strict,
      gateOff,
      pairwise,
      refinements,
      deviations: deviation ? [deviation] : [],
      timings: {
        prepareMs: prep.prepareMs,
        strictMs: strict.stats.analysisMs,
        gateOffMs,
        pairwiseMs,
        refinementsMs,
        totalMs: Date.now() - t0,
      },
    };
    writeFileSync(outFile, JSON.stringify(out, null, 2));
    console.log(
      `[${name}] D=${strict.D} E=${strict.E_predicted} net=${(strict.netReduction * 100).toFixed(1)}% ` +
        `(${suppressible.length} suppressible gates, ${Date.now() - t0}ms)`,
    );
  } catch (err) {
    writeError(`crash: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`.slice(0, 4000));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  });

  const apps = loadCorpusApps().map((c) => c.app);
  if (values.all) {
    for (const app of apps) await runApp(app); // sequential: memory, per design
  } else if (values.app) {
    if (!apps.includes(values.app)) {
      console.error(`unknown app '${values.app}'. Known: ${apps.join(', ')}`);
      process.exit(1);
    }
    await runApp(values.app);
  } else {
    console.error('usage: bun benchmarks/hazard-domain/run-corpus.ts --app <name> | --all');
    console.error(`known apps: ${apps.join(', ')}`);
    process.exit(1);
  }
}

await main();
