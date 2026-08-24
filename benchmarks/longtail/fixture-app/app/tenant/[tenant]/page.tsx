/**
 * TENANT / CONFIGURATION long tail.
 *
 * A per-tenant JSON config read from a configuration DIRECTORY at request time
 * (not imported, so no bundler and no static tracer sees the edge), which then
 * selects a tenant renderer by dynamic import. This is how a multi-tenant
 * self-hosted deployment normally differs per customer: one config file and one
 * renderer per tenant, both chosen at runtime.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const TENANTS = ['acme', 'globex', 'initech'] as const;

const RENDERER: Record<string, () => Promise<{ render: (cfg: TenantConfig) => Promise<string> }>> = {
  acme: () => import('../../../themes/acme'),
  globex: () => import('../../../themes/globex'),
  initech: () => import('../../../themes/initech'),
};

export interface TenantConfig {
  tenant: string;
  displayName: string;
  currency: string;
  renderer: string;
  banner: string;
}

export default async function TenantPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await params;
  if (!(TENANTS as readonly string[]).includes(tenant)) {
    return <main data-testid="tenant-unknown">unknown tenant</main>;
  }
  const cfgPath = path.join(process.cwd(), 'config', 'tenants', `${tenant}.json`);
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as TenantConfig;
  const { render } = await RENDERER[tenant]!();
  const html = await render(cfg);
  return (
    <main>
      <h1 data-testid="tenant">{cfg.displayName}</h1>
      <div data-testid="rendered" dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
