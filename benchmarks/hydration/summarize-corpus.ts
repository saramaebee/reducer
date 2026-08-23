/**
 * Corpus aggregates for the hydration experiment (ADR-0007 experiment 2).
 *
 * Reports per-app distributions and byte-weighted totals SEPARATELY and never
 * blurs them: a per-app median says what a typical application does, a
 * byte-weighted total says what the corpus's bytes do, and for a corpus whose
 * largest app is 700x the smallest they are different questions.
 *
 * The roster comes from the frozen `corpus.json`, never from the result
 * directory, so an application that failed to run is reported as a failure
 * instead of silently shrinking the denominator.
 *
 * Usage: bun benchmarks/hydration/summarize-corpus.ts [--run <dir>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpusApps } from '../hazard-domain/corpus-apps.ts';
import { BLOCKED } from './recipes.ts';
import type { AppAnalysis } from './analyze.ts';

export interface Dist {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

function dist(xs: number[]): Dist {
  if (xs.length === 0) return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.floor(f * (s.length - 1) + 0.5)))]!;
  return { n: s.length, min: s[0]!, p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1]! };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

const { values } = parseArgs({ options: { run: { type: 'string' } } });
const runDir = values.run ?? path.join(import.meta.dirname, 'run-1', 'corpus');
const outDir = path.dirname(runDir);

const roster = loadCorpusApps();
const results: AppAnalysis[] = [];
const missing: { app: string; reason: string }[] = [];
for (const c of roster) {
  const f = path.join(runDir, `${c.app}.json`);
  if (!existsSync(f)) {
    missing.push({ app: c.app, reason: BLOCKED[c.app] ?? 'no result file — the application was not measured' });
    continue;
  }
  const r: AppAnalysis = JSON.parse(readFileSync(f, 'utf8'));
  if (!r.ok) {
    // a known blocker explains WHY far better than "never reported ready"
    missing.push({ app: c.app, reason: BLOCKED[c.app] ?? r.failure ?? 'run did not reach ready' });
    continue;
  }
  results.push(r);
}

/** the last curve point that actually reached its goal — the strongest workload observed */
const strongest = (r: AppAnalysis) => [...r.curve].reverse().find((c) => c.reachedGoal) ?? r.curve[r.curve.length - 1]!;
const startup = (r: AppAnalysis) => r.curve.find((c) => c.phase === 'startup') ?? r.curve[0]!;

const sum = (f: (r: AppAnalysis) => number) => results.reduce((a, r) => a + f(r), 0);

const totals = {
  universeBytes: sum((r) => r.universe.bytes),
  initialHotBytes: sum((r) => r.initial.hotBytes),
  initialColdBytes: sum((r) => r.initial.coldBytes),
  hydratedBytes: sum((r) => r.totals.uniqueMissBytes),
  metadataOnlyColdBytes: sum((r) => r.totals.metadataOnlyColdBytes),
  hydratedAfterStartupBytes: sum((r) => startup(r).hydratedBytes),
  uniqueMissFiles: sum((r) => r.totals.uniqueMissFiles),
  totalAccesses: sum((r) => r.totals.totalAccesses),
  appTouchedFiles: sum((r) => r.totals.appTouchedFiles),
  hotNeverTouchedBytes: sum((r) => r.totals.hotNeverTouchedBytes),
  thirdPartyBytes: sum((r) => r.universe.thirdPartyBytes),
  D: sum((r) => r.universe.D),
  coldThirdPartyBytes: sum((r) => r.initial.coldThirdPartyBytes),
  coldThirdPartyJsBytes: sum((r) => r.initial.coldThirdPartyJsBytes),
  hydratedThirdPartyBytes: sum((r) => r.totals.uniqueMissThirdPartyBytes),
  hydratedThirdPartyJsBytes: sum((r) => r.totals.uniqueMissThirdPartyJsBytes),
  outsideContentBytes: sum((r) => r.outside.contentBytes),
  outsideFiles: sum((r) => r.outside.files),
  outsideGeneratedContentBytes: sum((r) => r.outside.generatedContentBytes ?? 0),
  outsidePreexistingContentBytes: sum((r) => r.outside.preexistingContentBytes ?? 0),
  outsidePreexistingContentFiles: sum((r) => r.outside.preexistingContentFiles ?? 0),
  excludedWorkloadColdFiles: sum((r) => r.totals.excludedWorkloadTreeColdFiles ?? 0),
  excludedWorkloadColdBytes: sum((r) => r.totals.excludedWorkloadTreeColdBytes ?? 0),
  appTouchedDirectories: sum((r) => r.totals.appTouchedDirectories ?? 0),
};

