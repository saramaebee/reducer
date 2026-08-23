/**
 * Aggregate benchmarks/hazard-domain/first-run/corpus/*.json (written by
 * run-corpus.ts) into the ADR-0006 decision statistics: the kill metric
 * (median net universe-relative reduction on TARGET apps, with P25/P75 and
 * fraction >=10%/>=15%), the same for CONTROLS reported separately (never
 * folded into the primary statistic — ADR-0006 explicitly says including the
 * deliberately-hostile controls "would make the experimental design fight
 * itself"), the full corpus descriptively, and the same three-way split for
 * each of the four named sound-refinement counterfactuals. Gate-off headroom
 * (single + pairwise) is reported as an explicitly UNSOUND-DIAGNOSTIC upper
 * bound, per CONTEXT.md's *Gate-off counterfactual* — it can disfavor the
 * thesis, never rescue it; only the sound-refinement numbers above can rescue.
 *
 * Percentile method: linear interpolation between order statistics (R type-7
 * / numpy's default / Excel PERCENTILE.INC): for a sorted array of length n
 * and quantile p in [0,1], idx = p*(n-1); interpolate between xs[floor(idx)]
 * and xs[ceil(idx)] by the fractional part of idx.
 *
 * This script transforms nothing and reads only the JSON run-corpus.ts wrote.
 *
 * Usage: bun benchmarks/hazard-domain/summarize-corpus.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GateTag, HazardDomainReport } from '@reducer/hazard-domain';
import { SR_REFINEMENTS } from './corpus-apps.ts';

const CORPUS_DIR = path.join(import.meta.dirname, 'first-run', 'corpus');
const OUT_DIR = path.join(import.meta.dirname, 'first-run');

interface ConfigSummary {
  label: string;
  D: number;
  E: number;
  netReduction: number;
  implBytesEliminable: number;
  dominantBlockingSets: [string, number][];
  analysisMs: number;
}
interface RefinementSummary extends ConfigSummary {
  candidates: number;
  admitted: number;
  widened: number;
}
interface AppRecord {
  app: string;
  category?: 'target' | 'control';
  error?: string;
  sha?: string;
  entry?: string;
  D?: number;
  strict?: HazardDomainReport;
  gateOff?: Record<string, ConfigSummary>;
  pairwise?: Record<string, ConfigSummary>;
  refinements?: Record<string, RefinementSummary>;
  deviations?: string[];
  timings?: { prepareMs: number; strictMs: number; gateOffMs: number; pairwiseMs: number; refinementsMs: number; totalMs: number };
}

function loadAll(): AppRecord[] {
  if (!existsSync(CORPUS_DIR)) {
    throw new Error(`${CORPUS_DIR} does not exist — run run-corpus.ts --all first`);
  }
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no per-app JSON in ${CORPUS_DIR} — run run-corpus.ts --all first`);
  return files.map((f) => JSON.parse(readFileSync(path.join(CORPUS_DIR, f), 'utf8')));
}

// ---------------------------------------------------------------------------
// percentile / category statistics
// ---------------------------------------------------------------------------

/** Linear interpolation between order statistics (documented above). `sorted` must be ascending. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

interface CategoryStats {
  n: number;
  median: number;
  p25: number;
  p75: number;
  fractionAtLeast10: number;
  fractionAtLeast15: number;
  values: number[];
}

function categoryStats(values: number[]): CategoryStats {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    median: percentile(s, 0.5),
    p25: percentile(s, 0.25),
    p75: percentile(s, 0.75),
    fractionAtLeast10: s.length ? s.filter((v) => v >= 0.1).length / s.length : NaN,
    fractionAtLeast15: s.length ? s.filter((v) => v >= 0.15).length / s.length : NaN,
    values: s,
  };
}

function statsFor(records: AppRecord[], selector: (r: AppRecord) => number | undefined): CategoryStats {
  return categoryStats(records.map(selector).filter((v): v is number => typeof v === 'number'));
}

// ---------------------------------------------------------------------------
// gate-off headroom (UNSOUND-DIAGNOSTIC, per-gate and per-pair, over TARGET apps)
// ---------------------------------------------------------------------------

interface HeadroomStats {
  appsTested: number;
  medianDeltaPct: number;
  meanDeltaPct: number;
  maxDeltaPct: number;
  perApp: { app: string; deltaPct: number }[];
}

function headroomTable(records: AppRecord[], pick: (r: AppRecord) => Record<string, ConfigSummary> | undefined): Record<string, HeadroomStats> {
  const byKey = new Map<string, { app: string; deltaPct: number }[]>();
  for (const r of records) {
    const configs = pick(r);
    if (!configs || !r.strict) continue;
    for (const [key, cfg] of Object.entries(configs)) {
      const delta = cfg.netReduction - r.strict.netReduction;
      const list = byKey.get(key) ?? [];
      list.push({ app: r.app, deltaPct: delta * 100 });
      byKey.set(key, list);
    }
  }
  const out: Record<string, HeadroomStats> = {};
  for (const [key, list] of byKey) {
    const deltas = list.map((x) => x.deltaPct).sort((a, b) => a - b);
    out[key] = {
      appsTested: list.length,
      medianDeltaPct: percentile(deltas, 0.5),
      meanDeltaPct: deltas.reduce((a, b) => a + b, 0) / deltas.length,
      maxDeltaPct: deltas[deltas.length - 1]!,
      perApp: list.sort((a, b) => b.deltaPct - a.deltaPct),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// dominant blocking sets by RETAINED bytes (from the full strict report only —
// gate-off/refinement configs store summary numbers, not per-file bytes)
// ---------------------------------------------------------------------------

function dominantBlockingSetsByBytes(records: AppRecord[]): [string, number][] {
  const bytesByKey = new Map<string, number>();
  for (const r of records) {
    if (!r.strict) continue;
    for (const f of r.strict.files) {
      if (f.state === 'predicted-removable-file') continue;
      const key = f.blockingSet.length > 0 ? f.blockingSet.join('+') : '<none>';
      bytesByKey.set(key, (bytesByKey.get(key) ?? 0) + f.bytes);
    }
  }
  return [...bytesByKey.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// aggregated distributions / analysis times / widened-case counts
// ---------------------------------------------------------------------------

function sumRecords(dicts: Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dicts) for (const [k, v] of Object.entries(d)) out[k] = (out[k] ?? 0) + v;
  return out;
}

function aggregatedDistributions(records: AppRecord[]) {
  const withStrict = records.filter((r): r is AppRecord & { strict: HazardDomainReport } => !!r.strict);
  return {
    capabilityCounts: sumRecords(withStrict.map((r) => r.strict.distributions.capabilityCounts)),
    domainTiers: sumRecords(withStrict.map((r) => r.strict.distributions.domainTiers)),
    resultFlows: sumRecords(withStrict.map((r) => r.strict.distributions.resultFlows)),
    exportSurface: {
      closed: withStrict.reduce((a, r) => a + r.strict.distributions.exportSurface.closed, 0),
      open: withStrict.reduce((a, r) => a + r.strict.distributions.exportSurface.open, 0),
      openReasons: sumRecords(withStrict.map((r) => r.strict.distributions.exportSurface.openReasons)),
    },
  };
}

function analysisTimes(records: AppRecord[]) {
  const perApp = records.filter((r) => r.timings).map((r) => ({ app: r.app, ...r.timings! }));
  const totals = perApp.reduce(
    (acc, t) => ({
      prepareMs: acc.prepareMs + t.prepareMs,
      strictMs: acc.strictMs + t.strictMs,
      gateOffMs: acc.gateOffMs + t.gateOffMs,
      pairwiseMs: acc.pairwiseMs + t.pairwiseMs,
      refinementsMs: acc.refinementsMs + t.refinementsMs,
      totalMs: acc.totalMs + t.totalMs,
    }),
    { prepareMs: 0, strictMs: 0, gateOffMs: 0, pairwiseMs: 0, refinementsMs: 0, totalMs: 0 },
  );
  const medianTotalMs = percentile(perApp.map((t) => t.totalMs).sort((a, b) => a - b), 0.5);
  return { perApp, totals, medianTotalMs };
}

function widenedCaseCounts(records: AppRecord[]) {
  const perApp = records.filter((r) => r.strict).map((r) => ({ app: r.app, count: r.strict!.widened.length }));
  const total = perApp.reduce((a, x) => a + x.count, 0);
  return { perApp: perApp.sort((a, b) => b.count - a.count), total };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const pct = (x: number) => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const pctPts = (x: number) => (Number.isNaN(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(1)} pts`);
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

function statsRow(label: string, s: CategoryStats): string {
  return `| ${label} | ${s.n} | ${pct(s.median)} | ${pct(s.p25)} | ${pct(s.p75)} | ${pct(s.fractionAtLeast10)} | ${pct(s.fractionAtLeast15)} |\n`;
}

interface Summary {
  generatedAt: string;
  percentileMethod: string;
  appsLoaded: number;
  appsFailed: { app: string; error?: string }[];
  targetApps: string[];
  controlApps: string[];
  strict: { target: CategoryStats; control: CategoryStats; full: CategoryStats };
  refinements: Record<string, { target: CategoryStats; control: CategoryStats; full: CategoryStats }>;
  singleGateHeadroomUnsoundDiagnostic: Record<string, HeadroomStats>;
  pairwiseGateHeadroomUnsoundDiagnostic: Record<string, HeadroomStats>;
  dominantBlockingSetsByRetainedBytes: {
    overall: [string, number][];
    target: [string, number][];
    control: [string, number][];
  };
  distributions: ReturnType<typeof aggregatedDistributions>;
  analysisTimes: ReturnType<typeof analysisTimes>;
  widenedCaseCounts: ReturnType<typeof widenedCaseCounts>;
}

function main() {
  const all = loadAll();
  const failed = all.filter((r) => r.error);
  const ok = all.filter((r) => !r.error);
  const targets = ok.filter((r) => r.category === 'target');
  const controls = ok.filter((r) => r.category === 'control');

  const strictStats = {
    target: statsFor(targets, (r) => r.strict?.netReduction),
    control: statsFor(controls, (r) => r.strict?.netReduction),
    full: statsFor(ok, (r) => r.strict?.netReduction),
  };
  const refinementStats = Object.fromEntries(
    SR_REFINEMENTS.map((name) => [
      name,
      {
        target: statsFor(targets, (r) => r.refinements?.[name]?.netReduction),
        control: statsFor(controls, (r) => r.refinements?.[name]?.netReduction),
        full: statsFor(ok, (r) => r.refinements?.[name]?.netReduction),
      },
    ]),
  );

  const singleGateHeadroom = headroomTable(targets, (r) => r.gateOff);
  const pairwiseHeadroom = headroomTable(targets, (r) => r.pairwise);
  const dominantBlockingSets = {
    overall: dominantBlockingSetsByBytes(ok),
    target: dominantBlockingSetsByBytes(targets),
    control: dominantBlockingSetsByBytes(controls),
  };
  const distributions = aggregatedDistributions(ok);
  const times = analysisTimes(ok);
  const widened = widenedCaseCounts(ok);

  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    percentileMethod:
      'linear interpolation between order statistics (R type-7 / numpy default / Excel PERCENTILE.INC): ' +
      'idx = p*(n-1), interpolate between floor(idx) and ceil(idx) by the fractional part',
    appsLoaded: ok.length,
    appsFailed: failed.map((r) => ({ app: r.app, error: r.error })),
    targetApps: targets.map((r) => r.app).sort(),
    controlApps: controls.map((r) => r.app).sort(),
    strict: strictStats,
    refinements: refinementStats,
    singleGateHeadroomUnsoundDiagnostic: singleGateHeadroom,
    pairwiseGateHeadroomUnsoundDiagnostic: pairwiseHeadroom,
    dominantBlockingSetsByRetainedBytes: dominantBlockingSets,
    distributions,
    analysisTimes: times,
    widenedCaseCounts: widened,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(OUT_DIR, 'summary.md'), toMarkdown(summary, targets.length, controls.length));
  console.log(`${ok.length} apps loaded (${failed.length} failed) -> first-run/summary.json, first-run/summary.md`);
  console.log(`STRICT median net reduction — target: ${pct(strictStats.target.median)}, control: ${pct(strictStats.control.median)}`);
}

function toMarkdown(s: Summary, nTarget: number, nControl: number): string {
  let md = '# ADR-0006 hazard-domain corpus summary\n\n';
  md += `Generated ${s.generatedAt}. ${s.appsLoaded} apps loaded (${s.appsFailed.length} failed). ` +
    `${nTarget} target apps, ${nControl} control apps.\n\n`;
  md += `**Percentile method:** ${s.percentileMethod}.\n\n`;

  if (s.appsFailed.length > 0) {
    md += '## Failed apps\n\n| app | error |\n|---|---|\n';
    for (const f of s.appsFailed) md += `| ${f.app} | ${String(f.error).slice(0, 200)} |\n`;
    md += '\n';
  }

  md += '## Strict predicted ceiling — the kill metric\n\n';
  md += '| population | n | median | P25 | P75 | frac >=10% | frac >=15% |\n|---|---|---|---|---|---|---|\n';
  md += statsRow('TARGET (decision statistic)', s.strict.target);
  md += statsRow('control (separate, never folded in)', s.strict.control);
  md += statsRow('full corpus (descriptive)', s.strict.full);

  md += '\n## Sound-refinement counterfactuals (the only rescue path)\n\n';
  md += '| refinement | population | n | median | P25 | P75 | frac >=10% | frac >=15% |\n|---|---|---|---|---|---|---|---|\n';
  for (const [name, st] of Object.entries(s.refinements) as [string, any][]) {
    md += `| ${name} | target | ${st.target.n} | ${pct(st.target.median)} | ${pct(st.target.p25)} | ${pct(st.target.p75)} | ${pct(st.target.fractionAtLeast10)} | ${pct(st.target.fractionAtLeast15)} |\n`;
    md += `| ${name} | control | ${st.control.n} | ${pct(st.control.median)} | ${pct(st.control.p25)} | ${pct(st.control.p75)} | ${pct(st.control.fractionAtLeast10)} | ${pct(st.control.fractionAtLeast15)} |\n`;
    md += `| ${name} | full | ${st.full.n} | ${pct(st.full.median)} | ${pct(st.full.p25)} | ${pct(st.full.p75)} | ${pct(st.full.fractionAtLeast10)} | ${pct(st.full.fractionAtLeast15)} |\n`;
  }

  md += '\n## Single-gate-off headroom — UNSOUND-DIAGNOSTIC upper bound, conditional on all other gates remaining conservative (TARGET apps only)\n\n';
  md += '| gate | apps tested | median delta | mean delta | max delta |\n|---|---|---|---|---|\n';
  for (const [g, h] of Object.entries(s.singleGateHeadroomUnsoundDiagnostic).sort((a: any, b: any) => b[1].medianDeltaPct - a[1].medianDeltaPct) as [string, HeadroomStats][]) {
    md += `| ${g} | ${h.appsTested} | ${pctPts(h.medianDeltaPct)} | ${pctPts(h.meanDeltaPct)} | ${pctPts(h.maxDeltaPct)} |\n`;
  }

  md += '\n## Pairwise-gate-off headroom — UNSOUND-DIAGNOSTIC, top-5-single-delta-ranked pairs (TARGET apps only)\n\n';
  md += '| gate pair | apps tested | median delta | mean delta | max delta |\n|---|---|---|---|---|\n';
  for (const [g, h] of Object.entries(s.pairwiseGateHeadroomUnsoundDiagnostic).sort((a: any, b: any) => b[1].medianDeltaPct - a[1].medianDeltaPct) as [string, HeadroomStats][]) {
    md += `| ${g} | ${h.appsTested} | ${pctPts(h.medianDeltaPct)} | ${pctPts(h.meanDeltaPct)} | ${pctPts(h.maxDeltaPct)} |\n`;
  }

  md += '\n## Dominant blocking-sets by retained bytes\n\n### Overall\n\n| blocking-set | retained bytes | share |\n|---|---|---|\n';
  const totalOverall = s.dominantBlockingSetsByRetainedBytes.overall.reduce((a: number, [, b]: [string, number]) => a + b, 0);
  for (const [k, b] of s.dominantBlockingSetsByRetainedBytes.overall.slice(0, 20) as [string, number][]) {
    md += `| ${k} | ${kb(b)} | ${pct(totalOverall > 0 ? b / totalOverall : 0)} |\n`;
  }
  md += '\n### Target only\n\n| blocking-set | retained bytes |\n|---|---|\n';
  for (const [k, b] of s.dominantBlockingSetsByRetainedBytes.target.slice(0, 10) as [string, number][]) md += `| ${k} | ${kb(b)} |\n`;
  md += '\n### Control only\n\n| blocking-set | retained bytes |\n|---|---|\n';
  for (const [k, b] of s.dominantBlockingSetsByRetainedBytes.control.slice(0, 10) as [string, number][]) md += `| ${k} | ${kb(b)} |\n`;

  md += '\n## Capability / domain / result-flow / export-surface distributions (aggregated, all loaded apps)\n\n';
  md += '### Capability site counts\n\n| capability | sites |\n|---|---|\n';
  for (const [k, v] of Object.entries(s.distributions.capabilityCounts).sort((a: any, b: any) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
  md += '\n### Specifier/resolved-target domain tiers\n\n| tier | sites |\n|---|---|\n';
  for (const [k, v] of Object.entries(s.distributions.domainTiers).sort((a: any, b: any) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
  md += '\n### Result flow\n\n| kind | sites |\n|---|---|\n';
  for (const [k, v] of Object.entries(s.distributions.resultFlows).sort((a: any, b: any) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;
  md += `\n### Export-surface confidence\n\nclosed: ${s.distributions.exportSurface.closed}, open: ${s.distributions.exportSurface.open}\n\n`;
  md += '| open reason | modules |\n|---|---|\n';
  for (const [k, v] of Object.entries(s.distributions.exportSurface.openReasons).sort((a: any, b: any) => b[1] - a[1])) md += `| ${k} | ${v} |\n`;

  md += '\n## Analysis times\n\n| app | prepareMs | strictMs | gateOffMs | pairwiseMs | refinementsMs | totalMs |\n|---|---|---|---|---|---|---|\n';
  for (const t of s.analysisTimes.perApp) md += `| ${t.app} | ${t.prepareMs} | ${t.strictMs} | ${t.gateOffMs} | ${t.pairwiseMs} | ${t.refinementsMs} | ${t.totalMs} |\n`;
  md += `| **total** | ${s.analysisTimes.totals.prepareMs} | ${s.analysisTimes.totals.strictMs} | ${s.analysisTimes.totals.gateOffMs} | ${s.analysisTimes.totals.pairwiseMs} | ${s.analysisTimes.totals.refinementsMs} | ${s.analysisTimes.totals.totalMs} |\n`;
  md += `\nMedian per-app total analysis time: ${s.analysisTimes.medianTotalMs.toFixed(0)}ms.\n`;

  md += '\n## Widened-case counts (conservative-widening events recorded per app, strict config)\n\n| app | widened events |\n|---|---|\n';
  for (const w of s.widenedCaseCounts.perApp) md += `| ${w.app} | ${w.count} |\n`;
  md += `\nTotal widened-case log entries across the corpus: ${s.widenedCaseCounts.total}.\n`;

  return md;
}

main();
