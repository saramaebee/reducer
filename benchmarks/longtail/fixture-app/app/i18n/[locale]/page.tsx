/**
 * LOCALE long tail.
 *
 * Filesystem-backed i18n: the message catalogue and the localized content pages
 * are read from disk at request time, the shape `i18next-fs-backend`,
 * `next-intl`'s file loader and every CMS-driven Next deployment use. A
 * deployment whose observed traffic is all default-locale never reads any other
 * catalogue or any other content directory, yet each is legitimate production
 * traffic — a locale fallback, a second market, a crawler with an
 * `Accept-Language` the training run never sent.
 *
 * Deliberately NOT a bundler-visible static import map: a catalogue that the
 * build inlines into a server chunk is not a placement decision at all, and
 * inlining is what Next does to `import()` of a template-literal path.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const SUPPORTED = ['en', 'de', 'fr', 'ja', 'pt-br'] as const;

export default async function LocalePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!(SUPPORTED as readonly string[]).includes(locale)) {
    return <main data-testid="locale-unknown">unsupported locale</main>;
  }
  const root = process.cwd();
  const messages = JSON.parse(
    await readFile(path.join(root, 'messages', `${locale}.json`), 'utf8'),
  ) as Record<string, string>;

  const contentDir = path.join(root, 'content', locale);
  const names = (await readdir(contentDir)).filter((f) => f.endsWith('.md')).sort();
  const pages = await Promise.all(
    names.map(async (f) => ({ slug: f.replace(/\.md$/, ''), body: await readFile(path.join(contentDir, f), 'utf8') })),
  );

  return (
    <main>
      <h1 data-testid="greeting">{messages.greeting}</h1>
      <p data-testid="tagline">{messages.tagline}</p>
      <p data-testid="keys">{Object.keys(messages).length}</p>
      <ul data-testid="pages">
        {pages.map((p) => (
          <li key={p.slug}>
            {p.slug}:{p.body.length}
          </li>
        ))}
      </ul>
    </main>
  );
}
