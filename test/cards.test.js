import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import {
  CARD_HEIGHT,
  CARD_MAX_TITLE_LINES,
  CARD_WIDTH,
  CardError,
  ENGINE_THEME_DIR,
  createCardMaker,
  layoutTitle,
  loadCardColours,
} from '../src/cards.js';
import { loadConfig } from '../src/config.js';
import { readFontMetrics } from '../src/font-metrics.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));
const fontsDir = join(ENGINE_THEME_DIR, 'fonts');

/** After the example's published posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

const RUSSIAN_TITLE = 'Как я неделю шёл по горам Алтая';

/**
 * Runs `body` with an empty temporary directory and removes it afterwards.
 *
 * @template T
 * @param {(root: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-cards-'));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {Buffer} png
 * @returns {{ width: number, height: number }}
 */
function pngSize(png) {
  assert.equal(png.toString('latin1', 1, 4), 'PNG', 'starts with the PNG signature');
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} files Relative path (forward slashes) to content.
 */
function addFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, ...name.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Copies the example site (without a previous build or cache) into a
 * temporary directory and runs `body` with its root.
 *
 * @param {(root: string) => Promise<void>} body
 * @param {Record<string, string | Buffer>} [extra] Files to add to the copy.
 */
async function withExampleCopy(body, extra = {}) {
  await inTemp(async (root) => {
    cpSync(exampleDir, root, {
      recursive: true,
      filter: (source) => !/[\\/](dist|\.cache)([\\/]|$)/.test(source),
    });
    addFiles(root, extra);
    await body(root);
  });
}

/**
 * @param {string} root
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'dist'),
    now: NOW,
  });
  return result;
}

/**
 * @param {string} outDir
 * @param {string} page Path of an HTML file below the site's output.
 * @returns {string} The `og:image` address of the page.
 */
function ogImage(outDir, page) {
  const html = readFileSync(join(outDir, ...page.split('/')), 'utf8');
  const match = /<meta property="og:image" content="([^"]*)">/.exec(html);
  assert.ok(match, `${page} has og:image`);
  return match[1];
}

test('the bundled font covers Latin and Cyrillic and comes with its license', () => {
  const regular = readFontMetrics(join(fontsDir, 'Inter-Regular.ttf'));
  const bold = readFontMetrics(join(fontsDir, 'Inter-Bold.ttf'));
  assert.equal(regular.family, 'Inter');
  assert.equal(bold.family, 'Inter');
  assert.equal(regular.weight, 400);
  assert.equal(bold.weight, 700);
  for (const char of 'AZaz09Аб Жя Ёё') {
    if (char !== ' ') assert.ok(bold.has(char.codePointAt(0) ?? 0), `has a glyph for ${char}`);
  }
  assert.ok(bold.width('Привет', 100) > 0);
  assert.ok(bold.width('Привет', 100) > bold.width('При', 100));
  const license = readFileSync(join(fontsDir, 'OFL.txt'), 'utf8');
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /Inter Project Authors/);
});

test('a title is wrapped to at most three lines and cut with an ellipsis', () => {
  const bold = readFontMetrics(join(fontsDir, 'Inter-Bold.ttf'));
  const width = (/** @type {string} */ text, /** @type {number} */ size) => bold.width(text, size);
  const maxWidth = CARD_WIDTH - 160;

  const short = layoutTitle('Dovetails', width);
  assert.deepEqual(short.lines, ['Dovetails']);
  assert.equal(short.size, 76, 'a short title is set in the largest size');

  const medium = layoutTitle(RUSSIAN_TITLE.repeat(2), width);
  assert.ok(medium.lines.length > 1 && medium.lines.length <= CARD_MAX_TITLE_LINES);
  for (const line of medium.lines) assert.ok(width(line, medium.size) <= maxWidth, `"${line}" fits`);

  const long = layoutTitle(`${RUSSIAN_TITLE} `.repeat(12), width);
  assert.equal(long.lines.length, CARD_MAX_TITLE_LINES);
  assert.equal(long.size, 46, 'the smallest size is used before cutting');
  assert.ok(long.lines[2].endsWith('…'));
  for (const line of long.lines) assert.ok(width(line, long.size) <= maxWidth, `"${line}" fits`);

  const unbroken = layoutTitle('W'.repeat(200), width);
  assert.equal(unbroken.lines.length, CARD_MAX_TITLE_LINES);
  for (const line of unbroken.lines) assert.ok(width(line, unbroken.size) <= maxWidth);
});

