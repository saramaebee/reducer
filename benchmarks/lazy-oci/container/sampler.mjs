/**
 * Fetch-state sampler: one long-lived process polling nydusd's API socket, so
 * the temporal curves cost one node process per trial instead of a curl fork
 * every 100 ms. Identical in every arm.
 *
 * argv: sampler.mjs <api.sock> <out.jsonl>
 */
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , sock, out] = process.argv;

const get = (path) =>
  new Promise((res) => {
    const req = http.request({ socketPath: sock, path, method: 'GET', timeout: 500 }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => {
        try {
          res(JSON.parse(b));
        } catch {
          res(null);
        }
      });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => {
      req.destroy();
      res(null);
    });
    req.end();
  });

for (;;) {
  const [be, bc, fs] = await Promise.all([
    get('/api/v1/metrics/backend'),
    get('/api/v1/metrics/blobcache'),
    get('/api/v1/metrics'),
  ]);
  if (be || bc || fs) {
    appendFileSync(
      out,
      `${JSON.stringify({
        at: Date.now(),
        rq: be?.read_count ?? null,
        rb: be?.read_amount_total ?? null,
        rlat: be?.read_cumulative_latency_millis_total ?? null,
        pf: bc?.prefetch_data_amount ?? null,
        pfr: bc?.prefetch_requests_count ?? null,
        allReady: bc?.data_all_ready ?? null,
        fsRead: fs?.data_read ?? null,
      })}\n`,
    );
  }
  await sleep(100);
}
