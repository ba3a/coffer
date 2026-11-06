import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { DEFAULT_IMAGE, loadConfig, normalizeConfig } from '../src/config.js';
import { absolutizeUrl, buildMeta, openGraphLocale } from '../src/meta.js';
import { renderRobots, renderSitemap } from '../src/sitemap.js';
import { parseXml } from '../src/xml.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));

/** After the example's published posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

const SITE = 'https://tove-marlowe.example';

/** @type {import('../src/meta.js').MetaSite} */
const META_SITE = {
  baseUrl: 'https://example.org',
  lang: 'en',
  title: 'Example',
  description: 'About the example.',
  defaultImage: '/assets/social-default.png',
};

/**
 * Copies the example site (without a previous build) into a temporary
 * directory, lets `prepare` change the copy, runs `body` with the copy's root
 * and removes it.
 *
 * @param {(root: string) => Promise<void>} body
 * @param {(root: string) => void} [prepare]
 */
async function withExampleCopy(body, prepare) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-meta-'));
  try {
    cpSync(exampleDir, root, { recursive: true, filter: (source) => !/[\\/]dist([\\/]|$)/.test(source) });
    prepare?.(root);
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Replaces a line of the copied configuration.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 */
function editConfig(root, from, to) {
  const file = join(root, 'coffer.yaml');
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes(from), `coffer.yaml has ${from}`);
  writeFileSync(file, text.replace(from, to));
}

/**
 * @param {string} root
 * @param {{ drafts?: boolean }} [options]
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root, options = {}) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'dist'),
    now: NOW,
    ...options,
  });
  return result;
}

/**
 * @param {string} dir
 * @returns {string[]} Paths of the HTML files below `dir`, relative to it, with forward slashes.
 */
function htmlFiles(dir) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.html')) found.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * @param {string} html
 * @param {'name' | 'property'} attribute
 * @param {string} key
 * @returns {string[]} The `content` of every matching `<meta>`.
 */
function metaContent(html, attribute, key) {
  /** @type {string[]} */
  const found = [];
  for (const match of html.matchAll(/<meta\s+([^>]*)>/g)) {
    const attributes = match[1];
    if (attributes.startsWith(`${attribute}="${key}"`)) {
      found.push(/content="([^"]*)"/.exec(attributes)?.[1] ?? '');
    }
  }
  return found;
}

/**
 * @param {string} html
 * @returns {string[]}
 */
