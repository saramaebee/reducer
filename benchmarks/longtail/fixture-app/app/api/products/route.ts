import { z } from 'zod';
import { PRODUCTS } from '../../../lib/data';

export const dynamic = 'force-dynamic';

const Query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });

/** The common happy path: the collection every client reads on every page load. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = Query.safeParse({ limit: url.searchParams.get('limit') ?? undefined });
  if (!parsed.success) return Response.json({ error: 'bad query' }, { status: 400 });
  return Response.json({ products: PRODUCTS.slice(0, parsed.data.limit) });
}
