/**
 * Container adaptation of the experiment-2 workload recipes, plus the
 * TRAIN / HELD-OUT TEST split (DESIGN.md §4).
 *
 * The recipes themselves are NOT edited: `benchmarks/hydration/recipes.ts`
 * stays the single source of what each application's representative workload
 * is. This module only rewrites the things that are host-specific (macOS
 * scratch paths, the asdf node binary, loopback service addresses) and states
 * which phases are TRAIN and which are held out.
 *
 * Split rule, fixed before any result was viewed:
 *   TRAIN = startup + phase "common"
 *   TEST  = startup + every other phase ("full", "extended")
 * Startup is shared. No TEST request appears in TRAIN.
 */
import { RECIPES, type HttpRequest, type Phase } from '../hydration/recipes.ts';

const MAC_SCRATCH = '/var/folders/ty/n54xqmds5tggd10mptbn2hwc0000gn/T/reducer-hydration';
const MAC_NODE = '/Users/sara/.asdf/installs/nodejs/24.19.0/bin/node';

/** Where the lazy mount is presented inside the trial container. */
export const APP_MOUNT = '/mnt/app';
/** An eager, non-lazy copy of the same tree, used ONLY by setup scaffolding. */
export const EAGER_MOUNT = '/eager';

export interface LinuxRecipe {
  app: string;
  argv: string[];
  cwdRel: string | null;
  env: Record<string, string>;
  /** scaffolding: DB create/migrate/seed. Runs against EAGER_MOUNT, never the lazy mount. */
  setup: string[];
  ready: { kind: 'stdout' | 'http' | 'tcp' | 'none'; value?: string; port?: number; timeoutMs: number };
  settleMs: number;
  port: number;
  baseUrl: string;
  train: Phase[];
  test: Phase[];
  quality: string;
  deviations: string[];
}

const rewrite = (s: string, appDir: string): string =>
  s
    .replaceAll('{{clone}}', appDir)
    .replaceAll(MAC_SCRATCH, '/scratch')
    .replaceAll(MAC_NODE, 'node')
    .replaceAll('127.0.0.1:5432', 'reducer-pg:5432')
    .replaceAll('127.0.0.1:27017', 'reducer-mongo:27017')
    .replaceAll('127.0.0.1:6379', 'reducer-redis:6379')
    .replaceAll('127.0.0.1:3306', 'reducer-mysql:3306')
    .replaceAll('postgres://sara@', 'postgres://sara:reducer@')
    .replaceAll('postgresql://sara@', 'postgresql://sara:reducer@');

/** The app must listen on all interfaces: the workload driver runs on the host. */
const unbindLoopback = (s: string): string => s.replaceAll('--host=127.0.0.1', '--host=0.0.0.0');

const portOf = (r: (typeof RECIPES)[string]): number => {
  const m = /:(\d+)/.exec(r.baseUrl ?? '');
  if (!m) throw new Error('recipe has no baseUrl port');
  return Number(m[1]);
};

export function linuxRecipe(app: string): LinuxRecipe {
  const r = RECIPES[app];
  if (!r) throw new Error(`no recipe for '${app}'`);
  const port = portOf(r);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.env)) {
    let val = rewrite(String(v), APP_MOUNT);
    if (k === 'HOST' || k === 'N8N_LISTEN_ADDRESS' || k === 'N8N_RUNNERS_BROKER_LISTEN_ADDRESS') val = '0.0.0.0';
    env[k] = val;
  }
  const ready =
    r.ready.kind === 'tcp'
      ? { kind: 'tcp' as const, port: (r.ready as { port: number }).port, timeoutMs: r.ready.timeoutMs }
      : {
          kind: r.ready.kind,
          value: rewrite(String((r.ready as { value?: string }).value ?? ''), APP_MOUNT).replace(
            '127.0.0.1',
            '127.0.0.1',
          ),
          timeoutMs: r.ready.timeoutMs,
        };

  return {
    app,
    argv: r.argv.map((a) => unbindLoopback(rewrite(a, APP_MOUNT))),
    cwdRel: r.cwd && !r.cwd.startsWith('/') ? r.cwd : null,
    env,
    // setup runs against the EAGER copy so that scaffolding never warms the
    // lazy cache — that would silently prefetch for whichever arm ran it.
    setup: (r.setup ?? []).map((s) => rewrite(s, EAGER_MOUNT)).filter((s) => !s.startsWith('docker exec')),
    ready,
    settleMs: r.settleMs ?? 0,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    train: r.phases.filter((p) => p.name === 'common'),
    test: r.phases.filter((p) => p.name !== 'common').map((p) => adaptPhase(p, app)),
    quality: r.quality,
    deviations: [...(r.deviations ?? [])],
  };
}

/**
 * `command` phases spawn a workload RUNNER. Under experiment 2 that runner was
 * a separate process tree whose reads were excluded. Here it must not read the
 * lazy mount at all, or the runner's own module loads would be charged to the
 * application's remote-fetch account — so the runner is rewritten to load from
 * the host-side tree and is executed on the host.
 */
function adaptPhase(p: Phase, _app: string): Phase {
  if (!p.command) return p;
  return {
    ...p,
    // `require("{{clone}}/node_modules/socket.io-client")` becomes a bare
    // specifier so it resolves through the driver's own NODE_PATH inside the
    // container image. Anything left pointing at {{clone}} would be a host
    // path that does not exist there — and, worse, a read of the lazy mount.
    command: rewrite(p.command.replaceAll('{{clone}}/node_modules/', ''), APP_MOUNT),
  };
}

export const requestList = (phases: Phase[]): HttpRequest[] => phases.flatMap((p) => p.requests ?? []);