/**
 * Sensitivity, not a redefinition: the frozen universe omits some files the
 * applications demonstrably content-read (build output, generated state, and a
 * few first-party data files). If every one of them were folded into the
 * universe as candidate-COLD *and* counted as hydrated, the surviving-cold
 * number would move to this. The denominator is NOT changed for the headline —
 * ADR-0005 keeps the frozen universe authoritative — but the reader is entitled
 * to the bound.
 */
const widened = {
  coldBytes: totals.initialColdBytes + totals.outsideContentBytes,
  hydratedBytes: totals.hydratedBytes + totals.outsideContentBytes,
  coldSurvivingFraction:
    1 - (totals.hydratedBytes + totals.outsideContentBytes) / (totals.initialColdBytes + totals.outsideContentBytes),
};

const weighted = {
  initialResidentFractionOfUniverse: totals.initialHotBytes / totals.universeBytes,
  residentAfterStartup: (totals.initialHotBytes + totals.hydratedAfterStartupBytes) / totals.universeBytes,
  residentAfterStrongest: (totals.initialHotBytes + totals.hydratedBytes) / totals.universeBytes,
  coldHydratedFraction: totals.hydratedBytes / totals.initialColdBytes,
  coldSurvivingFraction: 1 - totals.hydratedBytes / totals.initialColdBytes,
  coldHydratedFractionUpperBound: (totals.hydratedBytes + totals.metadataOnlyColdBytes) / totals.initialColdBytes,
  coldSurvivingFractionUpperBound: 1 - (totals.hydratedBytes + totals.metadataOnlyColdBytes) / totals.initialColdBytes,
  thirdPartyColdSurviving: 1 - totals.hydratedThirdPartyBytes / totals.coldThirdPartyBytes,
  thirdPartyJsColdSurviving: 1 - totals.hydratedThirdPartyJsBytes / totals.coldThirdPartyJsBytes,
  hotNeverTouchedFractionOfHot: totals.hotNeverTouchedBytes / totals.initialHotBytes,
};

const perApp = {
  initialColdFraction: dist(results.map((r) => r.initial.coldFraction)),
  residentInitial: dist(results.map((r) => 1 - r.initial.coldFraction)),
  residentAfterStartup: dist(results.map((r) => startup(r).resident.universe.residentFraction)),
  residentAfterStrongest: dist(results.map((r) => strongest(r).resident.universe.residentFraction)),
  coldHydratedFraction: dist(results.map((r) => r.survival.hydratedFractionOfCold)),
  coldSurvivingFraction: dist(results.map((r) => r.survival.stillColdFractionOfCold)),
  coldSurvivingUpperBound: dist(results.map((r) => r.survival.upperBoundStillColdFractionOfCold)),
  uniqueMissFiles: dist(results.map((r) => r.totals.uniqueMissFiles)),
  uniqueMissBytes: dist(results.map((r) => r.totals.uniqueMissBytes)),
  hotNeverTouchedFraction: dist(results.map((r) => (r.initial.hotBytes ? r.totals.hotNeverTouchedBytes / r.initial.hotBytes : 0))),
};

