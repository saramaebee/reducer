/**
 * ERROR-PATH long tail.
 *
 * A route that fails the way production routes fail (a downstream throw), with
 * a structured error report built by the ordinary error-reporting libraries.
 * Those libraries are only ever loaded when something actually goes wrong, so
 * a workload where nothing goes wrong never observes them.
 */
import { reportError } from '../../../lib/error-report';

export const dynamic = 'force-dynamic';

function downstream(): never {
  const err = new Error('synthetic downstream failure');
  (err as Error & { code?: string }).code = 'E_DOWNSTREAM';
  throw err;
}

export async function GET() {
  try {
    downstream();
  } catch (err) {
    return Response.json(await reportError(err), { status: 500 });
  }
}
