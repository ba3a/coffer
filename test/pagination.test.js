import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { paginate } from '../src/pagination.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-pages-'));
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
 * @param {string} blogExtra Extra keys of the blog entry, with a leading comma.
 * @param {string} extraSite Extra line of the site entry.
 * @returns {string}
 */
function configYaml(blogExtra, extraSite = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentDir: .',
    '    contentLicense: Some rights reserved',
    ...(extraSite === '' ? [] : [extraSite]),
    '    blogs:',
    `      - { id: notes, dir: notes, prefix: log, title: Notes${blogExtra} }`,
    '',
  ].join('\n');
}

/**
 * @param {number} count
 * @param {string[]} [slugs] Slugs for the first posts; the rest are `post-n`.
 * @returns {Record<string, string>}
 */
function postFiles(count, slugs = []) {
  /** @type {Record<string, string>} */
  const files = {};
  for (let n = 1; n <= count; n += 1) {
    const slug = slugs[n - 1] ?? `post-${n}`;
    // Post 1 is the newest.
    const day = String(count - n + 1).padStart(2, '0');
    files[`notes/${slug}.md`] = ['---', `title: Post ${n}`, `date: 2025-03-${day}`, '---', '', `Body words of post ${n}.`, ''].join('\n');
  }
  return files;
}

/**
 * @param {string} root
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
  return {
    manifest: result.manifest,
    read: (/** @type {string} */ file) => readFileSync(join(result.outDir, ...file.split('/')), 'utf8'),
    exists: (/** @type {string} */ file) => existsSync(join(result.outDir, ...file.split('/'))),
  };
}

/**
 * @param {string} html
 * @returns {string[]} The titles of the posts listed, in order.
 */
function titles(html) {
  return [...html.matchAll(/<h2><a href="[^"]+">(Post \d+)<\/a><\/h2>/g)].map((match) => match[1] ?? '');
}

/**
 * @param {string} html
 * @returns {string | undefined}
 */
function canonical(html) {
  return /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
}

test('paginate splits a list and links the pages', () => {
  const result = paginate([1, 2, 3, 4, 5], 2, '/log/');
  assert.deepEqual(result.map((entry) => entry.url), ['/log/', '/log/page/2/', '/log/page/3/']);
  assert.deepEqual(result.map((entry) => entry.items), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(result[0]?.pagination, { page: 1, pages: 3, previous: null, next: '/log/page/2/' });
  assert.deepEqual(result[1]?.pagination, { page: 2, pages: 3, previous: '/log/', next: '/log/page/3/' });
  assert.deepEqual(result[2]?.pagination, { page: 3, pages: 3, previous: '/log/page/2/', next: null });
});

test('paginate leaves a list that fits on a page alone', () => {
  assert.deepEqual(paginate([1, 2], 2, '/'), [{ url: '/', items: [1, 2], pagination: null }]);
  assert.deepEqual(paginate([], 2, '/'), [{ url: '/', items: [], pagination: null }]);
  assert.deepEqual(paginate([1, 2, 3], null, '/'), [{ url: '/', items: [1, 2, 3], pagination: null }]);
});

test('5 posts with pageSize 2 give three pages with links, canonicals, sitemap entries and redirects', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...postFiles(5) }, async (root) => {
    const { read, exists, manifest } = await build(root);

    const first = read('log/index.html');
    const second = read('log/page/2/index.html');
    const third = read('log/page/3/index.html');
    assert.equal(exists('log/page/4/index.html'), false);

    assert.deepEqual(titles(first), ['Post 1', 'Post 2']);
    assert.deepEqual(titles(second), ['Post 3', 'Post 4']);
    assert.deepEqual(titles(third), ['Post 5']);

    assert.doesNotMatch(first, /rel="prev"/);
    assert.match(first, /<a rel="next" href="\/log\/page\/2\/">Next page<\/a>/);
    assert.match(first, />Page 1 of 3</);
    assert.match(second, /<a rel="prev" href="\/log\/">Previous page<\/a>/);
    assert.match(second, /<a rel="next" href="\/log\/page\/3\/">Next page<\/a>/);
    assert.match(second, />Page 2 of 3</);
    assert.match(third, /<a rel="prev" href="\/log\/page\/2\/">Previous page<\/a>/);
    assert.doesNotMatch(third, /rel="next"/);
    assert.match(third, />Page 3 of 3</);

    assert.equal(canonical(first), 'https://demo.example/log/');
    assert.equal(canonical(second), 'https://demo.example/log/page/2/');
    assert.equal(canonical(third), 'https://demo.example/log/page/3/');
    assert.doesNotMatch(second, /noindex/);
    assert.match(second, /<title>Notes \(Page 2 of 3\) \| Demo<\/title>/);

    const sitemap = read('sitemap.xml');
    for (const url of ['/log/', '/log/page/2/', '/log/page/3/']) {
      assert.ok(sitemap.includes(`<loc>https://demo.example${url}</loc>`), `${url} is in the sitemap`);
    }
    assert.ok(!sitemap.includes('/log/page/1/'), 'the redirecting spelling is not');
    assert.deepEqual(
      manifest.pages.filter((entry) => entry.type === 'blog-index').map((entry) => entry.url),
      ['/log/', '/log/page/2/', '/log/page/3/'],
    );

    const rules = read('_redirects').split('\n');
    assert.ok(rules.includes('/log/page/1/ /log/ 301'));
    assert.ok(rules.includes('/log/page/1 /log/ 301'), 'the spelling without the slash redirects too');
    const stub = read('log/page/1/index.html');
    assert.match(stub, /<meta http-equiv="refresh" content="0; url=\/log\/">/);
    assert.match(stub, /<link rel="canonical" href="https:\/\/demo\.example\/log\/">/);
    assert.deepEqual(
      manifest.redirects.filter((entry) => entry.from.startsWith('/log/page/')),
      [{ from: '/log/page/1/', to: '/log/', status: 301 }],
    );
  });
});

