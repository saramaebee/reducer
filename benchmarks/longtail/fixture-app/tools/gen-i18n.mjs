/**
 * Generate the fixture's localized catalogues and content pages.
 *
 * Deterministic (no RNG, no clock), so the tree is byte-reproducible and the
 * committed fixture always matches what this script would emit. Catalogue and
 * page sizes are chosen to be ordinary for a real product surface — a few
 * thousand translated strings and a dozen localized pages per market — because
 * a locale long tail measured in tens of bytes cannot move any latency metric
 * and would make the fixture uninterpretable.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const LOCALES = {
  en: { greeting: 'Hello', tagline: 'The default catalogue', word: 'widget' },
  de: { greeting: 'Hallo', tagline: 'Der Standardkatalog', word: 'Bauteil' },
  fr: { greeting: 'Bonjour', tagline: 'Le catalogue par defaut', word: 'composant' },
  ja: { greeting: 'こんにちは', tagline: '既定のカタログ', word: '部品' },
  'pt-br': { greeting: 'Ola', tagline: 'O catalogo padrao', word: 'peca' },
};
const SECTIONS = [
  'checkout', 'catalog', 'account', 'billing', 'shipping', 'search',
  'reviews', 'support', 'legal', 'onboarding', 'errors', 'admin',
];
const KEYS_PER_SECTION = 160;
const PAGES = ['home', 'pricing', 'faq', 'terms', 'privacy', 'shipping', 'returns', 'contact', 'about', 'careers', 'security', 'status'];

for (const [tag, l] of Object.entries(LOCALES)) {
  const messages = { greeting: l.greeting, tagline: l.tagline, currencyLabel: `${l.word}.price` };
  for (const s of SECTIONS) {
    for (let i = 0; i < KEYS_PER_SECTION; i++) {
      messages[`${s}.k${String(i).padStart(3, '0')}`] =
        `${l.greeting} — ${s} ${l.word} ${i}: ${l.tagline} (${tag})`;
    }
  }
  writeFileSync(path.join(ROOT, 'messages', `${tag}.json`), `${JSON.stringify(messages, null, 1)}\n`);

  const dir = path.join(ROOT, 'content', tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const p of PAGES) {
    const body = [
      `# ${l.greeting}: ${p}`,
      '',
      ...Array.from(
        { length: 40 },
        (_, i) => `${i + 1}. ${l.tagline} — ${p} ${l.word} ${i}. ${l.greeting} ${tag} ${p} ${i}.`,
      ),
      '',
    ].join('\n');
    writeFileSync(path.join(dir, `${p}.md`), body);
  }
}
console.log('generated', Object.keys(LOCALES).length, 'locales ×', SECTIONS.length * KEYS_PER_SECTION + 3, 'keys and', PAGES.length, 'pages');
