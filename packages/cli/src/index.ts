import { parseArgs } from 'node:util';
import { run } from './build.ts';

const HELP = `reducer — conservative Node.js production linker (technical spike)

Usage:
  reducer analyze <entrypoint> [options]
  reducer build   <entrypoint> --out <dir> [options]

Options:
  --out <dir>              output directory for build (default: dist-reduced)
  --format json            print the full manifest as JSON
  --verbose                print per-symbol verdicts
  --additional-root <f>    extra entrypoint (repeatable)
  --keep-package <name>    force-retain a package's candidates (repeatable)
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      format: { type: 'string' },
      verbose: { type: 'boolean', default: false },
      'additional-root': { type: 'string', multiple: true },
      'keep-package': { type: 'string', multiple: true },
      help: { type: 'boolean', default: false },
    },
  });

  const [command, entry] = positionals;
  if (values.help || !command || !entry || !['analyze', 'build'].includes(command)) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const { manifest, outDir } = await run({
    entry,
    outDir: values.out,
    additionalRoots: values['additional-root'],
    keepPackages: values['keep-package'],
    write: command === 'build',
  });

  if (values.format === 'json') {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const m = manifest.metrics;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`reducer ${command}: ${entry}`);
  console.log(`  original dependency bytes : ${m.original.dependencyBytes} (${m.original.dependencyFiles} files)`);
  console.log(`  NFT baseline              : ${m.nft.bytes} bytes, ${m.nft.files} files (${m.nft.jsBytes} JS bytes)`);
  console.log(`  bytes removed beyond NFT  : ${m.reducer.bytesRemoved} (${pct(m.reducer.incrementalReductionVsNftJs)} of traced JS)`);
  console.log(`  functions stubbed         : ${m.reducer.functionsStubbed}`);
  console.log(`  proven unreachable        : ${m.reducer.symbolsProvenUnreachable}`);
  console.log(`  proven reachable          : ${m.reducer.symbolsProvenReachable}`);
  console.log(`  retained (uncertain)      : ${m.reducer.symbolsRetainedUncertain}`);
  const a = manifest.artifact;
  console.log(`  artifact                  : ${a.universeFiles} files (production universe; ${a.nftTracedFiles} NFT-traced), ${a.removed.length} removed by proof, ${a.devExcludedPackages.length} dev-only packages outside universe`);
  const buckets = Object.entries(m.retention.byReason).sort(
    (a, b) => b[1].estimatedJsBytes - a[1].estimatedJsBytes,
  );
  if (buckets.length) {
    console.log('  retention by reason (estimated JS bytes):');
    for (const [reason, b] of buckets.slice(0, 12)) {
      console.log(`    ${reason.padEnd(28)} ${b.estimatedJsBytes} bytes, ${b.symbols} symbols, ${b.modules} modules`);
    }
  }
  if (manifest.metrics.analyzer.globalHazards.length) {
    console.log(`  GLOBAL HAZARDS (analysis widened to keep everything): ${manifest.metrics.analyzer.globalHazards.join(', ')}`);
  }
  if (manifest.warnings.length) {
    console.log(`  NFT warnings: ${manifest.warnings.length}`);
    if (values.verbose) manifest.warnings.forEach((w) => console.log(`    - ${w}`));
  }
  if (values.verbose) {
    for (const v of manifest.verdicts) {
      console.log(`  [${v.state}] ${v.module} :: ${v.symbol} (${v.reasons.join(', ')})`);
    }
  }
  for (const tr of manifest.transformations) {
    console.log(`  stubbed ${tr.package} ${tr.file} :: ${tr.symbol} (${tr.bytesBefore - tr.bytesAfter} bytes removed)`);
  }
  if (outDir) console.log(`  output: ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
