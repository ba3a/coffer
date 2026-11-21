import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { renderMarkdown } from '../src/markdown/render.js';

const fixtures = fileURLToPath(new URL('./fixtures/typography/', import.meta.url));
const NOW = new Date('2026-06-01T12:00:00Z');
const offline = async () => new Response('', { status: 404 });

/** Fixture name to the typography locale it is rendered with. `neutral` has no rules of its own. */
const LOCALES = /** @type {const} */ ({ en: 'en', ru: 'ru', de: 'de', fr: 'fr', hy: 'hy', neutral: 'xx' });

/**
 * @param {string} locale
 */
const settings = (locale) => ({ enabled: true, locale, dashStyle: /** @type {const} */ ('locale'), headings: /** @type {const} */ ('locale'), widows: false, hanging: false });

/** @param {string} name */
const source = (name) => readFileSync(join(fixtures, `${name}.md`), 'utf8');
/** @param {string} html */
const text = (html) => html.replace(/<[^>]+>/g, '');

for (const [name, locale] of Object.entries(LOCALES)) {
  test(`golden: ${name} output matches ${name}.html`, async () => {
    const { html } = await renderMarkdown(source(name), { typography: settings(locale) });
    const golden = join(fixtures, `${name}.html`);
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(golden)) writeFileSync(golden, html);
    assert.equal(html, readFileSync(golden, 'utf8'));
  });

  test(`golden: ${name} reports its unpaired quote once`, async () => {
    const { typographyWarnings } = await renderMarkdown(source(name), { typography: settings(locale), file: `${name}.md` });
    assert.equal(typographyWarnings.length, 1);
  });

  test(`idempotence: typesetting the ${name} output again changes no text`, async () => {
    const first = await renderMarkdown(source(name), { typography: settings(locale) });
    // Take the typeset text back to Markdown-free plain paragraphs and typeset it again.
    const lines = text(first.html).split('\n').map((l) => l.trim()).filter(Boolean);
    const second = await renderMarkdown(lines.join('\n\n'), { typography: settings(locale) });
    assert.equal(text(second.html).split('\n').filter(Boolean).join('|'), lines.join('|'));
  });

  test(`ids: ${name} heading ids equal those of a build with typography off`, async () => {
    const on = await renderMarkdown(source(name), { typography: settings(locale) });
    const off = await renderMarkdown(source(name), { typography: { ...settings(locale), enabled: false, locale } });
    const none = await renderMarkdown(source(name));
    const ids = (/** @type {string} */ h) => [...h.matchAll(/<h[1-6][^>]* id="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(ids(on.html).length > 0, 'the fixture has a heading with an id');
    assert.deepEqual(ids(on.html), ids(off.html));
    assert.deepEqual(ids(on.html), ids(none.html));
  });
}

test('golden: every locale has a markdown and an html file', () => {
  const files = readdirSync(fixtures);
  for (const name of Object.keys(LOCALES)) {
    assert.ok(files.includes(`${name}.md`), `${name}.md`);
    assert.ok(files.includes(`${name}.html`), `${name}.html`);
  }
});

test('exclusions: code, attributes, raw HTML, alt text and URLs keep their bytes', async () => {
  const bytes = [
    '`"a" -- b... it\'s`',
    '<div title="a -- \'b\'...">"raw" -- html...</div>',
    '![say "hi" -- ok...](pic.png "t \'x\' -- y")',
    '[link](https://example.com/a--b?q="x"&r=\'y\' "ti\'tle -- 1")',
    'https://example.com/a--b...c?q=1',
    'me@example.com',
  ];
  const fence = '```js\nconst s = "a" -- \'b\'...;\n```';
  for (const [name, locale] of Object.entries(LOCALES)) {
    const src = `${bytes.join('\n\n')}\n\n${fence}\n`;
    const on = await renderMarkdown(src, { typography: settings(locale) });
    const off = await renderMarkdown(src, { typography: { ...settings(locale), enabled: false, locale } });
    assert.equal(on.html, off.html, `${name}: excluded content is byte-identical to a typography-off build`);
  }
});

test('exclusions: typeset text next to excluded text still changes', async () => {
  const { html } = await renderMarkdown('say "a" `"b"`', { typography: settings('en') });
  assert.match(html, /say “a” <code>"b"<\/code>/);
});

/**
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-typography-golden-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {{ siteLang?: string, siteExtra?: string, blogExtra?: string }} [o]
 */
const config = ({ siteLang = 'en', siteExtra = '', blogExtra = '' } = {}) =>
  [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    `    lang: ${siteLang}`,
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    contentDir: notes',
    siteExtra,
    '    blogs:',
    `      - { id: notes, dir: notes, prefix: log, title: Notes${blogExtra ? `, ${blogExtra}` : ''} }`,
    '',
  ].join('\n');

/**
 * @param {string} body
 * @param {string} [fm]
 */
const post = (body, fm = '') => `---\ntitle: T\ndate: 2026-05-01\n${fm}---\n\n${body}\n`;

/**
 * Builds the tree and returns the text of each post's page.
 * @param {Record<string, string>} files
 * @param {string[]} slugs
 * @returns {Promise<Record<string, string>>}
 */
async function pages(files, slugs) {
  return inTree(files, async (root) => {
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
      out: join(root, 'out'),
      now: NOW,
      videoFetch: { fetch: offline },
    });
    return Object.fromEntries(slugs.map((s) => [s, readFileSync(join(result.outDir, 'log', s, 'index.html'), 'utf8')]));
  });
}