test('a card is made for a Russian title: 1200 by 630 with real Cyrillic glyphs', async () => {
  await inTemp((root) => {
    const maker = createCardMaker({ cacheDir: join(root, 'cards'), siteTitle: 'Мой личный блог' });
    assert.equal(maker.fontFamily, 'Inter');
    assert.ok(maker.hasGlyph('Ж'));

    const card = maker.make(RUSSIAN_TITLE);
    assert.equal(card.cached, false);
    assert.match(card.hash, /^[0-9a-f]{16}$/);
    const png = readFileSync(card.file);
    assert.deepEqual(pngSize(png), { width: CARD_WIDTH, height: CARD_HEIGHT });

    // A font without Cyrillic would draw the same empty box for every letter,
    // so two titles of one length would look alike.
    const one = maker.make('ааааааааа');
    const other = maker.make('бббббббббб'.slice(1));
    assert.notEqual(one.hash, other.hash);
    assert.notDeepEqual(readFileSync(one.file), readFileSync(other.file));
  });
});

test('the same input gives the same bytes, in any cache', async () => {
  await inTemp((root) => {
    const first = createCardMaker({ cacheDir: join(root, 'one'), siteTitle: 'Мой блог' }).make(RUSSIAN_TITLE);
    const second = createCardMaker({ cacheDir: join(root, 'two'), siteTitle: 'Мой блог' }).make(RUSSIAN_TITLE);
    assert.equal(first.hash, second.hash);
    assert.deepEqual(readFileSync(first.file), readFileSync(second.file));

    const other = createCardMaker({ cacheDir: join(root, 'two'), siteTitle: 'Мой блог' }).make('Другой заголовок');
    assert.notEqual(other.hash, first.hash);
    const site = createCardMaker({ cacheDir: join(root, 'two'), siteTitle: 'Другой блог' }).make(RUSSIAN_TITLE);
    assert.notEqual(site.hash, first.hash, 'the site title is part of the card');
  });
});

test('a card that is in the cache is reused, not drawn again', async () => {
  await inTemp((root) => {
    const cacheDir = join(root, 'cards');
    const first = createCardMaker({ cacheDir, siteTitle: 'Site' });
    const card = first.make('Hello');
    assert.deepEqual(first.stats, { generated: 1, reused: 0 });
    const before = statSync(card.file).mtimeMs;

    const again = createCardMaker({ cacheDir, siteTitle: 'Site' });
    const reused = again.make('Hello');
    assert.equal(reused.cached, true);
    assert.equal(reused.file, card.file);
    assert.deepEqual(again.stats, { generated: 0, reused: 1 });
    assert.equal(statSync(card.file).mtimeMs, before);
    assert.deepEqual(readdirSync(cacheDir), [`${card.hash}.png`], 'no temporary files are left');

    const out = join(root, 'out');
    assert.equal(again.publish(reused, out), `/cards/${card.hash}.png`);
    assert.deepEqual(readFileSync(join(out, 'cards', `${card.hash}.png`)), readFileSync(card.file));
  });
});

test('markup in titles is escaped and control characters are dropped', async () => {
  await inTemp((root) => {
    const maker = createCardMaker({ cacheDir: join(root, 'cards'), siteTitle: 'A & B <site>' });
    const card = maker.make('<script>"Tom" & \'Jerry\'</script>\u0000\u0007 end');
    assert.deepEqual(pngSize(readFileSync(card.file)), { width: CARD_WIDTH, height: CARD_HEIGHT });
    assert.equal(maker.make('').cached, false, 'an empty title still makes a card');
  });
});

