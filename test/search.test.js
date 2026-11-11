import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { BuildError, buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/cli.js';
import { SearchError, buildSearchIndex, indexLanguage, searchPageUrl } from '../src/search.js';
import { openSearch } from './helpers/pagefind.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));
const assetsDir = fileURLToPath(new URL('../theme/assets/', import.meta.url));

/** After the example's posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string>} files Relative path (forward slashes) to content.
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-search-'));
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
 * Runs `body` with some environment variables set, and puts them back.
 *
 * @param {Record<string, string>} vars
 * @param {() => Promise<void>} body
 * @returns {Promise<void>}
 */
async function withEnv(vars, body) {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * @param {string} root
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
  });
  return result;
}

/**
 * @param {string} lang
 * @param {string} blogs Lines of the `blogs:` list, indented by six spaces.
 * @returns {string}
 */
function config(lang, blogs) {
  return `sites:\n  - id: demo\n    baseUrl: https://demo.example\n    lang: ${lang}\n    title: Demo\n    blogs:\n${blogs}\n`;
}

/**
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
function post(title, body) {
  return `---\ntitle: ${title}\ndate: 2026-04-20\n---\n\n${body}\n`;
}

const russianFiles = {
  'coffer.yaml': config(
    'ru',
    '      - { id: journal, dir: journal, prefix: zapisi, title: Записи }\n      - { id: travel, dir: travel, prefix: puteshestviya, title: Путешествия }',
  ),
  'journal/shkatulka.md': post('Шкатулка из ореха', 'Сегодня я доделал шкатулку из ореха. Крышка закрывается плотно.'),
  'journal/rubanok.md': post('Новый рубанок', 'Настроил рубанок и снял первую стружку.'),
  'travel/gory.md': post('Поход в горы', 'В горах мы нашли старую шкатулку, но открыть её не смогли.'),
};

test('a Russian query finds other word forms, and only in the blog it is asked in', async () => {
  await inTree(russianFiles, async (root) => {
    const result = await build(root);
    const search = await openSearch(result.outDir);
    for (const term of ['шкатулка', 'шкатулки', 'шкатулку', 'шкатулкой']) {
      const hits = await search.search(term, { blog: 'journal' });
      assert.deepEqual(
        hits.map((hit) => hit.url),
        ['/zapisi/shkatulka/'],
        `the query "${term}" finds the post of the blog "journal"`,
      );
      assert.equal(hits[0].title, 'Шкатулка из ореха');
      assert.match(hits[0].excerpt, /<mark>шкатулк\p{L}*<\/mark>/u);
    }
    assert.deepEqual(
      (await search.search('шкатулка', { blog: 'travel' })).map((hit) => hit.url),
      ['/puteshestviya/gory/'],
    );
    assert.deepEqual(
      (await search.search('шкатулка')).map((hit) => hit.url).sort(),
      ['/puteshestviya/gory/', '/zapisi/shkatulka/'],
      'without a filter both blogs answer',
    );
    assert.deepEqual(await search.search('стружка', { blog: 'travel' }), []);
    assert.deepEqual((await search.search('стружки', { blog: 'journal' })).map((hit) => hit.url), ['/zapisi/rubanok/']);
    assert.equal(result.search.pages, 3);
  });
});

test('the example site is searchable in English, with snippets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffer-search-example-'));
  try {
    cpSync(exampleDir, root, { recursive: true, filter: (source) => !/[\\/]dist([\\/]|$)/.test(source) });
    const result = await build(root);
    const search = await openSearch(result.outDir);

    const hits = await search.search('dovetails', { blog: 'journal' });
    const dovetail = hits.find((hit) => hit.url === '/journal/first-dovetail/');
    assert.ok(dovetail, 'the dovetail post answers "dovetails"');
    assert.equal(dovetail.title, 'My first hand-cut dovetail');
    assert.match(dovetail.excerpt, /<mark>dovetail<\/mark>/);
    assert.deepEqual(dovetail.filters, { blog: ['journal'] });

    // A post that is not published yet is not in the index.
    for (const term of ['thermos', 'demonstrations', 'stool']) {
      assert.ok(
        !(await search.search(term)).some((hit) => hit.url === '/journal/spring-open-house/'),
        `"${term}" does not find the post dated in the future`,
      );
    }

    // Guides are indexed under a filter of their own, so a blog's search never finds them.
    const filters = await search.filters();
    assert.deepEqual(Object.keys(filters).sort(), ['blog', 'guides']);
    assert.deepEqual(Object.keys(filters.blog), ['journal']);
    assert.deepEqual(Object.keys(filters.guides), ['kerfcalc']);
    assert.deepEqual(await search.search('alphabetically', { blog: 'journal' }), []);
    assert.deepEqual(
      (await search.search('alphabetically', { guides: 'kerfcalc' })).map((hit) => hit.url),
      ['/made/kerfcalc/docs/internals/'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every blog has a search page with a form, an explanation without JavaScript and a link in the navigation', async () => {
  await inTree(russianFiles, async (root) => {
    const result = await build(root);
    const index = join(result.outDir, 'pagefind');
    for (const file of ['pagefind.js', 'pagefind-modular-ui.js', 'pagefind-entry.json']) {
      assert.ok(existsSync(join(index, file)), `${file} is written to pagefind/`);
    }
    assert.ok(existsSync(join(result.outDir, 'assets', 'search.js')));

    for (const [prefix, id, title] of [
      ['zapisi', 'journal', 'Записи'],
      ['puteshestviya', 'travel', 'Путешествия'],
    ]) {
      const html = readFileSync(join(result.outDir, prefix, 'search', 'index.html'), 'utf8');
      assert.match(html, /<html lang="ru">/);
      assert.match(html, /<h1>Поиск<\/h1>/);
      // The text a visitor without JavaScript reads, and the way out.
      assert.match(html, /<div class="search-nojs">\s*<p>Для поиска нужен JavaScript/);
      assert.ok(html.includes(`<a href="/${prefix}/tags/">`), 'the explanation links the tag tree');
      // The form the script enhances, and the settings it reads.
      assert.match(html, /<form class="search-form" role="search" action="\/[a-z]+\/search\/" method="get">/);
      assert.match(html, /<input id="search-q" class="search-input" type="search" name="q"/);
      const data = JSON.parse(
        /** @type {string} */ (/data-search="([^"]*)"/.exec(html)?.[1]).replaceAll('&quot;', '"'),
      );
      assert.equal(data.bundle, '/pagefind/');
      assert.deepEqual(data.filters, { blog: id });
      assert.match(data.text.found, /Найдено: \{count\}/);
      assert.ok(html.includes('<script src="/pagefind/pagefind-modular-ui.js" defer></script>'));
      assert.ok(html.includes('<script src="/assets/search.js" defer></script>'));
      // The navigation of every page links both search pages, named after their blog.
      assert.ok(html.includes(`<a href="/${prefix}/search/">Поиск: ${title}</a>`));
    }

    const blogIndex = readFileSync(join(result.outDir, 'zapisi', 'index.html'), 'utf8');
    assert.ok(blogIndex.includes('<a href="/zapisi/search/">Поиск: Записи</a>'));

    // The search pages are pages of the build, but not of the sitemap.
    const searchPages = result.manifest.pages.filter((page) => page.type === 'search');
    assert.deepEqual(searchPages.map((page) => page.url), ['/puteshestviya/search/', '/zapisi/search/']);
    const sitemap = readFileSync(join(result.outDir, 'sitemap.xml'), 'utf8');
    assert.ok(!sitemap.includes('/search/'));
    assert.ok(!result.manifest.sitemap.some((url) => url.endsWith('/search/')));
  });
});