function canonicals(html) {
  return [...html.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((match) => match[1]);
}

/**
 * @param {string} xml
 * @returns {string[]}
 */
function sitemapLocations(xml) {
  const root = parseXml(xml);
  assert.equal(root.namespace, 'http://www.sitemaps.org/schemas/sitemap/0.9');
  return root.children.map((entry) => entry.children.find((child) => child.local === 'loc')?.text ?? '');
}

test('buildMeta joins the page and site titles and makes every address absolute', () => {
  const meta = buildMeta(META_SITE, {
    title: 'Dovetails',
    description: 'How to  cut\n them.',
    url: '/journal/dovetails/',
    image: '/img/cover.jpg',
  });
  assert.equal(meta.title, 'Dovetails | Example');
  assert.equal(meta.description, 'How to cut them.');
  assert.equal(meta.url, 'https://example.org/journal/dovetails/');
  assert.equal(meta.image, 'https://example.org/img/cover.jpg');
  assert.equal(meta.type, 'website');
  assert.equal(meta.siteName, 'Example');
  assert.equal(meta.locale, 'en_US');
  assert.equal(meta.twitterCard, 'summary_large_image');
  assert.equal(meta.publishedTime, null);
  assert.deepEqual(meta.tags, []);
});

test('buildMeta uses the site title alone for the page that is the site', () => {
  assert.equal(buildMeta(META_SITE, { title: 'Example', url: '/' }).title, 'Example');
  assert.equal(buildMeta(META_SITE, { title: '', url: '/' }).title, 'Example');
});

test('buildMeta falls back from the page description to the site description to the title', () => {
  assert.equal(buildMeta(META_SITE, { title: 'A', url: '/a/' }).description, 'About the example.');
  const bare = { ...META_SITE, description: '' };
  assert.equal(buildMeta(bare, { title: 'A', url: '/a/' }).description, 'A');
  assert.equal(buildMeta(bare, { title: '', url: '/' }).description, 'Example');
});

test('buildMeta falls back to the default image and keeps absolute images', () => {
  assert.equal(
    buildMeta(META_SITE, { title: 'A', url: '/a/' }).image,
    'https://example.org/assets/social-default.png',
  );
  assert.equal(
    buildMeta(META_SITE, { title: 'A', url: '/a/', image: 'https://cdn.example.net/x.png' }).image,
    'https://cdn.example.net/x.png',
  );
  const custom = { ...META_SITE, defaultImage: 'https://cdn.example.net/site.png' };
  assert.equal(buildMeta(custom, { title: 'A', url: '/a/' }).image, 'https://cdn.example.net/site.png');
});

test('buildMeta keeps the path of a base URL that has one', () => {
  const site = { ...META_SITE, baseUrl: 'https://example.org/sub' };
  const meta = buildMeta(site, { title: 'A', url: '/a/' });
  assert.equal(meta.url, 'https://example.org/sub/a/');
  assert.equal(meta.image, 'https://example.org/sub/assets/social-default.png');
});

test('buildMeta describes a post as an article with its published time and tags', () => {
  const meta = buildMeta(META_SITE, {
    title: 'Post',
    url: '/journal/post/',
    type: 'article',
    published: new Date('2026-03-04T10:00:00Z'),
    tags: ['Workshop', 'Boxes'],
  });
  assert.equal(meta.type, 'article');
  assert.equal(meta.publishedTime, '2026-03-04T10:00:00.000Z');
  assert.deepEqual(meta.tags, ['Workshop', 'Boxes']);
});

test('absolutizeUrl and openGraphLocale', () => {
  assert.equal(absolutizeUrl('https://example.org', 'img/a.png'), 'https://example.org/img/a.png');
  assert.equal(openGraphLocale('en'), 'en_US');
  assert.equal(openGraphLocale('ru'), 'ru_RU');
  assert.equal(openGraphLocale('pt-BR'), 'pt_BR');
  assert.equal(openGraphLocale('en-GB'), 'en_GB');
});

test('renderSitemap lists the addresses sorted, absolute and escaped', () => {
  const xml = renderSitemap('https://example.org', [
    { url: '/b/', lastModified: new Date('2026-01-02T03:04:05Z') },
    { url: '/' },
    { url: '/a&b/' },
  ]);
  assert.deepEqual(sitemapLocations(xml), [
    'https://example.org/',
    'https://example.org/a&b/',
    'https://example.org/b/',
  ]);
  assert.match(xml, /<loc>https:\/\/example\.org\/a&amp;b\/<\/loc>/);
  assert.match(xml, /<lastmod>2026-01-02T03:04:05\.000Z<\/lastmod>/);
});

test('renderRobots allows crawling and names the sitemap', () => {
  assert.equal(
    renderRobots('https://example.org'),
    'User-agent: *\nAllow: /\n\nSitemap: https://example.org/sitemap.xml\n',
  );
});

test('every built page has a title, description, canonical, Open Graph and Twitter tags with absolute URLs', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const files = htmlFiles(result.outDir);
    const redirectStubs = new Set(result.manifest.redirects.map((entry) => `${entry.from.slice(1)}index.html`));
    // A generated reference is a plain page of its own, not made by the theme, so it has no preview tags.
    const referenceDirs = result.manifest.projects.flatMap((project) => (project.docs?.reference ? [project.docs.reference.url.slice(1)] : []));
    assert.ok(referenceDirs.length > 0, 'the example has a reference');
    const isReference = (/** @type {string} */ file) => referenceDirs.some((dir) => file.startsWith(dir));
    let checked = 0;
    for (const file of files) {
      if (redirectStubs.has(file) || isReference(file)) continue;
      const html = readFileSync(join(result.outDir, file), 'utf8');
      const here = `${file}:`;
      assert.match(html, /<title>[^<]+<\/title>/, `${here} title`);
      const description = metaContent(html, 'name', 'description');
      assert.equal(description.length, 1, `${here} description`);
      assert.notEqual(description[0], '', `${here} description is empty`);
      const found = canonicals(html);
      assert.equal(found.length, 1, `${here} one canonical`);
      const [canonical] = found;
      assert.ok(canonical.startsWith(`${SITE}/`), `${here} canonical ${canonical}`);
      for (const key of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type', 'og:site_name', 'og:locale']) {
        assert.equal(metaContent(html, 'property', key).length, 1, `${here} ${key}`);
      }
      for (const key of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
        assert.equal(metaContent(html, 'name', key).length, 1, `${here} ${key}`);
      }
      assert.deepEqual(metaContent(html, 'name', 'twitter:card'), ['summary_large_image']);
      assert.equal(metaContent(html, 'property', 'og:url')[0], canonical);
      assert.equal(metaContent(html, 'property', 'og:locale')[0], 'en_US');
      for (const image of [metaContent(html, 'property', 'og:image')[0], metaContent(html, 'name', 'twitter:image')[0]]) {
        assert.ok(image.startsWith(`${SITE}/`), `${here} image ${image}`);
      }
      checked += 1;
    }
    assert.ok(checked >= 10, `expected many pages, checked ${checked}`);
    assert.equal(checked, files.filter((file) => !redirectStubs.has(file) && !isReference(file)).length);
  });
});