test('the feed has every post whatever the page size', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...postFiles(5) }, async (root) => {
    const { read } = await build(root);
    assert.equal((read('log/feed.xml').match(/<entry>/g) ?? []).length, 5);
  });
});

test('2 posts with pageSize 2 give one page, no page directory and no redirect', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...postFiles(2) }, async (root) => {
    const { read, exists, manifest } = await build(root);
    assert.equal(exists('log/page'), false);
    assert.equal(exists('_redirects'), false);
    const page = read('log/index.html');
    assert.deepEqual(titles(page), ['Post 1', 'Post 2']);
    assert.doesNotMatch(page, /class="pagination"/);
    assert.doesNotMatch(read('sitemap.xml'), /\/page\//);
    assert.equal(manifest.pages.filter((entry) => entry.type === 'blog-index').length, 1);
  });
});

test('a blog without pageSize is one page, whatever the number of posts', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...postFiles(5) }, async (root) => {
    const { read, exists } = await build(root);
    assert.equal(exists('log/page'), false);
    assert.equal(titles(read('log/index.html')).length, 5);
  });
});

test('a post with the slug "page" fails the build of a paginated blog and names the post', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...postFiles(3, ['page']) }, async (root) => {
    await assert.rejects(build(root), /page\.md: slug: "page".*rename the post/);
  });
});

test('the slug "page" is fine on a blog without pageSize', async () => {
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...postFiles(3, ['page']) }, async (root) => {
    const { exists } = await build(root);
    assert.equal(exists('log/page/index.html'), true);
  });
});

test('"urls.tags: page" fails the build of a paginated blog', async () => {
  await inTree(
    { 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }', '    urls: { tags: page }'), ...postFiles(3) },
    async (root) => {
      await assert.rejects(build(root), /urls\.tags.*"page".*choose another name/);
    },
  );
});

/**
 * Posts with extra front matter; post 1 is the newest.
 *
 * @param {string[]} extras Extra front matter lines (or '') per post.
 * @returns {Record<string, string>}
 */
function postsWith(extras) {
  /** @type {Record<string, string>} */
  const files = {};
  extras.forEach((extra, index) => {
    const n = index + 1;
    const day = String(extras.length - n + 1).padStart(2, '0');
    files[`notes/post-${n}.md`] = [
      '---',
      `title: Post ${n}`,
      `date: 2025-03-${day}`,
      ...(extra === '' ? [] : [extra]),
      '---',
      '',
      `Body words of post ${n}.`,
      '',
    ].join('\n');
  });
  return files;
}