test('a site with one blog gets a plain "Search" link; the posts mark their body for the index', async () => {
  await inTree(
    {
      'coffer.yaml': config('en', '      - { id: notes, dir: notes, prefix: "", title: Notes }'),
      'notes/hello.md': post('Hello', 'A body to find.'),
    },
    async (root) => {
      const result = await build(root);
      const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.ok(home.includes('<li><a href="/search/">Search</a></li>'));
      assert.ok(existsSync(join(result.outDir, 'search', 'index.html')));
      const page = readFileSync(join(result.outDir, 'hello', 'index.html'), 'utf8');
      assert.ok(page.includes('<div class="post-body" data-pagefind-body data-pagefind-filter="blog:notes">'));
      const search = await openSearch(result.outDir);
      assert.deepEqual((await search.search('finding', { blog: 'notes' })).map((hit) => hit.url), ['/hello/']);
    },
  );
});

test('a blog that shows full posts on its list pages still gives one search hit per post, never a list page', async () => {
  const entry = (/** @type {string} */ title, /** @type {string} */ date, /** @type {string} */ body) =>
    `---
title: ${title}
date: ${date}
tags: [trips]
series: tour
---

${body}
`;
  await inTree(
    {
      'coffer.yaml': config('en', '      - { id: notes, dir: notes, prefix: log, title: Notes, index: { type: full, pageSize: 1 } }'),
      'notes/one.md': entry('One', '2026-04-01', 'The zebrafinch sings in the first post.'),
      'notes/two.md': entry('Two', '2026-04-02', 'A narwhal swims through the second post.'),
      'notes/three.md': entry('Three', '2026-04-03', 'The third post mentions a quokka.'),
    },
    async (root) => {
      const result = await build(root);
      for (const file of ['log/index.html', 'log/page/2/index.html', 'log/tags/trips/index.html', 'log/series/tour/index.html']) {
        const html = readFileSync(join(result.outDir, ...file.split('/')), 'utf8');
        assert.ok(!html.includes('data-pagefind-body'), `${file} is not marked for the index`);
      }
      assert.ok(
        readFileSync(join(result.outDir, 'log', 'index.html'), 'utf8').includes('zebrafinch') ||
          readFileSync(join(result.outDir, 'log', 'page', '2', 'index.html'), 'utf8').includes('zebrafinch') ||
          readFileSync(join(result.outDir, 'log', 'page', '3', 'index.html'), 'utf8').includes('zebrafinch'),
        'the list pages do carry the body text',
      );
      const search = await openSearch(result.outDir);
      for (const [word, url] of [
        ['zebrafinch', '/log/one/'],
        ['narwhal', '/log/two/'],
        ['quokka', '/log/three/'],
      ]) {
        assert.deepEqual((await search.search(/** @type {string} */ (word), { blog: 'notes' })).map((hit) => hit.url), [url], `"${word}" finds only its post page`);
        assert.deepEqual((await search.search(/** @type {string} */ (word))).map((hit) => hit.url), [url], `"${word}" finds only its post page without a filter`);
      }
      assert.equal(result.search.pages, 3, 'only the three post pages are indexed');
    },
  );
});

