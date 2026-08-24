/**
 * Experiment A's closed static-traced artifact (A2).
 *
 * A2 contains ONLY the `@vercel/nft` trace of the pinned entrypoint — the same
 * strategy Next.js `output: "standalone"` ships. Files outside the trace are
 * physically absent, which is the whole point: A2 and A3 make the SAME
 * placement decision, and only recoverability differs.
 *
 * Symlinks whose target survives are kept: dropping them would break
 * resolution for reasons that have nothing to do with tracing, and would
 * manufacture failures instead of measuring the real ones.
 *
 * Usage: bun benchmarks/lazy-oci/a2.ts --app <name>
 */
import { linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { realpath } from '@reducer/production-universe';
import { APPS } from './apps.ts';
import { WORK_ROOT, type AppPlan } from './plan.ts';

function build(app: string): void {
  const plan: AppPlan = JSON.parse(readFileSync(path.join(WORK_ROOT, 'plans', `${app}.json`), 'utf8'));
  const keep = new Set<string>();
  for (const rel of plan.nft) {
    try {
      keep.add(realpath(path.join(plan.stage, rel)));
    } catch {
      /* the trace named something the staging tree does not physically hold */
    }
  }
  const dirPrefixes = new Set<string>();
  for (const real of keep) {
    let d = path.dirname(real);
    while (d.length > 1 && !dirPrefixes.has(d)) {
      dirPrefixes.add(d);
      d = path.dirname(d);
    }
  }
  const dst = path.join(WORK_ROOT, 'a2', app);
  rmSync(dst, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  const walk = (rel: string): boolean => {
    const from = path.join(plan.stage, rel);
    const to = path.join(dst, rel);
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return false;
    }
    mkdirSync(to, { recursive: true });
    let kept = false;
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childFrom = path.join(plan.stage, childRel);
      if (e.isSymbolicLink()) {
        try {
          const real = realpath(childFrom);
          const ok = statSync(real).isDirectory() ? dirPrefixes.has(real) : keep.has(real);
          if (!ok) continue;
          symlinkSync(readlinkSync(childFrom), path.join(dst, childRel));
          kept = true;
        } catch {
          /* dangling or unreadable */
        }
        continue;
      }
      if (e.isDirectory()) {
        if (walk(childRel)) kept = true;
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const real = realpath(childFrom);
        if (!keep.has(real)) continue;
        linkSync(childFrom, path.join(dst, childRel));
        files++;
        bytes += statSync(childFrom).size;
        kept = true;
      } catch {
        /* unreadable */
      }
    }
    if (!kept) rmSync(to, { recursive: true, force: true });
    return kept;
  };
  walk('');
  console.log(
    `[${app}] A2 (closed NFT trace): ${files} files / ${(bytes / 1e6).toFixed(1)} MB ` +
      `(A1 universe: ${plan.files.length} files / ${(plan.universeBytes / 1e6).toFixed(1)} MB, ` +
      `${((1 - bytes / plan.universeBytes) * 100).toFixed(1)}% omitted)`,
  );
}

const { values } = parseArgs({ options: { app: { type: 'string' }, all: { type: 'boolean' } } });
for (const app of values.all ? APPS.map((a) => a.name) : [values.app!]) build(app);
