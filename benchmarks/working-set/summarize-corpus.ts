/**
 * Aggregates `first-run/corpus/*.json` into `first-run/summary.json` and a
 * human-readable `first-run/SUMMARY.md`.
 *
 * Two aggregate views are kept strictly separate, because they answer
 * different questions and disagree:
 *
 *  - the PER-APP distribution (min/P25/median/P75/max) treats a 30 MB app and
 *    a 2 GB app equally — "is the effect consistent across real applications?"
 *  - the BYTE-WEIGHTED corpus aggregate, Σcold / Σtotal — "how much byte
 *    opportunity is there in total?"
 *
 * Apps whose NFT trace failed produce a fail-safe all-HOT plan. That is an
 * infrastructure failure, not a measured 0% cold result, so they are excluded
 * from every statistic and reported separately.
 *
 * Usage: bun benchmarks/working-set/summarize-corpus.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadCorpusApps } from '../hazard-domain/corpus-apps.ts';
import { DENOMINATORS, type Denominator } from './measure.ts';
import type { AppResult } from './run-corpus.ts';

const RUN_DIR = path.join(import.meta.dirname, 'first-run');
const CORPUS_DIR = path.join(RUN_DIR, 'corpus');

const DENOM_LABEL: Record<Denominator, string> = {
  universe: 'entire production universe',
  thirdParty: 'third-party production files',
  thirdPartyJs: 'third-party JS (ADR-0006 D)',
};

interface Dist {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

function dist(xs: number[]): Dist {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number): number => {
    if (s.length === 0) return 0;
    const i = (s.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
  };
  return { n: s.length, min: q(0), p25: q(0.25), median: q(0.5), p75: q(0.75), max: q(1) };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const bytes = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(1)} KB`;

function main(): void {
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const all: AppResult[] = files.map((f) => JSON.parse(readFileSync(path.join(CORPUS_DIR, f), 'utf8')));

  // The roster is the FROZEN corpus, never the directory listing. An app that
  // never ran — an interrupted sweep, a killed parent, a crash before the
  // failure stub was written — would otherwise be invisible: not measured, not
  // failed, and silently absent from the denominator of every statistic while
  // the summary claimed full coverage. The apps that go missing that way are
  // exactly the largest and most hazardous ones, so the bias is not random.
  const roster = loadCorpusApps();
  const present = new Set(all.map((a) => a.app));
  const missing = roster.filter((c) => !present.has(c.app));

  const failed = all.filter((a) => a.status !== 'ok');
  const noEvidence = all.filter((a) => a.status === 'ok' && !a.planAValid);
  const measured = all.filter((a) => a.status === 'ok' && a.planAValid && a.planBValid);
  const targets = measured.filter((a) => a.category === 'target');

  const perApp = (set: AppResult[], plan: 'planA' | 'planB', d: Denominator): number[] =>
    set.map((a) => a[plan].denominators[d].coldFraction);
  const weighted = (set: AppResult[], plan: 'planA' | 'planB', d: Denominator): number => {
    const total = sum(set.map((a) => a[plan].denominators[d].bytes));
    return total > 0 ? sum(set.map((a) => a[plan].denominators[d].coldBytes)) / total : 0;
  };

  const distributions: Record<string, Dist> = {};
  const weightedAgg: Record<string, number> = {};
  for (const plan of ['planA', 'planB'] as const) {
    for (const d of DENOMINATORS) {
      distributions[`${plan}.${d}.allApps`] = dist(perApp(measured, plan, d));
      distributions[`${plan}.${d}.targets`] = dist(perApp(targets, plan, d));
      weightedAgg[`${plan}.${d}.allApps`] = weighted(measured, plan, d);
      weightedAgg[`${plan}.${d}.targets`] = weighted(targets, plan, d);
    }
  }

  // ---- plan A -> plan B opportunity loss
  const lossPerApp = measured.map((a) => ({
    app: a.app,
    category: a.category,
    ...Object.fromEntries(DENOMINATORS.map((d) => [d, a.comparison[d]!])),
  }));
  const lossAgg: Record<string, { planAColdBytes: number; planBColdBytes: number; lostBytes: number; lostFraction: number }> =
    {};
  for (const d of DENOMINATORS) {
    const a = sum(measured.map((x) => x.comparison[d]!.planAColdBytes));
    const b = sum(measured.map((x) => x.comparison[d]!.planBColdBytes));
    lossAgg[d] = { planAColdBytes: a, planBColdBytes: b, lostBytes: a - b, lostFraction: a > 0 ? (a - b) / a : 0 };
  }
  const lossDist = dist(measured.map((a) => a.comparison.universe!.lostFraction));

  // ---- HOT bytes by reason (corpus-summed, marginal attribution)
  const reasonTotals: Record<string, Record<string, number>> = { planA: {}, planB: {} };
  for (const plan of ['planA', 'planB'] as const) {
    for (const a of measured) {
      for (const [r, v] of Object.entries(a[plan].reasons.attributed)) {
        reasonTotals[plan]![r] = (reasonTotals[plan]![r] ?? 0) + v;
      }
    }
  }

  // ---- what made plan B's forced-hot packages opaque
  const opaqueEvidenceBytes: Record<string, { packages: number; files: number; forcedHotBytes: number }> = {};
  for (const a of measured) {
    for (const [ev, b] of Object.entries(a.opaqueCost.byEvidence)) {
      const t = (opaqueEvidenceBytes[ev] ??= { packages: 0, files: 0, forcedHotBytes: 0 });
      t.packages += b.packages;
      t.files += b.files;
      t.forcedHotBytes += b.forcedHotBytes;
    }
  }

  // ---- the app's OWN root package being marked opaque
  // A distinct cause worth separating from "a dependency ships a native
  // artifact": when the ROOT package is opaque, every first-party file the app
  // owns is forced hot at once. `opaquePackages` scans a package's own tree
  // skipping only nested `node_modules`, so one `.wasm` anywhere in a monorepo
  // — or a build script in the root manifest — marks the whole application.
  // Computed from the persisted per-package stats, so it is exact rather than
  // limited to each app's top-25 opaque list.
  const rootCost = measured
    .map((a) => {
      const A = a.planA.packages.stats.find((s) => s.dir === '.');
      const B = a.planB.packages.stats.find((s) => s.dir === '.');
      const lost = A && B ? A.coldBytes - B.coldBytes : 0;
      return {
        app: a.app,
        lostBytes: lost,
        evidence: a.opaqueCost.topPackages.find((p) => p.dir === '.')?.evidence ?? 'unknown',
      };
    })
    .filter((x) => x.lostBytes > 0)
    .sort((x, y) => y.lostBytes - x.lostBytes);
  const rootCostTotal = sum(rootCost.map((x) => x.lostBytes));

  // ---- package structure
  const packageStructure = measured.map((a) => ({
    app: a.app,
    planA: pkgCounts(a, 'planA'),
    planB: pkgCounts(a, 'planB'),
  }));

  // ---- does file-level virtualization actually beat package-level?
  // Split plan B's cold bytes by the granularity that could reach them: bytes
  // inside a wholly-cold package (a package-granularity virtualizer gets those
  // too) vs bytes inside a package that is only PARTLY cold (only file-level
  // placement reaches those). `package.json` is excluded from the class, so a
  // "wholly cold" package still ships its manifest.
  const granularityPerApp = measured.map((a) => {
    let wholePackage = 0;
    let fileLevelOnly = 0;
    for (const s of a.planB.packages.stats) {
      if (s.classNonMeta === 'all-cold') wholePackage += s.coldBytes;
      else if (s.classNonMeta === 'mixed') fileLevelOnly += s.coldBytes;
    }
    const total = wholePackage + fileLevelOnly;
    return {
      app: a.app,
      wholePackageColdBytes: wholePackage,
      fileLevelOnlyColdBytes: fileLevelOnly,
      fileLevelOnlyShare: total > 0 ? fileLevelOnly / total : 0,
    };
  });
  const granularity = {
    perApp: granularityPerApp,
    wholePackageColdBytes: sum(granularityPerApp.map((g) => g.wholePackageColdBytes)),
    fileLevelOnlyColdBytes: sum(granularityPerApp.map((g) => g.fileLevelOnlyColdBytes)),
    fileLevelOnlyShare: 0,
    shareDistribution: dist(granularityPerApp.map((g) => g.fileLevelOnlyShare)),
  };
  granularity.fileLevelOnlyShare =
    granularity.wholePackageColdBytes + granularity.fileLevelOnlyColdBytes > 0
      ? granularity.fileLevelOnlyColdBytes / (granularity.wholePackageColdBytes + granularity.fileLevelOnlyColdBytes)
      : 0;
  const topColdPackages = measured
    .flatMap((a) => a.planB.packages.stats.filter((s) => s.classNonMeta === 'all-cold').map((s) => ({ app: a.app, ...s })))
    .sort((x, y) => y.coldBytes - x.coldBytes)
    .slice(0, 30);
  const topMixedPackages = measured
    .flatMap((a) => a.planB.packages.stats.filter((s) => s.classNonMeta === 'mixed').map((s) => ({ app: a.app, ...s })))
    .sort((x, y) => y.coldBytes - x.coldBytes)
    .slice(0, 30);

  const summary = {
    experiment: 'initial working-set placement measurement (ADR-0007 experiment 1)',
    corpus: 'corpus-v1 (frozen, 19 pinned applications)',
    apps: {
      total: roster.length,
      measured: measured.length,
      targets: targets.length,
      noEvidence: noEvidence.length,
      failed: failed.length,
      missing: missing.length,
    },
    failures: [
      ...failed.map((a) => ({ app: a.app, category: a.category, kind: 'failed' as const, reason: a.failure })),
      ...missing.map((c) => ({
        app: c.app,
        category: c.category,
        kind: 'no-result' as const,
        reason: 'no result file — the app was never run or the run was interrupted; NOT a measured value',
      })),
      ...noEvidence.map((a) => ({
        app: a.app,
        category: a.category,
        kind: 'no-positive-evidence' as const,
        reason: 'NFT trace unavailable; plan is fail-safe all-HOT and predicts nothing (NOT a measured 0% cold result)',
      })),
    ],
    perAppDistribution: distributions,
    byteWeighted: weightedAgg,
    planAtoB: { perApp: lossPerApp, aggregate: lossAgg, lostFractionDistribution: lossDist },
    hotBytesByReason: reasonTotals,
    opaqueEvidence: opaqueEvidenceBytes,
    firstPartyRootOpaque: { totalLostBytes: rootCostTotal, perApp: rootCost },
    packageStructure,
    granularity,
    topColdPackages,
    topMixedPackages,
    perApp: measured.map((a) => ({
      app: a.app,
      category: a.category,
      sha: a.sha,
      universeBytes: a.universe.bytes,
      universeFiles: a.universe.files,
      packages: a.planA.packages.total,
      D: a.universe.D,
      planA: Object.fromEntries(DENOMINATORS.map((d) => [d, a.planA.denominators[d]])),
      planB: Object.fromEntries(DENOMINATORS.map((d) => [d, a.planB.denominators[d]])),
    })),
  };
  writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(RUN_DIR, 'SUMMARY.md'), markdown(summary, measured, targets, all));
  console.log(
    `measured ${measured.length}/${all.length} apps; ` +
      `universe cold — plan A median ${pct(distributions['planA.universe.allApps']!.median)}, ` +
      `plan B median ${pct(distributions['planB.universe.allApps']!.median)}; ` +
      `byte-weighted A ${pct(weightedAgg['planA.universe.allApps']!)} / B ${pct(weightedAgg['planB.universe.allApps']!)}`,
  );
}

function pkgCounts(a: AppResult, plan: 'planA' | 'planB') {
  const p = a[plan].packages;
  return {
    total: p.total,
    allHot: p.allHot,
    mixed: p.mixed,
    allCold: p.allCold,
    allHotNonMeta: p.allHotNonMeta,
    mixedNonMeta: p.mixedNonMeta,
    allColdNonMeta: p.allColdNonMeta,
    hotFiles: a[plan].denominators.universe.hotFiles,
    coldFiles: a[plan].denominators.universe.coldFiles,
  };
}

function markdown(s: ReturnType<typeof Object.assign> & any, measured: AppResult[], targets: AppResult[], all: AppResult[]): string {
  const L: string[] = [];
  const row = (cells: (string | number)[]) => L.push(`| ${cells.join(' | ')} |`);

  L.push('# Initial working-set measurement — corpus-v1 first run');
  L.push('');
  L.push('ADR-0007 experiment 1. **`COLD` means only "not selected for initial local placement."**');
  L.push('It does not mean dead, unused, unreachable, or removable. Nothing here demonstrates runtime');
  L.push('recoverability, miss latency, startup improvement, or production correctness.');
  L.push('');
  L.push(
    `Measured **${measured.length} of ${s.apps.total}** frozen corpus applications ` +
      `(${targets.length} target, ${measured.length - targets.length} control).`,
  );
  L.push('');

  L.push('## Plans');
  L.push('');
  L.push('```text');
  L.push('Plan A  NFT-positive + entrypoint + resolver metadata -> HOT, everything else candidate COLD');
  L.push('        (no hazard widening: dynamic require / createRequire / escaped loaders / vm /');
  L.push('         generated source / unbounded sinks do NOT expand the hot set)');
  L.push('Plan B  Plan A + every opaquePackages(universe).own package forced HOT');
  L.push('');
  L.push('Universe -> Plan A  = intrinsic working-set opportunity');
  L.push('Plan A   -> Plan B  = opportunity consumed by current implementation constraints');
  L.push('```');
  L.push('');

  for (const scope of ['allApps', 'targets'] as const) {
    L.push(`## Candidate-COLD fraction — per-app distribution (${scope === 'targets' ? 'target apps only' : 'all measured apps'})`);
    L.push('');
    row(['denominator', 'plan', 'n', 'min', 'P25', 'median', 'P75', 'max']);
    row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:']);
    for (const d of DENOMINATORS) {
      for (const plan of ['planA', 'planB'] as const) {
        const x: Dist = s.perAppDistribution[`${plan}.${d}.${scope}`];
        const cell = (v: number) => (x.n === 0 ? 'n/a' : pct(v));
        row([DENOM_LABEL[d], plan === 'planA' ? 'A' : 'B', x.n, cell(x.min), cell(x.p25), cell(x.median), cell(x.p75), cell(x.max)]);
      }
    }
    L.push('');
  }

  L.push('## Candidate-COLD fraction — byte-weighted corpus aggregate');
  L.push('');
  L.push('`sum(candidate-COLD bytes) / sum(universe bytes)` — a big app counts more than a small one.');
  L.push('');
  row(['denominator', 'plan A', 'plan B', 'plan A (targets)', 'plan B (targets)']);
  row(['---', '---:', '---:', '---:', '---:']);
  for (const d of DENOMINATORS) {
    row([
      DENOM_LABEL[d],
      pct(s.byteWeighted[`planA.${d}.allApps`]),
      pct(s.byteWeighted[`planB.${d}.allApps`]),
      pct(s.byteWeighted[`planA.${d}.targets`]),
      pct(s.byteWeighted[`planB.${d}.targets`]),
    ]);
  }
  L.push('');

  L.push('## Plan A → Plan B: opportunity consumed by current constraints');
  L.push('');
  row(['denominator', 'plan A cold', 'plan B cold', 'lost', 'lost % of A']);
  row(['---', '---:', '---:', '---:', '---:']);
  for (const d of DENOMINATORS) {
    const x = s.planAtoB.aggregate[d];
    row([DENOM_LABEL[d], bytes(x.planAColdBytes), bytes(x.planBColdBytes), bytes(x.lostBytes), pct(x.lostFraction)]);
  }
  L.push('');
  L.push(
    `Per-app loss (universe denominator): min ${pct(s.planAtoB.lostFractionDistribution.min)}, ` +
      `median ${pct(s.planAtoB.lostFractionDistribution.median)}, max ${pct(s.planAtoB.lostFractionDistribution.max)}.`,
  );
  L.push('');

  L.push('## HOT bytes by reason (marginal attribution)');
  L.push('');
  L.push('Each byte is charged to exactly one reason — the first one it carries in the order below —');
  L.push('so a reason\'s total is the bytes it forces hot that no earlier reason already would.');
  L.push('`opaque-boundary` is last, so its total IS the Plan A → Plan B loss.');
  L.push('');
  row(['reason', 'plan A', 'plan B']);
  row(['---', '---:', '---:']);
  for (const r of ['nft-positive', 'entrypoint', 'resolver-metadata', 'opaque-boundary', 'no-positive-evidence']) {
    row([r, bytes(s.hotBytesByReason.planA[r] ?? 0), bytes(s.hotBytesByReason.planB[r] ?? 0)]);
  }
  L.push('');

  L.push('## What actually made Plan B force those packages hot');
  L.push('');
  L.push('`opaquePackages().own` marks a package on any of five very different facts. Classified here');
  L.push('(never refined — that is out of scope for this run) so the dominant cause is visible.');
  L.push('Artifact evidence wins over the install-script proxy, so `install-script` counts only packages');
  L.push('where the script is the SOLE signal.');
  L.push('');
  row(['evidence', 'packages', 'files', 'forced-HOT bytes', '% of total loss']);
  row(['---', '---:', '---:', '---:', '---:']);
  const lossTotal: number = s.planAtoB.aggregate.universe.lostBytes;
  for (const [ev, b] of Object.entries(s.opaqueEvidence as Record<string, any>).sort(
    (a, c) => c[1].forcedHotBytes - a[1].forcedHotBytes,
  )) {
    row([ev, b.packages, b.files, bytes(b.forcedHotBytes), lossTotal > 0 ? pct(b.forcedHotBytes / lossTotal) : 'n/a']);
  }
  L.push('');

  const rootTotal: number = s.firstPartyRootOpaque.totalLostBytes;
  if (rootTotal > 0) {
    L.push('### …of which: the application\'s OWN root package');
    L.push('');
    L.push('A separate cause from "a dependency ships a native artifact". When the ROOT package is');
    L.push('marked opaque, every first-party file the application owns is forced hot at once — one `.wasm`');
    L.push('anywhere in a monorepo outside `node_modules`, or a build script in the root manifest, is enough.');
    L.push('');
    row(['app', 'evidence', 'forced-HOT bytes', '% of total loss']);
    row(['---', '---', '---:', '---:']);
    for (const r of s.firstPartyRootOpaque.perApp) {
      row([r.app, r.evidence, bytes(r.lostBytes), lossTotal > 0 ? pct(r.lostBytes / lossTotal) : 'n/a']);
    }
    L.push('');
    L.push(
      `**${bytes(rootTotal)} — ${lossTotal > 0 ? pct(rootTotal / lossTotal) : 'n/a'} of the entire Plan A → Plan B loss ` +
        'is first-party application code**, forced hot because the app\'s own root package tripped a heuristic ' +
        'aimed at native dependencies.',
    );
    L.push('');
  }

  L.push('## Per-application results');
  L.push('');
  row(['app', 'cat', 'universe', 'files', 'pkgs', 'cold A', 'cold B', '3p-JS cold A', '3p-JS cold B']);
  row(['---', '---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']);
  for (const a of [...measured].sort((x, y) => y.universe.bytes - x.universe.bytes)) {
    row([
      a.app,
      a.category === 'target' ? 'T' : 'C',
      bytes(a.universe.bytes),
      a.universe.files,
      a.planA.packages.total,
      pct(a.planA.denominators.universe.coldFraction),
      pct(a.planB.denominators.universe.coldFraction),
      pct(a.planA.denominators.thirdPartyJs.coldFraction),
      pct(a.planB.denominators.thirdPartyJs.coldFraction),
    ]);
  }
  L.push('');

  L.push('## Package structure (Plan B)');
  L.push('');
  L.push('`package.json` is forced hot in every package as resolver metadata, so the plan-faithful');
  L.push('classification calls almost every package "mixed" and answers nothing. The `non-meta` columns');
  L.push('exclude manifests and are the ones that distinguish package-level from file-level opportunity:');
  L.push('`all-cold (non-meta)` is what a package-granularity virtualizer would also have caught.');
  L.push('');
  row(['app', 'pkgs', 'all-hot', 'mixed', 'all-cold', 'all-hot (non-meta)', 'mixed (non-meta)', 'all-cold (non-meta)']);
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']);
  for (const p of s.packageStructure) {
    row([
      p.app,
      p.planB.total,
      p.planB.allHot,
      p.planB.mixed,
      p.planB.allCold,
      p.planB.allHotNonMeta,
      p.planB.mixedNonMeta,
      p.planB.allColdNonMeta,
    ]);
  }
  L.push('');

  L.push('### File-level vs package-level opportunity (Plan B)');
  L.push('');
  L.push('How much of the cold opportunity a package-granularity virtualizer would ALSO reach, versus');
  L.push('the part that exists only because placement is per-file.');
  L.push('');
  row(['granularity', 'cold bytes', 'share']);
  row(['---', '---:', '---:']);
  const g = s.granularity;
  const gTotal = g.wholePackageColdBytes + g.fileLevelOnlyColdBytes;
  row(['wholly-cold packages (package-level reaches these)', bytes(g.wholePackageColdBytes), pct(1 - g.fileLevelOnlyShare)]);
  row(['partly-cold packages (file-level only)', bytes(g.fileLevelOnlyColdBytes), pct(g.fileLevelOnlyShare)]);
  row(['**total**', bytes(gTotal), '100%']);
  L.push('');
  L.push(
    `Per-app file-level-only share: min ${pct(g.shareDistribution.min)}, median ${pct(g.shareDistribution.median)}, ` +
      `max ${pct(g.shareDistribution.max)}.`,
  );
  L.push('');

  L.push('### Largest fully-cold packages (Plan B, non-meta)');
  L.push('');
  row(['app', 'package', 'cold bytes', 'files']);
  row(['---', '---', '---:', '---:']);
  for (const p of s.topColdPackages.slice(0, 15)) row([p.app, `${p.name}@${p.version}`, bytes(p.coldBytes), p.files]);
  L.push('');
  L.push('### Largest partially-cold (mixed) packages (Plan B, non-meta)');
  L.push('');
  row(['app', 'package', 'cold bytes', 'hot byte fraction', 'files']);
  row(['---', '---', '---:', '---:', '---:']);
  for (const p of s.topMixedPackages.slice(0, 15)) {
    row([p.app, `${p.name}@${p.version}`, bytes(p.coldBytes), pct(p.hotByteFraction), p.files]);
  }
  L.push('');

  L.push('## Failures and non-measurements');
  L.push('');
  if (s.failures.length === 0) {
    L.push('None — all ' + s.apps.total + ' frozen corpus applications completed with positive evidence.');
  } else {
    row(['app', 'cat', 'kind', 'reason']);
    row(['---', '---', '---', '---']);
    for (const f of s.failures) row([f.app, f.category, f.kind, String(f.reason).replace(/\n/g, ' ').slice(0, 220)]);
    L.push('');
    L.push('An NFT failure produces a fail-safe all-HOT plan. That is an infrastructure failure, **not**');
    L.push('a measured 0%-cold result, and those apps are excluded from every statistic above.');
  }
  L.push('');
  return L.join('\n');
}

main();
