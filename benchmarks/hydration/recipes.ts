/**
 * Per-app workload recipes for the hydration experiment (ADR-0007 experiment 2).
 *
 * Each recipe says how to START the frozen application from its PINNED entry
 * file — the same file the preserved Plan B placement was traced from — and
 * what representative work already exists in that repository to drive it with.
 *
 * Rules these recipes follow, because breaking them would silently change what
 * the headline number means:
 *
 *  - argv[0] is the pinned entry from `hazard-domain/corpus-apps.ts` ENTRY_TABLE.
 *    Any deviation is listed in `deviations` and appears in the result file.
 *  - `setup` runs BEFORE tracing and WITHOUT the preload: creating a database,
 *    migrating, and seeding are experiment scaffolding, not application
 *    execution, and must not be charged to the application's working set.
 *  - Workloads come from the repository's own routes, tests, CLI and fixtures,
 *    never invented to touch more (or less) of the dependency tree.
 *  - `quality` is an honest label, and `startup-only` is a legitimate answer.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';

export type WorkloadQuality =
  | 'startup-only'
  | 'smoke'
  | 'representative-endpoint-set'
  | 'integration-suite'
  | 'broad-full';

export interface HttpRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** name → `json:a.b` | `header:x` | `regex:…(group)…`, reused as {{name}} later */
  capture?: Record<string, string>;
  timeoutMs?: number;
  delayMs?: number;
}

export interface Phase {
  name: string;
  detail: string;
  requests?: HttpRequest[];
  /** a workload runner; traced as a SEPARATE process tree, never merged into the app's */
  command?: string;
  timeoutMs?: number;
  requiresReady?: boolean;
}

export interface Recipe {
  /** argv after the node binary; `{{clone}}` expands to the frozen clone dir */
  argv: string[];
  /** relative to the clone dir */
  cwd?: string;
  env: Record<string, string>;
  /** shell commands run before the traced process starts (no preload) */
  setup?: string[];
  ready:
    | { kind: 'stdout'; value: string; timeoutMs: number }
    | { kind: 'tcp'; port: number; timeoutMs: number }
    | { kind: 'http'; value: string; timeoutMs: number }
    | { kind: 'none'; timeoutMs: number };
  /** quiet time after ready, so late startup work lands in the startup phase */
  settleMs?: number;
  baseUrl?: string;
  phases: Phase[];
  quality: WorkloadQuality;
  notes: string;
  deviations?: string[];
}

/** Writable state the applications need. Never inside a frozen clone. */
export const SCRATCH = process.env.HYDRATION_SCRATCH ?? path.join(tmpdir(), 'reducer-hydration');
const NODE = '/Users/sara/.asdf/installs/nodejs/24.19.0/bin/node';

const get = (p: string): HttpRequest => ({ method: 'GET', path: p });
const gets = (...ps: string[]): HttpRequest[] => ps.map(get);

