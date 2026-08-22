/**
 * Mutation-sensitivity harness: for every MUST_RETAIN symbol, break its body
 * in the ORIGINAL app (marker-delimited replacement, in place with restore),
 * boot, replay that symbol's endpoint, and require the endpoint to FAIL
 * (non-2xx or body divergence). An endpoint that still passes while its
 * symbol is broken protects nothing — that is a Garden spec bug and this
 * harness exits non-zero, reporting it.
 *
 * Usage: bun benchmarks/garden/tools/mutate.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GARDEN, APP, bootServer, fetchEntry } from './lib.ts';

const map = JSON.parse(readFileSync(path.join(GARDEN, 'garden-map.json'), 'utf8'));
const contracts = JSON.parse(readFileSync(path.join(GARDEN, 'fixtures', 'contracts.json'), 'utf8'));
const byPath = new Map<string, any>(contracts.entries.map((e: any) => [e.path, e]));

interface Target { label: string; file: string; endpoint: string; mutate: (src: string) => string }

const targets: Target[] = [];

for (const t of map.mutationTargets) {
  const open = `/*<garden:${t.marker}>*/`;
  const close = `/*</garden:${t.marker}>*/`;
  targets.push({
    label: `${t.id}:${t.symbol}`,
    file: path.join(APP, t.file),
    endpoint: t.endpoint,
    mutate: (src) => {
      const i = src.indexOf(open);
      const j = src.indexOf(close);
      if (i < 0 || j < 0) throw new Error(`markers for ${t.marker} not found in ${t.file}`);
      return src.slice(0, i) + `throw new Error("GARDEN_MUTATED:${t.marker}");` + src.slice(j + close.length);
    },
  });
}
for (const r of map.realMutations) {
  targets.push({
    label: `real:${r.label}`,
    file: path.join(APP, r.file),
    endpoint: r.endpoint,
    mutate: (src) => src + '\n' + r.append + '\n',
  });
}

const specBugs: string[] = [];
const failures: string[] = [];
let checked = 0;

for (const t of targets) {
  const fixture = byPath.get(t.endpoint);
  if (!fixture) { failures.push(`${t.label}: no recorded fixture for ${t.endpoint}`); continue; }
  const original = readFileSync(t.file, 'utf8');
  try {
    writeFileSync(t.file, t.mutate(original));
    let outcome: string;
    try {
      const server = await bootServer(APP);
      try {
        const got = await fetchEntry(server.base, t.endpoint);
        if (got.status !== fixture.status) outcome = `detected (status ${got.status} != ${fixture.status})`;
        else if (got.body !== fixture.body) outcome = `detected (body diverged)`;
        else outcome = 'NOT DETECTED';
      } finally {
        await server.kill();
      }
    } catch (bootErr) {
      // A boot failure IS detection (the mutation is load-bearing at init).
      outcome = `detected (boot failed: ${String(bootErr).slice(0, 120)})`;
    }
    checked++;
    if (outcome === 'NOT DETECTED') {
      specBugs.push(`${t.label}: endpoint ${t.endpoint} still matches its fixture with the symbol broken — the endpoint protects nothing`);
      console.error(`  ✗ ${t.label} — SPEC BUG (mutation not detected)`);
    } else {
      console.log(`  ✓ ${t.label} — ${outcome}`);
    }
  } finally {
    writeFileSync(t.file, original);
  }
}

console.log(`\nmutation-sensitivity: ${checked} symbols checked, ${specBugs.length} spec bugs, ${failures.length} harness failures`);
for (const s of specBugs) console.error(`SPEC BUG: ${s}`);
for (const f of failures) console.error(`HARNESS: ${f}`);
process.exit(specBugs.length || failures.length ? 1 : 0);
