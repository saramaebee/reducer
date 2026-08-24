/**
 * ADMIN / OPTIONAL-SUBTREE long tail.
 *
 * A spreadsheet export behind an admin token. `exceljs` is a large optional
 * subtree that only this one route reaches — the canonical "feature almost
 * nobody uses but every deployment ships" shape.
 */
import ExcelJS from 'exceljs';
import { PRODUCTS } from '../../../../lib/data';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (req.headers.get('x-admin-token') !== process.env.ADMIN_TOKEN) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('products');
  ws.columns = [
    { header: 'sku', key: 'sku' },
    { header: 'name', key: 'name' },
    { header: 'price', key: 'price' },
    { header: 'stock', key: 'stock' },
  ];
  for (const p of PRODUCTS) ws.addRow(p);
  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'x-rows': String(PRODUCTS.length),
    },
  });
}
