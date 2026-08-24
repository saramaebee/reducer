/**
 * The post-admission traffic model.
 *
 * The scenario being modelled is a scale-out pod: it finishes prewarming, is
 * admitted to the service, and immediately receives ordinary traffic in which
 * one of several unusual requests happens to arrive first. Which unusual
 * request is first is the whole question — an arm that covers the tenant path
 * but not the error path looks excellent or terrible depending on the draw — so
 * the arrival order of the long-tail GROUPS is rotated across trial families
 * and every arm at every budget sees the identical sequence for a given family.
 *
 * Groups, not individual requests, are the permuted unit: a publish→deprecate→
 * unpublish lifecycle or an authenticate-then-use pair is one piece of
 * application behaviour and cannot be shuffled internally without breaking it.
 *
 * WARM-ORDER CONTAMINATION, stated rather than assumed away. Within one trial,
 * an earlier long-tail group can hydrate files a later one needs. Two things
 * bound it:
 *   1. the family rotation puts a different group in the first slot, so the
 *      uncontaminated "first unusual request on a cold pod" measurement exists
 *      for FAMILIES distinct groups per app;
 *   2. per-category COVERAGE — which of a category's files a budget did and did
 *      not prewarm — is computed analytically from the ranked set against the
 *      per-category first-touch oracle, so it is exact for every category and
 *      cannot be contaminated by execution order at all.
 * Measured first-hit latency is therefore always reported with the group's
 * arrival position, and the headline first-hit number is position 1 only.
 */
import type { LongTailGroup, Req, Workload } from './workloads.ts';

/** Preregistered: four cold trial families per (app, arm, budget). */
export const FAMILIES = 4;
/** Preregistered: post-admission requests per pass, per trial. */
export const STREAM_LENGTH = 400;

export interface TrafficStep {
  req: Req;
  kind: 'prelude' | 'common' | 'longtail';
  group?: string;
  category?: string;
  /** 1 for a group's first arrival in this stream, 2+ for later repeats */
  occurrence?: number;
  /** the group's arrival position among long-tail groups (1 = first unusual) */
  position?: number;
}

/** Rotate so a different group leads in each family, deterministically. */
export function rotateGroups(groups: LongTailGroup[], family: number): LongTailGroup[] {
  const k = groups.length;
  if (k === 0) return [];
  const stride = Math.max(1, Math.ceil(k / FAMILIES));
  const off = (family * stride) % k;
  return [...groups.slice(off), ...groups.slice(0, off)];
}

export function buildTraffic(w: Workload, family: number, length = STREAM_LENGTH): TrafficStep[] {
  const steps: TrafficStep[] = [];
  for (const req of w.prelude) steps.push({ req, kind: 'prelude' });

  const order = rotateGroups(w.longTail, family);
  const seenCount = new Map<string, number>();
  let ci = 0;
  const common = w.common;
  const pushCommon = (n: number) => {
    for (let i = 0; i < n; i++) {
      steps.push({ req: common[ci % common.length]!, kind: 'common' });
      ci++;
    }
  };
  const pushGroup = (g: LongTailGroup, position: number) => {
    const occ = (seenCount.get(g.id) ?? 0) + 1;
    seenCount.set(g.id, occ);
    for (const req of g.requests) {
      steps.push({ req, kind: 'longtail', group: g.id, category: g.category, occurrence: occ, position });
    }
  };

  // phase 1 — every long-tail group arrives once, each preceded by two ordinary
  // requests, so the first unusual request lands at stream position 3.
  order.forEach((g, i) => {
    pushCommon(2);
    pushGroup(g, i + 1);
  });

  // phase 2 — the same mixture continues: four ordinary requests, then one
  // repeatable long-tail group, cycling, until the stream length is reached.
  const repeatable = order.filter((g) => g.repeatable);
  let ri = 0;
  while (steps.length - w.prelude.length < length) {
    pushCommon(4);
    if (repeatable.length) {
      pushGroup(repeatable[ri % repeatable.length]!, 0);
      ri++;
    }
  }
  return steps;
}

/** Flatten to the wire format the in-container driver consumes. */
export function toWire(steps: TrafficStep[]): unknown[] {
  return steps.map((s) => ({
    ...(s.req as Req),
    kind: s.kind,
    group: s.group ?? null,
    category: s.category ?? null,
    occurrence: s.occurrence ?? null,
    position: s.position ?? null,
  }));
}

/** The TRAIN stream: startup plus the common set, cycled. Never a measured trial. */
export function buildTrain(w: Workload, cycles = 6): unknown[] {
  const out: Req[] = [...w.prelude];
  for (let c = 0; c < cycles; c++) out.push(...w.common);
  return out.map((r) => ({ ...r, kind: 'common', group: null, category: null, occurrence: null, position: null }));
}
