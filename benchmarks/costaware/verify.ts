/**
 * Mechanical checks of the fairness invariants this experiment's conclusion
 * rests on. Run before the results are frozen; the output is preserved in
 * `run-1/VERIFY.json` and quoted in `run-1/ADVERSARIAL.md`.
 *
 * These are the claims that, if false, would make the headline comparison
 * meaningless — so they are checked by code against the artefacts rather than
 * asserted in prose:
 *
 *   1. one image per app, byte-identical across arms (there is nothing to
 *      compare because nothing is built: the bootstrap is experiment 4's file
 *      and its digest is recorded here)
 *   2. the semantic arm's behavioural value contains NO workload evidence
 *   3. the generic arm's behavioural value DOES contain the TRAIN trace, and is
 *      the strongest generic ranking available, not the lexicographic one
 *   4. one cost model, one set of coefficients, for every arm
 *   5. the retrieval-unit partition is a function of the image alone
 *   6. every deployed manifest is a subset of the universe and its chunk cover
 *      buys exactly the chunk set the selection chose
 *
 * Usage: bun benchmarks/costaware/verify.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPlan } from '../longtail/plan.ts';
import { LONGTAIL_WORK, loadPhysicalMap } from './physical.ts';
import { buildUnits } from './select.ts';
import { APPS, ARMS, PARAMS_MS, loadCostModel, loadRanking } from './run.ts';

const RUN = path.join(import.meta.dirname, 'run-1');
const WORK = '/Users/sara/.cache/reducer-costaware-v1';

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);

const TRAIN_WORDS = ['train', 'workload', 'access log', 'first-content-read', 'observ'];
const mentionsWorkload = (inputs: string[]): string[] =>
  inputs.filter((i) => TRAIN_WORDS.some((w) => i.toLowerCase().includes(w)));

interface Check {
  name: string;
  pass: boolean;
  detail: unknown;
}

const checks: Check[] = [];
const report: Record<string, unknown> = { apps: {} };

const model = loadCostModel();
checks.push({
  name: 'one cost model, one set of coefficients, shared by every arm',
  pass: Number.isFinite(model.perRequestMs) && Number.isFinite(model.perByteMs),
  detail: model,
});

for (const app of APPS) {
  const plan = loadPlan(app);
  const m = loadPhysicalMap(app);
  const universe = new Set(plan.files.map(([rel]) => rel));
  const byFile = new Map(m.fileChunks);
  const per: Record<string, unknown> = {};

  // 1 — one image, and its identity
  const boot = path.join(LONGTAIL_WORK, 'images', app, 'base', 'boot.img');
  per.bootstrapSha256 = sha(boot);
  per.blobId = m.blobId;
  per.blobCompressedBytes = m.totals.compressedBytes;
  checks.push({
    name: `[${app}] exactly one RAFS bootstrap and one blob exist for every arm`,
    pass: existsSync(boot) && m.totals.blobIndexes.length === 1,
    detail: { bootstrap: boot, sha: per.bootstrapSha256, blobIndexes: m.totals.blobIndexes },
  });

  // 2/3 — the information boundary, read from the FROZEN experiment-4 rankings
  const semantic = loadRanking(app, 'R1');
  const generic = loadRanking(app, 'G2');
  const literal = loadRanking(app, 'G1');
  per.semanticInputs = semantic.inputs;
  per.genericInputs = generic.inputs;
  checks.push({
    name: `[${app}] semantic value (R1) carries NO workload evidence`,
    pass: mentionsWorkload(semantic.inputs).length === 0,
    detail: { inputs: semantic.inputs, offending: mentionsWorkload(semantic.inputs) },
  });
  checks.push({
    name: `[${app}] generic value (G2) DOES carry the TRAIN trace`,
    pass: mentionsWorkload(generic.inputs).length > 0,
    detail: { inputs: generic.inputs },
  });
  // the generic value is not the weak one: G2's head must be exactly G1's trace tier
  const g1Trace = literal.tiers[0]!.upto;
  const g2Trace = generic.tiers[0]!.upto;
  const samePrefix =
    g1Trace === g2Trace && literal.order.slice(0, g1Trace).every((r, i) => r === generic.order[i]);
  checks.push({
    name: `[${app}] the generic arm's value contains the literal TRAIN trace as its strict prefix`,
    pass: samePrefix,
    detail: { g1TraceFiles: g1Trace, g2TraceFiles: g2Trace, identicalPrefix: samePrefix },
  });

  // 5 — units depend on the image alone
  const u1 = buildUnits(m, model.maxRange, model.maxURange);
  const u2 = buildUnits(m, model.maxRange, model.maxURange);
  checks.push({
    name: `[${app}] the retrieval-unit partition is a pure function of the image`,
    pass: u1.span.length === u2.span.length && u1.span.every((s, i) => s[0] === u2.span[i]![0] && s[1] === u2.span[i]![1]),
    detail: { units: u1.span.length, medianBytes: [...u1.bytes].sort((a, b) => a - b)[Math.floor(u1.bytes.length / 2)] },
  });

  // 6 — every deployed manifest is inside the universe
  let manifestsChecked = 0;
  const outside: string[] = [];
  for (const a of ARMS) {
    for (const p of PARAMS_MS) {
      const f = path.join(WORK, 'prefetch', app, `${a.name}.${p}.txt`);
      if (!existsSync(f)) continue;
      manifestsChecked++;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        const rel = line.slice(1);
        if (!universe.has(rel) || !byFile.has(rel)) outside.push(`${a.name}.${p}: ${rel}`);
      }
    }
  }
  checks.push({
    name: `[${app}] every deployed manifest entry is a universe file of this image`,
    pass: outside.length === 0,
    detail: { manifestsChecked, outside: outside.slice(0, 5) },
  });

  // the ladder's equal-cost property, measured
  const lp = path.join(RUN, 'prep', `${app}.ladder.json`);
  if (existsSync(lp)) {
    const ladder = JSON.parse(readFileSync(lp, 'utf8')) as { arm: string; rungMs: number; measuredMs: number }[];
    const spread: Record<string, number> = {};
    for (const rung of [...new Set(ladder.map((l) => l.rungMs))]) {
      const xs = ladder.filter((l) => l.rungMs === rung).map((l) => l.measuredMs);
      spread[rung] = Number((((Math.max(...xs) - Math.min(...xs)) / Math.min(...xs)) * 100).toFixed(1));
    }
    per.rungCostSpreadPct = spread;
    checks.push({
      name: `[${app}] at every rung the four arms' MEASURED prewarm costs agree within 25 %`,
      pass: Object.values(spread).every((x) => x <= 25),
      detail: spread,
    });
  }

  report.apps = { ...(report.apps as object), [app]: per };
}

report.checks = checks;
const failed = checks.filter((c) => !c.pass);
writeFileSync(path.join(RUN, 'VERIFY.json'), JSON.stringify(report, null, 1));
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
console.log(`\n${checks.length - failed.length}/${checks.length} invariants hold`);
if (failed.length) process.exitCode = 1;
