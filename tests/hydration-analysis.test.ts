/**
 * The join between observed accesses and the frozen Plan B placement. Every
 * test here is a measurement defect that would move the headline rather than
 * crash the run:
 *
 *  1. one cold file touched in two processes is ONE hydration, not two;
 *  2. a workload RUNNER's own reads are not the application's working set;
 *  3. a metadata-only cold touch is never counted as hydrated bytes;
 *  4. first-touches land in the phase whose interval contains their timestamp;
 *  5. touching a HOT file is not a miss, and hot-touched + hot-untouched == hot;
 *  6. a touched file outside the frozen universe is recorded, never hydrated;
 *  7. hydrated + still-cold == the initial cold bytes, exactly.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../benchmarks/hydration/analyze.ts';

const APP = 'fixture-app';
const CLONE = '/synthetic/clone';

/** [real, rel, bytes, hotA, hotB, pkgDir, thirdParty, isJs] */
const PLAN: [string, string, number, 0 | 1, 0 | 1, string, 0 | 1, 0 | 1][] = [
  [`${CLONE}/entry.js`, 'entry.js', 1000, 1, 1, '', 0, 1],
  [`${CLONE}/node_modules/hot/index.js`, 'node_modules/hot/index.js', 2000, 1, 1, `${CLONE}/node_modules/hot`, 1, 1],
  [`${CLONE}/node_modules/hot/never.js`, 'node_modules/hot/never.js', 4000, 1, 1, `${CLONE}/node_modules/hot`, 1, 1],
  [`${CLONE}/node_modules/cold/a.js`, 'node_modules/cold/a.js', 8000, 0, 0, `${CLONE}/node_modules/cold`, 1, 1],
  [`${CLONE}/node_modules/cold/b.js`, 'node_modules/cold/b.js', 16000, 0, 0, `${CLONE}/node_modules/cold`, 1, 1],
  [`${CLONE}/node_modules/cold/meta.json`, 'node_modules/cold/meta.json', 32000, 0, 0, `${CLONE}/node_modules/cold`, 1, 0],
  [`${CLONE}/node_modules/cold/untouched.js`, 'node_modules/cold/untouched.js', 64000, 0, 0, `${CLONE}/node_modules/cold`, 1, 1],
  [`${CLONE}/node_modules/runneronly/x.js`, 'node_modules/runneronly/x.js', 128000, 0, 0, `${CLONE}/node_modules/runneronly`, 1, 1],
];

const T0 = 1_000_000;
const READY = T0 + 1000;
const COMMON_END = T0 + 2000;
const FULL_END = T0 + 3000;

