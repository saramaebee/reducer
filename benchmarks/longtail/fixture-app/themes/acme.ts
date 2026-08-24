import type { TenantConfig } from '../app/tenant/[tenant]/page';

/** The default tenant renderer: plain markup, no extra dependency. */
export async function render(cfg: TenantConfig): Promise<string> {
  return `<section class="acme"><p>${cfg.banner}</p><p>${cfg.currency}</p></section>`;
}
