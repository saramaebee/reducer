import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, type RunResult } from '@reducer/cli';

export const FIXTURES = path.resolve(import.meta.dirname, '..', 'fixtures');

export async function buildFixture(name: string): Promise<RunResult & { outDir: string }> {
  const outDir = mkdtempSync(path.join(tmpdir(), `reducer-${name}-`));
  const result = await run({
    entry: path.join(FIXTURES, name, 'app.mjs'),
    outDir,
    write: true,
  });
  return { ...result, outDir };
}

/** Run a fixture's own test file under stock `node` in the given directory. */
export function runNodeTest(dir: string, script = 'test.mjs'): { status: number | null; output: string } {
  const res = spawnSync(process.execPath.includes('bun') ? 'node' : process.execPath, [script], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: res.status, output: `${res.stdout}\n${res.stderr}` };
}

/** Copy the fixture's test file into the reduced output so it can run there. */
export function installTest(fixture: string, outDir: string, script = 'test.mjs'): void {
  cpSync(path.join(FIXTURES, fixture, script), path.join(outDir, script));
}
