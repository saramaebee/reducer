/**
 * TRAIN, LONG-TAIL TEST and the post-admission traffic model, per application.
 *
 * ─── the split, fixed before any outcome was observed ───────────────────────
 *   TRAIN      startup + the COMMON request set, cycled. This is the ONLY
 *              application behaviour the generic strategies (and R2) observe.
 *   LONG-TAIL  legitimate production behaviour that COMMON does not reach,
 *   TEST       grouped so that a group is an atomic unit of application
 *              behaviour (a write lifecycle, an auth-then-use pair) and so the
 *              traffic model can permute *groups* without breaking state.
 *   SHARED     startup, and the prelude below: one-time state establishment
 *              (admin registration) that every trial performs identically.
 *
 * Every long-tail group carries `why` — the argument that a real deployment
 * genuinely serves it — and `mechanism`, the Node behaviour it exercises. Both
 * are reproduced verbatim in the preserved result, because "is this held-out
 * path legitimate?" is the first thing an adversarial reader should attack.
 *
 * Nothing here is invented to defeat filesystem tracing. Each candidate came
 * from reading the application's own route table and its own source, and is
 * cited in DESIGN.md §5 with the file:line that defines it.
 */
import { linuxRecipe } from '../lazy-oci/recipes-linux.ts';
import type { LongtailPlan } from './plan.ts';
import { npmTarball } from './tarball.ts';

