/**
 * Garden setup: install the pinned real packages, verify version+integrity
 * against MANIFEST.json (hard fail on any mismatch), re-confirm validator is
 * hazard-free at this exact version, then copy the fabricated packages into
 * the app's node_modules.
 *
 * Usage: bun benchmarks/garden/tools/setup.ts [--skip-install]
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { analyzeModuleSource } from '@reducer/analyzer';

const GARDEN = path.resolve(import.meta.dirname, '..');
const APP = path.join(GARDEN, 'app');
const FAB = path.join(GARDEN, 'fab');

const manifest = JSON.parse(readFileSync(path.join(GARDEN, 'MANIFEST.json'), 'utf8'));

const skipInstall = process.argv.includes('--skip-install');
if (!skipInstall) {
  console.log('npm ci (pinned real packages)…');
  const res = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: APP, stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`npm ci failed with status ${res.status}`);
}

// ---- integrity verification against MANIFEST -------------------------------
const lock = JSON.parse(readFileSync(path.join(APP, 'package-lock.json'), 'utf8'));
const pinned: { name: string; version: string; integrity: string }[] = [
  ...manifest.realPackages.hazardControls.packages.map((p: any) => ({
    name: p.name, version: p.version, integrity: p.integrity,
  })),
  manifest.realPackages.reducibleControl,
  manifest.realPackages.nativeControl,
  manifest.realPackages.wasmControl,
].map((p: any) => ({ name: p.name, version: p.version, integrity: p.integrity }));

const failures: string[] = [];
for (const p of pinned) {
  const entry = lock.packages?.[`node_modules/${p.name}`];
  if (!entry) { failures.push(`${p.name}: not present in package-lock.json`); continue; }
  if (entry.version !== p.version) {
    failures.push(`${p.name}: version ${entry.version} != pinned ${p.version}`);
  }
  if (entry.integrity !== p.integrity) {
    failures.push(`${p.name}: integrity mismatch\n  lock:     ${entry.integrity}\n  manifest: ${p.integrity}`);
  }
  if (!existsSync(path.join(APP, 'node_modules', p.name, 'package.json'))) {
    failures.push(`${p.name}: not installed on disk`);
  }
}
if (failures.length) {
  console.error('PINNED PACKAGE VERIFICATION FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`verified ${pinned.length} pinned real packages (version + integrity).`);

// ---- validator hazard-free recheck (manifest requires it at build time) ----
const validatorDir = path.join(APP, 'node_modules', 'validator');
const hazardHits: string[] = [];
const scan = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'es') scan(abs); continue; } // CJS entry uses lib/ + index.js
    if (!/\.c?js$/.test(e.name)) continue;
    const m = analyzeModuleSource(readFileSync(abs, 'utf8'), abs);
    if (m === null) hazardHits.push(`${abs}: PARSE FAILURE`);
    else if (m.hazards.length) hazardHits.push(`${abs}: ${[...new Set(m.hazards)].join(', ')}`);
  }
};
scan(validatorDir);
if (hazardHits.length) {
  console.error('validator@13.15.35 hazard recheck FAILED (manifest declares it hazard-free):');
  for (const h of hazardHits) console.error(`  - ${h}`);
  process.exit(1);
}
console.log('validator hazard-free recheck passed.');

// ---- copy fabricated packages into app/node_modules ------------------------
let copied = 0;
for (const e of readdirSync(FAB, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dest = path.join(APP, 'node_modules', e.name);
  rmSync(dest, { recursive: true, force: true });
  cpSync(path.join(FAB, e.name), dest, { recursive: true });
  copied++;
}
console.log(`copied ${copied} fabricated packages into app/node_modules.`);