test('a theme sets the accent colour, the template and the font of its cards', async () => {
  await inTemp((root) => {
    const plain = createCardMaker({ cacheDir: join(root, 'cards'), siteTitle: 'Site' });
    const base = plain.make('Hello');

    const accentTheme = join(root, 'accent-theme');
    addFiles(root, { 'accent-theme/theme.yaml': 'accent: "#ff0066"\n' });
    const accented = createCardMaker({ themeDir: accentTheme, cacheDir: join(root, 'cards'), siteTitle: 'Site' });
    assert.equal(accented.colours.accent, '#ff0066');
    assert.notEqual(accented.make('Hello').hash, base.hash);

    const templateTheme = join(root, 'template-theme');
    addFiles(root, {
      'template-theme/card.svg.njk':
        '<svg xmlns="http://www.w3.org/2000/svg" width="{{ width }}" height="{{ height }}"><rect width="{{ width }}" height="{{ height }}" fill="{{ accent }}"/><text x="40" y="300" font-family="{{ fontFamily }}" font-size="60" fill="#fff">{{ titleLines[0].text }}</text></svg>',
    });
    const templated = createCardMaker({ themeDir: templateTheme, cacheDir: join(root, 'cards'), siteTitle: 'Site' });
    assert.equal(templated.templateFile, join(templateTheme, 'card.svg.njk'));
    const own = templated.make('Hello');
    assert.notEqual(own.hash, base.hash);
    assert.deepEqual(pngSize(readFileSync(own.file)), { width: CARD_WIDTH, height: CARD_HEIGHT });

    const fontTheme = join(root, 'font-theme');
    mkdirSync(join(fontTheme, 'fonts'), { recursive: true });
    cpSync(join(fontsDir, 'Inter-Regular.ttf'), join(fontTheme, 'fonts', 'Own-Regular.ttf'));
    const themed = createCardMaker({ themeDir: fontTheme, cacheDir: join(root, 'cards'), siteTitle: 'Site' });
    assert.deepEqual(themed.fontFiles, [join(fontTheme, 'fonts', 'Own-Regular.ttf')], 'the theme font replaces the engine font');
    assert.deepEqual(plain.fontFiles, [join(fontsDir, 'Inter-Bold.ttf'), join(fontsDir, 'Inter-Regular.ttf')]);
    assert.notEqual(themed.make('Hello').hash, base.hash, 'the fonts are part of the hash');
  });
});

test('a card theme that cannot be used is reported with its file', async () => {
  await inTemp((root) => {
    addFiles(root, { 'bad-colour/theme.yaml': 'accent: red\n' });
    assert.throws(
      () => loadCardColours(join(root, 'bad-colour')),
      (error) => error instanceof CardError && error.message.includes('theme.yaml') && error.message.includes('accent'),
    );

    addFiles(root, { 'bad-card/theme.yaml': 'card:\n  background: 12\n' });
    assert.throws(() => loadCardColours(join(root, 'bad-card')), /card\.background/);

    addFiles(root, { 'bad-yaml/theme.yaml': 'accent: [\n' });
    assert.throws(() => loadCardColours(join(root, 'bad-yaml')), CardError);

    assert.deepEqual(loadCardColours(join(root, 'no-such-theme')), loadCardColours(null));

    addFiles(root, {
      'small/card.svg.njk': '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>',
    });
    const small = createCardMaker({ themeDir: join(root, 'small'), cacheDir: join(root, 'cards'), siteTitle: 'Site' });
    assert.throws(() => small.make('Hello'), /1200 by 630/);

    addFiles(root, { 'broken-font/fonts/Broken.ttf': 'not a font' });
    assert.throws(
      () => createCardMaker({ themeDir: join(root, 'broken-font'), cacheDir: join(root, 'cards'), siteTitle: 'Site' }),
      /Broken\.ttf/,
    );
  });
});

test('a post without a cover gets og:image pointing at a generated 1200 by 630 PNG', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const outDir = result.outDir;

      const address = ogImage(outDir, 'journal/russkiy-post/index.html');
      assert.match(address, /^https:\/\/tove-marlowe\.example\/cards\/[0-9a-f]{16}\.png$/);
      const file = join(outDir, 'cards', address.split('/').pop() ?? '');
      assert.ok(existsSync(file), 'the card is in the output');
      assert.deepEqual(pngSize(readFileSync(file)), { width: 1200, height: 630 });
      const twitter = /<meta name="twitter:image" content="([^"]*)">/.exec(
        readFileSync(join(outDir, 'journal', 'russkiy-post', 'index.html'), 'utf8'),
      );
      assert.equal(twitter?.[1], address);

      // Posts, the blog index, the tag tree, tag pages and series pages each have a card;
      // the home page and the 404 page keep the site's default image.
      for (const page of [
        'journal/walnut-box/index.html',
        'journal/index.html',
        'journal/tags/index.html',
        'journal/tags/workshop/index.html',
        'journal/series/boxes-by-hand/index.html',
      ]) {
        assert.match(ogImage(outDir, page), /\/cards\/[0-9a-f]{16}\.png$/, page);
      }
      assert.match(ogImage(outDir, 'index.html'), /\/assets\/social-default\.png$/);
      assert.match(ogImage(outDir, '404.html'), /\/assets\/social-default\.png$/);
      for (const name of readdirSync(join(outDir, 'cards'))) {
        assert.deepEqual(pngSize(readFileSync(join(outDir, 'cards', name))), { width: 1200, height: 630 }, name);
      }
    },
    {
      'content/journal/russkiy-post.md':
        '---\ntitle: Как я неделю шёл по горам Алтая\ndate: 2025-05-01\ntags: [workshop]\n---\n\nТекст записи.\n',
    },
  );
});