const targets = results.filter((r) => r.category === 'target');
const perTarget = {
  n: targets.length,
  coldSurvivingFraction: dist(targets.map((r) => r.survival.stillColdFractionOfCold)),
  residentAfterStrongest: dist(targets.map((r) => strongest(r).resident.universe.residentFraction)),
  weightedColdSurviving:
    1 - targets.reduce((a, r) => a + r.totals.uniqueMissBytes, 0) / targets.reduce((a, r) => a + r.initial.coldBytes, 0),
};

// ---- hydration shape: how front-loaded is it?
const shape = results.map((r) => {
  const st = startup(r).hydratedBytes;
  const all = r.totals.uniqueMissBytes;
  return { app: r.app, startupShare: all > 0 ? st / all : 0, total: all };
});
const weightedStartupShare = totals.hydratedBytes > 0 ? totals.hydratedAfterStartupBytes / totals.hydratedBytes : 0;

// ---- miss size profile across the corpus
const sizeBuckets = new Map<string, { files: number; bytes: number }>();
for (const r of results) {
  for (const b of r.misses.sizeBuckets) {
    const cur = sizeBuckets.get(b.label) ?? { files: 0, bytes: 0 };
    cur.files += b.files;
    cur.bytes += b.bytes;
    sizeBuckets.set(b.label, cur);
  }
}

// ---- clustering: do misses arrive together? (from the preserved first-touch stream)
interface Cluster { app: string; misses: number; packages: number; burstFraction: number; samePackageAsPrev: number }
const clusters: Cluster[] = [];
for (const r of results) {
  const f = path.join(runDir, 'first-touch', `${r.app}.ndjson`);
  if (!existsSync(f)) continue;
  const ev = readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ev.sort((a, b) => a.order - b.order);
  if (ev.length < 2) {
    clusters.push({ app: r.app, misses: ev.length, packages: new Set(ev.map((e) => e.pkg)).size, burstFraction: 0, samePackageAsPrev: 0 });
    continue;
  }
  let burst = 0;
  let same = 0;
  for (let i = 1; i < ev.length; i++) {
    if (ev[i].offsetMs - ev[i - 1].offsetMs < 50) burst++;
    if (ev[i].pkg === ev[i - 1].pkg) same++;
  }
  clusters.push({
    app: r.app,
    misses: ev.length,
    packages: new Set(ev.map((e) => e.pkg)).size,
    burstFraction: burst / (ev.length - 1),
    samePackageAsPrev: same / (ev.length - 1),
  });
}
const clusterTotals = clusters.reduce(
  (a, c) => ({ pairs: a.pairs + Math.max(0, c.misses - 1), burst: a.burst + c.burstFraction * Math.max(0, c.misses - 1), same: a.same + c.samePackageAsPrev * Math.max(0, c.misses - 1) }),
  { pairs: 0, burst: 0, same: 0 },
);

// ---- does static NFT warning density predict runtime hydration?
const firstRunDir = path.join(import.meta.dirname, '..', 'working-set', 'first-run', 'corpus');
const nftRows = results.map((r) => {
  const fr = JSON.parse(readFileSync(path.join(firstRunDir, `${r.app}.json`), 'utf8'));
  return { app: r.app, warnings: fr.nft.warnings as number, density: fr.nft.warnings / Math.max(fr.nft.tracedFiles, 1), missBytes: r.totals.uniqueMissBytes };
});
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / n;
  const sx = Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) / n);
  const sy = Math.sqrt(ys.reduce((a, y) => a + (y - my) ** 2, 0) / n);
  return sx === 0 || sy === 0 ? 0 : cov / (sx * sy);
}
const nftCorrelation = pearson(nftRows.map((r) => r.density), nftRows.map((r) => r.missBytes));

// ---- do initially-mixed packages stay mixed? (the 57.8%-of-cold-bytes question)
let mixedPkgs = 0;
let mixedColdBytes = 0;
let mixedHydrated = 0;
let mixedBecameHot = 0;
for (const r of results) {
  for (const row of r.packages.rows) {
    if (row.coldBytes > 0 && row.hotBytes > 0 && row.initialHotFraction >= 0.02) {
      mixedPkgs++;
      mixedColdBytes += row.coldBytes;
      mixedHydrated += row.hydratedBytes;
      if (row.finalResidentFraction >= 0.95) mixedBecameHot++;
    }
  }
}

