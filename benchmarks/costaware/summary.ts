/**
 * Generate `run-1/SUMMARY.md` from the computed per-app metrics.
 *
 * Tables only. Every number here is read from `<app>.metrics.json`; nothing is
 * recomputed, so the summary cannot disagree with the analysis.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ARMS, RUNGS_MS } from './run.ts';

const RUN = path.join(import.meta.dirname, 'run-1');

type Agg = { n: number; median: number; min: number; max: number } | null;
const f0 = (a: Agg): string => (a ? `${Math.round(a.median)}` : '—');
const f1 = (a: Agg, div = 1): string => (a ? (a.median / div).toFixed(1) : '—');
const s = (n: number | null | undefined): string => (n == null ? '—' : String(n));

export function summarize(apps: string[]): string {
  const out: string[] = [];
  out.push('# Cost-aware traffic-warm — generated tables\n');
  out.push('Preregistration: [`../DESIGN.md`](../DESIGN.md). Every rung is a MEASURED');
  out.push('prewarm cost, chosen per arm by an application-free probe of each candidate');
  out.push('manifest (DESIGN §8.1); the nominal parameter is only a knob.\n');

  for (const app of apps) {
    const p = path.join(RUN, `${app}.metrics.json`);
    if (!existsSync(p)) continue;
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const cell = (arm: string, rung: number) => m.byCell[`${arm}@${rung}`] ?? null;
    const rungs: number[] = m.rungs ?? RUNGS_MS[app] ?? [];

    out.push(`\n---\n\n## ${app}\n`);
    out.push(
      `Universe ${m.universe.files} files / ${(m.universe.bytes / 1e6).toFixed(1)} MB; ` +
        `blob ${(m.physical.compressedBytes / 1e6).toFixed(1)} MB in ${m.physical.chunks} chunks ` +
        `(${m.physical.sharedChunks} shared). Frozen band ${m.band.primary} ms; ` +
        `eager arm's own worst post-admission window p99 ${Math.round(m.eagerWorstWindowP99)} ms.\n`,
    );

    // ── what each arm actually bought
    out.push('### 1. The ladder — what a rung actually cost, and what it bought\n');
    out.push('| rung | arm | param | probe-measured prewarm | in-trial prewarm | manifest entries | resident files | resident MB | backend req @admit | backend MB @admit |');
    out.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of rungs) {
      for (const a of ARMS) {
        const c = cell(a.name, r);
        const l = (m.ladder as { arm: string; rungMs: number; param: number; measuredMs: number; files: number }[]).find(
          (x) => x.arm === a.name && x.rungMs === r,
        );
        if (!c) continue;
        out.push(
          `| ${(r / 1000).toFixed(1)} s | ${a.name} | ${s(l?.param)} | ${s(l?.measuredMs)} ms | ${f0(c.prewarmDuration)} ms | ` +
            `${s(l?.files)} | ${f0(c.residentFiles)} | ${f1(c.residentFileBytes, 1e6)} | ${f0(c.backendRequestsAtAdmit)} | ${f1(c.backendBytesAtAdmit, 1e6)} |`,
        );
      }
    }

    // ── the headline
    out.push('\n### 2. Equal measured prewarm time → outcome\n');
    out.push('`T_steady − T0` is the preregistered primary metric, computed against the frozen band.');
    out.push('`T_steady(eager) − T0` is the same construction against a REACHABLE threshold — the eager');
    out.push("arm's own worst cold post-admission window — because the frozen band comes from the eager");
    out.push('arm\'s WARM pass and no cold pass can meet it (experiment 4 amendment A4). Both are shown;');
    out.push('neither replaces the other. `T_traffic − T0` is admission delay.\n');
    out.push('| rung | arm | T_steady(eager)−T0 | reached | T_steady(band)−T0 | reached | T_traffic−T0 | max window p95 | max window p99 | post-adm remote req | residual prefetch | demand faults | post-adm MB |');
    out.push('| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of rungs) {
      for (const a of ARMS) {
        const c = cell(a.name, r);
        if (!c) continue;
        out.push(
          `| ${(r / 1000).toFixed(1)} s | ${a.name} | ${f0(c.tSteadyEager)} | ${c.steadyEagerReached}/${c.trials} | ${f0(c.tSteady)} | ${c.steadyReached}/${c.trials} | ${f0(c.tTraffic)} | ` +
            `${f0(c.maxWindowP95)} | ${f0(c.maxWindowP99)} | ${f0(c.postAdmissionFaults)} | ${f0(c.postAdmissionPrefetchRequests)} | ${f0(c.postAdmissionDemandRequests)} | ${f1(c.postAdmissionBytes, 1e6)} |`,
        );
      }
    }
    const e0 = m.byCell.E0;
    if (e0) {
      out.push(
        `| eager | E0 | ${f0(e0.tSteadyEager)} | ${e0.steadyEagerReached}/${e0.trials} | ${f0(e0.tSteady)} | ${e0.steadyReached}/${e0.trials} | ${f0(e0.tTraffic)} | ` +
          `${f0(e0.maxWindowP95)} | ${f0(e0.maxWindowP99)} | ${f0(e0.postAdmissionFaults)} | ${f0(e0.postAdmissionPrefetchRequests)} | ${f0(e0.postAdmissionDemandRequests)} | ${f1(e0.postAdmissionBytes, 1e6)} |`,
      );
    }

    // ── long-tail first hit
    out.push('\n### 3. Long-tail first-hit latency, arrival position 1 only\n');
    const cats = new Set<string>();
    for (const k of Object.keys(m.byCell)) for (const c of Object.keys((m.byCell[k] as { firstHitByCategory: object }).firstHitByCategory ?? {})) cats.add(c);
    for (const cat of [...cats].sort()) {
      out.push(`\n**${cat}**\n`);
      out.push(`| rung | ${ARMS.map((a) => a.name).join(' | ')} | E0 |`);
      out.push(`| ---: | ${ARMS.map(() => '---:').join(' | ')} | ---: |`);
      for (const r of rungs) {
        const cells = ARMS.map((a) => {
          const c = cell(a.name, r);
          return f0(c?.firstHitByCategory?.[cat]?.position1 ?? null);
        });
        out.push(`| ${(r / 1000).toFixed(1)} s | ${cells.join(' | ')} | ${f0(e0?.firstHitByCategory?.[cat]?.position1 ?? null)} |`);
      }
    }

    // ── equal outcome
    out.push('\n### 4. Equal outcome — smallest rung that is eager-matched\n');
    out.push('Eager-matched: median worst post-admission window p99 ≤ the worst the eager arm itself produced (experiment 4 amendment A4, reused).\n');
    out.push('| arm | smallest eager-matched rung | its measured prewarm |');
    out.push('| --- | --- | ---: |');
    for (const a of ARMS) {
      const eo = m.equalOutcome[a.name];
      out.push(`| ${a.name} | ${eo?.rungMs == null ? 'never in the swept range' : `${(eo.rungMs / 1000).toFixed(1)} s`} | ${eo?.measuredMs == null ? '—' : `${eo.measuredMs} ms`} |`);
    }

    // ── waste
    out.push('\n### 5. Prewarm waste — resident at admission, never touched by any workload\n');
    out.push('| rung | arm | waste files | waste MB | needed TEST files still missing |');
    out.push('| ---: | --- | ---: | ---: | ---: |');
    for (const r of rungs) {
      for (const a of ARMS) {
        const c = cell(a.name, r);
        if (!c) continue;
        out.push(`| ${(r / 1000).toFixed(1)} s | ${a.name} | ${f0(c.wasteFiles)} | ${f1(c.wasteBytes, 1e6)} | ${f0(c.neededMiss)} |`);
      }
    }

    // ── oracle
    const o = m.physicalOracle;
    out.push('\n### 6. The physical oracle — perfect future knowledge, priced in the same units\n');
    out.push('```text');
    out.push(`needed TEST files       ${o.neededFiles}`);
    out.push(`unique chunks           ${o.chunks}`);
    out.push(`backend requests        ${o.requests}`);
    out.push(`backend bytes           ${(o.backendBytes / 1e6).toFixed(1)} MB`);
    out.push(`predicted prewarm       ${o.predictedMs} ms`);
    out.push('```');
    out.push('\nAgainst what a cost-aware arm actually pays for far more content:\n');
    out.push('| arm | rung | resident files | measured prewarm | backend requests |');
    out.push('| --- | ---: | ---: | ---: | ---: |');
    for (const l of (m.ladder as { arm: string; rungMs: number; measuredMs: number; measuredRequests: number | null }[])) {
      if (l.arm !== 'G1C' && l.arm !== 'R1C') continue;
      const c = cell(l.arm, l.rungMs);
      out.push(`| ${l.arm} | ${(l.rungMs / 1000).toFixed(1)} s | ${f0(c?.residentFiles ?? null)} | ${l.measuredMs} ms | ${s(l.measuredRequests)} |`);
    }

    // ── do the two prediction sources still disagree?
    out.push('\n### 6b. Do the two prediction sources still disagree once both pay real retrieval cost?\n');
    out.push('Jaccard overlap of what each arm makes RESIDENT, from the frozen manifests alone — no trial, no latency.\n');
    out.push('| rung | G1C vs R1C: chunks | resident files | R1C-only | G1C-only | G1 vs R1: chunks | resident files |');
    out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of rungs) {
      const o = (m.selectionOverlap ?? {})[r];
      if (!o) continue;
      const c1 = o['G1C-vs-R1C'];
      const c2 = o['G1-vs-R1'];
      out.push(
        `| ${(r / 1000).toFixed(1)} s | ${c1 ? c1.unitJaccard.toFixed(3) : '—'} | ${c1 ? c1.residentJaccard.toFixed(3) : '—'} | ` +
          `${c1 ? c1.onlyB : '—'} | ${c1 ? c1.onlyA : '—'} | ${c2 ? c2.unitJaccard.toFixed(3) : '—'} | ${c2 ? c2.residentJaccard.toFixed(3) : '—'} |`,
      );
    }

    // ── decomposition of experiment 4
    out.push('\n### 7. Why experiment 4 lost — its own manifests, re-priced physically\n');
    out.push('| exp-4 arm | byte budget | files | file MB | unique chunks | backend req | backend MB | overfetch | predicted prewarm |');
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const d of m.decomposition as Record<string, number>[]) {
      out.push(
        `| ${d.arm} | ${(Number(d.byteBudget) * 100).toFixed(0)}% | ${d.files} | ${(Number(d.fileBytes) / 1e6).toFixed(1)} | ` +
          `${d.uniqueChunks} | ${d.backendRequests} | ${(Number(d.backendBytes) / 1e6).toFixed(1)} | ${d.overfetchRatio}× | ${d.predictedMs} ms |`,
      );
    }

    // ── correctness
    const c = m.correctness;
    out.push('\n### 8. Correctness\n');
    out.push('```text');
    out.push(`arm-vs-eager trial comparisons   ${c.comparedTrials}`);
    out.push(`status mismatches                ${c.statusMismatches.length}`);
    out.push(`body-length mismatches           ${c.lengthMismatches.length}`);
    out.push(`body-fingerprint mismatches      ${c.bodyMismatches.length}`);
    out.push(`declared-header mismatches       ${c.headerMismatches.length}`);
    out.push(`requests outside declared expect ${c.unexpectedStatus.length}`);
    out.push('```');

    // ── cost model accuracy on deployed manifests
    out.push('\n### 9. Cost-model accuracy on the deployed manifests\n');
    out.push('| arm | rung | predicted | probe-measured | in-trial |');
    out.push('| --- | ---: | ---: | ---: | ---: |');
    for (const r of m.costAccuracy as Record<string, number | string | null>[]) {
      out.push(`| ${r.arm} | ${r.rungMs} ms | ${s(r.predictedMs as number)} ms | ${s(r.probeMeasuredMs as number)} ms | ${s(r.inTrialPrewarmMs as number)} ms |`);
    }
  }
  return `${out.join('\n')}\n`;
}