test('locale resolution: post over blog over site, through a built site', async () => {
  const body = 'Say "x" -- y.';
  const out = await pages(
    {
      'coffer.yaml': config({ siteLang: 'de', blogExtra: 'lang: fr' }),
      'notes/post.md': post(body, 'lang: ru\n'),
      'notes/blog.md': post(body),
    },
    ['post', 'blog'],
  );
  assert.match(out.post, /«x»/, 'post lang ru wins over blog fr and site de');
  assert.match(out.blog, /«(?: | )?x(?: | )?»/, 'blog lang fr wins over site de');
  assert.ok(!out.blog.includes('„'), 'the site de rules are not used when the blog sets fr');
});

test('locale resolution: the site language is used when nothing is nearer', async () => {
  const out = await pages({ 'coffer.yaml': config({ siteLang: 'de' }), 'notes/a.md': post('Say "x".') }, ['a']);
  assert.match(out.a, /„x“/);
});

test('locale resolution: typography.locale overrides the language for rules only', async () => {
  const out = await pages({ 'coffer.yaml': config(), 'notes/a.md': post('Say "x".', 'typography: { locale: de }\n') }, ['a']);
  assert.match(out.a, /„x“/);
  assert.ok(!out.a.includes('lang="de"'), 'the content language stays the site language');
});

test('locale resolution: fr-CH falls back to the rules of fr', async () => {
  const out = await pages({ 'coffer.yaml': config(), 'notes/a.md': post('Say "x".', 'lang: fr-CH\n') }, ['a']);
  assert.match(out.a, /«(?: | )?x(?: | )?»/);
  assert.match(out.a, /<article class="post" lang="fr-CH">/);
});

test('locale resolution: an unknown language gets the neutral set', async () => {
  const out = await pages({ 'coffer.yaml': config(), 'notes/a.md': post('Say "x" -- y... the "box".', 'lang: tlh\n') }, ['a']);
  assert.match(out.a, /Say “x” – y… the “box”\./);
  assert.match(out.a, /lang="tlh"/);
});

test('the example site has two locales', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'coffer-typography-example-'));
  try {
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'example', 'coffer.yaml') }), {
      out,
      now: NOW,
      videoFetch: { fetch: offline },
    });
    const journal = join(result.outDir, 'journal');
    const langs = new Set(['en']);
    for (const dir of readdirSync(journal, { withFileTypes: true })) {
      const file = join(journal, dir.name, 'index.html');
      if (!dir.isDirectory() || !existsSync(file)) continue;
      const m = readFileSync(file, 'utf8').match(/<article class="post"[^>]* lang="([^"]+)"/);
      if (m) langs.add(m[1]);
    }
    assert.ok(langs.has('ru') && langs.has('en'), [...langs].join(','));
    assert.ok(langs.size >= 2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