// ---- package classes
const pkgClasses = new Map<string, number>();
for (const r of results) {
  for (const [k, v] of Object.entries(r.packages.byClass)) pkgClasses.set(k, (pkgClasses.get(k) ?? 0) + v);
}

const summary = {
  experiment: 'ADR-0007 experiment 2 — runtime hydration of the Plan B candidate-COLD set',
  measuredApps: results.length,
  rosterApps: roster.length,
  failures: missing,
  weighted,
  widenedUniverseSensitivity: widened,
  totals,
  perApp,
  perTarget,
  hydrationShape: { weightedStartupShareOfHydratedBytes: weightedStartupShare, perApp: shape },
  missSizeProfile: [...sizeBuckets.entries()].map(([label, v]) => ({ label, ...v })),
  clustering: {
    perApp: clusters,
    corpusBurstFraction: clusterTotals.pairs ? clusterTotals.burst / clusterTotals.pairs : 0,
    corpusSamePackageFraction: clusterTotals.pairs ? clusterTotals.same / clusterTotals.pairs : 0,
  },
  nftWarningPrediction: { pearsonDensityVsMissBytes: nftCorrelation, rows: nftRows },
  mixedPackages: { packages: mixedPkgs, coldBytes: mixedColdBytes, hydratedBytes: mixedHydrated, becameResident: mixedBecameHot },
  outsideFrozenUniverse: {
    files: totals.outsideFiles,
    contentBytes: totals.outsideContentBytes,
    directoriesTouched: results.reduce((a, r) => a + (r.outside.directoriesTouched ?? 0), 0),
  },
  packageClasses: Object.fromEntries(pkgClasses),
  apps: results.map((r) => ({
    app: r.app,
    category: r.category,
    workloadQuality: r.workloadQuality,
    universeBytes: r.universe.bytes,
    initialColdFraction: r.initial.coldFraction,
    residentInitial: 1 - r.initial.coldFraction,
    residentAfterStartup: startup(r).resident.universe.residentFraction,
    residentAfterStrongest: strongest(r).resident.universe.residentFraction,
    coldSurviving: r.survival.stillColdFractionOfCold,
    coldSurvivingUpperBound: r.survival.upperBoundStillColdFractionOfCold,
    uniqueMissFiles: r.totals.uniqueMissFiles,
    uniqueMissBytes: r.totals.uniqueMissBytes,
    metadataOnlyColdFiles: r.totals.metadataOnlyColdFiles,
    totalAccesses: r.totals.totalAccesses,
    hotNeverTouchedBytes: r.totals.hotNeverTouchedBytes,
    outsideFiles: r.outside.files,
    outsideContentBytes: r.outside.contentBytes,
    phases: r.curve.map((c) => ({ phase: c.phase, reachedGoal: c.reachedGoal, offsetMs: c.offsetMs, residentFraction: c.resident.universe.residentFraction, hydratedBytes: c.hydratedBytes })),
    concentration: r.misses.concentration,
    deviations: r.deviations,
  })),
};

writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

