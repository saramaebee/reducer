/**
 * Record the behavioral oracle: boot the ORIGINAL service and store the
 * response of every non-__force endpoint as a request→response contract.
 * Bodies must be deterministic; recording twice and diffing enforces that.
 *
 * Usage: bun benchmarks/garden/tools/record-fixtures.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { GARDEN, APP, bootServer, fetchEntry, type ContractEntry } from './lib.ts';

const map = JSON.parse(readFileSync(path.join(GARDEN, 'garden-map.json'), 'utf8'));
const paths: string[] = map.routes.map((r: any) => r.path);

const server = await bootServer(APP);
try {
  const entries: ContractEntry[] = [];
  for (const p of paths) {
    const a = await fetchEntry(server.base, p);
    const b = await fetchEntry(server.base, p); // determinism probe
    if (a.status !== b.status || a.body !== b.body) {
      throw new Error(`NON-DETERMINISTIC endpoint ${p}:\n  first:  ${a.body.slice(0, 200)}\n  second: ${b.body.slice(0, 200)}`);
    }
    if (a.status !== 200) {
      console.error(`WARNING: ${p} recorded with status ${a.status}: ${a.body.slice(0, 200)}`);
    }
    entries.push({ path: p, status: a.status, contentType: a.contentType, body: a.body });
  }
  mkdirSync(path.join(GARDEN, 'fixtures'), { recursive: true });
  writeFileSync(
    path.join(GARDEN, 'fixtures', 'contracts.json'),
    JSON.stringify({ $schema: 'reducer-garden-contracts/1', entries }, null, 2),
  );
  const non200 = entries.filter((e) => e.status !== 200).length;
  console.log(`recorded ${entries.length} contracts (${non200} non-200) → fixtures/contracts.json`);
  if (non200 > 0) process.exit(2);
} finally {
  await server.kill();
}