test('tag pages paginate, and a tag counts the posts of its children', async () => {
  // a/x has posts 1-3, a/y has posts 4-5: a has 5, a/x 3, a/y 2.
  const files = postsWith(['tags: [a/x]', 'tags: [a/x]', 'tags: [a/x]', 'tags: [a/y]', 'tags: [a/y]']);
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...files }, async (root) => {
    const { read, exists, manifest } = await build(root);

    const parent = ['log/tags/a/index.html', 'log/tags/a/page/2/index.html', 'log/tags/a/page/3/index.html'].map(read);
    assert.deepEqual(parent.map(titles), [['Post 1', 'Post 2'], ['Post 3', 'Post 4'], ['Post 5']]);
    assert.equal(exists('log/tags/a/page/4/index.html'), false);
    assert.match(parent[0] ?? '', /<a rel="next" href="\/log\/tags\/a\/page\/2\/">Next page<\/a>/);
    assert.doesNotMatch(parent[0] ?? '', /rel="prev"/);
    assert.match(parent[1] ?? '', /<a rel="prev" href="\/log\/tags\/a\/">Previous page<\/a>/);
    assert.match(parent[1] ?? '', /<a rel="next" href="\/log\/tags\/a\/page\/3\/">Next page<\/a>/);
    assert.match(parent[2] ?? '', /<a rel="prev" href="\/log\/tags\/a\/page\/2\/">Previous page<\/a>/);
    assert.doesNotMatch(parent[2] ?? '', /rel="next"/);
    assert.match(parent[1] ?? '', />Page 2 of 3</);
    assert.deepEqual(parent.map(canonical), [
      'https://demo.example/log/tags/a/',
      'https://demo.example/log/tags/a/page/2/',
      'https://demo.example/log/tags/a/page/3/',
    ]);
    assert.match(parent[1] ?? '', /<title>a \(Page 2 of 3\) \| Demo<\/title>/);
    assert.match(parent[1] ?? '', /<a href="\/log\/tags\/a\/x\/">x<\/a> <span class="tag-count">\(3\)<\/span>/);

    const child = ['log/tags/a/x/index.html', 'log/tags/a/x/page/2/index.html'].map(read);
    assert.deepEqual(child.map(titles), [['Post 1', 'Post 2'], ['Post 3']]);
    assert.equal(exists('log/tags/a/x/page/3/index.html'), false);

    // A tag that fits on one page has no pages after the first.
    assert.equal(exists('log/tags/a/y/page'), false);
    assert.doesNotMatch(read('log/tags/a/y/index.html'), /class="pagination"/);

    const sitemap = read('sitemap.xml');
    for (const url of ['/log/tags/a/', '/log/tags/a/page/2/', '/log/tags/a/page/3/', '/log/tags/a/x/page/2/']) {
      assert.ok(sitemap.includes(`<loc>https://demo.example${url}</loc>`), `${url} is in the sitemap`);
    }
    assert.ok(!sitemap.includes('/log/tags/a/y/page/'));
    assert.ok(!sitemap.includes('/page/1/'));
    assert.deepEqual(
      manifest.pages
        .filter((entry) => entry.type === 'tag')
        .map((entry) => entry.url)
        .sort(),
      [
        '/log/tags/a/',
        '/log/tags/a/page/2/',
        '/log/tags/a/page/3/',
        '/log/tags/a/x/',
        '/log/tags/a/x/page/2/',
        '/log/tags/a/y/',
      ],
    );
    assert.deepEqual(
      manifest.tags.map((entry) => [entry.path, entry.url, entry.count]).sort(),
      [
        ['a', '/log/tags/a/', 5],
        ['a/x', '/log/tags/a/x/', 3],
        ['a/y', '/log/tags/a/y/', 2],
      ],
    );

    const rules = read('_redirects').split('\n');
    assert.ok(rules.includes('/log/tags/a/page/1/ /log/tags/a/ 301'));
    assert.ok(rules.includes('/log/tags/a/page/1 /log/tags/a/ 301'));
    assert.ok(rules.includes('/log/tags/a/x/page/1/ /log/tags/a/x/ 301'));
    assert.ok(!rules.some((rule) => rule.startsWith('/log/tags/a/y/page/')));
    assert.match(read('log/tags/a/page/1/index.html'), /<meta http-equiv="refresh" content="0; url=\/log\/tags\/a\/">/);

    // Feeds are not paginated.
    assert.equal((read('log/tags/a/feed.xml').match(/<entry>/g) ?? []).length, 5);
    assert.equal(exists('log/tags/a/page/2/feed.xml'), false);
  });
});

