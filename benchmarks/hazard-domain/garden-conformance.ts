/**
 * Garden conformance harness for the NON-TRANSFORMING hazard-domain analyzer
 * (ADR-0006). This is the analyzer analogue of `benchmarks/garden/tools/
 * score.ts` — same by-construction ground truth (`garden-map.json`), same
 * three-axis vocabulary — but the join predicate is
 * `state === 'predicted-removable-file'` (expanded to every export) UNION
 * `stubPredictions[].predicted === true`, never `manifest.transformations`.
 * The analyzer grants no deletion authority; this harness never writes
 * anything into `benchmarks/garden/` except throwaway `.conformance-*.mjs`
 * isolation entries, cleaned up in `finally`.
 *
 * Four modes, one process:
 *   A. COMBINED strict run  — the real-app condition; global hazards widen
 *      almost everything, so achieved/ceiling is expected to be low. This is
 *      the number ADR-0006 actually measures.
 *   B. ISOLATION sweep (47 fab packages) — per-package mini-entries strip the
 *      global-hazard blast radius so the analyzer's PER-MECHANISM verdict is
 *      visible. Soundness join is restricted to that package's own
 *      fab-owned packages (garden.md §4.1): unrelated packages the isolated
 *      entry never reaches are expected to show up predicted-removable and
 *      are not a violation of anything — that is not what isolation mode is
 *      testing.
 *   C. Sound-refinement (SR) counterfactuals on the combined tree — same
 *      soundness gate as A. A sound refinement must never reclaim a
 *      MUST_RETAIN*; if it does, that is a defect in the refinement's
 *      admission predicate, not a permissible result.
 *   D. Gate-off counterfactuals (diagnostic, UNSOUND, exempt from the gate) —
 *      upper bounds on what a hypothetical refinement of one gate (or a top
 *      pair) could recover, conditional on every other gate staying
 *      conservative (ADR-0006 "Gate-off counterfactual").
 *
 * Usage: bun benchmarks/hazard-domain/garden-conformance.ts
 * Emits garden-conformance.json + garden-conformance.md next to this file.
 * Exit: 0 clean, 2 if any soundness violation survives the mode-B
 * star-overbreadth finding predicate (D is diagnostic and never gates exit).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  analyzePrepared,
  prepareHazardDomain,
  UNSUPPRESSIBLE_GATES,
  type GateTag,
  type HazardDomainReport,
  type ModuleFacts,
  type PreparedApp,
  type RefinementName,
} from '@reducer/hazard-domain';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../..');
const GARDEN = path.join(ROOT, 'benchmarks', 'garden');
const APP = path.join(GARDEN, 'app');
const OUT_JSON = path.join(HERE, 'garden-conformance.json');
const OUT_MD = path.join(HERE, 'garden-conformance.md');

// ---------------------------------------------------------------------------
// Ground truth (loaded, never re-derived — garden.md §4.6: reuse garden-map
// wholesale, it is the generated join of MANIFEST truth <-> physical files).
// ---------------------------------------------------------------------------
interface SymbolTruth { key: string; id: string; npmPkg: string; symbol: string; truth: string; sentinel?: string }
interface MustRemoveEntry { id: string; symbol: string; sentinel: string; npmPkg: string; loaders: { spec: string; exportName: string }[] }
interface GmPackage { id: string; npmPkg: string; importStmt: string }
interface WiringRoute { path: string; expr: string; awaited?: boolean; note?: string }
interface WiringPkg { id: string; importStmt: string; routes: WiringRoute[] }

const gardenMap = JSON.parse(readFileSync(path.join(GARDEN, 'garden-map.json'), 'utf8')) as {
  symbols: SymbolTruth[];
  starPackages: { npmPkg: string }[];
  fabOwnedPackages: string[];
  fabOwnerById: Record<string, string>;
  mustRemove: MustRemoveEntry[];
  packages: GmPackage[];
  validatorUsed: string[];
  validatorCeiling: number;
};
const wiring = JSON.parse(readFileSync(path.join(GARDEN, 'wiring.json'), 'utf8')) as { packages: WiringPkg[] };

const symbolIndex = new Map<string, SymbolTruth>(); // `${npmPkg}::${symbol}`
for (const s of gardenMap.symbols) symbolIndex.set(`${s.npmPkg}::${s.symbol}`, s);
// Fallback join for a symbol whose ONE logical ground-truth entry has TWO
// physical owning packages (require-finite's rf-a/rf-b, garden.md §5.11): the
// canonical `symbols[]` row only names the owner npmPkg (rf-b); the sibling
// body (rf-a) carries the identical symbol name under the same fab id and
// must be treated as the same ground truth, never as an unlabeled passenger.
const byFabIdSymbol = new Map<string, SymbolTruth>(); // `${id}::${symbol}`
for (const s of gardenMap.symbols) {
  const k = `${s.id}::${s.symbol}`;
  if (!byFabIdSymbol.has(k)) byFabIdSymbol.set(k, s);
}
const starPkgs = new Set(gardenMap.starPackages.map((p) => p.npmPkg));
const fabOwned = new Set(gardenMap.fabOwnedPackages);
const fabOwnerById = gardenMap.fabOwnerById;
const npmPkgById = new Map(gardenMap.packages.map((p) => [p.id, p.npmPkg]));
const wiringById = new Map(wiring.packages.map((p) => [p.id, p]));
// score.ts:52 — the hazard/boundary real controls the calibration reproduces.
// Not derivable from garden-map (it only joins fab-owned packages), so this
// mirrors score.ts's hard-coded set exactly.
const HAZARD_CONTROLS = new Set(['optional-require', 'require-at', 'depd', 'lodash', 'express', 'better-sqlite3', 'sql.js']);
const VALIDATOR_USED = new Set(gardenMap.validatorUsed);
const VALIDATOR_CEILING = gardenMap.validatorCeiling;

function scopeForFabId(fabId: string): Set<string> {
  const s = new Set<string>();
  for (const [npm, id] of Object.entries(fabOwnerById)) if (id === fabId) s.add(npm);
  return s;
}

// ---------------------------------------------------------------------------
// Classification (score.ts:47-82 ported: predicate swap `manifest.
// transformations` -> `state === 'predicted-removable-file' | stub.predicted`.
// The predicate `predicted-unreachable` is the exact non-transforming
// analogue of "a transformation was recorded" — garden.md §4.6.)
// ---------------------------------------------------------------------------
type Verdict =
  | { kind: 'achieved-fab'; id: string }
  | { kind: 'achieved-validator' }
  | { kind: 'false-removal'; why: string }
  | { kind: 'unsafe-optimism-star'; why: string }
  | { kind: 'unsafe-optimism-hazard-control'; why: string }
  | { kind: 'unsafe-optimism-fab-conservative'; why: string }
  | { kind: 'unlabeled-fab-passenger'; why: string }
  | { kind: 'out-of-scope' };

function classify(pkgName: string, symbol: string): Verdict {
  if (pkgName === 'validator') {
    return VALIDATOR_USED.has(symbol)
      ? { kind: 'false-removal', why: `validator::${symbol} is a used export (isEmail/isURL)` }
      : { kind: 'achieved-validator' };
  }
  if (HAZARD_CONTROLS.has(pkgName)) {
    return { kind: 'unsafe-optimism-hazard-control', why: `${pkgName} is a hazard/boundary real control — every symbol is MUST_RETAIN_CONSERVATIVELY by construction` };
  }
  if (starPkgs.has(pkgName)) {
    return { kind: 'unsafe-optimism-star', why: `${pkgName} is a starPackages ("*") member — every export is MUST_RETAIN_CONSERVATIVELY` };
  }
  if (fabOwned.has(pkgName)) {
    if (symbol === '*') {
      // The whole file was predicted removable but its export surface was not
      // even statically recognized (facts.exports empty). We cannot tell WHICH
      // symbol this is, so we cannot tell it is the labeled MUST_REMOVE one —
      // widen to a violation rather than assume the best case.
      return { kind: 'unsafe-optimism-fab-conservative', why: `${pkgName} predicted removable at file level with an unrecognized export surface (cannot confirm which export)` };
    }
    const direct = symbolIndex.get(`${pkgName}::${symbol}`) ?? byFabIdSymbol.get(`${fabOwnerById[pkgName]}::${symbol}`);
    if (!direct) {
      return { kind: 'unlabeled-fab-passenger', why: `${pkgName}::${symbol} has no ground-truth label (wiring carrier/passenger export) — never removable per garden.md §5.7/§4.2` };
    }
    if (direct.truth === 'MUST_REMOVE') return { kind: 'achieved-fab', id: direct.id };
    if (direct.truth === 'MUST_RETAIN') return { kind: 'false-removal', why: `${pkgName}::${symbol} is MUST_RETAIN` };
    return { kind: 'unsafe-optimism-fab-conservative', why: `${pkgName}::${symbol} is MUST_RETAIN_CONSERVATIVELY` };
  }
  return { kind: 'out-of-scope' };
}

// ---------------------------------------------------------------------------
// Predicted-removable extraction (design §10/§12): a predicted-removable FILE
// expands to every export of that module (we cannot know which export the
// consumer cared about once the whole module is gone); a retained file
// contributes only the stubs it actually predicts.
// ---------------------------------------------------------------------------
interface PredictedSymbol { pkgName: string; symbol: string; file: string; source: 'file' | 'stub' }

function pkgNameOf(pkgLabel: string): string {
  return pkgLabel.slice(0, pkgLabel.lastIndexOf('@'));
}

function predictedRemovableSymbols(report: HazardDomainReport, facts: Map<string, ModuleFacts>): PredictedSymbol[] {
  const out: PredictedSymbol[] = [];
  for (const f of report.files) {
    if (!f.pkg) continue; // report.ts only emits third-party files, which always carry pkg in fallback-ownership mode
    const pkgName = pkgNameOf(f.pkg);
    if (f.state === 'predicted-removable-file') {
      const mf = facts.get(f.rel);
      const names = mf && mf.exports.size > 0 ? [...mf.exports.keys()] : ['*'];
      for (const symbol of names) out.push({ pkgName, symbol, file: f.rel, source: 'file' });
      continue;
    }
    for (const sp of f.stubPredictions) if (sp.predicted) out.push({ pkgName, symbol: sp.symbol, file: f.rel, source: 'stub' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode-B pre-registered star-overbreadth predicate (task spec, ADR-0006 mode
// B). Applies ONLY to an isolation-mode hit on a starPackages CARRIER symbol;
// a combined-tree hit is always a straight violation. All four conditions
// must hold, or it is a soundness violation like any other.
// ---------------------------------------------------------------------------
function isCarrierStarOverbreadthFinding(
  fabId: string,
  pkgName: string,
  symbol: string,
  facts: Map<string, ModuleFacts>,
): boolean {
  const carrierNpm = npmPkgById.get(fabId);
  if (!carrierNpm || pkgName !== carrierNpm) return false; // (1) must be the carrier itself, not a nested target
  const owned = [...Object.entries(fabOwnerById)].filter(([, id]) => id === fabId).map(([npm]) => npm);
  if (!owned.some((npm) => npm !== carrierNpm)) return false; // (1) manifest mechanism must target a NESTED package
  const carrierFacts = [...facts.values()].find((m) => m.pkg?.name === carrierNpm);
  if (!carrierFacts || carrierFacts.surfaceOpen.length > 0) return false; // (2) carrier export surface statically closed
  if (carrierFacts.escapedLoader) return false; // (3) carrier module object does not escape (facts-level proxy)
  const w = wiringById.get(fabId);
  const mentions = (s: string) => new RegExp(`\\b${symbol}\\b`).test(s); // word-boundary: avoid a substring false-positive
  const referencesSymbol = !!w && (mentions(w.importStmt) || w.routes.some((r) => mentions(r.expr)));
  if (referencesSymbol) return false; // (4) no route/import references the symbol
  return true;
}

// ---------------------------------------------------------------------------
// Soundness evaluation shared by modes A, B, C.
// ---------------------------------------------------------------------------
interface Violation { pkgName: string; symbol: string; file: string; kind: string; why: string }
interface Finding { pkgName: string; symbol: string; file: string; why: string }
interface SoundnessResult {
  violations: Violation[];
  findings: Finding[];
  achievedFab: Map<string, string>; // `${id}:${symbol}` -> pkgName
  achievedValidator: Set<string>;
  outOfScope: PredictedSymbol[];
}

function evaluateSoundness(predicted: PredictedSymbol[], facts: Map<string, ModuleFacts>, isolationFabId?: string): SoundnessResult {
  const violations: Violation[] = [];
  const findings: Finding[] = [];
  const achievedFab = new Map<string, string>();
  const achievedValidator = new Set<string>();
  const outOfScope: PredictedSymbol[] = [];
  for (const p of predicted) {
    const v = classify(p.pkgName, p.symbol);
    if (v.kind === 'achieved-fab') { achievedFab.set(`${v.id}:${p.symbol}`, p.pkgName); continue; }
    if (v.kind === 'achieved-validator') { achievedValidator.add(p.symbol); continue; }
    if (v.kind === 'out-of-scope') { outOfScope.push(p); continue; }
    if (v.kind === 'unsafe-optimism-star' && isolationFabId && isCarrierStarOverbreadthFinding(isolationFabId, p.pkgName, p.symbol, facts)) {
      findings.push({ pkgName: p.pkgName, symbol: p.symbol, file: p.file, why: `${v.why} — pre-registered carrier star-overbreadth FINDING (ADR-0006 mode B predicate), not a soundness failure` });
      continue;
    }
    violations.push({ pkgName: p.pkgName, symbol: p.symbol, file: p.file, kind: v.kind, why: v.why });
  }
  return { violations, findings, achievedFab, achievedValidator, outOfScope };
}

// ---------------------------------------------------------------------------
// Per-MUST_REMOVE blocking-set reporting (garden.md §4.6: blockingReasons /
// StubPrediction.blockingSet is already ADR-0006's blocking-set — union it
// across every physical file that can carry this logical symbol).
// ---------------------------------------------------------------------------
function ownerFromSpec(spec: string): string {
  const idx = spec.lastIndexOf('node_modules/');
  const rel = idx >= 0 ? spec.slice(idx + 'node_modules/'.length) : spec;
  const parts = rel.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

interface MustRemoveStatus { id: string; symbol: string; achieved: boolean; blockingSet: GateTag[] }

function mustRemoveStatus(entry: MustRemoveEntry, report: HazardDomainReport, facts: Map<string, ModuleFacts>): MustRemoveStatus {
  const npmPkgs = new Set([entry.npmPkg, ...entry.loaders.map((l) => ownerFromSpec(l.spec))]);
  let achieved = false;
  const blocking = new Set<GateTag>();
  for (const f of report.files) {
    if (!f.pkg || !npmPkgs.has(pkgNameOf(f.pkg))) continue;
    if (f.state === 'predicted-removable-file') {
      // Credit this MUST_REMOVE symbol as achieved only when we can AFFIRM it
      // lives in this specific removed file (a package can own more than one
      // physical file, e.g. esm-reexport's index.js + impl.js). An unrecognized
      // export surface (mf missing / exports empty) is doubt, not confirmation
      // — it must never be silently read as "yes this was the one" (that would
      // narrow uncertainty into an achieved credit, which soundness forbids).
      const mf = facts.get(f.rel);
      if (mf?.exports.has(entry.symbol)) achieved = true;
      continue;
    }
    const sp = f.stubPredictions.find((s) => s.symbol === entry.symbol);
    if (sp) {
      if (sp.predicted) achieved = true;
      else for (const g of sp.blockingSet) blocking.add(g);
    } else if (f.blockingSet.length > 0) {
      // No symbol-level decision exists for this file at all (e.g. an opaque
      // or global-hazard-widened module never reaches per-symbol projection);
      // the file's own blocking-set is the best available "why" — widen to it
      // rather than report an empty (and misleadingly clean) blocking-set.
      for (const g of f.blockingSet) blocking.add(g);
    }
  }
  return { id: entry.id, symbol: entry.symbol, achieved, blockingSet: [...blocking].sort() };
}

// ---------------------------------------------------------------------------
// Mode-B isolation entry generation (garden.md §4.4: importStmt ALONE is not
// faithful — esm-namespace-clean's mechanism lives in the route expression,
// not the import. `req` stays an opaque function parameter; the wiring exprs
// that read `req.query.*` / `req.url` are used verbatim so no literal
// specifier value is ever inlined — garden.md §5.15 / wiring notes.)
// ---------------------------------------------------------------------------
function isolationEntrySource(pkg: WiringPkg): string {
  const lines = [pkg.importStmt];
  pkg.routes.forEach((r, i) => {
    const asyncKw = r.awaited ? 'async ' : '';
    lines.push(`export ${asyncKw}function __r${i}(req){ return ( ${r.expr} ); }`);
  });
  return `${lines.join('\n')}\n`;
}

function cleanupConformanceEntries(): void {
  for (const name of readdirSync(APP)) {
    if (/^\.conformance-.*\.mjs$/.test(name)) rmSync(path.join(APP, name), { force: true });
  }
}

// ===========================================================================
// main
// ===========================================================================
const REFINEMENTS: RefinementName[] = [
  'SR-vm-known-globals',
  'SR-subpath-exports-narrowing',
  'SR-import-condition-resolution',
  'SR-cross-module-wrapper',
];

async function main() {
  cleanupConformanceEntries(); // defensive: a prior crashed run may have left stragglers
  const t0 = Date.now();
  const warnings: string[] = [];

  // ---- Mode A: combined strict run ----------------------------------------
  console.log('[A] combined strict run…');
  const entryCombined = path.join(APP, 'server.mjs');
  const prepMain: PreparedApp = await prepareHazardDomain({ app: 'garden', entry: entryCombined, nft: true });
  const reportA = analyzePrepared(prepMain, { label: 'strict' });
  const predictedA = predictedRemovableSymbols(reportA, prepMain.facts);
  const soundA = evaluateSoundness(predictedA, prepMain.facts);
  const mustRemoveA = gardenMap.mustRemove.map((m) => mustRemoveStatus(m, reportA, prepMain.facts));
  const achievedFabA = mustRemoveA.filter((m) => m.achieved).length;
  console.log(`    achieved fab ${achievedFabA}/${gardenMap.mustRemove.length}, achieved validator ${soundA.achievedValidator.size}/${VALIDATOR_CEILING}, violations ${soundA.violations.length}`);

  // ---- Mode B: isolation sweep (47 fab packages) --------------------------
  console.log('[B] isolation sweep (47 packages)…');
  const modeB: any[] = [];
  try {
    for (const pkg of wiring.packages) {
      const entryPath = path.join(APP, `.conformance-${pkg.id}.mjs`);
      writeFileSync(entryPath, isolationEntrySource(pkg));
      try {
        const prep = await prepareHazardDomain({ app: `garden-iso-${pkg.id}`, entry: entryPath, nft: true });
        const report = analyzePrepared(prep, { label: `isolation:${pkg.id}` });
        const scope = scopeForFabId(pkg.id);
        const predictedAll = predictedRemovableSymbols(report, prep.facts);
        const predicted = predictedAll.filter((p) => scope.has(p.pkgName));
        const swept = predictedAll.length - predicted.length; // informational: other packages this tiny entry never reaches
        const sound = evaluateSoundness(predicted, prep.facts, pkg.id);
        const own = gardenMap.mustRemove.filter((m) => m.id === pkg.id).map((m) => mustRemoveStatus(m, report, prep.facts));
        modeB.push({
          id: pkg.id,
          npmPkg: npmPkgById.get(pkg.id) ?? null,
          achieved: own.filter((m) => m.achieved).length,
          ceiling: own.length,
          mustRemoveStatus: own,
          violations: sound.violations,
          findings: sound.findings,
          sweptOutOfScope: swept,
        });
        console.log(`    ${pkg.id.padEnd(38)} ceiling=${own.length} achieved=${own.filter((m) => m.achieved).length} violations=${sound.violations.length} findings=${sound.findings.length}`);
      } finally {
        rmSync(entryPath, { force: true });
      }
    }
  } finally {
    cleanupConformanceEntries();
  }
  const modeBViolations = modeB.flatMap((p) => p.violations.map((v: Violation) => ({ package: p.id, ...v })));
  const modeBFindings = modeB.flatMap((p) => p.findings.map((f: Finding) => ({ package: p.id, ...f })));
  const isoAchievedFab = modeB.reduce((n, p) => n + p.achieved, 0);
  const isoCeilingFab = modeB.reduce((n, p) => n + p.ceiling, 0);

  // ---- Mode C: sound-refinement counterfactuals on the combined tree -----
  console.log('[C] sound-refinement counterfactuals…');
  const modeC: any[] = [];
  for (const name of REFINEMENTS) {
    const report = analyzePrepared(prepMain, { refinements: [name], label: `SR:${name}` });
    const predicted = predictedRemovableSymbols(report, prepMain.facts);
    const sound = evaluateSoundness(predicted, prepMain.facts); // no isolationFabId: combined-tree gate, same as A
    const mr = gardenMap.mustRemove.map((m) => mustRemoveStatus(m, report, prepMain.facts));
    modeC.push({
      refinement: name,
      netReduction: report.netReduction,
      achievedFab: mr.filter((m) => m.achieved).length,
      achievedValidator: sound.achievedValidator.size,
      violations: sound.violations,
      findings: sound.findings,
      mustRemoveStatus: mr,
    });
    console.log(`    ${name.padEnd(32)} achieved fab=${mr.filter((m) => m.achieved).length}/${gardenMap.mustRemove.length} violations=${sound.violations.length}`);
  }
  // Specific pre-registered asserts for SR-vm-known-globals.
  const vmSr = modeC.find((c) => c.refinement === 'SR-vm-known-globals')!;
  const vmInjectedLoaderStillRetained = !vmSr.violations.some(
    (v: Violation) => v.pkgName === 'fab-vm-injected-loader' || v.pkgName === 'vil-target',
  );
  const vmNoLoaderStatus = vmSr.mustRemoveStatus.find((m: MustRemoveStatus) => m.id === 'vm-no-loader')!;
  // ...also under SR-vm-known-globals IN ISOLATION (expected yes per garden.md §5.5/§4.5).
  console.log('[C] vm-no-loader isolation entry under SR-vm-known-globals…');
  const vmNoLoaderPkg = wiringById.get('vm-no-loader')!;
  const vmEntryPath = path.join(APP, `.conformance-vm-no-loader-sr.mjs`);
  let vmNoLoaderIsolationSr: MustRemoveStatus;
  writeFileSync(vmEntryPath, isolationEntrySource(vmNoLoaderPkg));
  try {
    const prep = await prepareHazardDomain({ app: 'garden-iso-vm-no-loader-sr', entry: vmEntryPath, nft: true });
    const report = analyzePrepared(prep, { refinements: ['SR-vm-known-globals'], label: 'isolation:vm-no-loader+SR-vm-known-globals' });
    vmNoLoaderIsolationSr = mustRemoveStatus(gardenMap.mustRemove.find((m) => m.id === 'vm-no-loader')!, report, prep.facts);
  } finally {
    rmSync(vmEntryPath, { force: true });
  }
  console.log(`    combined tree: reclaimed=${vmNoLoaderStatus.achieved}  isolation: reclaimed=${vmNoLoaderIsolationSr.achieved}`);

  // ---- Mode D: gate-off counterfactuals (diagnostic, exempt from the gate) --
  console.log('[D] gate-off counterfactuals (UNSOUND-DIAGNOSTIC)…');
  const candidateGates = new Set<GateTag>();
  for (const m of mustRemoveA) for (const g of m.blockingSet) candidateGates.add(g);
  for (const p of modeB) for (const m of p.mustRemoveStatus as MustRemoveStatus[]) for (const g of m.blockingSet) candidateGates.add(g);
  for (const g of UNSUPPRESSIBLE_GATES) candidateGates.delete(g); // never suppressible; the engine would refuse anyway

  const baselineFab = achievedFabA;
  const baselineValidator = soundA.achievedValidator.size;
  const singleGate: { gate: GateTag; achievedFab: number; achievedFabDelta: number; achievedValidator: number; achievedValidatorDelta: number; netReduction: number }[] = [];
  for (const gate of candidateGates) {
    const report = analyzePrepared(prepMain, { suppressGates: [gate], label: `gate-off:${gate}` });
    const predicted = predictedRemovableSymbols(report, prepMain.facts);
    // No soundness gate here BY DESIGN — this is the diagnostic, unsound path.
    const achFab = predicted.filter((p) => classify(p.pkgName, p.symbol).kind === 'achieved-fab').length;
    const achVal = predicted.filter((p) => classify(p.pkgName, p.symbol).kind === 'achieved-validator').length;
    singleGate.push({ gate, achievedFab: achFab, achievedFabDelta: achFab - baselineFab, achievedValidator: achVal, achievedValidatorDelta: achVal - baselineValidator, netReduction: report.netReduction });
  }
  singleGate.sort((a, b) => b.achievedFabDelta - a.achievedFabDelta || b.achievedValidatorDelta - a.achievedValidatorDelta);
  console.log(`    ${singleGate.length} candidate gate(s): ${singleGate.map((g) => `${g.gate}(+${g.achievedFabDelta})`).join(', ')}`);

  const topN = singleGate.slice(0, Math.min(5, singleGate.length)).map((g) => g.gate);
  const pairwise: { gates: [GateTag, GateTag]; achievedFab: number; achievedFabDelta: number; achievedValidator: number; achievedValidatorDelta: number }[] = [];
  for (let i = 0; i < topN.length; i++) {
    for (let j = i + 1; j < topN.length; j++) {
      const gates: [GateTag, GateTag] = [topN[i]!, topN[j]!];
      const report = analyzePrepared(prepMain, { suppressGates: gates, label: `gate-off:${gates.join('+')}` });
      const predicted = predictedRemovableSymbols(report, prepMain.facts);
      const achFab = predicted.filter((p) => classify(p.pkgName, p.symbol).kind === 'achieved-fab').length;
      const achVal = predicted.filter((p) => classify(p.pkgName, p.symbol).kind === 'achieved-validator').length;
      pairwise.push({ gates, achievedFab: achFab, achievedFabDelta: achFab - baselineFab, achievedValidator: achVal, achievedValidatorDelta: achVal - baselineValidator });
    }
  }
  pairwise.sort((a, b) => b.achievedFabDelta - a.achievedFabDelta || b.achievedValidatorDelta - a.achievedValidatorDelta);
  console.log(`    top pairwise: ${pairwise.slice(0, 3).map((p) => `${p.gates.join('+')}(+${p.achievedFabDelta})`).join(', ')}`);

  // ===========================================================================
  // assemble + write output
  // ===========================================================================
  const soundnessViolations = [
    ...soundA.violations.map((v) => ({ mode: 'A', ...v })),
    ...modeBViolations.map((v) => ({ mode: 'B', ...v })),
    ...modeC.flatMap((c) => c.violations.map((v: Violation) => ({ mode: `C:${c.refinement}`, ...v }))),
  ];
  const findings = [
    ...soundA.findings.map((f) => ({ mode: 'A', ...f })),
    ...modeBFindings.map((f) => ({ mode: 'B', ...f })),
    ...modeC.flatMap((c) => c.findings.map((f: Finding) => ({ mode: `C:${c.refinement}`, ...f }))),
  ];
  const exitCode = soundnessViolations.length > 0 ? 2 : 0;

  const machine = {
    $schema: 'reducer-hazard-domain-garden-conformance/1',
    generatedAt: new Date().toISOString(),
    analyzerVersion: reportA.analyzerVersion,
    analyzerSourceHash: reportA.analyzerSourceHash,
    analysisMs: Date.now() - t0,
    modeA: {
      D: reportA.D,
      E_predicted: reportA.E_predicted,
      netReduction: reportA.netReduction,
      achievedFab: { achieved: achievedFabA, ceiling: gardenMap.mustRemove.length },
      achievedValidator: { achieved: soundA.achievedValidator.size, ceiling: VALIDATOR_CEILING },
      violations: soundA.violations,
      findings: soundA.findings,
      mustRemoveStatus: mustRemoveA,
      warnings: reportA.warnings,
      widenedCount: reportA.widened.length,
      distributions: reportA.distributions,
      stats: reportA.stats,
    },
    modeB: {
      achievedFab: { achieved: isoAchievedFab, ceiling: isoCeilingFab },
      globalHazardBlastRadiusDelta: { fab: isoAchievedFab - achievedFabA }, // the delta A vs B IS the blast-radius headline (garden.md §4.6 #4)
      packages: modeB,
      violations: modeBViolations,
      findings: modeBFindings,
    },
    modeC: {
      refinements: modeC,
      asserts: {
        vmInjectedLoaderStillRetained,
        vmNoLoaderReclaimedCombined: vmNoLoaderStatus.achieved,
        vmNoLoaderReclaimedIsolation: vmNoLoaderIsolationSr.achieved,
      },
    },
    modeD: {
      label: 'UNSOUND-DIAGNOSTIC — exempt from the soundness gate; upper bounds only, conditional on all other gates remaining conservative',
      baseline: { achievedFab: baselineFab, achievedValidator: baselineValidator },
      singleGate,
      topPairwise: pairwise,
    },
    soundness: {
      violationCount: soundnessViolations.length,
      violations: soundnessViolations,
      findingCount: findings.length,
      findings,
      verdict: soundnessViolations.length === 0 ? 'SOUND — no MUST_RETAIN/MUST_RETAIN_CONSERVATIVELY symbol was predicted-removable' : 'SOUNDNESS VIOLATION',
    },
    warnings,
    exitCode,
  };
  mkdirSync(HERE, { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(machine, null, 2));

  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
  const md = `# Garden conformance — hazard-domain analyzer (ADR-0006)

Non-transforming. ${machine.analyzerVersion} @ ${machine.analyzerSourceHash.slice(0, 12)}. Generated ${machine.generatedAt}.

## Soundness verdict

**${machine.soundness.verdict}** — ${machine.soundness.violationCount} violation(s), ${machine.soundness.findingCount} pre-registered finding(s) (star-overbreadth, non-fatal).

${soundnessViolations.length > 0 ? soundnessViolations.map((v) => `- **[${v.mode}]** \`${v.pkgName}::${v.symbol}\` (${v.kind}): ${v.why}`).join('\n') : '_no violations._'}

${findings.length > 0 ? `### Findings (non-fatal, ADR-0006 mode B predicate)\n\n${findings.map((f) => `- **[${f.mode}]** \`${f.pkgName}::${f.symbol}\`: ${f.why}`).join('\n')}\n` : ''}

## Mode A — combined strict run (the real-app condition)

| metric | value |
|---|---|
| D (universe third-party JS bytes) | ${reportA.D.toLocaleString()} |
| E_predicted | ${reportA.E_predicted.toLocaleString()} |
| net reduction | ${(reportA.netReduction * 100).toFixed(2)}% |
| achieved/ceiling (fab) | ${achievedFabA}/${gardenMap.mustRemove.length} = ${pct(achievedFabA, gardenMap.mustRemove.length)} |
| achieved/ceiling (validator) | ${soundA.achievedValidator.size}/${VALIDATOR_CEILING} = ${pct(soundA.achievedValidator.size, VALIDATOR_CEILING)} |

### Per-MUST_REMOVE blocking sets (combined tree)

| id | symbol | achieved | blocking set |
|---|---|---|---|
${mustRemoveA.map((m) => `| ${m.id} | ${m.symbol} | ${m.achieved ? '✓' : '✗'} | ${m.blockingSet.join(', ') || '—'} |`).join('\n')}

## Mode B — isolation sweep (47 fab packages)

Per-package soundness join restricted to that package's own fab-owned packages (garden.md §4.1) — a hit on an unrelated, unreached package is expected and not reported as a violation.

achieved/ceiling (fab, sum over packages): **${isoAchievedFab}/${isoCeilingFab}** vs combined-tree **${achievedFabA}/${gardenMap.mustRemove.length}** — the delta (${isoAchievedFab - achievedFabA}) is the global-hazard blast-radius headline.

| package | ceiling | achieved | violations | findings |
|---|---|---|---|---|
${modeB.filter((p) => p.ceiling > 0 || p.violations.length > 0 || p.findings.length > 0).map((p) => `| ${p.id} | ${p.ceiling} | ${p.achieved} | ${p.violations.length} | ${p.findings.length} |`).join('\n')}

## Mode C — sound-refinement counterfactuals (combined tree)

| refinement | achieved fab | achieved validator | violations | net reduction |
|---|---|---|---|---|
${modeC.map((c) => `| ${c.refinement} | ${c.achievedFab}/${gardenMap.mustRemove.length} | ${c.achievedValidator}/${VALIDATOR_CEILING} | ${c.violations.length} | ${(c.netReduction * 100).toFixed(2)}% |`).join('\n')}

### SR-vm-known-globals asserts

- vm-injected-loader (\`{ require }\` context) still fully retained: **${vmInjectedLoaderStillRetained ? 'yes (correct)' : 'NO — DEFECT'}**
- vm-no-loader:deadNoLoader reclaimed on the **combined tree**: ${vmNoLoaderStatus.achieved ? 'yes' : 'no'}
- vm-no-loader:deadNoLoader reclaimed in **isolation**: ${vmNoLoaderIsolationSr.achieved ? 'yes (expected)' : 'no'}

## Mode D — gate-off counterfactuals (UNSOUND-DIAGNOSTIC, exempt from the gate)

Upper bounds only, each conditional on every other gate remaining conservative (ADR-0006). Never a rescue by itself.

| gate | achieved-fab Δ | achieved-validator Δ | net reduction |
|---|---|---|---|
${singleGate.map((g) => `| ${g.gate} | +${g.achievedFabDelta} | +${g.achievedValidatorDelta} | ${(g.netReduction * 100).toFixed(2)}% |`).join('\n')}

### Top pairwise combinations (among the top ${topN.length} single gates)

| gates | achieved-fab Δ | achieved-validator Δ |
|---|---|---|
${pairwise.slice(0, 10).map((p) => `| ${p.gates.join(' + ')} | +${p.achievedFabDelta} | +${p.achievedValidatorDelta} |`).join('\n')}

---
Analysis wall time: ${(machine.analysisMs / 1000).toFixed(1)}s.
`;
  writeFileSync(OUT_MD, md);
  console.log(md);
  return exitCode;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error('garden-conformance harness failed:', err);
  code = 1;
} finally {
  cleanupConformanceEntries();
}
process.exit(code);
