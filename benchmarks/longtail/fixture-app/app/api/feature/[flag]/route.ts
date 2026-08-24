/**
 * FEATURE-FLAG / CONFIGURATION long tail.
 *
 * A feature toggle read from a configuration file at request time, gating a
 * conditional dynamic import. The flag is off in the default configuration this
 * deployment's common traffic exercises, so the gated subtree is never loaded
 * until a request arrives with the feature enabled for that caller.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

interface Features {
  [flag: string]: { enabled: boolean };
}

export async function GET(_req: Request, { params }: { params: Promise<{ flag: string }> }) {
  const { flag } = await params;
  const cfg = JSON.parse(
    await readFile(path.join(process.cwd(), 'config', 'features.json'), 'utf8'),
  ) as Features;
  if (!cfg[flag]?.enabled) return Response.json({ flag, enabled: false }, { status: 404 });

  if (flag === 'temporal') {
    const { Temporal } = await import('@js-temporal/polyfill');
    const d = Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO('UTC');
    return Response.json({ flag, enabled: true, value: d.toString() });
  }
  if (flag === 'spreadsheet-preview') {
    const ExcelJS = (await import('exceljs')).default;
    return Response.json({ flag, enabled: true, value: typeof ExcelJS.Workbook });
  }
  return Response.json({ flag, enabled: true, value: null });
}