test('series pages paginate and keep the part numbers', async () => {
  // Post 5 is the oldest, so the first part.
  const files = postsWith(Array.from({ length: 5 }, () => 'series: trail'));
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...files }, async (root) => {
    const { read, exists, manifest } = await build(root);

    const pages = ['log/series/trail/index.html', 'log/series/trail/page/2/index.html', 'log/series/trail/page/3/index.html'].map(read);
    assert.deepEqual(pages.map(titles), [['Post 5', 'Post 4'], ['Post 3', 'Post 2'], ['Post 1']]);
    assert.equal(exists('log/series/trail/page/4/index.html'), false);
    assert.match(pages[1] ?? '', /Part 3 of 5/);
    assert.match(pages[2] ?? '', /Part 5 of 5/);
    assert.match(pages[0] ?? '', /<a rel="next" href="\/log\/series\/trail\/page\/2\/">Next page<\/a>/);
    assert.match(pages[1] ?? '', /<a rel="prev" href="\/log\/series\/trail\/">Previous page<\/a>/);
    assert.doesNotMatch(pages[2] ?? '', /rel="next"/);
    assert.deepEqual(pages.map(canonical), [
      'https://demo.example/log/series/trail/',
      'https://demo.example/log/series/trail/page/2/',
      'https://demo.example/log/series/trail/page/3/',
    ]);

    const sitemap = read('sitemap.xml');
    for (const url of ['/log/series/trail/', '/log/series/trail/page/2/', '/log/series/trail/page/3/']) {
      assert.ok(sitemap.includes(`<loc>https://demo.example${url}</loc>`), `${url} is in the sitemap`);
    }
    assert.deepEqual(
      manifest.pages.filter((entry) => entry.type === 'series').map((entry) => entry.url),
      ['/log/series/trail/', '/log/series/trail/page/2/', '/log/series/trail/page/3/'],
    );
    assert.ok(read('_redirects').split('\n').includes('/log/series/trail/page/1/ /log/series/trail/ 301'));
    assert.match(read('log/series/trail/page/1/index.html'), /<meta http-equiv="refresh" content="0; url=\/log\/series\/trail\/">/);

    assert.equal((read('log/series/trail/feed.xml').match(/<entry>/g) ?? []).length, 5);
    assert.equal(exists('log/series/trail/page/2/feed.xml'), false);
  });
});

test('a tag whose address is a page of its parent fails the build', async () => {
  const files = postsWith(['tags: [a/page/2]', 'tags: [a]', 'tags: [a]']);
  await inTree({ 'coffer.yaml': configYaml(', index: { type: full, pageSize: 2 }'), ...files }, async (root) => {
    await assert.rejects(
      build(root),
      /tag "a\/page\/2".*collide with page 2 of the tag "a" \(\/log\/tags\/a\/page\/2\/\).*rename the tag/,
    );
  });
});

test('tags and series without pageSize stay one page', async () => {
  const files = postsWith(Array.from({ length: 5 }, () => 'tags: [a]\nseries: trail'));
  await inTree({ 'coffer.yaml': configYaml(', index: full'), ...files }, async (root) => {
    const { read, exists } = await build(root);
    assert.equal(exists('log/tags/a/page'), false);
    assert.equal(exists('log/series/trail/page'), false);
    assert.equal(titles(read('log/tags/a/index.html')).length, 5);
    assert.equal(titles(read('log/series/trail/index.html')).length, 5);
  });
});