test('a post is an article with its published time and tags; the home page is a website', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const post = result.manifest.posts.find((entry) => entry.tags.length > 0 && entry.published);
    assert.ok(post, 'the example has a tagged post');
    const html = readFileSync(join(result.outDir, post.file), 'utf8');
    assert.deepEqual(canonicals(html), [`${SITE}${post.url}`]);
    assert.deepEqual(metaContent(html, 'property', 'og:type'), ['article']);
    assert.deepEqual(metaContent(html, 'property', 'article:published_time'), [post.date]);
    assert.equal(metaContent(html, 'property', 'article:tag').length, post.tags.length);
    assert.ok(/<title>[^<]+ \| Tove Marlowe<\/title>/.test(html));

    const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.deepEqual(canonicals(home), [`${SITE}/`]);
    assert.deepEqual(metaContent(home, 'property', 'og:type'), ['website']);
    assert.deepEqual(metaContent(home, 'property', 'article:published_time'), []);
    assert.deepEqual(metaContent(home, 'property', 'og:image'), [`${SITE}${DEFAULT_IMAGE}`]);
  });
});

test('the text of a post describes it when it has no summary', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    for (const entry of result.manifest.posts.filter((post) => post.published)) {
      const html = readFileSync(join(result.outDir, entry.file), 'utf8');
      const [description] = metaContent(html, 'name', 'description');
      assert.ok(description.length > 20, `${entry.url}: ${description}`);
      assert.notEqual(description, 'Small wooden things, and notes on making them.', entry.url);
    }
  });
});

test('the 404 page has metadata and stays out of search results', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const html = readFileSync(join(result.outDir, '404.html'), 'utf8');
    assert.deepEqual(canonicals(html), [`${SITE}/404.html`]);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.equal(metaContent(html, 'property', 'og:image').length, 1);
  });
});

test('<html lang> is the language of the site', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const files = htmlFiles(result.outDir);
      assert.ok(files.length > 0);
      for (const file of files) {
        const html = readFileSync(join(result.outDir, file), 'utf8');
        assert.match(html, /^<!doctype html>\n<html lang="ru">/, file);
      }
      const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.deepEqual(metaContent(home, 'property', 'og:locale'), ['ru_RU']);
    },
    (root) => editConfig(root, 'lang: en', 'lang: ru'),
  );
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const home = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.match(home, /<html lang="en">/);
  });
});