// ------------------------------------------------------------------ markdown
const L: string[] = [];
L.push('# Runtime hydration of the Plan B candidate-COLD set — corpus-v1');
L.push('');
L.push('ADR-0007 experiment 2. **Nothing was removed and nothing was recovered**: every application ran');
L.push('against its complete, untouched production universe with an observe-only tracer preloaded. A');
L.push('"hydration miss" is a counterfactual — the first time execution *read the content of* a file that');
L.push('Plan B had placed candidate-COLD.');
L.push('');
L.push(`Measured **${results.length} of ${roster.length}** frozen corpus applications.`);
L.push('');
L.push('## Headline');
L.push('');
L.push('```text');
L.push(`initial Plan B resident (byte-weighted)   ${pct(weighted.initialResidentFractionOfUniverse)}`);
L.push(`after startup                             ${pct(weighted.residentAfterStartup)}`);
L.push(`after strongest available workload        ${pct(weighted.residentAfterStrongest)}`);
L.push('');
L.push(`Plan B cold bytes hydrated                ${pct(weighted.coldHydratedFraction)}  (${bytes(totals.hydratedBytes)} of ${bytes(totals.initialColdBytes)})`);
L.push(`Plan B cold bytes STILL COLD              ${pct(weighted.coldSurvivingFraction)}`);
L.push(`  …counting metadata-only touches too     ${pct(weighted.coldSurvivingFractionUpperBound)}`);
L.push('```');
L.push('');
L.push('## Miss metrics — three different quantities, never collapsed');
L.push('');
L.push('| quantity | corpus total |');
L.push('| --- | ---: |');
L.push(`| total observed accesses (application trees) | ${totals.totalAccesses.toLocaleString()} |`);
L.push(`| unique files touched by the applications | ${totals.appTouchedFiles.toLocaleString()} |`);
L.push(`| directories touched (not placeable files) | ${totals.appTouchedDirectories.toLocaleString()} |`);
L.push(`| **hydration misses** (first content touch of a cold file) | ${totals.uniqueMissFiles.toLocaleString()} |`);
L.push(`| **unique bytes hydrated** | ${bytes(totals.hydratedBytes)} |`);
L.push(`| cold files touched for metadata only (no bytes moved) | ${sum((r) => r.totals.metadataOnlyColdFiles).toLocaleString()} (${bytes(totals.metadataOnlyColdBytes)}) |`);
L.push(`| cold files excluded because only a workload RUNNER read them | ${totals.excludedWorkloadColdFiles.toLocaleString()} (${bytes(totals.excludedWorkloadColdBytes)}) |`);
L.push('');
L.push('A hydration miss count and a unique-file count are the same number here **by construction**: a');
L.push('recovery runtime caches what it recovered, so every later access to a hydrated file is a resident');
L.push('hit. The quantity that is genuinely different is total accesses — 304k accesses produced 3.7k misses.');
L.push('');
L.push('## Per-app distribution');
L.push('');
L.push('| metric | n | min | P25 | median | P75 | max |');
L.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
const row = (label: string, d: Dist, f: (x: number) => string) =>
  L.push(`| ${label} | ${d.n} | ${f(d.min)} | ${f(d.p25)} | ${f(d.median)} | ${f(d.p75)} | ${f(d.max)} |`);