export const RECIPES: Record<string, Recipe> = {
  // ------------------------------------------------------------- json-server
  'json-server': {
    argv: ['{{clone}}/lib/bin.js', 'fixtures/db.json', '--port', '3401'],
    env: { NODE_ENV: 'production' },
    ready: { kind: 'http', value: 'http://127.0.0.1:3401/posts', timeoutMs: 60_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3401',
    quality: 'representative-endpoint-set',
    notes:
      "Every route src/app.ts defines, driven against the repo's own fixtures/db.json: the eta-rendered " +
      'index, collection and item reads, the query/filter/sort/paginate/embed surface, and the full write path.',
    phases: [
      {
        name: 'common',
        detail: 'index page + collection/item reads',
        requests: gets('/', '/posts', '/posts/1', '/comments', '/profile'),
      },
      {
        name: 'full',
        detail: 'query/filter/sort/paginate/embed surface plus POST/PUT/PATCH/DELETE',
        requests: [
          ...gets(
            '/posts?title=a%20title',
            '/posts?_sort=title&_order=desc',
            '/posts?_page=1&_per_page=1',
            '/posts?_embed=comments',
            '/comments?_expand=post',
            '/posts?id_ne=1',
          ),
          { method: 'POST', path: '/posts', body: { title: 'hydration probe' }, capture: { newId: 'json:id' } },
          { method: 'PUT', path: '/posts/{{newId}}', body: { title: 'replaced' } },
          { method: 'PATCH', path: '/posts/{{newId}}', body: { title: 'patched' } },
          { method: 'DELETE', path: '/posts/{{newId}}' },
          get('/does-not-exist'),
        ],
      },
    ],
  },

  // -------------------------------------------------------------- juice-shop
  'juice-shop': {
    argv: ['{{clone}}/build/app.js'],
    env: { PORT: '3402' },
    ready: { kind: 'stdout', value: 'Server listening on port', timeoutMs: 300_000 },
    settleMs: 2000,
    baseUrl: 'http://127.0.0.1:3402',
    quality: 'representative-endpoint-set',
    notes:
      'Unauthenticated route sweep taken from the route table in server.ts, then the authenticated write ' +
      'path (basket, checkout → pdfkit, b2b order → notevil/vm, file upload, data export) which is where the ' +
      'expensive dependency subgraphs live. sqlite3 native binding, finale-rest, i18n and swagger all participate.',
    phases: [
      {
        name: 'common',
        detail: 'unauthenticated REST + static + the routes any visitor hits',
        requests: gets(
          '/',
          '/rest/admin/application-version',
          '/rest/admin/application-configuration',
          '/rest/languages',
          '/rest/country-mapping',
          '/rest/captcha',
          '/rest/memories',
          '/rest/user/whoami',
          '/rest/products/search?q=apple',
          '/rest/products/1/reviews',
          '/api/Products',
          '/api/Products/1',
          '/api/Challenges',
          '/api/Feedbacks',
          '/api/SecurityQuestions',
          '/robots.txt',
          '/.well-known/security.txt',
          '/metrics',
        ),
      },
      {
        name: 'full',
        detail: 'authenticated read+write path: login, basket, checkout (pdfkit), b2b order (vm), data export',
        requests: [
          ...gets('/api-docs/', '/ftp', '/ftp/legal.md', '/encryptionkeys', '/support/logs', '/video', '/promotion'),
          {
            method: 'POST',
            path: '/rest/user/login',
            body: { email: 'admin@juice-sh.op', password: 'admin123' },
            capture: { token: 'json:authentication.token' },
          },
          { method: 'GET', path: '/rest/user/whoami', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/basket/1', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/wallet/balance', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/order-history', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/2fa/status', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/deluxe-membership', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/rest/image-captcha', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/api/Users', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/api/Cards', headers: { authorization: 'Bearer {{token}}' } },
          {
            method: 'POST',
            path: '/api/BasketItems',
            headers: { authorization: 'Bearer {{token}}' },
            body: { BasketId: 1, ProductId: 3, quantity: 1 },
          },
          {
            method: 'POST',
            path: '/b2b/v2/orders',
            headers: { authorization: 'Bearer {{token}}' },
            body: { cid: 'probe', orderLinesData: '1+1' },
          },
          {
            method: 'POST',
            path: '/rest/basket/1/checkout',
            headers: { authorization: 'Bearer {{token}}' },
            body: { orderDetails: { paymentId: 1, addressId: 1, deliveryMethodId: 1 } },
          },
          {
            method: 'POST',
            path: '/rest/user/data-export',
            headers: { authorization: 'Bearer {{token}}' },
            body: { UserId: 1, deliveryMethodId: 1 },
          },
          {
            method: 'POST',
            path: '/api/Users',
            body: { email: 'probe@juice-sh.op', password: 'probe1234', passwordRepeat: 'probe1234' },
          },
          { method: 'GET', path: '/main.js' },
          { method: 'GET', path: '/assets/public/images/products/apple_juice.jpg' },
        ],
      },
    ],
  },

  // --------------------------------------------------------------- verdaccio
  verdaccio: {
    argv: ['{{clone}}/packages/verdaccio/bin/verdaccio', '--config', `${SCRATCH}/verdaccio/config.yaml`, '--listen', '127.0.0.1:4873'],
    env: { NODE_ENV: 'production' },
    setup: [
      `rm -rf ${SCRATCH}/verdaccio && mkdir -p ${SCRATCH}/verdaccio/storage`,
      // storage/htpasswd resolve against dirname(configPath), so everything the
      // registry writes stays in the scratch dir and never inside the clone.
      `printf '%s\\n' 'storage: ./storage' 'auth:' '  htpasswd:' '    file: ./htpasswd' '    max_users: 1000' \\
        'uplinks:' '  npmjs:' '    url: https://registry.npmjs.org/' \\
        'packages:' "  '@*/*':" '    access: $all' '    publish: $authenticated' '    proxy: npmjs' \\
        "  '**':" '    access: $all' '    publish: $authenticated' '    proxy: npmjs' \\
        'logs: {type: stdout, format: pretty, level: http}' > ${SCRATCH}/verdaccio/config.yaml`,
    ],
    ready: { kind: 'http', value: 'http://127.0.0.1:4873/-/ping', timeoutMs: 120_000 },
    settleMs: 1000,
    baseUrl: 'http://127.0.0.1:4873',
    quality: 'representative-endpoint-set',
    notes:
      'Registry-protocol sweep taken from the actual route tables: ping, web UI shell and its data endpoints, ' +
      'user creation + login (jsonwebtoken/htpasswd), package metadata and tarball fetch through the npmjs ' +
      'uplink, search, and the audit proxy. The e2e-cli suite was not used: it drives a real npm client, whose ' +
      'file accesses are npm’s, not the registry’s.',
    phases: [
      {
        name: 'common',
        detail: 'ping, web UI shell, package listing',
        requests: gets('/-/ping', '/', '/-/static/ui-options.js', '/-/verdaccio/data/packages'),
      },
      {
        name: 'full',
        detail: 'auth (htpasswd + jwt), uplink metadata/tarball fetch, search, audit',
        requests: [
          {
            method: 'PUT',
            path: '/-/user/org.couchdb.user:probe',
            body: { name: 'probe', password: 'probe1234', _id: 'org.couchdb.user:probe', type: 'user', roles: [] },
            capture: { token: 'json:token' },
          },
          { method: 'GET', path: '/-/whoami', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/-/npm/v1/user', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/-/npm/v1/tokens', headers: { authorization: 'Bearer {{token}}' } },
          ...gets(
            '/jsonwebtoken',
            '/jsonwebtoken/9.0.2',
            '/-/package/jsonwebtoken/dist-tags',
            '/jsonwebtoken/-/jsonwebtoken-9.0.2.tgz',
            '/-/v1/search?text=jsonwebtoken&size=5',
            '/-/verdaccio/data/sidebar/jsonwebtoken',
            '/-/verdaccio/data/package/readme/jsonwebtoken',
          ),
          { method: 'POST', path: '/-/npm/v1/security/audits/quick', body: {} },
        ],
      },
    ],
  },

  // ------------------------------------------------------------ fastify-demo
  'fastify-demo': {
    argv: ['{{clone}}/dist/server.js'],
    env: {
      NODE_ENV: 'production',
      PORT: '3403',
      MYSQL_HOST: '127.0.0.1',
      MYSQL_PORT: '3306',
      MYSQL_DATABASE: 'test_db',
      MYSQL_USER: 'test_user',
      MYSQL_PASSWORD: 'test_password',
      COOKIE_SECRET: 'reducer-corpus-cookie-secret-0123456789',
      COOKIE_NAME: 'session_id',
      COOKIE_SECURED: 'false',
      RATE_LIMIT_MAX: '1000',
      UPLOAD_DIRNAME: 'uploads',
      UPLOAD_TASKS_DIRNAME: 'tasks',
      LOG_LEVEL: 'info',
      FASTIFY_CLOSE_GRACE_DELAY: '500',
    },
    setup: [
      // the repo's OWN migration + seed scripts, run untraced: schema creation
      // is scaffolding, not application execution
      'npx tsx ./scripts/migrate.ts',
      'CAN_SEED_DATABASE=1 npx tsx ./scripts/seed-database.ts || true',
    ],
    ready: { kind: 'stdout', value: 'Server listening at', timeoutMs: 120_000 },
    settleMs: 1000,
    baseUrl: 'http://127.0.0.1:3403',
    quality: 'representative-endpoint-set',
    notes:
      'Fastify autoloaded plugin app against the mysql schema its own migrations create. Exercises the ' +
      'documented auth flow (login → session cookie), the tasks CRUD routes, and the swagger/scalar docs route.',
    phases: [
      { name: 'common', detail: 'home route + docs + the unauthenticated surface', requests: gets('/', '/documentation', '/documentation/json', '/api/tasks', '/nope') },
      {
        name: 'full',
        detail: 'login then the authenticated tasks CRUD surface',
        requests: [
          {
            method: 'POST',
            path: '/api/auth/login',
            body: { email: 'basic@example.com', password: 'Password123$' },
            capture: { cookie: 'header:set-cookie' },
          },
          { method: 'GET', path: '/api/tasks', headers: { cookie: '{{cookie}}' } },
          { method: 'POST', path: '/api/tasks', headers: { cookie: '{{cookie}}' }, body: { name: 'probe', author_id: 1, status: 'new' }, capture: { taskId: 'json:id' } },
          { method: 'GET', path: '/api/tasks/{{taskId}}', headers: { cookie: '{{cookie}}' } },
          { method: 'PATCH', path: '/api/tasks/{{taskId}}', headers: { cookie: '{{cookie}}' }, body: { name: 'probe-2' } },
          { method: 'GET', path: '/api/users', headers: { cookie: '{{cookie}}' } },
          { method: 'DELETE', path: '/api/tasks/{{taskId}}', headers: { cookie: '{{cookie}}' } },
        ],
      },
    ],
  },

  // ------------------------------------------------ node-express-boilerplate
  'node-express-boilerplate': {
    argv: ['{{clone}}/src/index.js'],
    env: {
      NODE_ENV: 'production',
      PORT: '3404',
      MONGODB_URL: 'mongodb://127.0.0.1:27017/neb-workload',
      JWT_SECRET: 'thisisasamplesecret',
      JWT_ACCESS_EXPIRATION_MINUTES: '30',
      JWT_REFRESH_EXPIRATION_DAYS: '30',
      JWT_RESET_PASSWORD_EXPIRATION_MINUTES: '10',
      JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: '10',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_USERNAME: 'u',
      SMTP_PASSWORD: 'p',
      EMAIL_FROM: 'support@example.com',
    },
    // mongo state persists across runs; a reused database turns `register` into
    // a 400 and quietly degrades the authenticated half of the workload
    setup: ['docker exec hyd-mongo mongosh --quiet --eval \'db.getSiblingDB("neb-workload").dropDatabase()\' >/dev/null 2>&1 || true'],
    ready: { kind: 'stdout', value: 'Listening to port', timeoutMs: 120_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3404',
    quality: 'representative-endpoint-set',
    notes:
      'The full documented v1 API: register → login → authenticated user CRUD → refresh → logout, plus the ' +
      'swagger docs route. Every path comes from src/routes/v1.',
    phases: [
      { name: 'common', detail: 'docs + unauthenticated surface', requests: gets('/v1/docs/', '/v1/users', '/nope') },
      {
        name: 'full',
        detail: 'register/login/refresh/logout + authenticated user CRUD (mongoose + passport + joi)',
        requests: [
          {
            method: 'POST',
            path: '/v1/auth/register',
            body: { name: 'Probe', email: 'probe@example.com', password: 'password1' },
            capture: { token: 'json:tokens.access.token', refresh: 'json:tokens.refresh.token', uid: 'json:user.id' },
          },
          {
            method: 'POST',
            path: '/v1/auth/login',
            body: { email: 'probe@example.com', password: 'password1' },
            capture: { token: 'json:tokens.access.token', refresh: 'json:tokens.refresh.token' },
          },
          { method: 'GET', path: '/v1/users?limit=5', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/v1/users/{{uid}}', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'PATCH', path: '/v1/users/{{uid}}', headers: { authorization: 'Bearer {{token}}' }, body: { name: 'Probe2' } },
          { method: 'POST', path: '/v1/auth/refresh-tokens', body: { refreshToken: '{{refresh}}' } },
          { method: 'POST', path: '/v1/auth/forgot-password', body: { email: 'probe@example.com' } },
          { method: 'POST', path: '/v1/auth/logout', body: { refreshToken: '{{refresh}}' } },
        ],
      },
    ],
  },

  // ------------------------------------------------ express-rest-boilerplate
  'express-rest-boilerplate': {
    argv: ['{{clone}}/src/index.js'],
    env: {
      NODE_ENV: 'production',
      PORT: '3405',
      JWT_SECRET: 'bA2xcjpf8y5aSUFsNB2qN5yymUBSs6es3qHoFpGkec75RCeBb8cpKauGefw5qy4',
      JWT_EXPIRATION_MINUTES: '15',
      MONGO_URI: 'mongodb://127.0.0.1:27017/erb-workload',
      MONGO_URI_TESTS: 'mongodb://127.0.0.1:27017/erb-workload-test',
      EMAIL_PORT: '1025',
      EMAIL_HOST: '127.0.0.1',
      EMAIL_USERNAME: 'u',
      EMAIL_PASSWORD: 'p',
    },
    setup: ['docker exec hyd-mongo mongosh --quiet --eval \'db.getSiblingDB("erb-workload").dropDatabase()\' >/dev/null 2>&1 || true'],
    ready: { kind: 'http', value: 'http://127.0.0.1:3405/v1/status', timeoutMs: 120_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3405',
    quality: 'representative-endpoint-set',
    notes: 'The v1 API from src/api/routes/v1: status, docs, register/login/refresh, and the authenticated user routes.',
    phases: [
      { name: 'common', detail: 'status + docs', requests: gets('/v1/status', '/v1/docs/', '/nope') },
      {
        name: 'full',
        detail: 'register → login → refresh → authenticated user CRUD (mongoose, passport, joi, bcrypt)',
        requests: [
          {
            method: 'POST',
            path: '/v1/auth/register',
            body: { email: 'probe@example.com', password: 'password1' },
            capture: { token: 'json:token.accessToken', refresh: 'json:token.refreshToken', uid: 'json:user.id' },
          },
          {
            method: 'POST',
            path: '/v1/auth/login',
            body: { email: 'probe@example.com', password: 'password1' },
            capture: { token: 'json:token.accessToken', refresh: 'json:token.refreshToken' },
          },
          { method: 'GET', path: '/v1/users?perPage=5', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/v1/users/profile', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/v1/users/{{uid}}', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'PATCH', path: '/v1/users/{{uid}}', headers: { authorization: 'Bearer {{token}}' }, body: { name: 'Probe2' } },
          { method: 'POST', path: '/v1/auth/refresh-token', body: { email: 'probe@example.com', refreshToken: '{{refresh}}' } },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ nodebb
  nodebb: {
    argv: ['{{clone}}/app.js'],
    env: { NODE_ENV: 'production' },
    ready: { kind: 'stdout', value: 'NodeBB is now listening on', timeoutMs: 300_000 },
    settleMs: 3000,
    baseUrl: 'http://127.0.0.1:4567',
    quality: 'representative-endpoint-set',
    notes:
      'Guest reads, rendered HTML pages, feeds/sitemap, then an authenticated write path — every path taken ' +
      'from the route tables (src/routes/*). The mocha suite was NOT used: it boots its own server in-process, ' +
      'so it would be a different process tree, not this one.',
    deviations: [
      'NodeBB required a one-time `app.js --setup` (postgres schema + full asset build) before it could start. ' +
        'That setup ran untraced, and its generated assets (build/, config.json) are outside the frozen universe.',
    ],
    phases: [
      {
        name: 'common',
        detail: 'guest JSON API + the core rendered pages',
        requests: gets(
          '/ping',
          '/api/config',
          '/api/',
          '/api/categories',
          '/api/recent',
          '/api/popular',
          '/api/tags',
          '/api/users',
          '/api/groups',
          '/',
          '/categories',
          '/recent',
          '/users',
          '/groups',
          '/login',
          '/register',
        ),
      },
      {
        name: 'full',
        detail: 'feeds, sitemap, search, write API v3 (login → create topic → reply → tag), admin JSON',
        requests: [
          ...gets(
            '/robots.txt',
            '/manifest.webmanifest',
            '/osd.xml',
            '/sitemap.xml',
            '/sitemap/pages.xml',
            '/sitemap/categories.xml',
            '/recent.rss',
            '/popular.rss',
            '/api/search?term=welcome&in=titlesposts',
            '/api/v3/ping',
            '/api/v3/categories',
            '/api/v3/groups',
          ),
          {
            method: 'POST',
            path: '/api/v3/utilities/login',
            body: { username: 'admin', password: 'hAN3Eg8W' },
            capture: { cookie: 'header:set-cookie' },
          },
          { method: 'GET', path: '/api/self', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/unread/total', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/v3/notifications', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/v3/chats', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/admin/dashboard', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/admin/manage/categories', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/api/admin/settings/general', headers: { cookie: '{{cookie}}' } },
        ],
      },
    ],
  },

  // ----------------------------------------------------------------- outline
  outline: {
    argv: ['{{clone}}/build/server/index.js', '--services=web,websockets,worker,collaboration'],
    env: {
      NODE_ENV: 'production',
      SECRET_KEY: 'f4b1c2d3e4f5a60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
      UTILS_SECRET: 'reducer-hydration-utils-secret',
      URL: 'http://localhost:3406',
      PORT: '3406',
      FORCE_HTTPS: 'false',
      PGSSLMODE: 'disable',
      DATABASE_URL: 'postgres://sara@127.0.0.1:5432/outline_reducer',
      REDIS_URL: 'redis://127.0.0.1:6379',
      FILE_STORAGE: 'local',
      FILE_STORAGE_LOCAL_ROOT_DIR: `${SCRATCH}/outline-data`,
      TELEMETRY: 'false',
      LOG_LEVEL: 'info',
    },
    setup: [
      `mkdir -p ${SCRATCH}/outline-data`,
      // installation.create refuses to run once any Team exists, so a reused
      // database silently turns the entire authenticated sweep into 401s. The
      // database is recreated per run; outline migrates itself at boot.
      'dropdb -h 127.0.0.1 -U sara --if-exists outline_reducer && createdb -h 127.0.0.1 -U sara outline_reducer',
    ],
    ready: { kind: 'http', value: 'http://127.0.0.1:3406/_health', timeoutMs: 420_000 },
    settleMs: 4000,
    baseUrl: 'http://127.0.0.1:3406',
    quality: 'representative-endpoint-set',
    notes:
      'Bootstraps a workspace through the self-hosted installation.create endpoint, then sweeps the real ' +
      'RPC API (collections, documents incl. markdown export/import paths, search, users, teams, shares, ' +
      'events, views) plus the SPA shell. Runs all four services (web, websockets, worker, collaboration) ' +
      'in one cluster worker, so socket.io, bull queues and hocuspocus all participate.',
    phases: [
      {
        name: 'common',
        detail: 'health, SPA shell, unauthenticated config',
        requests: [
          ...gets('/_health', '/', '/manifest.webmanifest'),
          { method: 'POST', path: '/api/auth.config', body: {} },
        ],
      },
      {
        name: 'full',
        detail: 'workspace bootstrap then the authenticated RPC surface (collections, documents, search, export)',
        requests: [
          {
            method: 'POST',
            path: '/api/installation.create',
            body: { teamName: 'Reducer', userName: 'Probe Admin', userEmail: 'probe@example.com' },
            // signIn() answers 302 with the session JWT in Set-Cookie; a regex
            // over the (empty) body captures nothing, which silently turns the
            // whole authenticated sweep into 401s
            capture: { token: 'cookie:accessToken' },
            timeoutMs: 60_000,
          },
          { method: 'POST', path: '/api/auth.info', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/users.info', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/users.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/teams.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          {
            method: 'POST',
            path: '/api/collections.create',
            body: { name: 'Probe', description: 'hydration probe' },
            headers: { authorization: 'Bearer {{token}}' },
            capture: { col: 'json:data.id' },
          },
          { method: 'POST', path: '/api/collections.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/collections.info', body: { id: '{{col}}' }, headers: { authorization: 'Bearer {{token}}' } },
          {
            method: 'POST',
            path: '/api/documents.create',
            body: {
              title: 'Probe doc',
              text: '# Heading\n\nSome **bold** text, a [link](https://example.com) and code:\n\n```js\nconst x = 1;\n```\n',
              collectionId: '{{col}}',
              publish: true,
            },
            headers: { authorization: 'Bearer {{token}}' },
            capture: { doc: 'json:data.id' },
          },
          { method: 'POST', path: '/api/documents.info', body: { id: '{{doc}}' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.list', body: { collectionId: '{{col}}' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.search', body: { query: 'Heading' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.export', body: { id: '{{doc}}' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.update', body: { id: '{{doc}}', text: '# Updated\n\nnew body' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.viewed', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.drafts', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/shares.create', body: { documentId: '{{doc}}' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/shares.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/events.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/groups.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/stars.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/notifications.list', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/documents.delete', body: { id: '{{doc}}' }, headers: { authorization: 'Bearer {{token}}' } },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ strapi
  strapi: {
    argv: ['{{clone}}/packages/core/strapi/bin/strapi.js', 'start'],
    cwd: 'examples/getstarted',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '1337',
      APP_KEYS: 'toBeModified1,toBeModified2',
      ADMIN_JWT_SECRET: 'example-token',
      API_TOKEN_SALT: 'example-salt',
      TRANSFER_TOKEN_SALT: 'example-salt',
      JWT_SECRET: 'example-jwt-secret-for-users-permissions',
      ENCRYPTION_KEY: 'example-key-example-key-example1',
      STRAPI_TELEMETRY_DISABLED: 'true',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    setup: ['rm -rf {{clone}}/examples/getstarted/.tmp'],
    ready: { kind: 'stdout', value: 'Strapi started successfully|http://127.0.0.1:1337', timeoutMs: 420_000 },
    settleMs: 3000,
    baseUrl: 'http://127.0.0.1:1337',
    quality: 'representative-endpoint-set',
    notes:
      'The getstarted example app started through the pinned CLI entry, then: first-admin registration, the ' +
      'admin API, content-manager CRUD with publish/unpublish on a real document, plugin routes (i18n, upload, ' +
      'content-type-builder) and the REST + GraphQL content APIs.',
    deviations: [
      'GET /admin (the admin panel HTML) is never requested: the admin bundle was never built for this example, ' +
        'so it would be a request-time ENOENT rather than representative work.',
    ],
    phases: [
      { name: 'common', detail: 'health + bootstrap info + public content API', requests: gets('/_health', '/admin/init', '/admin/project-type', '/robots.txt', '/api/articles', '/api/categories') },
      {
        name: 'full',
        detail: 'admin registration → admin API → content-manager CRUD/publish → plugin routes → GraphQL',
        requests: [
          {
            method: 'POST',
            path: '/admin/register-admin',
            body: { email: 'admin@example.com', firstname: 'Admin', lastname: 'User', password: 'Admin123456' },
            capture: { token: 'json:data.token' },
            timeoutMs: 60_000,
          },
          { method: 'GET', path: '/admin/information', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/admin/users', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/admin/roles', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/admin/permissions', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/admin/webhooks', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/admin/content-api/routes', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/init', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/content-types', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/components', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/collection-types/api::article.article', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/collection-types/api::category.category', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-manager/collection-types/api::kitchensink.kitchensink', headers: { authorization: 'Bearer {{token}}' } },
          {
            method: 'POST',
            path: '/content-manager/collection-types/api::tag.tag',
            body: { name: 'probe-tag' },
            headers: { authorization: 'Bearer {{token}}' },
            capture: { doc: 'json:data.documentId' },
          },
          { method: 'GET', path: '/content-manager/collection-types/api::tag.tag/{{doc}}', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'PUT', path: '/content-manager/collection-types/api::tag.tag/{{doc}}', body: { name: 'probe-tag-2' }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/content-manager/collection-types/api::tag.tag/{{doc}}/actions/publish', body: {}, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/content-manager/collection-types/api::tag.tag/{{doc}}/actions/unpublish', body: { discardDraft: false }, headers: { authorization: 'Bearer {{token}}' } },
          { method: 'DELETE', path: '/content-manager/collection-types/api::tag.tag/{{doc}}', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/i18n/locales', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/upload/files', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'GET', path: '/content-type-builder/content-types', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/graphql', body: { query: '{ __schema { queryType { name } } }' } },
        ],
      },
    ],
  },

  // ------------------------------------------------------------ parse-server
  'parse-server': {
    argv: [
      '{{clone}}/bin/parse-server',
      '--appId',
      'reducerApp',
      '--masterKey',
      'reducerMasterKey',
      '--databaseURI',
      'postgres://sara@127.0.0.1:5432/parse_reducer',
      '--port',
      '1338',
      '--serverURL',
      'http://127.0.0.1:1338/parse',
      '--allowClientClassCreation',
      'true',
      '--masterKeyIps',
      '0.0.0.0/0,::0',
    ],
    env: { NODE_ENV: 'production' },
    ready: { kind: 'stdout', value: 'parse-server running on|running on http', timeoutMs: 180_000 },
    settleMs: 2000,
    baseUrl: 'http://127.0.0.1:1338',
    quality: 'representative-endpoint-set',
    notes:
      'The Parse REST API over the postgres storage adapter: health, server info, schema creation, object ' +
      'CRUD, queries, user signup/login/session, cloud-function surface and the file API.',
    phases: [
      {
        name: 'common',
        detail: 'health + serverInfo + schemas',
        requests: [
          get('/parse/health'),
          { method: 'GET', path: '/parse/serverInfo', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
          { method: 'GET', path: '/parse/schemas', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
        ],
      },
      {
        name: 'full',
        detail: 'object CRUD + queries + user signup/login/session + file upload (postgres adapter)',
        requests: [
          {
            method: 'POST',
            path: '/parse/classes/Probe',
            headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' },
            body: { name: 'probe', score: 42 },
            capture: { objId: 'json:objectId' },
          },
          { method: 'GET', path: '/parse/classes/Probe', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
          { method: 'GET', path: '/parse/classes/Probe/{{objId}}', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
          { method: 'PUT', path: '/parse/classes/Probe/{{objId}}', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' }, body: { score: 43 } },
          {
            method: 'POST',
            path: '/parse/users',
            headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Revocable-Session': '1' },
            body: { username: 'probe', password: 'probe1234', email: 'probe@example.com' },
            capture: { session: 'json:sessionToken' },
          },
          { method: 'GET', path: '/parse/login?username=probe&password=probe1234', headers: { 'X-Parse-Application-Id': 'reducerApp' } },
          { method: 'GET', path: '/parse/users/me', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Session-Token': '{{session}}' } },
          { method: 'GET', path: '/parse/sessions/me', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Session-Token': '{{session}}' } },
          {
            method: 'POST',
            path: '/parse/files/probe.txt',
            headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey', 'content-type': 'text/plain' },
            body: 'hydration probe payload',
          },
          { method: 'GET', path: '/parse/classes/_User', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
          { method: 'DELETE', path: '/parse/classes/Probe/{{objId}}', headers: { 'X-Parse-Application-Id': 'reducerApp', 'X-Parse-Master-Key': 'reducerMasterKey' } },
          { method: 'GET', path: '/parse/functions/nope', headers: { 'X-Parse-Application-Id': 'reducerApp' } },
        ],
      },
    ],
  },

  // --------------------------------------------------------------------- n8n
  n8n: {
    argv: ['{{clone}}/packages/cli/bin/n8n', 'start'],
    cwd: 'packages/cli',
    env: {
      NODE_ENV: 'production',
      N8N_USER_FOLDER: `${SCRATCH}/n8n-home`,
      N8N_ENCRYPTION_KEY: 'reducer-corpus-v1-fixed-key',
      DB_TYPE: 'sqlite',
      DB_SQLITE_DATABASE: 'database.sqlite',
      DB_SQLITE_POOL_SIZE: '3',
      N8N_PROTOCOL: 'http',
      N8N_LISTEN_ADDRESS: '127.0.0.1',
      N8N_PORT: '5678',
      N8N_RUNNERS_BROKER_LISTEN_ADDRESS: '127.0.0.1',
      N8N_RUNNERS_BROKER_PORT: '5679',
      N8N_LOG_LEVEL: 'info',
      N8N_DIAGNOSTICS_ENABLED: 'false',
      N8N_VERSION_NOTIFICATIONS_ENABLED: 'false',
      N8N_TEMPLATES_ENABLED: 'false',
      N8N_LICENSE_AUTO_RENEW_ENABLED: 'false',
      N8N_PERSONALIZATION_ENABLED: 'false',
      N8N_HIRING_BANNER_ENABLED: 'false',
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'false',
    },
    setup: [`rm -rf ${SCRATCH}/n8n-home && mkdir -p ${SCRATCH}/n8n-home`],
    ready: { kind: 'http', value: 'http://127.0.0.1:5678/healthz/readiness', timeoutMs: 600_000 },
    settleMs: 5000,
    baseUrl: 'http://127.0.0.1:5678',
    quality: 'representative-endpoint-set',
    notes:
      'The stress case. Started through the pinned CLI entry with sqlite; owner setup, then the REST surface ' +
      'the editor itself calls (node types, credential types, workflows, executions, settings), then creating ' +
      'and MANUALLY EXECUTING a workflow — which is what forces the node/credential loading machinery behind ' +
      "n8n's 29,491 unresolved-specifier NFT warnings to actually resolve something.",
    phases: [
      {
        name: 'common',
        detail: 'health, settings, editor bootstrap, node/credential type catalogues',
        requests: [
          ...gets('/healthz', '/healthz/readiness', '/rest/settings', '/rest/login'),
          ...gets('/types/nodes.json', '/types/credentials.json', '/types/node-versions.json'),
        ],
      },
      {
        name: 'full',
        detail: 'owner setup → workflow create → MANUAL EXECUTION → executions/credentials/tags surface',
        requests: [
          {
            method: 'POST',
            path: '/rest/owner/setup',
            body: { email: 'probe@example.com', firstName: 'Probe', lastName: 'User', password: 'Probe1234' },
            capture: { cookie: 'header:set-cookie' },
            timeoutMs: 60_000,
          },
          { method: 'GET', path: '/rest/login', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/workflows', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/credentials', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/executions', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/tags', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/projects', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/node-types', headers: { cookie: '{{cookie}}' } },
          {
            method: 'POST',
            path: '/rest/node-types',
            headers: { cookie: '{{cookie}}' },
            body: {
              nodeInfos: [
                { name: 'n8n-nodes-base.set', version: 3.4 },
                { name: 'n8n-nodes-base.code', version: 2 },
                { name: 'n8n-nodes-base.httpRequest', version: 4.2 },
                { name: 'n8n-nodes-base.if', version: 2 },
                { name: 'n8n-nodes-base.webhook', version: 2 },
              ],
            },
          },
          {
            method: 'POST',
            path: '/rest/workflows',
            headers: { cookie: '{{cookie}}' },
            body: {
              name: 'hydration probe',
              nodes: [
                { parameters: {}, id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'When clicking Test', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0] },
                { parameters: { assignments: { assignments: [{ id: 'x', name: 'probe', value: 'hydration', type: 'string' }] }, options: {} }, id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', name: 'Edit Fields', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [220, 0] },
              ],
              connections: { 'When clicking Test': { main: [[{ node: 'Edit Fields', type: 'main', index: 0 }]] } },
              settings: {},
            },
            capture: { wfId: 'json:data.id' },
            timeoutMs: 60_000,
          },
          { method: 'GET', path: '/rest/workflows/{{wfId}}', headers: { cookie: '{{cookie}}' } },
          {
            method: 'POST',
            path: '/rest/workflows/{{wfId}}/run',
            headers: { cookie: '{{cookie}}' },
            body: { triggerToStartFrom: { name: 'When clicking Test' } },
            timeoutMs: 120_000,
            delayMs: 5000,
          },
          { method: 'GET', path: '/rest/executions', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/credentials/schema/httpBasicAuth', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/dynamic-node-parameters/options', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/community-packages', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/rest/binary-data', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/', timeoutMs: 60_000 },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------- ghost
  ghost: {
    argv: ['{{clone}}/ghost/core/index.js'],
    cwd: 'ghost/core',
    env: {
      NODE_ENV: 'development',
      url: 'http://localhost:2368',
      server__host: '127.0.0.1',
      server__port: '2368',
      database__client: 'sqlite3',
      database__connection__filename: `${SCRATCH}/ghost/ghost-reducer.db`,
      logging__level: 'info',
      logging__transports: '["stdout"]',
      paths__contentPath: `${SCRATCH}/ghost/content`,
    },
    setup: [
      `rm -rf ${SCRATCH}/ghost && mkdir -p ${SCRATCH}/ghost/content`,
      // Ghost's core is TypeScript and the frozen materialization declared
      // build:null, so `core/shared/config/index.ts` was never compiled and the
      // pinned entry dies on require. This is the repo's OWN `build:tsc`
      // script, run untraced; it only ADDS .js next to the .ts sources.
      'test -f {{clone}}/ghost/core/core/shared/config/index.js || ' +
        `${NODE} "$(ls -d {{clone}}/node_modules/.pnpm/typescript@*/node_modules/typescript/bin/tsc | head -1)" -p tsconfig.json`,
    ],
    ready: { kind: 'stdout', value: 'Ghost booted in|Ghost is running', timeoutMs: 600_000 },
    settleMs: 4000,
    baseUrl: 'http://127.0.0.1:2368',
    quality: 'representative-endpoint-set',
    notes:
      'Ghost on sqlite: the themed frontend (handlebars rendering, routing, feeds, sitemap) plus the public ' +
      'Content API and the unauthenticated half of the Admin API. Theme rendering is the part that pulls the ' +
      'widest dependency subgraph.',
    deviations: [
      'NODE_ENV=development, because the pinned Ghost refuses to boot in production without a mysql ' +
        'configuration; sqlite is only a development-mode database. Recorded rather than worked around.',
      "Ghost's core is TypeScript and corpus.json declares build:null, so the frozen clone had no compiled " +
        "core/shared/*.js and the pinned entry threw MODULE_NOT_FOUND on './shared/config'. The repo's own " +
        '`build:tsc` was run untraced before measurement; it only adds .js files, which are outside the frozen ' +
        'universe and are reported there. The pinned NFT trace was taken against the same uncompiled tree, so ' +
        "Ghost's own compiled first-party code is candidate-COLD by construction.",
    ],
    phases: [
      {
        name: 'common',
        detail: 'themed frontend pages (handlebars render path)',
        requests: gets('/', '/about/', '/tag/getting-started/', '/author/ghost/', '/welcome/', '/404-does-not-exist/'),
      },
      {
        name: 'full',
        detail: 'feeds, sitemap, robots, public Content API, admin API bootstrap, static assets',
        requests: gets(
          '/rss/',
          '/sitemap.xml',
          '/sitemap-posts.xml',
          '/sitemap-pages.xml',
          '/robots.txt',
          '/ghost/api/admin/site/',
          '/ghost/api/admin/authentication/setup/',
          '/members/api/member',
          '/public/cards.min.css',
          '/assets/built/screen.css',
          '/ghost/',
        ),
      },
    ],
  },

  // ------------------------------------------------------------ uptime-kuma
  'uptime-kuma': {
    argv: ['{{clone}}/server/server.js', '--port=3408', '--host=127.0.0.1'],
    env: {
      NODE_ENV: 'production',
      UPTIME_KUMA_DB_TYPE: 'sqlite',
      DATA_DIR: `${SCRATCH}/kuma-data/`,
      UPTIME_KUMA_WS_ORIGIN_CHECK: 'cors-like',
    },
    setup: [
      `rm -rf ${SCRATCH}/kuma-data && mkdir -p ${SCRATCH}/kuma-data`,
      // The frozen materialization declared build:null, but the server hard-exits
      // without dist/index.html. This runs the repo's OWN vite build, untraced;
      // it only ADDS generated files, never modifies a frozen universe file.
      'test -f {{clone}}/dist/index.html || npm run build',
    ],
    ready: { kind: 'stdout', value: 'Listening on', timeoutMs: 420_000 },
    settleMs: 3000,
    baseUrl: 'http://127.0.0.1:3408',
    quality: 'representative-endpoint-set',
    notes:
      'Uptime Kuma is socket.io-first, so the workload is both halves: the real HTTP routes (entry-page, ' +
      'badges via the badge renderer, status pages, metrics, SPA catch-all) and a socket.io client driving ' +
      'the setup/login/monitor/tag/status-page/settings event handlers — the surface no HTTP request reaches.',
    deviations: [
      "uptime-kuma's frontend bundle was not part of the frozen materialization (corpus.json declares " +
        "build:null) and server.js exits without dist/index.html. The repo's own `npm run build` was run " +
        'untraced before measurement; every file it produced is outside the frozen universe and is reported there.',
    ],
    phases: [
      {
        name: 'common',
        detail: 'entry page, setup info, SPA shell and the static/catch-all routes',
        requests: gets('/api/entry-page', '/setup-database-info', '/robots.txt', '/', '/dashboard', '/.well-known/change-password'),
      },
      {
        name: 'full',
        detail: 'socket.io event surface (setup, login, add monitor, beats, charts, tags, status page, settings) then badge/metrics routes',
        command:
          `${NODE} -e 'const {io}=require("{{clone}}/node_modules/socket.io-client");` +
          `const s=io("http://127.0.0.1:3408",{transports:["websocket"]});` +
          `const call=(ev,...a)=>new Promise((res)=>s.emit(ev,...a,res));` +
          `const log=(n,r)=>console.log(n,JSON.stringify(r).slice(0,200));` +
          `const MON={type:"http",name:"self",parent:null,url:"http://127.0.0.1:3408/api/entry-page",method:"GET",interval:60,retryInterval:60,resendInterval:0,maxretries:0,notificationIDList:{},ignoreTls:false,upsideDown:false,expiryNotification:false,maxredirects:10,accepted_statuscodes:["200-299"],saveResponse:false,saveErrorResponse:true,responseMaxLength:1024,dns_resolve_type:"A",proxyId:null,authMethod:null,httpBodyEncoding:"json",kafkaProducerBrokers:[],kafkaProducerSaslOptions:{mechanism:"None"},rabbitmqNodes:[],conditions:[],active:true};` +
          `s.on("connect",async()=>{try{` +
          `log("needSetup",await call("needSetup"));` +
          `log("setup",await call("setup","admin","kuma-test-1234"));` +
          `log("login",await call("login",{username:"admin",password:"kuma-test-1234",token:""}));` +
          `const add=await call("add",MON);log("add",add);const id=add.monitorID;` +
          `log("getMonitorList",await call("getMonitorList"));` +
          `log("getMonitor",await call("getMonitor",id));` +
          `log("getMonitorBeats",await call("getMonitorBeats",id,24));` +
          `log("getMonitorChartData",await call("getMonitorChartData",id,24));` +
          `log("getSettings",await call("getSettings"));` +
          `log("addTag",await call("addTag",{name:"prod",color:"#059669"}));` +
          `log("getTags",await call("getTags"));` +
          `log("addStatusPage",await call("addStatusPage","Demo","demo"));` +
          `log("getStatusPage",await call("getStatusPage","demo"));` +
          `log("getMaintenanceList",await call("getMaintenanceList"));` +
          `log("getAPIKeyList",await call("getAPIKeyList"));` +
          `}catch(e){console.log("ERR",String(e).slice(0,300))}finally{setTimeout(()=>process.exit(0),1500)}});` +
          `setTimeout(()=>process.exit(0),60000);'`,
        timeoutMs: 120_000,
      },
      {
        name: 'extended',
        detail: 'badge renderer, status page render, push API and prometheus metrics',
        requests: gets(
          '/api/badge/1/status',
          '/api/badge/1/status?style=flat&label=Health',
          '/api/badge/1/uptime/24',
          '/api/badge/1/ping/24',
          '/api/badge/1/avg-response/24',
          '/api/badge/1/cert-exp',
          '/api/push/deadbeef?status=up&msg=OK&ping=12',
          '/api/status-page/demo',
          '/status/demo',
          '/metrics',
          '/some/unknown/spa/route',
        ),
      },
    ],
  },

  // ------------------------------------------------------- express-realworld
  'express-realworld': {
    argv: ['{{clone}}/dist/api/main.js'],
    env: {
      NODE_ENV: 'production',
      PORT: '3409',
      DATABASE_URL: 'postgresql://sara@127.0.0.1:5432/reducer_ws_express?schema=public',
      JWT_SECRET: 'hydration-probe-secret',
    },
    setup: [
      'createdb -h 127.0.0.1 -U sara reducer_ws_express 2>/dev/null || true',
      'npx --no-install prisma migrate deploy || npx prisma migrate deploy || true',
    ],
    ready: { kind: 'stdout', value: 'server up on port', timeoutMs: 180_000 },
    settleMs: 1000,
    baseUrl: 'http://127.0.0.1:3409',
    quality: 'representative-endpoint-set',
    notes:
      'The complete RealWorld API from src/app/routes/routes.ts driven end to end over Prisma/PostgreSQL: ' +
      'register two users, log in, update the profile, create/read/update an article, comment, favourite, ' +
      'follow, read the feed, then delete. The Prisma query engine is the native boundary this app exists to test.',
    phases: [
      { name: 'common', detail: 'unauthenticated reads', requests: gets('/', '/api/tags', '/api/articles', '/api/articles?limit=5&offset=0', '/api/articles/no-such-article-slug') },
      {
        name: 'full',
        detail: 'register → login → article/comment/favourite/follow/feed write path → delete',
        requests: [
          { method: 'POST', path: '/api/users', body: { user: { username: 'wsuser1', email: 'wsuser1@example.com', password: 'pass1234' } }, capture: { token1: 'json:user.token' } },
          { method: 'POST', path: '/api/users', body: { user: { username: 'wsuser2', email: 'wsuser2@example.com', password: 'pass1234' } } },
          { method: 'POST', path: '/api/users/login', body: { user: { email: 'wsuser1@example.com', password: 'pass1234' } }, capture: { token1: 'json:user.token' } },
          { method: 'GET', path: '/api/user', headers: { authorization: 'Token {{token1}}' } },
          { method: 'PUT', path: '/api/user', headers: { authorization: 'Token {{token1}}' }, body: { user: { bio: 'hydration probe' } } },
          { method: 'POST', path: '/api/articles', headers: { authorization: 'Token {{token1}}' }, body: { article: { title: 'Working Set Probe', description: 'probe description', body: 'probe body', tagList: ['reactjs', 'dragons'] } }, capture: { slug: 'json:article.slug' } },
          { method: 'GET', path: '/api/articles/{{slug}}' },
          { method: 'PUT', path: '/api/articles/{{slug}}', headers: { authorization: 'Token {{token1}}' }, body: { article: { body: 'updated body' } } },
          { method: 'POST', path: '/api/articles/{{slug}}/comments', headers: { authorization: 'Token {{token1}}' }, body: { comment: { body: 'a probe comment' } }, capture: { commentId: 'json:comment.id' } },
          { method: 'GET', path: '/api/articles/{{slug}}/comments' },
          { method: 'POST', path: '/api/articles/{{slug}}/favorite', headers: { authorization: 'Token {{token1}}' } },
          { method: 'GET', path: '/api/articles?favorited=wsuser1', headers: { authorization: 'Token {{token1}}' } },
          { method: 'GET', path: '/api/profiles/wsuser2', headers: { authorization: 'Token {{token1}}' } },
          { method: 'POST', path: '/api/profiles/wsuser2/follow', headers: { authorization: 'Token {{token1}}' } },
          { method: 'GET', path: '/api/articles/feed?limit=10&offset=0', headers: { authorization: 'Token {{token1}}' } },
          { method: 'DELETE', path: '/api/articles/{{slug}}/comments/{{commentId}}', headers: { authorization: 'Token {{token1}}' } },
          { method: 'DELETE', path: '/api/articles/{{slug}}', headers: { authorization: 'Token {{token1}}' } },
        ],
      },
    ],
  },

  // ------------------------------------------------------- hackathon-starter
  'hackathon-starter': {
    argv: ['{{clone}}/app.js'],
    env: {
      NODE_ENV: 'production',
      PORT: '3410',
      BASE_URL: 'http://localhost:3410',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/reducer_hackathon',
      SESSION_SECRET: 'reducer_measurement_secret',
      RATE_LIMIT_GLOBAL: '5000',
      RATE_LIMIT_STRICT: '2000',
      RATE_LIMIT_LOGIN: '2000',
    },
    setup: ['docker exec hyd-mongo mongosh --quiet --eval \'db.getSiblingDB("reducer_hackathon").dropDatabase()\' >/dev/null 2>&1 || true'],
    ready: { kind: 'stdout', value: 'App is running on', timeoutMs: 180_000 },
    settleMs: 1500,
    baseUrl: 'http://127.0.0.1:3410',
    quality: 'representative-endpoint-set',
    notes:
      'Every GET route in the app.js router table that returns non-5xx with the placeholder API keys, then ' +
      'the authenticated write path (signup → session → profile update → logout) which is what reaches ' +
      'mongoose, the bcrypt native binding, connect-mongo sessions and the pug render path.',
    phases: [
      {
        name: 'common',
        detail: 'public pages + static assets (pug rendering, sass output, express.static)',
        requests: gets('/', '/login', '/signup', '/forgot', '/contact', '/account', '/api', '/css/main.css', '/js/main.js', '/this-route-does-not-exist'),
      },
      {
        name: 'full',
        detail: 'the API-integration pages and the authenticated signup/profile/logout flow',
        requests: [
          ...gets('/api/chart', '/api/upload', '/api/here-maps', '/api/google-maps', '/api/stripe', '/api/twilio', '/api/paypal/cancel', '/api/scraping', '/api/github', '/api/pubchem', '/api/wikipedia', '/api/lastfm', '/ai', '/ai/llm-classifier', '/ai/rag'),
          { method: 'GET', path: '/signup', capture: { csrf: 'regex:csrf-token" content="([^"]*)', cookie: 'header:set-cookie' } },
          {
            method: 'POST',
            path: '/signup',
            headers: { cookie: '{{cookie}}', 'content-type': 'application/x-www-form-urlencoded' },
            body: '_csrf={{csrf}}&email=reducer-probe-1%40example.com&password=ReducerProbe123&confirmPassword=ReducerProbe123',
          },
          { method: 'GET', path: '/account', headers: { cookie: '{{cookie}}' } },
          { method: 'GET', path: '/logout', headers: { cookie: '{{cookie}}' } },
          ...gets('/js/lib/jquery.min.js', '/js/lib/bootstrap.min.js', '/webfonts/fa-solid-900.woff2'),
        ],
      },
    ],
  },

  // --------------------------------------------------------- excalidraw-room
  'excalidraw-room': {
    argv: ['{{clone}}/dist/index.js'],
    env: { NODE_ENV: 'production', PORT: '3411', CORS_ORIGIN: '*' },
    ready: { kind: 'http', value: 'http://127.0.0.1:3411/', timeoutMs: 60_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3411',
    quality: 'representative-endpoint-set',
    notes:
      'A socket.io collaboration server with exactly one HTTP route, so the representative workload is the ' +
      'socket protocol: two concurrent clients exercising every server-side handler (join-room in both the ' +
      'first-in-room and new-user branches, server-broadcast, server-volatile-broadcast, user-follow/unfollow, ' +
      'disconnecting). Driven over the raw engine.io websocket protocol because the repo ships no socket client.',
    phases: [
      { name: 'common', detail: 'the complete express surface: the single route, static public/, and a 404', requests: gets('/', '/test64.png', '/test128.png', '/test256.png', '/this-route-does-not-exist') },
      {
        name: 'full',
        detail: 'two concurrent socket.io clients driving every server-side event handler',
        command:
          `${NODE} -e 'const U="ws://127.0.0.1:3411/socket.io/?EIO=4&transport=websocket";` +
          `const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));` +
          `const mk=(n)=>new Promise((res)=>{const ws=new WebSocket(U);ws.sid=null;ws.onmessage=(e)=>{const d=String(e.data);` +
          `if(d[0]==="0"){ws.send("40");}else if(d.startsWith("40")){ws.sid=JSON.parse(d.slice(2)).sid;console.log(n,"connected");res(ws);}` +
          `else if(d==="2"){ws.send("3");}else if(d.startsWith("42")){console.log(n,"<-",d.slice(2,120));}};});` +
          `(async()=>{const a=await mk("A"),b=await mk("B");` +
          `a.send("42"+JSON.stringify(["join-room","reducer-room"]));await sleep(300);` +
          `b.send("42"+JSON.stringify(["join-room","reducer-room"]));await sleep(300);` +
          `a.send("42"+JSON.stringify(["server-broadcast","reducer-room",[1,2,3,4],[9,9]]));` +
          `a.send("42"+JSON.stringify(["server-volatile-broadcast","reducer-room",[5,6],[1]]));await sleep(300);` +
          `b.send("42"+JSON.stringify(["user-follow",{userToFollow:{socketId:a.sid,username:"A"},action:"FOLLOW"}]));await sleep(300);` +
          `b.send("42"+JSON.stringify(["user-follow",{userToFollow:{socketId:a.sid,username:"A"},action:"UNFOLLOW"}]));await sleep(300);` +
          `b.close();await sleep(400);a.close();await sleep(600);process.exit(0);})();'`,
        timeoutMs: 60_000,
      },
      {
        name: 'extended',
        detail: 'the same protocol over the HTTP long-polling transport (engine.io polling + packet encoders)',
        requests: [get('/socket.io/?EIO=4&transport=polling')],
      },
    ],
  },

  // ----------------------------------------------- nestjs-typescript-starter
  'nestjs-typescript-starter': {
    argv: ['{{clone}}/dist/main.js'],
    env: { NODE_ENV: 'production' },
    ready: { kind: 'tcp', port: 3000, timeoutMs: 120_000 },
    settleMs: 500,
    baseUrl: 'http://127.0.0.1:3000',
    quality: 'smoke',
    notes:
      'The complete route table of this app is one handler (GET /). Honestly labelled `smoke`: it is a ' +
      'floor case that measures what booting the Nest framework itself costs, not what a real workload costs.',
    phases: [
      { name: 'common', detail: 'the entire route table: GET / plus HEAD and a 404', requests: [get('/'), { method: 'HEAD', path: '/' }, get('/does-not-exist')] },
    ],
  },

  // ------------------------------------------------------ bulletproof-nodejs
  'bulletproof-nodejs': {
    argv: ['{{clone}}/build/app.js'],
    cwd: `${SCRATCH}/bulletproof-run`,
    env: {
      NODE_ENV: 'production',
      // tsc does not rewrite tsconfig `paths`, and the repo ships neither
      // `module-alias` nor `_moduleAliases`, so `web: node build/app.js` cannot
      // resolve its own `@/…` imports as published. NODE_PATH + an `@` symlink
      // is the launcher-level equivalent: no source is changed and no module is
      // added to the graph.
      NODE_PATH: `${SCRATCH}/bulletproof-alias`,
      PORT: '3412',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/bulletproof-nodejs',
      JWT_SECRET: 'p4sta.w1th-b0logn3s3-s@uce',
      JWT_ALGO: 'HS256',
      LOG_LEVEL: 'silly',
      AGENDA_DB_COLLECTION: 'agendaJobs',
      AGENDA_POOL_TIME: '5 seconds',
      AGENDA_CONCURRENCY: '20',
      MAILGUN_API_KEY: 'key-0000000000000000000000000000000',
      MAILGUN_USERNAME: 'api',
      MAILGUN_DOMAIN: 'example.invalid',
    },
    setup: [
      // The frozen materialization installed with --ignore-scripts (recorded in
      // MATERIALIZATION.md), so argon2's binding was never compiled and the app
      // dies on require. Building it ADDS a .node inside an already-opaque
      // (therefore already-HOT) package; no frozen universe file is modified.
      'test -f {{clone}}/node_modules/argon2/lib/binding/napi-v3/argon2.node || (cd {{clone}} && npm rebuild argon2 --build-from-source) || true',
      // never `rm -rf` the run dir: it is this recipe's cwd, and deleting it
      // makes every later setup command and the spawn itself fail with a
      // misleading ENOENT that names the node binary
      `rm -rf ${SCRATCH}/bulletproof-alias`,
      `mkdir -p ${SCRATCH}/bulletproof-alias ${SCRATCH}/bulletproof-run && : > ${SCRATCH}/bulletproof-run/.env`,
      `ln -sfn {{clone}}/build ${SCRATCH}/bulletproof-alias/@`,
    ],
    ready: { kind: 'stdout', value: 'Server listening on port', timeoutMs: 180_000 },
    settleMs: 1000,
    baseUrl: 'http://127.0.0.1:3412',
    quality: 'representative-endpoint-set',
    notes:
      'Every route this app mounts, ordered so state flows: status, signup, signin, the Bearer-authenticated ' +
      'current-user route, logout, the validation-failure paths, and the agendash job dashboard (which is the ' +
      'only route that exercises the agenda/mongo job machinery).',
    deviations: [
      "argon2's native binding was absent from the frozen materialization (installed with --ignore-scripts) and " +
        'is on the startup require path. It was compiled from source untraced before measurement; that only ADDS ' +
        'a file to an already-opaque package and modifies no frozen universe file.',
      'This application cannot start from its published entry as frozen: tsc leaves its `@/…` tsconfig-path ' +
        'imports unrewritten and the repo ships no `module-alias`, so `node build/app.js` (its own Procfile ' +
        'command) throws MODULE_NOT_FOUND on `@/config`. It was launched with NODE_PATH pointing at a scratch ' +
        'directory holding an `@` symlink to build/. NOTE FOR INTERPRETATION: the pinned NFT trace could not ' +
        'follow those specifiers either, so this app’s own first-party code is largely candidate-COLD and its ' +
        'hydration figure is expected to be high. That is a real property of the frozen baseline, not an artefact ' +
        'of the launcher.',
    ],
    phases: [
      { name: 'common', detail: 'status probe and the unauthenticated error paths', requests: [get('/status'), { method: 'HEAD', path: '/status' }, get('/api/users/me'), get('/api/nope')] },
      {
        name: 'full',
        detail: 'signup → signin → authenticated me → logout, validation failures, and the agendash dashboard',
        requests: [
          { method: 'POST', path: '/api/auth/signup', body: { name: 'Probe User', email: 'probe1@example.com', password: 'hunter2hunter2' }, capture: { token: 'json:token' }, timeoutMs: 60_000 },
          { method: 'POST', path: '/api/auth/signin', body: { email: 'probe1@example.com', password: 'hunter2hunter2' }, capture: { token: 'json:token' }, timeoutMs: 60_000 },
          { method: 'GET', path: '/api/users/me', headers: { authorization: 'Bearer {{token}}' } },
          { method: 'POST', path: '/api/auth/logout', headers: { authorization: 'Bearer {{token}}' }, body: {} },
          { method: 'POST', path: '/api/auth/signup', body: { email: 'missing-fields@example.com' } },
          { method: 'POST', path: '/api/auth/signin', body: { email: 'nobody@example.com', password: 'whatever' } },
          { method: 'GET', path: '/api/dash/api', headers: { authorization: 'Basic YWdlbmRhc2g6MTIzNDU2' } },
          { method: 'GET', path: '/api/dash/', headers: { authorization: 'Basic YWdlbmRhc2g6MTIzNDU2' } },
        ],
      },
    ],
  },
};


/**
 * Applications that cannot be measured, with the reason. Recorded here so the
 * corpus roster stays 19 and a blocked app is reported as blocked rather than
 * silently shrinking the denominator.
 */
export const BLOCKED: Record<string, string> = {
  ghost:
    'Frozen materialization gap, surfaced by this experiment: corpus.json declares build:null for ghost, but ' +
    "Ghost's monorepo ships its workspace packages as TypeScript SOURCE ONLY (packages/adapters/storage-base " +
    'has `main: build/index.js` and no build/), and ghost/core\'s own core/shared/config is index.ts. The pinned ' +
    "entry therefore cannot boot: first MODULE_NOT_FOUND on './shared/config', and after running the repo's own " +
    '`build:tsc`, MODULE_NOT_FOUND on ghost-storage-base (an unbuilt workspace package). Making it run needs a ' +
    'full `pnpm nx run-many -t build` of the Ghost monorepo, which would produce a materially different tree ' +
    'from the one the preserved placement was computed against. The tsc output was reverted and the clone left ' +
    'byte-identical. NOTE: the same gap means the preserved Plan A/B numbers for ghost describe a tree that ' +
    'cannot execute, which is a finding about the corpus, not about virtualization.',
  'bulletproof-nodejs':
    'Two independent blockers, both materialization/upstream defects. (1) argon2\'s native binding is absent ' +
    '(MATERIALIZATION.md records this clone was installed with --ignore-scripts) and is on the startup require ' +
    'path; `npm rebuild argon2 --build-from-source` fails because argon2@0.27 pins node-pre-gyp v0.15.0, which ' +
    'does not work on Node 24, and no darwin-arm64 prebuild exists upstream. (2) Separately, tsc leaves the ' +
    "app's `@/…` tsconfig-path imports unrewritten and the repo ships no module-alias, so its own Procfile " +
    'command cannot resolve them; that half was worked around with NODE_PATH and did resolve. The app reaches ' +
    'build/services/auth.js and then dies on argon2, so no startup trace is obtainable.',
  'nestjs-realworld':
    'Frozen materialization defect, not an experiment limitation: 47 top-level directories in this clone\'s ' +
    'node_modules are EMPTY (no package.json, no files) — the recorded npm "Exit handler never called" failure ' +
    'in MATERIALIZATION.md. `require("@nestjs/core")` fails at the first import of the pinned entry with ' +
    "Cannot find module 'event-emitter', so no startup trace is obtainable. Repairing it needs a re-install, " +
    'which would rewrite files INSIDE the frozen production universe and invalidate the preserved placement, ' +
    'so the app is reported as not-measured instead. Fixing it requires an explicit corpus revision.',
};
