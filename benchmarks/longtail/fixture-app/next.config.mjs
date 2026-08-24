/**
 * The long-tail fixture is a self-hosted Next.js server, not a bundling
 * experiment. `serverExternalPackages` keeps the heavy leaf libraries as real
 * `node_modules` requires at runtime instead of inlining them into a server
 * chunk — the ordinary, documented configuration for large or native-adjacent
 * server dependencies, and the one every self-hosted deployment of this shape
 * uses. Without it the bundler would flatten package structure into a handful
 * of chunk files and the experiment would be measuring webpack, not Node
 * resolution.
 */
const nextConfig = {
  output: 'standalone' === process.env.NEXT_OUTPUT ? 'standalone' : undefined,
  // Next's production server preloads EVERY app route module at startup, which
  // pulls each route's whole external dependency subtree into memory before the
  // first request. `preloadEntriesOnStart: false` is Next's own documented
  // opt-out, provided for exactly this reason (self-hosted deployments that do
  // not want to pay the whole graph up front). With it, a route's modules load
  // when that route is first requested — the behaviour this fixture exists to
  // represent. The default-preload behaviour is measured and reported too; it
  // is a finding about self-hosted Next, not something to hide.
  experimental: { preloadEntriesOnStart: false },
  serverExternalPackages: [
    'exceljs',
    'dayjs',
    'marked',
    'papaparse',
    'qrcode',
    'handlebars',
    'serialize-error',
    'stacktrace-parser',
    '@js-temporal/polyfill',
  ],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