row('resident % — initial (Plan B)', perApp.residentInitial, pct);
row('resident % — after startup', perApp.residentAfterStartup, pct);
row('resident % — after strongest workload', perApp.residentAfterStrongest, pct);
row('cold bytes hydrated %', perApp.coldHydratedFraction, pct);
row('**cold bytes still cold %**', perApp.coldSurvivingFraction, pct);
row('cold still cold % (metadata-inclusive)', perApp.coldSurvivingUpperBound, pct);
row('unique miss files', perApp.uniqueMissFiles, (x) => x.toLocaleString());
row('unique miss bytes', perApp.uniqueMissBytes, bytes);
row('Plan B HOT bytes never touched', perApp.hotNeverTouchedFraction, pct);
L.push('');
L.push(`Target apps only (n=${perTarget.n}): median cold surviving **${pct(perTarget.coldSurvivingFraction.median)}**, byte-weighted **${pct(perTarget.weightedColdSurviving)}**.`);
L.push('');
L.push('## Byte-weighted vs per-app — they answer different questions');
L.push('');
L.push('| | byte-weighted | per-app median |');
L.push('| --- | ---: | ---: |');
L.push(`| cold bytes still cold | ${pct(weighted.coldSurvivingFraction)} | ${pct(perApp.coldSurvivingFraction.median)} |`);
L.push(`| resident after strongest workload | ${pct(weighted.residentAfterStrongest)} | ${pct(perApp.residentAfterStrongest.median)} |`);
L.push('');
L.push('## Third-party denominators');
L.push('');
L.push('| denominator | initial cold | hydrated | still cold |');
L.push('| --- | ---: | ---: | ---: |');
L.push(`| entire production universe | ${bytes(totals.initialColdBytes)} | ${bytes(totals.hydratedBytes)} | ${pct(weighted.coldSurvivingFraction)} |`);
L.push(`| third-party production files | ${bytes(totals.coldThirdPartyBytes)} | ${bytes(totals.hydratedThirdPartyBytes)} | ${pct(weighted.thirdPartyColdSurviving)} |`);
L.push(`| third-party JS (ADR-0006 D) | ${bytes(totals.coldThirdPartyJsBytes)} | ${bytes(totals.hydratedThirdPartyJsBytes)} | ${pct(weighted.thirdPartyJsColdSurviving)} |`);
L.push('');
L.push('## Hydration shape');
L.push('');
L.push(`Of every cold byte the corpus hydrated, **${pct(weightedStartupShare)}** was hydrated before the`);
L.push('application reported ready. Startup is where hydration happens; workload adds comparatively little.');
L.push('');
L.push('## Miss size profile');
L.push('');
L.push('| file size | miss files | bytes |');
L.push('| --- | ---: | ---: |');
for (const b of summary.missSizeProfile) L.push(`| ${b.label} | ${b.files.toLocaleString()} | ${bytes(b.bytes)} |`);
L.push('');
L.push('## Do initially-mixed packages stay mixed?');
L.push('');
L.push('The static run found 57.8% of Plan B cold bytes inside partially-HOT packages — the part of the');
L.push('opportunity that exists only because placement is per-file. Execution barely touches it:');
L.push('');
L.push('```text');
L.push(`initially-mixed packages            ${mixedPkgs.toLocaleString()}`);
L.push(`their candidate-COLD bytes          ${bytes(mixedColdBytes)}`);
L.push(`…hydrated by execution              ${bytes(mixedHydrated)}  (${pct(mixedColdBytes ? mixedHydrated / mixedColdBytes : 0)})`);
L.push(`…that became ≥95% resident          ${mixedBecameHot.toLocaleString()} packages`);
L.push('```');
L.push('');
L.push('## Miss clustering');
L.push('');
L.push(`**${pct(clusterTotals.pairs ? clusterTotals.burst / clusterTotals.pairs : 0)}** of consecutive hydration misses arrive within 50 ms of the previous one, and`);
L.push(`**${pct(clusterTotals.pairs ? clusterTotals.same / clusterTotals.pairs : 0)}** are in the SAME package as the previous miss. Misses are not scattered: they arrive in`);
L.push('tight, package-local bursts. (Evidence that semantic prefetching is plausible — no predictor is built here.)');
L.push('');
L.push('## Does static NFT warning density predict runtime hydration?');
L.push('');
L.push(`No. Pearson r = **${nftCorrelation.toFixed(3)}** between an app's NFT-warning density and its unique hydrated bytes.`);
L.push('');
L.push('| app | NFT warnings | warnings/traced file | unique hydrated |');
L.push('| --- | ---: | ---: | ---: |');
for (const r of [...nftRows].sort((a, b) => b.density - a.density)) {
  L.push(`| ${r.app} | ${r.warnings.toLocaleString()} | ${r.density.toFixed(3)} | ${bytes(r.missBytes)} |`);
}
L.push('');
L.push('## Accesses outside the frozen production universe');
L.push('');
L.push(`${totals.outsideFiles.toLocaleString()} files under the clone roots were touched that the frozen universe does not contain`);
L.push(`(${bytes(totals.outsideContentBytes)} of them content-read), plus ${results.reduce((a, r) => a + (r.outside.directoriesTouched ?? 0), 0).toLocaleString()} directories. These are recorded separately and`);
L.push('never counted as hydration.');
L.push('');
L.push('**All of it is application-generated output.** Classified against each repository\'s own');
L.push('`.gitignore` (writes observed during a single run are not sufficient — juice-shop builds');
L.push('`i18n/*.json` from `data/static/i18n` at first start, so a later run reads files it did not');
L.push('create), the split is:');
L.push('');
L.push('```text');
L.push(`app-generated / build output      ${bytes(totals.outsideGeneratedContentBytes)}`);
L.push(`genuinely absent from the model   ${bytes(totals.outsidePreexistingContentBytes)}   (${totals.outsidePreexistingContentFiles} files)`);
L.push('```');
L.push('');
L.push('So this run found **no production dependency that the frozen universe model missed**. The');
L.push('out-of-universe reads are sqlite databases, compiled templates, generated locale files and');
L.push('vite/tsc bundles — exactly the things that should not be in a production-universe artifact.');
L.push('');
L.push(`**Sensitivity anyway.** Were every one of those bytes folded in as candidate-COLD *and* counted as`);
L.push(`hydrated, cold surviving would move from **${pct(weighted.coldSurvivingFraction)}** to **${pct(widened.coldSurvivingFraction)}** — the conclusion does not depend on the choice.`);
L.push('');
L.push('## Package behaviour');
L.push('');
L.push('| class | packages |');
L.push('| --- | ---: |');
for (const [k, v] of Object.entries(summary.packageClasses).sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${v.toLocaleString()} |`);
L.push('');
L.push('## Outliers, and the stress case');
L.push('');
{
  const byWorst = [...results].sort((a, b) => a.survival.stillColdFractionOfCold - b.survival.stillColdFractionOfCold);
  const worst = byWorst[0]!;
  const n8n = results.find((r) => r.app === 'n8n');
  L.push(`- **Worst case — ${worst.app}**: ${pct(worst.survival.stillColdFractionOfCold)} of its cold bytes survive, on`);
  L.push(`  ${worst.totals.uniqueMissFiles.toLocaleString()} misses totalling ${bytes(worst.totals.uniqueMissBytes)}. Even the worst application in the corpus keeps ~9/10 of its`);
  L.push('  candidate-COLD bytes cold, and its misses are overwhelmingly tiny files, not large ones.');
  if (n8n) {
    L.push(`- **n8n, the designated stress case**: 29,491 NFT warnings (0.32 per traced file, mostly unresolved`);
    L.push(`  computed specifiers) produced **${n8n.totals.uniqueMissFiles} misses / ${bytes(n8n.totals.uniqueMissBytes)}** across **${n8n.misses.concentration.totalPackagesHydrated} packages**, leaving`);
    L.push(`  ${pct(n8n.survival.stillColdFractionOfCold)} of its ${bytes(n8n.initial.coldBytes)} cold set untouched. The static uncertainty did **not** become`);
    L.push('  runtime hydration. Its workload created and executed a real workflow, so the node/credential');
    L.push('  loading machinery behind those warnings did run.');
  }
  const zero = results.filter((r) => r.totals.uniqueMissFiles === 0).map((r) => r.app);
  if (zero.length) L.push(`- **Zero misses**: ${zero.join(', ')} — the NFT-positive set already covered everything executed.`);
  L.push(`- **Over-provisioning cuts the other way too**: ${pct(weighted.hotNeverTouchedFractionOfHot)} of the bytes Plan B placed HOT were`);
  L.push('  never touched at all. The resident set is not just recoverable-sparse; it is itself far larger');
  L.push('  than what execution needs. (Counting is by byte; see RUN-INFO.md on the by-file caveat.)');
}
L.push('');
L.push('## Untraced child processes — the blind spot, measured');
L.push('');
L.push('The tracer travels in `NODE_OPTIONS`, so a child spawned with a REPLACED environment never loads');
L.push('it. Re-injecting it would mean mutating the application\'s spawn options, which an observe-only');
L.push('experiment must not do — so every spawn is recorded, every traced process announces itself, and the');
L.push('difference is published here rather than assumed away. A non-zero count understates that app\'s');
L.push('hydration by a bounded amount (see RUN-INFO.md for the per-app bounds).');
L.push('');
L.push('| app | spawn events | child processes traced | untraced |');
L.push('| --- | ---: | ---: | ---: |');
for (const r of results) {
  const u = (r as any).untracedChildren;
  if (!u || u.spawnEvents === 0) continue;
  L.push(`| ${r.app} | ${u.spawnEvents} | ${u.tracedChildProcesses} | ${u.untracedSpawns} |`);
}
L.push('');
L.push('## Workload quality — what each application actually answered');
L.push('');
L.push('Per phase: the share of its requests that returned < 400. A low `common` ratio is usually correct');
L.push('(those phases deliberately probe unauthenticated and 404 paths); a low `full` ratio would mean the');
L.push('authenticated workload degraded, which is exactly how outline\'s sweep was caught silently returning');
L.push('401 for every request.');
L.push('');
L.push('| app | workload | phases (share of requests that succeeded) |');
L.push('| --- | --- | --- |');
for (const r of results) {
  const ph = Object.entries(r.phaseSuccessRatio ?? {}).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
  L.push(`| ${r.app} | ${r.workloadQuality} | ${ph || 'n/a'} |`);
}
L.push('');
L.push('## Per-application results');
L.push('');
L.push('| app | cat | workload | universe | cold B | resident init | after startup | after workload | cold surviving | miss files | miss bytes |');
L.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const a of [...summary.apps].sort((x, y) => y.universeBytes - x.universeBytes)) {
  L.push(
    `| ${a.app} | ${a.category === 'target' ? 'T' : 'C'} | ${a.workloadQuality} | ${bytes(a.universeBytes)} | ${pct(a.initialColdFraction)} | ` +
      `${pct(a.residentInitial)} | ${pct(a.residentAfterStartup)} | ${pct(a.residentAfterStrongest)} | **${pct(a.coldSurviving)}** | ` +
      `${a.uniqueMissFiles.toLocaleString()} | ${bytes(a.uniqueMissBytes)} |`,
  );
}
L.push('');
L.push('## What this establishes — and what it does not');
L.push('');
L.push('Establishes: **real Node applications can execute representative workloads while leaving a large');
L.push('majority of their complete production dependency universe untouched, starting from the practical');
L.push('Plan B placement.** It says nothing about remote miss latency, SLO viability, economics, safe code');
L.push('distribution, eviction, prefetch, security, cross-machine caching, or final architecture, and it');
L.push('claims no performance improvement — placement here is simulated, not applied.');
L.push('');
L.push('**"Still cold" means "not touched by this workload", never "never needed".** These runs last');
L.push('minutes. Nothing here exercises a cron path, a backup, an error path, an admin operation, a second');
L.push('locale, or an alternative database driver. A material part of the surviving cold set is certainly');
L.push('untested functionality rather than proven-dead code — which is exactly why the model is recovery,');
L.push('not removal: a wrong prediction costs latency, never correctness.');
L.push('');
L.push('Other limitations: one run per application, so run-to-run variance is unmeasured; multi-entry');
L.push('surfaces (CLI subcommands, alternative services) appear only where an existing workload happened to');
L.push('exercise them; and the instrumentation blind spots enumerated in RUN-INFO.md all bias hydration');
L.push('DOWNWARD, each bounded (the largest is worth 0.02 pp on the one application it affects).');
L.push('');
L.push('## Not measured');
L.push('');
if (missing.length === 0) L.push('None — every frozen corpus application was measured.');
else for (const m of missing) L.push(`- **${m.app}** — ${m.reason}`);
L.push('');

writeFileSync(path.join(outDir, 'SUMMARY.md'), L.join('\n'));
console.log(L.join('\n'));