test('a site with no published post gets a search page that says there is nothing yet', async () => {
  await inTree(
    {
      'coffer.yaml': config('en', '      - { id: notes, dir: notes, prefix: log, title: Notes }'),
      'notes/draft.md': '---\ntitle: Draft\ndate: 2026-04-20\ndraft: true\n---\n\nUnfinished words.\n',
    },
    async (root) => {
      const result = await build(root);
      assert.equal(result.search.pages, 0);
      assert.ok(existsSync(join(result.outDir, 'pagefind', 'pagefind.js')));
      const html = readFileSync(join(result.outDir, 'log', 'search', 'index.html'), 'utf8');
      assert.match(html, /<p class="empty">No posts yet\.<\/p>/);
      assert.ok(!html.includes('<form'));
      assert.ok(!html.includes('pagefind-modular-ui.js'));
      assert.ok(html.includes('<a href="/log/tags/">'));
    },
  );
});

test('a post called "search" is refused, because its address is the search page', async () => {
  await inTree(
    {
      'coffer.yaml': config('en', '      - { id: notes, dir: notes, prefix: log, title: Notes }'),
      'notes/search.md': post('Searching', 'Words.'),
    },
    async (root) => {
      await assert.rejects(
        () => build(root),
        (error) => error instanceof BuildError && /slug "search".*search page \(\/log\/search\/\)/.test(error.message),
      );
    },
  );
});

test('the index language is the primary subtag of the site language', () => {
  assert.equal(indexLanguage('ru'), 'ru');
  assert.equal(indexLanguage('ru-RU'), 'ru');
  assert.equal(indexLanguage('en-GB'), 'en');
  assert.equal(searchPageUrl('/log/'), '/log/search/');
  assert.equal(searchPageUrl('/'), '/search/');
});

test('the search script of the theme is valid JavaScript', () => {
  assert.doesNotThrow(() => new Script(readFileSync(join(assetsDir, 'search.js'), 'utf8'), { filename: 'search.js' }));
});

test('a Pagefind that cannot start is a SearchError, not a bare Error', async () => {
  await inTree({}, async (root) => {
    await withEnv({ PAGEFIND_EXTENDED_BINARY_PATH: join(root, 'no-such-pagefind') }, async () => {
      await assert.rejects(
        () => buildSearchIndex({ outDir: root, lang: 'en', pages: [] }),
        (error) => error instanceof SearchError && /^Pagefind failed: /.test(error.message),
      );
    });
  });
});

test('coffer build prints a Pagefind failure as a message and exits 1', async () => {
  await inTree(
    {
      'coffer.yaml': config('en', '      - { id: notes, dir: notes, prefix: log, title: Notes }'),
      'notes/one.md': post('One', 'Words.'),
    },
    async (root) => {
      await withEnv({ PAGEFIND_EXTENDED_BINARY_PATH: join(root, 'no-such-pagefind') }, async () => {
        let err = '';
        const code = await run(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'out')], {
          out: () => {},
          err: (text) => {
            err += text;
          },
        });
        assert.equal(code, 1);
        assert.match(err, /^Pagefind failed: /);
        assert.ok(!err.includes('    at '), 'no stack trace');
      });
    },
  );
});
