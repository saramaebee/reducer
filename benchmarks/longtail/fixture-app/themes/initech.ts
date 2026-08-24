import QRCode from 'qrcode';
import type { TenantConfig } from '../app/tenant/[tenant]/page';

/** A tenant whose page embeds a generated QR code — one optional leaf library. */
export async function render(cfg: TenantConfig): Promise<string> {
  const svg = await QRCode.toString(`tenant:${cfg.tenant}`, { type: 'svg', margin: 0, width: 96 });
  return `<section class="initech"><p>${cfg.banner}</p>${svg}</section>`;
}