export const CATEGORIES = [
  'rare-route',
  'error-path',
  'locale',
  'tenant-config',
  'optional-feature',
  'admin-background',
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Req {
  /** stable identity, used to align the same request across arms */
  id: string;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  capture?: Record<string, string>;
  /** statuses that count as the intended behaviour; verified empirically */
  expect: number[];
  /** false when the response body legitimately varies run to run (zip mtimes,
   *  generated ids); status and any declared header are still compared */
  stableBody?: boolean;
  /** false when even the response LENGTH legitimately varies (a generated
   *  captcha image); such a request is compared on status alone */
  stableLength?: boolean;
  /** compare this response header across arms instead of / as well as the body */
  compareHeader?: string;
  multipart?: { field: string; filename: string; contentType: string; base64: string };
  timeoutMs?: number;
}

export interface LongTailGroup {
  id: string;
  category: Category;
  /** why a real deployment genuinely serves this */
  why: string;
  /** the Node mechanism it exercises */
  mechanism: string;
  /** may the group run again later in the stream (idempotent or seq-keyed)? */
  repeatable: boolean;
  requests: Req[];
}

export interface Workload {
  app: string;
  argv: string[];
  cwdRel: string | null;
  env: Record<string, string>;
  setup: string[];
  ready: { kind: 'stdout' | 'http' | 'tcp' | 'none'; value?: string; port?: number; timeoutMs: number };
  settleMs: number;
  baseUrl: string;
  port: number;
  /** one-time state establishment, run once at the head of the traffic stream */
  prelude: Req[];
  /** the common happy path — TRAIN is startup plus this, cycled */
  common: Req[];
  longTail: LongTailGroup[];
  notes: string[];
}

const G = (id: string, path: string, expect = [200], extra: Partial<Req> = {}): Req => ({
  id,
  method: 'GET',
  path,
  expect,
  ...extra,
});

// ────────────────────────────────────────────────────────────── json-server

function jsonServer(): Workload {
  const r = linuxRecipe('json-server');
  return {
    app: 'json-server',
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup: r.setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    prelude: [],
    common: [
      G('js.index', '/'),
      G('js.posts', '/posts'),
      G('js.post1', '/posts/1'),
      G('js.comments', '/comments'),
      G('js.profile', '/profile'),
    ],
    longTail: [
      {
        id: 'js.query',
        category: 'rare-route',
        why: "json-server's query surface (sort, paginate, embed, expand) is documented API that a client using only collection reads never touches.",
        mechanism: 'additional query-handling code paths inside the already-resident lib; no new package is expected.',
        repeatable: true,
        requests: [
          G('js.q.sort', '/posts?_sort=title&_order=desc'),
          G('js.q.page', '/posts?_page=1&_per_page=1'),
          G('js.q.embed', '/posts?_embed=comments'),
          G('js.q.expand', '/comments?_expand=post'),
        ],
      },
      {
        id: 'js.write',
        category: 'optional-feature',
        why: 'the write half of a REST API: a read-only training workload never exercises create/replace/patch/delete.',
        mechanism: 'the mutation path and its serialiser; lowdb write-back.',
        repeatable: true,
        requests: [
          { id: 'js.w.post', method: 'POST', path: '/posts', body: { title: 'longtail probe {{seq}}' }, capture: { newId: 'json:id' }, expect: [201], stableBody: false },
          { id: 'js.w.put', method: 'PUT', path: '/posts/{{newId}}', body: { title: 'replaced' }, expect: [200], stableBody: false },
          { id: 'js.w.patch', method: 'PATCH', path: '/posts/{{newId}}', body: { title: 'patched' }, expect: [200], stableBody: false },
          { id: 'js.w.delete', method: 'DELETE', path: '/posts/{{newId}}', expect: [200], stableBody: false },
        ],
      },
      {
        id: 'js.error',
        category: 'error-path',
        why: '404s are ordinary production traffic (stale links, probes, crawlers).',
        mechanism: "express's 404 branch and json-server's own not-found rendering.",
        repeatable: true,
        requests: [G('js.e.missing', '/does-not-exist', [404]), G('js.e.item', '/posts/999999', [404])],
      },
    ],
    notes: [
      'Selected as the negative control: a 3.2 MB universe with no plugin surface, no i18n, no tenancy and no optional dependency subtree. A null result here is the expected result.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────── verdaccio

function verdaccio(): Workload {
  const r = linuxRecipe('verdaccio');
  const tgz = npmTarball('longtail-probe', '1.0.0');
  const pkg = 'longtail-probe-{{seq}}';
  // The scratch config is rewritten so the uplink fails FAST and DETERMINISTICALLY.
  // The trial container can reach the real internet through the docker bridge,
  // so pointing the uplink at registry.npmjs.org would (a) make the
  // unknown-package 404 depend on someone else's network and (b) cost ~15 s per
  // request — measured, and it dominated every other latency in the pilot. An
  // unroutable local port keeps verdaccio's proxy/uplink-failure code path
  // exactly as it is while making it refuse the connection immediately.
  const setup = [
    ...r.setup,
    `printf '%s\\n' 'storage: ./storage' 'auth:' '  htpasswd:' '    file: ./htpasswd' '    max_users: 1000' \\
      'uplinks:' '  npmjs:' '    url: http://127.0.0.1:1/' '    timeout: 2s' '    max_fails: 1' '    fail_timeout: 5s' \\
      'packages:' "  '@*/*':" '    access: $all' '    publish: $authenticated' '    unpublish: $authenticated' '    proxy: npmjs' \\
      "  '**':" '    access: $all' '    publish: $authenticated' '    unpublish: $authenticated' '    proxy: npmjs' \\
      'logs: {type: stdout, format: pretty, level: warn}' > /scratch/verdaccio/config.yaml`,
  ];
  const auth = { authorization: 'Bearer {{token}}' };
  return {
    app: 'verdaccio',
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    prelude: [
      {
        id: 'vd.register',
        method: 'PUT',
        path: '/-/user/org.couchdb.user:probe',
        body: { name: 'probe', password: 'probe1234', _id: 'org.couchdb.user:probe', type: 'user', roles: [] },
        capture: { token: 'json:token' },
        expect: [201, 409],
        stableBody: false,
      },
    ],
    common: [
      G('vd.ping', '/-/ping'),
      G('vd.web', '/'),
      G('vd.uiopts', '/-/static/ui-options.js'),
      G('vd.packages', '/-/verdaccio/data/packages'),
      G('vd.whoami', '/-/whoami', [200], { headers: auth }),
    ],
    longTail: [
      {
        id: 'vd.lifecycle',
        category: 'optional-feature',
        why: 'publish → tag → deprecate → unpublish is the whole point of a private registry, and a read-only training workload never performs any of it.',
        mechanism: 'tarball validation (gunzip/tar-stream), the local-storage write path, manifest merge, dist-tag mutation and tarball removal.',
        repeatable: true,
        requests: [
          {
            id: 'vd.l.publish',
            method: 'PUT',
            path: `/${pkg}`,
            headers: { ...auth, 'content-type': 'application/json' },
            body: {
              _id: pkg,
              name: pkg,
              description: '',
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name: pkg,
                  version: '1.0.0',
                  description: '',
                  dist: { tarball: `http://0.0.0.0:4873/${pkg}/-/${pkg}-1.0.0.tgz` },
                },
              },
              readme: '# longtail probe',
              _attachments: { [`${pkg}-1.0.0.tgz`]: { content_type: 'application/octet-stream', data: tgz.base64, length: tgz.length } },
            },
            expect: [201],
            stableBody: false,
          },
          { id: 'vd.l.tag', method: 'PUT', path: `/-/package/${pkg}/dist-tags/beta`, headers: { ...auth, 'content-type': 'application/json' }, body: '"1.0.0"', expect: [201], stableBody: false },
          G('vd.l.read', `/${pkg}`, [200], { capture: { rev: 'json:_rev' }, stableBody: false }),
          { id: 'vd.l.deprecate', method: 'PUT', path: `/${pkg}/-rev/{{rev}}`, headers: { ...auth, 'content-type': 'application/json' }, body: { _id: pkg, _rev: '{{rev}}', name: pkg, versions: { '1.0.0': { name: pkg, version: '1.0.0', deprecated: 'superseded' } } }, expect: [201, 422], stableBody: false },
          { id: 'vd.l.untag', method: 'DELETE', path: `/-/package/${pkg}/dist-tags/beta`, headers: auth, expect: [201], stableBody: false },
          { id: 'vd.l.unpublish', method: 'DELETE', path: `/${pkg}/-rev/{{rev}}`, headers: auth, expect: [201], stableBody: false },
        ],
      },
      {
        id: 'vd.profile',
        category: 'admin-background',
        why: 'account self-service (profile reads, token issuance) is real but rare traffic on a private registry.',
        mechanism: 'the profile and token-management route family, the JWT signer and the token store — none of which a read-only workload reaches.',
        repeatable: true,
        requests: [
          G('vd.p.user', '/-/npm/v1/user', [200], { headers: auth, stableBody: false }),
          G('vd.p.tokens', '/-/npm/v1/tokens', [200], { headers: auth, stableBody: false }),
          { id: 'vd.p.newtoken', method: 'POST', path: '/-/npm/v1/tokens', headers: { ...auth, 'content-type': 'application/json' }, body: { password: 'probe1234', readonly: true, cidr_whitelist: [] }, expect: [201, 200, 400, 401], stableBody: false },
        ],
      },
      {
        id: 'vd.notfound',
        category: 'error-path',
        why: 'a request for a package this registry has never cached is the single most common error a registry serves; offline it also exercises the uplink-failure branch.',
        mechanism: 'uplink attempt → failure collection → getNotFound; the error middleware and its formatter.',
        repeatable: true,
        requests: [G('vd.nf.pkg', '/this-package-does-not-exist-xyz', [404], { timeoutMs: 15_000 }), G('vd.nf.ver', '/jsonwebtoken/99.0.0', [404], { timeoutMs: 15_000 })],
      },
      {
        id: 'vd.badpublish',
        category: 'error-path',
        why: 'a broken or truncated publish from a CI job is ordinary registry traffic.',
        mechanism: 'media-type rejection, zero-length attachment rejection and the tarball-parse failure path.',
        repeatable: true,
        requests: [
          { id: 'vd.bp.nomedia', method: 'PUT', path: '/longtail-bad-{{seq}}', headers: auth, body: 'x', expect: [400, 415], stableBody: false },
          { id: 'vd.bp.empty', method: 'PUT', path: '/longtail-bad-{{seq}}', headers: { ...auth, 'content-type': 'application/json' }, body: { _id: 'longtail-bad', name: 'longtail-bad', versions: { '1.0.0': { name: 'longtail-bad', version: '1.0.0' } }, _attachments: { 'longtail-bad-1.0.0.tgz': { data: '' } } }, expect: [500, 422, 400], stableBody: false },
          { id: 'vd.bp.badname', method: 'PUT', path: '/_.invalid..name', headers: { ...auth, 'content-type': 'application/json' }, body: {}, expect: [400], stableBody: false },
        ],
      },
      {
        id: 'vd.rare',
        category: 'rare-route',
        why: 'the removed-endpoint stub, the web shell under a non-root path and the favicon are all live routes a browser or an old client reaches.',
        mechanism: 'route-table entries, the HTML-shell render cache miss, and static file serving outside the web-UI data API.',
        repeatable: true,
        requests: [G('vd.r.all', '/-/all', [404]), G('vd.r.web', '/-/web/longtail', [200, 404]), G('vd.r.favicon', '/-/static/favicon.ico', [200, 404])],
      },
    ],
    notes: [
      'The dynamic plugin loader (a computed createRequire over a `verdaccio-<id>` prefix) was examined and deliberately EXCLUDED: swapping a plugin is a boot-time configuration change, not a request-time execution path, so it cannot be a post-admission long tail without making TRAIN and TEST different deployments.',
      'The uplink is pointed at an unroutable local port by the scratch config. The trial container CAN reach the real internet, so a real registry.npmjs.org uplink would make the unknown-package 404 depend on an external service and cost ~15 s per request (measured in the pilot). The proxy/uplink-failure code path still runs; only the failure is immediate, and identically so for every arm.',
      'Locale is not a category here: the server never reads a locale file (the web UI bundles its translations at build time).',
      'PILOT-OBSERVED, recorded not hidden: the deprecate request answers 422 at this SHA, not 201 — the manifest shape isDeprecatedManifest() wants differs from the one sent. The publish, dist-tag, un-tag and unpublish halves of the lifecycle group all execute (201), so the group is kept, but the DEPRECATE branch specifically did not run and no claim is made about it.',
      'GET /.env was in the first draft as a dotfile-guard probe and was REMOVED after the pilot observation run: verdaccio never answers it, so every occurrence burned the full request timeout and dominated the run. Removed as unmeasurable, not as unfavourable.',
    ],
  };
}

// ─────────────────────────────────────────────────────────────── juice-shop

function juiceShop(): Workload {
  const r = linuxRecipe('juice-shop');
  const bearer = { authorization: 'Bearer {{token}}' };
  const xml = Buffer.from('<?xml version="1.0"?><complaint><body>longtail probe</body></complaint>', 'utf8').toString('base64');
  return {
    app: 'juice-shop',
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup: r.setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    // Authentication is SHARED state establishment, not a long-tail path: the
    // traffic model rotates which unusual group arrives first, so an
    // auth-dependent group can legitimately land before the first common login
    // would have run. In the pilot that produced spurious 401s on checkout in
    // two of four families. Both logins therefore happen once, up front, for
    // every arm identically; the ordinary login also stays in the common set,
    // because logging in IS common traffic.
    prelude: [
      {
        id: 'js.pre.login',
        method: 'POST',
        path: '/rest/user/login',
        body: { email: 'admin@juice-sh.op', password: 'admin123' },
        capture: { token: 'json:authentication.token' },
        expect: [200],
        stableBody: false,
      },
      {
        id: 'js.pre.acct',
        method: 'POST',
        path: '/rest/user/login',
        body: { email: 'accountant@juice-sh.op', password: 'i am an awesome accountant' },
        capture: { atoken: 'json:authentication.token' },
        expect: [200, 401],
        stableBody: false,
      },
    ],
    common: [
      G('js.index', '/'),
      G('js.ver', '/rest/admin/application-version'),
      G('js.cfg', '/rest/admin/application-configuration'),
      G('js.search', '/rest/products/search?q=apple', [200], { stableBody: false }),
      G('js.products', '/api/Products', [200], { stableBody: false }),
      G('js.product1', '/api/Products/1', [200], { stableBody: false }),
      G('js.challenges', '/api/Challenges', [200], { stableBody: false }),
      G('js.feedbacks', '/api/Feedbacks', [200], { stableBody: false }),
      {
        id: 'js.login',
        method: 'POST',
        path: '/rest/user/login',
        body: { email: 'admin@juice-sh.op', password: 'admin123' },
        capture: { token: 'json:authentication.token' },
        expect: [200],
        stableBody: false,
      },
      G('js.whoami', '/rest/user/whoami', [200], { headers: bearer, stableBody: false }),
      G('js.basket', '/rest/basket/1', [200], { headers: bearer, stableBody: false }),
    ],
    longTail: [
      {
        id: 'js.web3',
        category: 'optional-feature',
        why: 'the wallet/key surface is a real, shipped feature of the application that ordinary shopping traffic never reaches.',
        mechanism: "lazy `await import('ethers')` inside the handler — a 19 MB dependency subtree that only this route family loads.",
        repeatable: true,
        requests: [{ id: 'js.w3.key', method: 'POST', path: '/rest/web3/submitKey', body: { privateKey: '0x00' }, expect: [401, 200], stableBody: false }],
      },
      {
        id: 'js.checkout',
        category: 'optional-feature',
        why: 'checkout is the revenue path; it is rare relative to browsing and it is the only route that renders a document.',
        mechanism: "lazy `await import('pdfkit')` plus request-time reads of pdfkit's own font-metric data directory (.afm files).",
        repeatable: true,
        requests: [
          { id: 'js.co.add', method: 'POST', path: '/api/BasketItems', headers: bearer, body: { BasketId: 1, ProductId: 3, quantity: 1 }, expect: [200, 400, 500], stableBody: false },
          { id: 'js.co.checkout', method: 'POST', path: '/rest/basket/1/checkout', headers: bearer, body: {}, expect: [200], stableBody: false },
        ],
      },
      {
        id: 'js.xmlupload',
        category: 'error-path',
        why: 'the complaint form accepts a customer-supplied XML document; a rejected upload is ordinary production behaviour.',
        mechanism: "an import() deliberately hidden behind `new Function('specifier','return import(specifier)')` so it survives TypeScript's CJS downlevel — loads libxml2-wasm and its .wasm binary, then returns through the error handler.",
        repeatable: true,
        requests: [
          {
            id: 'js.xu.post',
            method: 'POST',
            path: '/file-upload',
            multipart: { field: 'file', filename: 'complaint.xml', contentType: 'application/xml', base64: xml },
            expect: [410, 204, 500],
            stableBody: false,
          },
        ],
      },
      {
        id: 'js.dataerasure',
        category: 'tenant-config',
        why: 'a GDPR erasure request is a legally required, genuinely rare surface, and it is the first route in the process that renders a template.',
        mechanism: "express's view layer resolving the configured engine through `require(<computed>)` — pulls hbs and handlebars (2.9 MB), which nothing in the application imports statically. The rendered theme is chosen by config.",
        repeatable: true,
        requests: [G('js.de.form', '/dataerasure', [200, 500], { headers: { cookie: 'token={{token}}' }, stableBody: false })],
      },
      {
        id: 'js.promotion',
        category: 'tenant-config',
        why: 'the promotion page is served to real visitors and its assets are named by deployment configuration.',
        mechanism: "lazy `await import('pug')` plus a config-computed subtitle path read from the assets directory at request time.",
        repeatable: true,
        requests: [G('js.pr.page', '/promotion', [200, 500])],
      },
      {
        id: 'js.apidocs',
        category: 'rare-route',
        why: 'the OpenAPI browser is shipped and linked; developers and integrators load it.',
        mechanism: "request-time static serving out of swagger-ui-dist's 11 MB asset directory, whose path is resolved at boot but whose bytes are read only on request.",
        repeatable: true,
        requests: [G('js.ad.index', '/api-docs/', [200, 301]), G('js.ad.bundle', '/api-docs/swagger-ui-bundle.js', [200]), G('js.ad.css', '/api-docs/swagger-ui.css', [200])],
      },
      {
        id: 'js.captcha',
        category: 'optional-feature',
        why: 'the image captcha is served on a specific authenticated flow, not on browsing traffic.',
        mechanism: "lazy `await import('svg-captcha')` plus a read of that package's bundled TTF font.",
        repeatable: true,
        requests: [G('js.cp.image', '/rest/image-captcha', [200, 401], { headers: bearer, stableBody: false, stableLength: false })],
      },
      {
        id: 'js.filesurfaces',
        category: 'rare-route',
        why: 'the FTP, key and log surfaces are real routes the application exposes and links to.',
        mechanism: 'request-time DIRECTORY listings (serve-index) and file reads of paths no module graph contains.',
        repeatable: true,
        requests: [G('js.fs.ftp', '/ftp', [200]), G('js.fs.legal', '/ftp/legal.md', [200]), G('js.fs.keys', '/encryptionkeys', [200]), G('js.fs.logs', '/support/logs', [200])],
      },
      {
        id: 'js.accounting',
        category: 'admin-background',
        why: 'back-office order administration is performed by a different role than the shopper the training traffic represents.',
        mechanism: 'a second authentication, a role-gated route family, and an IP-filter denial path that only that role can reach.',
        repeatable: true,
        requests: [
          { id: 'js.ac.login', method: 'POST', path: '/rest/user/login', body: { email: 'accountant@juice-sh.op', password: 'i am an awesome accountant' }, capture: { atoken: 'json:authentication.token' }, expect: [200, 401], stableBody: false },
          G('js.ac.orders', '/rest/order-history/orders', [200, 401, 403], { headers: { authorization: 'Bearer {{atoken}}' }, stableBody: false }),
          { id: 'js.ac.ipfilter', method: 'PUT', path: '/api/Quantitys/1', headers: { authorization: 'Bearer {{atoken}}', 'content-type': 'application/json' }, body: { quantity: 1 }, expect: [401, 403, 500], stableBody: false },
        ],
      },
    ],
    notes: [
      'juice-shop runs a background loop every 5 s that recursively reads routes/, lib/, data/, models/, infrastructure/ and frontend/src/app for the code-snippet challenge index. Those trees are therefore hydrated on every arm within seconds of process start, independent of traffic; no candidate above depends on them, and the effect is identical across arms. It is recorded as a background-work confound in ADVERSARIAL.md.',
      'Locale is not a category here: all 43 backend catalogues are read at boot by i18n.configure, so no locale file is ever cold.',
      "Five DB-backed listings are declared body-unstable: juice-shop's models carry createdAt/updatedAt timestamps, so two responses of identical length differ in content between runs. Their byte LENGTH is still compared across arms. The generated captcha image is declared length-unstable too and is compared on status alone — it is a random image by construction.",
    ],
  };
}

// ────────────────────────────────────────────────────────────── uptime-kuma

/**
 * uptime-kuma's asset chunks are content-hashed by its own Vite build, so the
 * exact filenames are a property of the measured tree. They are discovered from
 * the universe file list rather than hard-coded, which also means the workload
 * fails loudly if the tree changes instead of silently requesting 404s.
 */
function kumaAssets(plan: LongtailPlan): { locales: string[]; routes: string[] } {
  const assets = plan.files.map(([rel]) => rel).filter((r) => r.startsWith('dist/assets/') && r.endsWith('.js'));
  const pick = (re: RegExp, n: number): string[] =>
    assets
      .filter((r) => re.test(r.slice('dist/assets/'.length)))
      .sort()
      .slice(0, n);
  return {
    locales: pick(/^(de-DE|ja|zh-CN|ru-RU|fr-FR|es-ES|pt-BR|ko-KR|it-IT|nl-NL)-[\w-]+\.js$/, 6),
    routes: pick(/^(Settings|Security|Notifications|PingChart|EditMonitor|StatusPage|Details|MonitorHistory)-[\w-]+\.js$/, 6),
  };
}

function uptimeKuma(plan: LongtailPlan): Workload {
  const r = linuxRecipe('uptime-kuma');
  const a = kumaAssets(plan);
  if (a.locales.length === 0 || a.routes.length === 0) {
    throw new Error('[uptime-kuma] no locale/route chunks found under dist/assets — the tree is not the one this workload was written against');
  }
  return {
    app: 'uptime-kuma',
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup: r.setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    prelude: [],
    common: [
      G('uk.entry', '/api/entry-page'),
      G('uk.setupinfo', '/setup-database-info'),
      G('uk.shell', '/', [200, 302]),
      G('uk.dashboard', '/dashboard'),
      G('uk.robots', '/robots.txt'),
    ],
    longTail: [
      {
        id: 'uk.locale',
        category: 'locale',
        why: 'every non-English visitor fetches their language chunk; a training run in one language never requests any of the other 65.',
        mechanism: 'request-time static serving of a per-locale build chunk from dist/assets. NOT a module edge — this is exactly the shape a module-graph strategy cannot reach.',
        repeatable: true,
        requests: a.locales.map((f, i) => G(`uk.l${i}`, `/assets/${f.slice('dist/assets/'.length)}`, [200])),
      },
      {
        id: 'uk.routechunks',
        category: 'rare-route',
        why: 'the settings, security and notification screens are real pages of the product that a dashboard-only workload never loads.',
        mechanism: 'request-time static serving of per-route build chunks. Again asset-shaped, not module-shaped.',
        repeatable: true,
        requests: a.routes.map((f, i) => G(`uk.r${i}`, `/assets/${f.slice('dist/assets/'.length)}`, [200])),
      },
      {
        id: 'uk.autherror',
        category: 'error-path',
        why: 'a scraper or a misconfigured Prometheus job hitting /metrics with bad credentials is routine.',
        mechanism: 'the API-key verification and rate-limiter path, reached only when authentication is attempted and fails.',
        repeatable: true,
        requests: [
          G('uk.ae.metrics', '/metrics', [401], { headers: { authorization: 'Basic bm9wZTpub3Bl' } }),
          G('uk.ae.badge', '/api/badge/999/status', [404, 200, 500]),
        ],
      },
      {
        id: 'uk.notfound',
        category: 'rare-route',
        why: 'push endpoints with unknown tokens, unknown status-page slugs and deep SPA links are all ordinary inbound traffic.',
        mechanism: 'the push router, the status-page router 404 branch and the SPA catch-all.',
        repeatable: true,
        requests: [
          G('uk.nf.push', '/api/push/deadbeef?status=up&msg=OK&ping=12', [200, 404]),
          G('uk.nf.sp', '/api/status-page/does-not-exist', [404, 200]),
          G('uk.nf.spa', '/some/unknown/spa/route', [200, 404]),
          G('uk.nf.chpw', '/.well-known/change-password', [200, 302, 404]),
        ],
      },
    ],
    notes: [
      'SELECTED AS THE ADVERSE CASE. The server eagerly requires all 25 monitor-type modules and all ~106 notification providers at boot, so uptime-kuma has almost no module-shaped long tail; what it has is per-locale and per-route ASSET chunks. Generic directory widening should cover those better than any module-graph reasoning can, and this app is in the set so that the result cannot be read as having been chosen for a favourable shape.',
      'Its tenant (status page) and admin surfaces need socket.io-driven seeding, which was deliberately not built: it would have doubled this app\'s per-trial cost for categories the fixture already covers. The workload therefore covers locale, rare-route and error-path only, and no claim is made about the other three categories for this app.',
    ],
  };
}

// ────────────────────────────────────────────────────────────────── strapi

function strapi(): Workload {
  const r = linuxRecipe('strapi');
  const jwt = { authorization: 'Bearer {{adminJwt}}' };
  const apiTok = { authorization: 'Bearer {{apiToken}}' };
  // a 1x1 JPEG, so the upload pipeline runs on real image bytes
  const jpeg =
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  return {
    app: 'strapi',
    argv: r.argv,
    cwdRel: r.cwdRel,
    env: r.env,
    setup: r.setup,
    ready: r.ready,
    settleMs: r.settleMs,
    baseUrl: r.baseUrl,
    port: r.port,
    prelude: [
      {
        id: 'st.register',
        method: 'POST',
        path: '/admin/register-admin',
        body: { email: 'probe@example.com', password: 'Longtail1234', firstname: 'Probe', lastname: 'User' },
        capture: { adminJwt: 'json:data.token' },
        expect: [200, 400],
        stableBody: false,
      },
      {
        id: 'st.login',
        method: 'POST',
        path: '/admin/login',
        body: { email: 'probe@example.com', password: 'Longtail1234' },
        capture: { adminJwt: 'json:data.token' },
        expect: [200, 400],
        stableBody: false,
      },
    ],
    common: [
      G('st.health', '/_health', [200, 204]),
      G('st.init', '/admin/init'),
      G('st.ptype', '/admin/project-type'),
      G('st.robots', '/robots.txt', [200, 404]),
      G('st.articles', '/api/articles', [200, 401, 403]),
      G('st.me', '/admin/users/me', [200, 401], { headers: jwt, stableBody: false }),
      G('st.info', '/admin/information', [200, 401], { headers: jwt, stableBody: false }),
    ],
    longTail: [
      {
        id: 'st.docs',
        category: 'optional-feature',
        why: 'the API documentation plugin is installed and its login page is publicly routed; integrators reach it.',
        mechanism: "an explicitly lazy `require('cheerio')` inside the handler, pulling cheerio + parse5 (~5.5 MB) that nothing else in the process loads.",
        repeatable: true,
        requests: [G('st.dc.login', '/documentation/login', [200, 404, 500])],
      },
      {
        id: 'st.upload',
        category: 'optional-feature',
        why: 'media upload is core CMS functionality that a read-only content workload never performs.',
        mechanism: "a lazy `await import('file-type')` (ESM-only) inside MIME validation, then the sharp image pipeline.",
        repeatable: true,
        requests: [
          { id: 'st.up.token', method: 'POST', path: '/admin/api-tokens', headers: jwt, body: { name: 'longtail-{{seq}}', type: 'full-access', lifespan: null, description: '' }, capture: { apiToken: 'json:data.accessKey' }, expect: [201, 400, 401], stableBody: false },
          { id: 'st.up.file', method: 'POST', path: '/api/upload', headers: apiTok, multipart: { field: 'files', filename: 'probe.jpg', contentType: 'image/jpeg', base64: jpeg }, expect: [201, 400, 401, 403], stableBody: false },
        ],
      },
      {
        id: 'st.contentapi',
        category: 'admin-background',
        why: 'a machine integration authenticating with an API token and reading a content type other than the two the site renders is ordinary production traffic.',
        mechanism: 'the content-api token strategy plus the full core-api controller → document-service → sanitize/transform chain, none of which the 401-ing public request reaches.',
        repeatable: true,
        requests: [
          { id: 'st.ca.token', method: 'POST', path: '/admin/api-tokens', headers: jwt, body: { name: 'longtail-ca-{{seq}}', type: 'full-access', lifespan: null, description: '' }, capture: { apiToken: 'json:data.accessKey' }, expect: [201, 400, 401], stableBody: false },
          G('st.ca.kitchensink', '/api/kitchensinks', [200, 401, 403, 404], { headers: apiTok, stableBody: false }),
          G('st.ca.v4', '/api/articles', [200, 401, 403], { headers: { ...apiTok, 'strapi-response-format': 'v4' }, stableBody: false }),
        ],
      },
      {
        id: 'st.webhook',
        category: 'admin-background',
        why: 'webhooks are configured once and fire on content events; the delivery path is exercised in production and never by a read workload.',
        mechanism: 'the webhook runner, its worker queue and an outbound fetch.',
        repeatable: true,
        requests: [
          { id: 'st.wh.create', method: 'POST', path: '/admin/webhooks', headers: jwt, body: { name: 'longtail-{{seq}}', url: 'http://127.0.0.1:9/x', events: ['entry.create'], headers: {} }, capture: { hookId: 'json:data.id' }, expect: [201, 400, 401], stableBody: false },
          { id: 'st.wh.trigger', method: 'POST', path: '/admin/webhooks/{{hookId}}/trigger', headers: jwt, body: {}, expect: [200, 400, 401, 404, 500], stableBody: false, timeoutMs: 20_000 },
        ],
      },
      {
        id: 'st.preview',
        category: 'rare-route',
        why: 'the content-manager preview bridge is served to editors using live preview.',
        mechanism: 'a request-time read of a 400-line script file that is never `require`d by anything — invisible to any module graph.',
        repeatable: true,
        requests: [G('st.pv.script', '/content-manager/preview/script', [200, 404])],
      },
      {
        id: 'st.errors',
        category: 'error-path',
        why: 'a client sending an unregistered query parameter, and an attempt to change the schema on a production instance, are both real and both must fail cleanly.',
        mechanism: 'strict-params validation → ValidationError formatting, and the is-development-mode policy rejection that only exists in production.',
        repeatable: true,
        requests: [
          { id: 'st.er.token', method: 'POST', path: '/admin/api-tokens', headers: jwt, body: { name: 'longtail-er-{{seq}}', type: 'read-only', lifespan: null, description: '' }, capture: { apiToken: 'json:data.accessKey' }, expect: [201, 400, 401], stableBody: false },
          G('st.er.strict', '/api/categories?extraParam=coffee', [400, 401, 403], { headers: apiTok, stableBody: false }),
          { id: 'st.er.ctb', method: 'POST', path: '/content-type-builder/content-types', headers: jwt, body: { contentType: { displayName: 'x', singularName: 'x', pluralName: 'xs', kind: 'collectionType', attributes: {} } }, expect: [403, 400, 401], stableBody: false },
        ],
      },
      {
        id: 'st.users',
        category: 'tenant-config',
        why: 'users-permissions self-registration is the front-door of any Strapi deployment that has end users, and it is entirely separate from the admin surface a content workload exercises.',
        mechanism: 'the users-permissions auth controller, its password hasher, JWT issuance and its own rate limiter.',
        repeatable: true,
        requests: [
          { id: 'st.us.register', method: 'POST', path: '/api/auth/local/register', body: { username: 'probe{{seq}}', email: 'probe{{seq}}@example.com', password: 'Longtail1234' }, expect: [200, 400, 403], stableBody: false },
          { id: 'st.us.login', method: 'POST', path: '/api/auth/local', body: { identifier: 'probe{{seq}}@example.com', password: 'Longtail1234' }, expect: [200, 400], stableBody: false },
        ],
      },
    ],
    notes: [
      'Strapi 5.7.0 is aggressively eager: plugins, routes, the error machinery and every zod/yup locale are loaded at boot. Only two candidates above move genuinely new bytes (documentation → cheerio/parse5; upload → file-type). The rest are execution-path long tail over resident modules. That is itself a finding and is reported as one rather than being papered over.',
      'Locale is not a category here: `?locale=xx` loads zero extra server files; the per-locale translation trees belong to the admin browser bundle, which this deployment does not build.',
      "The public role has no permissions on a fresh database, so `GET /api/articles` answers 401 in the common set. That is the honest common surface of this deployment, and it is identical for every arm.",
    ],
  };
}

// ─────────────────────────────────────────────────────── nextjs-longtail fixture

function nextjsLongtail(): Workload {
  const admin = { 'x-admin-token': 'longtail-admin' };
  return {
    app: 'nextjs-longtail',
    argv: ['node_modules/next/dist/bin/next', 'start', '-p', '3412', '-H', '0.0.0.0'],
    cwdRel: null,
    env: { NODE_ENV: 'production', ADMIN_TOKEN: 'longtail-admin', NEXT_TELEMETRY_DISABLED: '1', PORT: '3412', HOSTNAME: '0.0.0.0' },
    setup: [],
    ready: { kind: 'http', value: 'http://127.0.0.1:3412/api/health', timeoutMs: 120_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3412',
    port: 3412,
    prelude: [],
    common: [
      G('nx.home', '/', [200], { stableBody: false }),
      G('nx.health', '/api/health'),
      G('nx.products', '/api/products?limit=5'),
      G('nx.locale.en', '/i18n/en', [200], { stableBody: false }),
      G('nx.tenant.acme', '/tenant/acme', [200], { stableBody: false }),
      G('nx.report.json', '/api/report/json'),
    ],
    longTail: [
      ...(['de', 'ja', 'pt-br'] as const).map(
        (l): LongTailGroup => ({
          id: `nx.locale.${l}`,
          category: 'locale',
          why: `a visitor whose Accept-Language selects ${l} is ordinary traffic for a multi-market deployment; the training run only ever saw the default market.`,
          mechanism: 'a message catalogue and a localized content directory read from disk at request time — the i18next-fs-backend / next-intl file-loader shape. Data-shaped, not module-shaped.',
          repeatable: true,
          requests: [G(`nx.l.${l}`, `/i18n/${l}`, [200], { stableBody: false })],
        }),
      ),
      {
        id: 'nx.tenant.globex',
        category: 'tenant-config',
        why: 'a second tenant with its own branding is the entire premise of a multi-tenant deployment.',
        mechanism: 'a per-tenant config file read from a configuration directory, then a dynamically imported per-tenant renderer chunk that pulls a template engine.',
        repeatable: true,
        requests: [G('nx.t.globex', '/tenant/globex', [200], { stableBody: false })],
      },
      {
        id: 'nx.tenant.initech',
        category: 'tenant-config',
        why: 'a third tenant whose page embeds generated artwork; different tenants legitimately need different libraries.',
        mechanism: 'the same config read, resolving to a renderer chunk that pulls a QR-code library nothing else uses.',
        repeatable: true,
        requests: [G('nx.t.initech', '/tenant/initech', [200], { stableBody: false })],
      },
      {
        id: 'nx.admin',
        category: 'admin-background',
        why: 'a spreadsheet export behind an admin token: shipped, occasionally used, and by far the largest dependency in the tree.',
        mechanism: 'a lazily loaded route chunk whose external require pulls exceljs and its ~500-file archive/zip subtree.',
        repeatable: true,
        requests: [
          { id: 'nx.a.export', method: 'GET', path: '/api/admin/export', headers: admin, expect: [200], stableBody: false, stableLength: false, compareHeader: 'x-rows' },
          G('nx.a.forbidden', '/api/admin/export', [403]),
        ],
      },
      {
        id: 'nx.report',
        category: 'rare-route',
        why: 'alternate report serialisations are documented API used by a minority of clients.',
        mechanism: 'per-format dynamic import of a distinct external serialiser (papaparse, marked).',
        repeatable: true,
        requests: [G('nx.rp.csv', '/api/report/csv'), G('nx.rp.md', '/api/report/markdown')],
      },
      {
        id: 'nx.error',
        category: 'error-path',
        why: 'a downstream failure is inevitable in production, and the structured report is what the operator actually sees.',
        mechanism: 'error-reporting libraries loaded lazily, so nothing loads them until something has already gone wrong.',
        repeatable: true,
        requests: [G('nx.er.throw', '/api/error-trigger', [500])],
      },
      {
        id: 'nx.feature',
        category: 'optional-feature',
        why: 'a feature flag enabled for some callers and not others is standard configuration-driven behaviour.',
        mechanism: 'a configuration file read at request time gating a conditional dynamic import of a polyfill subtree.',
        repeatable: true,
        requests: [G('nx.ft.temporal', '/api/feature/temporal'), G('nx.ft.off', '/api/feature/disabled-example', [404])],
      },
      {
        id: 'nx.notfound',
        category: 'error-path',
        why: 'unknown locales, unknown tenants and unknown report kinds all arrive from crawlers and stale links.',
        mechanism: 'the not-found branches of three different dynamic route segments.',
        repeatable: true,
        requests: [G('nx.nf.locale', '/i18n/zz', [200], { stableBody: false }), G('nx.nf.tenant', '/tenant/nope', [200], { stableBody: false }), G('nx.nf.report', '/api/report/xml', [404])],
      },
    ],
    notes: [
      'CONTROLLED FIXTURE — interpretability, not headline evidence. Its job is to answer "why does one strategy generalise better?" with a tree whose long tail is known by construction and spans all six categories. Real applications answer whether the advantage exists outside a construction, and the two conclusions are reported separately.',
      "Built with `experimental.preloadEntriesOnStart: false`. Next's production server otherwise preloads EVERY app route module at startup, pulling each route's whole external dependency subtree into memory before the first request — measured here at 968 files resident before any traffic, versus 377 with the option set. That is a real finding about self-hosted Next.js and is reported as one; the option is Next's own documented opt-out and is what a deployment that cares about cold-start residency would set.",
      'The xlsx export is declared body- AND length-unstable: a zip embeds creation timestamps, so its byte length shifts. It is compared on status and on the x-rows header it emits for exactly this purpose — the semantic content of the export, which matched on every trial.',
      'The server-rendered HTML pages are declared body-unstable: React embeds a per-render identifier, so two byte-identical-length responses hash differently. Correctness therefore compares their exact byte LENGTH across arms (and every JSON API response by full fingerprint), which is a real check, not a waived one.',
      'Heavy leaf libraries are declared in `serverExternalPackages` so they remain real node_modules requires rather than being inlined into a server chunk — the ordinary configuration for large server dependencies.',
    ],
  };
}

// ────────────────────────────────────────────────────────────────── registry

export function workloadFor(app: string, plan: LongtailPlan): Workload {
  switch (app) {
    case 'json-server':
      return jsonServer();
    case 'verdaccio':
      return verdaccio();
    case 'juice-shop':
      return juiceShop();
    case 'uptime-kuma':
      return uptimeKuma(plan);
    case 'strapi':
      return strapi();
    case 'nextjs-longtail':
      return nextjsLongtail();
    default:
      throw new Error(`no long-tail workload defined for '${app}'`);
  }
}
