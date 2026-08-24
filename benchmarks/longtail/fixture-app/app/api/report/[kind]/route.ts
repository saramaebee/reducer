/**
 * RARE-ROUTE long tail.
 *
 * A reporting endpoint whose serializer is chosen by a path segment. Each
 * format is a separate leaf library loaded only when that format is actually
 * asked for — the ordinary shape of an export/report surface.
 */
import { PRODUCTS } from '../../../../lib/data';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  if (kind === 'csv') {
    const Papa = (await import('papaparse')).default;
    const csv = Papa.unparse(PRODUCTS);
    return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
  }
  if (kind === 'markdown') {
    const { marked } = await import('marked');
    const md = ['# Report', '', ...PRODUCTS.slice(0, 5).map((p) => `- **${p.sku}** — ${p.price}`)].join('\n');
    return new Response(await marked.parse(md), { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (kind === 'json') {
    return Response.json({ products: PRODUCTS });
  }
  return Response.json({ error: 'unknown report kind' }, { status: 404 });
}
