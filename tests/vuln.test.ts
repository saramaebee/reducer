import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixture, installTest, runNodeTest } from './helpers.ts';

/**
 * Vulnerability-removal experiment: a package that must remain, whose
 * vulnerable-but-unused API is proven unreachable and physically removed.
 * The fixture's own test.mjs asserts the fail-closed chain end to end.
 */
describe('vuln-template: localized vulnerable API removed, package preserved', async () => {
  const { manifest, outDir } = await buildFixture('vuln-template');

  test('exactly the vulnerable symbol is stubbed; safe API untouched', () => {
    const stubbed = manifest.transformations.map((t) => t.symbol);
    expect(stubbed).toEqual(['merge']);
    const get = manifest.verdicts.find((v) => v.symbol === 'get');
    expect(get?.state).toBe('proven-reachable');
  });

  test('vulnerable bytes physically absent; safe API + stub present', () => {
    const src = readFileSync(path.join(outDir, 'node_modules/minilodash/index.cjs'), 'utf8');
    expect(src).toContain('function get');
    expect(src).not.toContain('pollutable');
    expect(src).toContain('ReducerReachabilityViolation');
  });

  test('reduced tree passes fail-closed suite under stock node', () => {
    installTest('vuln-template', outDir);
    const r = runNodeTest(outDir);
    expect(r.output).toContain('fixture-vuln-template: ok');
    expect(r.status).toBe(0);
  });

  test('manifest yields VEX not_affected/code_not_present evidence', () => {
    const mapPath = path.join(outDir, 'vuln-map.json');
    writeFileSync(
      mapPath,
      JSON.stringify([{ id: 'CVE-SIM-0001', package: 'minilodash', symbol: 'merge' }]),
    );
    writeFileSync(path.join(outDir, 'm.json'), JSON.stringify(manifest));
    const r = spawnSync(
      process.execPath.includes('bun') ? 'bun' : 'bunx',
      ['benchmarks/vex.ts', path.join(outDir, 'm.json'), mapPath],
      { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
    );
    const vex = JSON.parse(r.stdout);
    expect(vex.records[0].status).toBe('not_affected');
    expect(vex.records[0].justification).toBe('vulnerable_code_not_present');
    expect(vex.records[0].evidence.bytesRemoved).toBeGreaterThan(0);
  });
});
