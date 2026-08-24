import Handlebars from 'handlebars';
import type { TenantConfig } from '../app/tenant/[tenant]/page';

/** A tenant whose branding is a Handlebars template — a normal CMS-ish shape. */
const TEMPLATE = '<section class="globex"><h2>{{displayName}}</h2><p>{{banner}}</p><small>{{currency}}</small></section>';

export async function render(cfg: TenantConfig): Promise<string> {
  return Handlebars.compile(TEMPLATE)(cfg);
}
