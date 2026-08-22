/**
 * Turn a reducer-manifest.json + a vuln→symbol mapping into VEX-shaped
 * evidence records. This is deliberately NOT a vuln database or VEX product —
 * it just shows the manifest already carries everything a VEX/SBOM consumer
 * needs to assert "not_affected: vulnerable_code_not_present" for a
 * function-localized CVE.
 *
 * Usage:
 *   bun benchmarks/vex.ts <reducer-manifest.json> <mapping.json>
 * mapping.json: [{ "id": "CVE-2019-10744", "package": "minilodash", "symbol": "merge" }]
 */
import { readFileSync } from 'node:fs';

const [, , manifestPath, mappingPath] = process.argv;
if (!manifestPath || !mappingPath) {
  console.error('usage: bun benchmarks/vex.ts <reducer-manifest.json> <mapping.json>');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const mapping: { id: string; package: string; symbol: string }[] = JSON.parse(readFileSync(mappingPath, 'utf8'));

const records = mapping.map((v) => {
  const tr = manifest.transformations.find(
    (t: any) => t.symbol === v.symbol && (t.package ?? '').startsWith(`${v.package}@`),
  );
  if (tr) {
    return {
      vulnerability: { id: v.id },
      product: { component: tr.package, subcomponent: v.symbol },
      status: 'not_affected',
      justification: 'vulnerable_code_not_present',
      impact_statement:
        `reducer proved "${v.symbol}" unreachable and replaced its body with a throwing stub; ` +
        `the vulnerable implementation bytes are physically absent from the deployment.`,
      evidence: {
        file: tr.file,
        action: tr.action,
        proof: tr.proof,
        sourceRange: tr.sourceRange,
        inputHash: tr.inputHash,
        outputHash: tr.outputHash,
        bytesRemoved: tr.bytesBefore - tr.bytesAfter,
      },
    };
  }
  // Not removed: report why, so a consumer knows the CVE still applies.
  const verdict = manifest.verdicts.find(
    (x: any) => x.symbol === v.symbol && (x.pkg ?? '').startsWith(`${v.package}@`),
  );
  return {
    vulnerability: { id: v.id },
    product: { component: verdict?.pkg ?? v.package, subcomponent: v.symbol },
    status: 'affected',
    justification: null,
    impact_statement: verdict
      ? `retained (${verdict.state}: ${verdict.reasons.join(', ')}) — vulnerable code still present.`
      : `symbol not found in manifest — vulnerable code assumed present.`,
    evidence: null,
  };
});

console.log(JSON.stringify({ '@context': 'reducer-vex-evidence/0', records }, null, 2));
