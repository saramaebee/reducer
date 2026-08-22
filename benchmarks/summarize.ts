/**
 * Aggregate benchmarks/results/*.json into a Markdown summary
 * (per-project table + retention-reason totals + medians).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const resultsDir = path.resolve(process.argv[2] ?? 'benchmarks/results');
const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.error(`no results in ${resultsDir}`);
  process.exit(1);
}
const rows = files.map((f) => JSON.parse(readFileSync(path.join(resultsDir, f), 'utf8')));

const kb = (n: number | null | undefined) => (n == null ? 'n/a' : `${(n / 1024).toFixed(0)} KB`);
const pct = (x: number | null | undefined) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

let md = `# reducer real-world benchmark summary\n\n`;
md += `| project | fw | modules | deps | A prod | B NFT JS | C bundle | D reducer JS | Δ vs NFT | stubbed | hazards | tests | startup |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  md += `| ${r.project} | ${r.framework ?? '-'} | ${r.moduleSystem} | ${r.productionDependencyCount} | ${kb(r.A_prod?.bytes)} | ${kb(r.B_nft?.jsBytes)} | ${r.C_bundle?.ok ? kb(r.C_bundle.bytes) : 'FAIL'} | ${kb(r.D_reducer?.outputJsBytes)} | ${pct(r.incremental?.vsNftJs)} | ${r.D_reducer?.functionsStubbed ?? 'n/a'} | ${r.analysis?.globalHazards?.join('<br>') || 'none'} | ${r.validation?.testsPassed ?? '-'} | ${r.validation?.startupPassed ?? '-'} |\n`;
}

const vsNft = rows.map((r) => r.incremental?.vsNftJs).filter((x: unknown) => typeof x === 'number');
md += `\n**Median incremental reduction vs NFT:** ${pct(median(vsNft))} across ${vsNft.length} analyzable project(s); `;
md += `bundler passed on ${rows.filter((r) => r.C_bundle?.ok).length}/${rows.length}.\n`;

md += `\n## Retention reasons (aggregate, estimated JS bytes)\n\n| reason | est. bytes | symbols | modules | projects |\n|---|---|---|---|---|\n`;
const agg = new Map<string, { bytes: number; symbols: number; modules: number; projects: number }>();
for (const r of rows) {
  for (const [reason, b] of Object.entries<any>(r.analysis?.retentionByReason ?? {})) {
    const a = agg.get(reason) ?? { bytes: 0, symbols: 0, modules: 0, projects: 0 };
    a.bytes += b.estimatedJsBytes;
    a.symbols += b.symbols;
    a.modules += b.modules;
    a.projects++;
    agg.set(reason, a);
  }
}
for (const [reason, a] of [...agg].sort((x, y) => y[1].bytes - x[1].bytes)) {
  md += `| ${reason} | ${kb(a.bytes)} | ${a.symbols} | ${a.modules} | ${a.projects} |\n`;
}

const outPath = path.join(resultsDir, 'SUMMARY.md');
writeFileSync(outPath, md);
console.log(md);
console.log(`wrote ${outPath}`);