test('the sitemap lists exactly the published canonical pages, and robots.txt points at it', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const { manifest } = result;
    const listed = sitemapLocations(readFileSync(join(result.outDir, 'sitemap.xml'), 'utf8'));
    const expected = manifest.pages
      .filter((entry) => entry.type !== 'not-found' && entry.type !== 'search')
      .map((entry) => `${SITE}${entry.url}`)
      .sort();
    assert.deepEqual([...listed].sort(), expected);
    assert.deepEqual(listed, [...listed].sort(), 'sorted');
    assert.equal(new Set(listed).size, listed.length, 'no duplicates');
    assert.ok(listed.every((url) => url.endsWith('/')), 'every address ends in a slash');
    assert.ok(!listed.some((url) => url.includes('404')));
    assert.deepEqual(
      manifest.sitemap.map((url) => `${SITE}${url}`),
      listed,
    );
    for (const post of manifest.posts) {
      assert.equal(listed.includes(`${SITE}${post.url}`), post.published && !post.draft, post.url);
    }
    for (const redirect of manifest.redirects) {
      assert.ok(!listed.includes(`${SITE}${redirect.from}`), `${redirect.from} is a redirect`);
    }
    assert.equal(
      readFileSync(join(result.outDir, 'robots.txt'), 'utf8'),
      `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
    );
  });
});

test('drafts and future-dated posts that a preview builds are not in the sitemap', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root, { drafts: true });
    const unpublished = result.manifest.posts.filter((post) => !post.published);
    assert.ok(unpublished.length > 0, 'the example has an unpublished post');
    const listed = sitemapLocations(readFileSync(join(result.outDir, 'sitemap.xml'), 'utf8'));
    for (const post of unpublished) {
      assert.ok(existsSync(join(result.outDir, post.file)), `${post.url} is built`);
      assert.ok(!listed.includes(`${SITE}${post.url}`), `${post.url} is listed`);
    }
    for (const post of result.manifest.posts.filter((entry) => entry.published)) {
      assert.ok(listed.includes(`${SITE}${post.url}`), `${post.url} is not listed`);
    }
  });
});

test('the default image comes from the configuration', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.deepEqual(metaContent(html, 'property', 'og:image'), ['https://images.example/share.png']);
      assert.deepEqual(metaContent(html, 'name', 'twitter:image'), ['https://images.example/share.png']);
      // The only warning is the undocumented item of the sample tool's reference, which is there on purpose.
      assert.deepEqual(result.warnings, ['content/projects/kerfcalc/project.yaml: docs.reference: "Kerf.spacing" (Functions) has no documentation']);
    },
    (root) => editConfig(root, '    lang: en\n', '    lang: en\n    defaultImage: https://images.example/share.png\n'),
  );
});

test('a default image that is not in the output is a warning', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const warnings = result.warnings.filter((warning) => !warning.includes('docs.reference'));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /defaultImage: "\/assets\/missing\.png" is not in the output/);
    },
    (root) => editConfig(root, '    lang: en\n', '    lang: en\n    defaultImage: /assets/missing.png\n'),
  );
});

test('the engine ships the default image', () => {
  const png = readFileSync(new URL('../theme/assets/social-default.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('defaultImage is validated and defaults to the engine image', () => {
  const normalize = (/** @type {Record<string, unknown>} */ extra) =>
    normalizeConfig(
      { sites: [{ id: 'a', baseUrl: 'https://example.org', title: 'A', ...extra }] },
      { file: '/work/coffer.yaml' },
    );
  assert.equal(normalize({}).sites[0].defaultImage, DEFAULT_IMAGE);
  assert.equal(normalize({ defaultImage: '/img/share.png' }).sites[0].defaultImage, '/img/share.png');
  assert.equal(normalize({ defaultImage: 'https://x.example/a.png' }).sites[0].defaultImage, 'https://x.example/a.png');
  for (const bad of ['share.png', 'mailto:a@b.example', '//x.example/a.png', 3]) {
    assert.throws(
      () => normalize({ defaultImage: bad }),
      /sites\[0\]\.defaultImage: (must be an http\(s\) URL or a path starting with "\/"|must be a non-empty string)/,
      String(bad),
    );
  }
});