function fixture(): { runDir: string; snapshotRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'hyd-an-'));
  const snapshotRoot = path.join(base, 'plans');
  const snapDir = path.join(snapshotRoot, APP);
  const traceDir = path.join(base, 'trace');
  const runDir = path.join(base, 'run');
  mkdirSync(snapDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  writeFileSync(path.join(snapDir, 'plan.ndjson'), PLAN.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(
    path.join(snapDir, 'packages.ndjson'),
    [
      [`${CLONE}/node_modules/hot`, 'hot', '1.0.0'],
      [`${CLONE}/node_modules/cold`, 'cold', '2.0.0'],
      [`${CLONE}/node_modules/runneronly`, 'runneronly', '3.0.0'],
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(snapDir, 'meta.json'),
    JSON.stringify({
      app: APP,
      category: 'target',
      sha: 'deadbeef',
      entryRel: 'entry.js',
      universeRoot: CLONE,
      cloneRoot: CLONE,
      matchesFirstRun: true,
    }),
  );

  const app = (o: object) => ({ t: 'touch', pid: 10, tid: 0, from: null, ...o });
  const lines: object[] = [
    { t: 'proc', pid: 10, ppid: 1, threadId: 0, ts: T0, argv: ['node', 'entry.js'], label: `${APP}:app`, isWorker: false },
    { t: 'proc', pid: 11, ppid: 10, threadId: 0, ts: T0, argv: ['node', 'w.js'], label: `${APP}:app`, isWorker: true },
    { t: 'proc', pid: 20, ppid: 1, threadId: 0, ts: T0, argv: ['node', 'runner.js'], label: `${APP}:workload:full`, isWorker: false },

    // startup: hot entry + a cold file, plus a repeat access of the same cold file
    app({ real: `${CLONE}/entry.js`, cls: 'content', op: 'require.js', ord: 0, ts: T0 + 100 }),
    app({ real: `${CLONE}/node_modules/hot/index.js`, cls: 'content', op: 'require.js', ord: 1, ts: T0 + 200 }),
    app({ real: `${CLONE}/node_modules/cold/a.js`, cls: 'content', op: 'require.js', ord: 2, ts: T0 + 300 }),
    // the SAME cold file, first-touched again in a different process — one hydration
    { t: 'touch', pid: 11, tid: 0, from: null, real: `${CLONE}/node_modules/cold/a.js`, cls: 'content', op: 'readFileSync', ord: 0, ts: T0 + 400 },

    // common phase: a metadata-only cold touch (must NOT hydrate)
    app({ real: `${CLONE}/node_modules/cold/meta.json`, cls: 'metadata', op: 'existsSync', ord: 3, ts: T0 + 1500 }),

    // full phase: a second real hydration
    app({ real: `${CLONE}/node_modules/cold/b.js`, cls: 'content', op: 'require.js', ord: 4, ts: T0 + 2500 }),

    // a file outside the frozen universe, content-read by the app
    app({ real: `${CLONE}/generated/cache.bin`, cls: 'content', op: 'readFileSync', ord: 5, ts: T0 + 2600 }),

    // the workload RUNNER reads a cold file — not the application's working set
    { t: 'touch', pid: 20, tid: 0, from: null, real: `${CLONE}/node_modules/runneronly/x.js`, cls: 'content', op: 'require.js', ord: 0, ts: T0 + 2700 },

    { t: 'summary', pid: 10, tid: 0, ts: T0 + 2900, uniqueFiles: 6, totalAccesses: 99, firstTouchesByClass: {}, outside: [] },
  ];
  writeFileSync(path.join(traceDir, '10-0.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  writeFileSync(
    path.join(runDir, `${APP}.run.json`),
    JSON.stringify({
      app: APP,
      recipeQuality: 'representative-endpoint-set',
      recipeNotes: 'synthetic',
      traceDir,
      t0: T0,
      ready: { ok: true, ts: READY, how: 'tcp', waitedMs: 1000 },
      phases: [
        { name: 'common', startTs: READY, endTs: COMMON_END, detail: 'common', reachedGoal: true },
        { name: 'full', startTs: COMMON_END, endTs: FULL_END, detail: 'full', reachedGoal: true },
      ],
      failure: null,
      deviations: [],
    }),
  );
  return { runDir, snapshotRoot };
}

const { runDir, snapshotRoot } = fixture();
const R = (await analyze(APP, runDir, snapshotRoot))!;

describe('hydration analysis', () => {
  test('1: one cold file touched by two processes is ONE hydration', () => {
    // cold/a.js is content-touched by the main process and again by a worker
    expect(R.totals.uniqueMissFiles).toBe(2); // a.js and b.js only
    expect(R.totals.uniqueMissBytes).toBe(8000 + 16000);
  });

  test('2: a workload runner is not the application working set', () => {
    expect(R.misses.topFiles.some((f) => f.rel.includes('runneronly'))).toBe(false);
    expect(R.totals.uniqueMissBytes).toBeLessThan(128000);
    const runnerPkg = R.packages.rows.find((p) => p.name === 'runneronly')!;
    expect(runnerPkg.hydratedBytes).toBe(0);
  });

  test('3: metadata-only cold touches are reported apart from hydrated bytes', () => {
    expect(R.totals.metadataOnlyColdFiles).toBe(1);
    expect(R.totals.metadataOnlyColdBytes).toBe(32000);
    expect(R.survival.hydratedBytes).toBe(24000);
    expect(R.survival.upperBoundHydratedBytes).toBe(24000 + 32000);
  });

  test('4: first-touches land in the phase containing their timestamp', () => {
    const byPhase = Object.fromEntries(R.curve.map((c) => [c.phase, c]));
    expect(byPhase.startup!.hydratedBytes).toBe(8000); // a.js only
    expect(byPhase.common!.hydratedBytes).toBe(8000); // metadata-only adds nothing
    expect(byPhase.common!.touchedAnyBytes).toBe(8000 + 32000); // …but shows in the upper bound
    expect(byPhase.full!.hydratedBytes).toBe(24000);
  });

  test('5: touching a HOT file is not a miss, and hot accounting closes', () => {
    expect(R.totals.hotTouchedFiles).toBe(2); // entry.js + hot/index.js
    expect(R.totals.hotNeverTouchedFiles).toBe(1); // hot/never.js
    expect(R.totals.hotTouchedBytes + R.totals.hotNeverTouchedBytes).toBe(R.initial.hotBytes);
  });

  test('6: a file outside the frozen universe is recorded, never hydrated', () => {
    expect(R.outside.files).toBe(1);
    expect(R.outside.contentFiles).toBe(1);
    expect(R.survival.hydratedBytes).toBe(24000); // unchanged by the outside file
  });

  test('7: hydrated + still-cold == initial cold bytes, exactly', () => {
    expect(R.survival.hydratedBytes + R.survival.stillColdBytes).toBe(R.initial.coldBytes);
    expect(R.initial.coldBytes).toBe(8000 + 16000 + 32000 + 64000 + 128000);
  });

  test('8: package rollup separates stays-cold from becomes-resident', () => {
    const cold = R.packages.rows.find((p) => p.name === 'cold')!;
    expect(cold.hydratedBytes).toBe(24000);
    expect(cold.stillColdBytes).toBe(32000 + 64000);
    const hot = R.packages.rows.find((p) => p.name === 'hot')!;
    expect(hot.klass).toBe('all-hot-initially');
  });
});