test('a second build reuses the cached cards', async () => {
  await withExampleCopy(async (root) => {
    const first = await build(root);
    assert.ok(first.cards.generated > 0, 'the first build draws cards');
    const cacheDir = join(root, '.cache', 'cards');
    const cached = readdirSync(cacheDir).sort();
    assert.ok(cached.length > 0);
    const times = new Map(cached.map((name) => [name, statSync(join(cacheDir, name)).mtimeMs]));
    const published = readdirSync(join(first.outDir, 'cards')).sort();
    assert.deepEqual(published, cached, 'every cached card is published, and nothing else');

    const second = await build(root);
    assert.equal(second.cards.generated, 0, 'the second build draws nothing');
    assert.ok(second.cards.reused > 0);
    assert.deepEqual(readdirSync(cacheDir).sort(), cached);
    for (const [name, time] of times) assert.equal(statSync(join(cacheDir, name)).mtimeMs, time, name);
    assert.deepEqual(readdirSync(join(second.outDir, 'cards')).sort(), published);
  });
});

test('a changed title is drawn again and the other cards stay cached', async () => {
  await withExampleCopy(
    async (root) => {
      await build(root);
      addFiles(root, {
        'content/journal/russkiy-post.md':
          '---\ntitle: Как я две недели шёл по горам Алтая\ndate: 2025-05-01\ntags: [workshop]\n---\n\nТекст записи.\n',
      });
      const second = await build(root);
      assert.equal(second.cards.generated, 1);
    },
    {
      'content/journal/russkiy-post.md':
        '---\ntitle: Как я неделю шёл по горам Алтая\ndate: 2025-05-01\ntags: [workshop]\n---\n\nТекст записи.\n',
    },
  );
});

test('a post with a cover uses the cover, not a generated card', async () => {
  const cover = Buffer.from('89504e470d0a1a0a', 'hex');
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const withFile = ogImage(result.outDir, 'journal/with-cover/index.html');
      assert.match(withFile, /^https:\/\/tove-marlowe\.example\/covers\/[0-9a-f]{16}\.png$/);
      assert.deepEqual(readFileSync(join(result.outDir, 'covers', withFile.split('/').pop() ?? '')), cover);

      assert.equal(ogImage(result.outDir, 'journal/with-url/index.html'), 'https://images.example/cover.jpg');

      const missing = ogImage(result.outDir, 'journal/missing-cover/index.html');
      assert.match(missing, /\/cards\/[0-9a-f]{16}\.png$/, 'a missing cover falls back to a card');
      assert.ok(
        result.warnings.some((warning) => warning.includes('missing-cover.md') && warning.includes('nowhere.png')),
        `warns about the missing cover: ${result.warnings.join(' | ')}`,
      );
      assert.ok(!result.warnings.some((warning) => warning.includes('with-cover')));
    },
    {
      'content/journal/with-cover/index.md': '---\ntitle: With cover\ndate: 2025-05-02\ncover: cover.png\n---\n\nText.\n',
      'content/journal/with-cover/cover.png': cover,
      'content/journal/with-url.md': '---\ntitle: With url\ndate: 2025-05-03\ncover: https://images.example/cover.jpg\n---\n\nText.\n',
      'content/journal/missing-cover.md': '---\ntitle: Missing cover\ndate: 2025-05-04\ncover: nowhere.png\n---\n\nText.\n',
    },
  );
});
