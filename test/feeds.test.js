import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { validateFeed } from '../src/check/feed-validator.js';
import { loadConfig } from '../src/config.js';
import { parseXml } from '../src/xml.js';
import { solidImage } from './helpers/images.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));

/** After the example's published posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

const SITE = 'https://tove-marlowe.example';

/**
 * Copies the example site (without a previous build) into a temporary
 * directory, runs `body` with the copy's root and removes it.
 *
 * @param {(root: string) => Promise<void>} body
 */
async function withExampleCopy(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-feeds-'));
  try {
    cpSync(exampleDir, root, { recursive: true, filter: (source) => !/[\\/]dist([\\/]|$)/.test(source) });
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {{ drafts?: boolean, now?: Date }} [options]
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
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} url Site-relative URL of a page, ending in a slash.
 * @returns {string}
 */
function page(result, url) {
  return readFileSync(join(result.outDir, ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} url Site-relative URL of a feed.
 * @returns {string}
 */
function feedText(result, url) {
  return readFileSync(join(result.outDir, ...url.split('/').filter(Boolean)), 'utf8');
}

/**
 * @param {import('../src/xml.js').XmlElement} parent
 * @param {string} name
 * @returns {string | undefined}
 */
function childText(parent, name) {
  return parent.children.find((child) => child.local === name)?.text;
}

/**
 * Entries of a feed document: id, title, summary and the decoded HTML content.
 *
 * @param {string} xml
 */
function entriesOf(xml) {
  return parseXml(xml)
    .children.filter((child) => child.local === 'entry')
    .map((element) => ({
      id: childText(element, 'id') ?? '',
      title: childText(element, 'title') ?? '',
      html: childText(element, 'content') ?? '',
      summary: childText(element, 'summary') ?? '',
      element,
    }));
}

/**
 * @param {string} root
 * @param {string} name Path under `content/journal`.
 * @param {string | Buffer} text
 */
function addPost(root, name, text) {
  const file = join(root, 'content', 'journal', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test('the example site gets a blog feed, tag subtree feeds and a series feed, all valid', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const { feeds } = result.manifest;
    assert.deepEqual(
      feeds.map((feed) => [feed.type, feed.url, feed.entries]),
      [
        ['blog', '/journal/feed.xml', 5],
        ['series', '/journal/series/boxes-by-hand/feed.xml', 2],
        ['tag', '/journal/tags/trips/feed.xml', 2],
        ['tag', '/journal/tags/trips/mountains/feed.xml', 2],
        ['tag', '/journal/tags/workshop/boxes/dovetails/feed.xml', 1],
        ['tag', '/journal/tags/workshop/boxes/feed.xml', 2],
        ['tag', '/journal/tags/workshop/feed.xml', 3],
      ],
    );
    for (const feed of feeds) {
      assert.equal(feed.selfUrl, `${SITE}${feed.url}`);
      assert.equal(feed.file, feed.url.slice(1));
      assert.ok(existsSync(join(result.outDir, ...feed.file.split('/'))), feed.file);
      const verdict = validateFeed(feedText(result, feed.url), { selfUrl: feed.selfUrl });
      assert.deepEqual(verdict.errors, [], feed.url);
      assert.deepEqual(verdict.warnings, [], feed.url);
      assert.equal(verdict.entries, feed.entries, feed.url);
    }
  });
});

test('a tag feed covers the whole subtree, a series feed every part, newest first', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const ids = (/** @type {string} */ url) => entriesOf(feedText(result, url)).map((entry) => entry.id);
    const base = `${SITE}/journal`;
    assert.deepEqual(ids('/journal/feed.xml'), [
      `${base}/walnut-box/`,
      `${base}/first-dovetail/`,
      `${base}/ridge-walk/`,
      `${base}/mountain-weekend/`,
      `${base}/photo-notes/`,
    ]);
    assert.deepEqual(ids('/journal/tags/workshop/feed.xml'), [
      `${base}/walnut-box/`,
      `${base}/first-dovetail/`,
      `${base}/photo-notes/`,
    ]);
    assert.deepEqual(ids('/journal/tags/workshop/boxes/dovetails/feed.xml'), [`${base}/first-dovetail/`]);
    assert.deepEqual(ids('/journal/tags/trips/feed.xml'), [`${base}/ridge-walk/`, `${base}/mountain-weekend/`]);
    assert.deepEqual(ids('/journal/series/boxes-by-hand/feed.xml'), [`${base}/walnut-box/`, `${base}/first-dovetail/`]);
  });
});

test('entries carry id, dates, author, categories, summary and the full post HTML', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const xml = feedText(result, '/journal/feed.xml');
    const feed = parseXml(xml);
    assert.equal(feed.attributes['xml:lang'], 'en');
    assert.equal(childText(feed, 'title'), 'Workshop journal | Tove Marlowe');
    assert.equal(childText(feed, 'subtitle'), 'Small wooden things, and notes on making them.');
    assert.equal(childText(feed, 'updated'), '2025-04-09T22:00:00Z');
    const author = feed.children.find((child) => child.local === 'author');
    assert.equal(author && childText(author, 'name'), 'Tove Marlowe');

    const dovetail = entriesOf(xml).find((entry) => entry.title === 'My first hand-cut dovetail');
    assert.ok(dovetail);
    assert.equal(childText(dovetail.element, 'published'), '2025-03-13T23:00:00Z');
    assert.equal(childText(dovetail.element, 'updated'), '2025-03-13T23:00:00Z');
    assert.equal(dovetail.summary, 'Six attempts, one tidy joint, and what the saw taught me about patience.');
    assert.deepEqual(
      dovetail.element.children
        .filter((child) => child.local === 'category')
        .map((category) => [category.attributes.term, category.attributes.label]),
      [['workshop/boxes/dovetails', 'dovetails']],
    );
    assert.equal(dovetail.element.children.find((child) => child.local === 'content')?.attributes.type, 'html');
    // The whole post, not an excerpt.
    assert.match(dovetail.html, /<h2 id="the-plan">The plan<\/h2>/);
    assert.match(dovetail.html, /stop and look after every cut/);
    const source = readFileSync(join(root, 'content', 'journal', 'first-dovetail', 'index.md'), 'utf8');
    const lastLine = source.trim().split('\n').pop() ?? '';
    assert.ok(dovetail.html.includes(lastLine.slice(0, 25)), 'the end of the post is in the feed');
  });
});

test('a configured author and feed limit are used; series feeds ignore the limit', async () => {
  await withExampleCopy(async (root) => {
    const file = join(root, 'coffer.yaml');
    const original = readFileSync(file, 'utf8');
    const changed = original.replace(
      /(\r?\n)(\s+)contentLicense: CC BY 4\.0/,
      `$&$1$2author: { name: Tove M., email: tove@tove-marlowe.example, url: "${SITE}/" }$1$2feeds: { limit: 1 }`,
    );
    assert.notEqual(changed, original);
    writeFileSync(file, changed);
    const result = await build(root);
    const blog = feedText(result, '/journal/feed.xml');
    assert.equal(entriesOf(blog).length, 1);
    assert.match(blog, /<name>Tove M\.<\/name>\s*<email>tove@tove-marlowe\.example<\/email>\s*<uri>https:\/\/tove-marlowe\.example\/<\/uri>/);
    assert.equal(entriesOf(feedText(result, '/journal/tags/workshop/feed.xml')).length, 1);
    assert.equal(entriesOf(feedText(result, '/journal/series/boxes-by-hand/feed.xml')).length, 2);
    assert.deepEqual(validateFeed(blog, { selfUrl: `${SITE}/journal/feed.xml` }).errors, []);
  });
});

test('feed content has absolute links, images and srcset URLs', async () => {
  await withExampleCopy(async (root) => {
    addPost(
      root,
      'links/index.md',
      [
        '---',
        'title: Links and pictures',
        'date: 2025-05-01',
        'tags: [workshop/boxes]',
        '---',
        '',
        'See [the walnut box](../walnut-box/), [home](/), [a heading](#below) and [elsewhere](https://other.example/a?b=1&c=2).',
        '',
        '![A bench](bench.jpg)',
        '',
        '<img src="small.jpg" srcset="small.jpg 480w, /media/large.jpg 960w" alt="raw">',
        '',
        '## Below',
        '',
        '```html',
        '<a href="not-a-link/">code</a>',
        '```',
        '',
      ].join('\n'),
    );
    addPost(root, 'links/bench.jpg', await solidImage(1400, 900));
    const result = await build(root);
    const xml = feedText(result, '/journal/feed.xml');
    const entry = entriesOf(xml).find((candidate) => candidate.title === 'Links and pictures');
    assert.ok(entry);
    assert.ok(entry.html.includes(`<a href="${SITE}/journal/walnut-box/">the walnut box</a>`), entry.html);
    assert.ok(entry.html.includes(`<a href="${SITE}/">home</a>`), entry.html);
    assert.ok(entry.html.includes(`<a href="${SITE}/journal/links/#below">a heading</a>`), entry.html);
    assert.match(entry.html, /<a href="https:\/\/other\.example\/a\?b=1&(?:amp|#x26);c=2">elsewhere<\/a>/);
    // The picture is a plain img with the 1200 pixel variant, without srcset, loading or decoding.
    assert.match(
      entry.html,
      new RegExp(
        `<figure><a href="${SITE}/img/[0-9a-f]{16}/bench-full\\.jpg"><img src="${SITE}/img/[0-9a-f]{16}/bench-1200\\.webp" alt="A bench" width="1200" height="771"></a></figure>`,
      ),
      entry.html,
    );
    assert.ok(!entry.html.includes('<picture'), entry.html);
    assert.ok(!entry.html.includes('loading='), entry.html);
    assert.ok(
      entry.html.includes(`srcset="${SITE}/journal/links/small.jpg 480w, ${SITE}/media/large.jpg 960w"`),
      entry.html,
    );
    // Text that only looks like markup is left as it was.
    assert.ok(entry.html.includes('not-a-link/'));
    assert.ok(!entry.html.includes(`${SITE}/journal/links/not-a-link/`));
    assert.deepEqual(validateFeed(xml, { selfUrl: `${SITE}/journal/feed.xml` }).errors, []);
  });
});

test('a draft and a future-dated post are in no feed, with a fixed now', async () => {
  await withExampleCopy(async (root) => {
    for (const drafts of [false, true]) {
      const result = await build(root, { drafts });
      assert.ok(result.manifest.posts.some((post) => post.slug === 'planer-notes') === drafts);
      for (const feed of result.manifest.feeds) {
        const xml = feedText(result, feed.url);
        for (const hidden of ['planer-notes', 'Notes on the new thickness planer', 'spring-open-house', 'Spring open house']) {
          assert.ok(!xml.includes(hidden), `${feed.url} (drafts: ${drafts}) contains ${hidden}`);
        }
      }
    }
    // The future-dated post is published, and so in the feed, once the clock reaches its date.
    const later = await build(root, { now: new Date('2099-06-01T00:00:00Z') });
    const events = later.manifest.feeds.find((feed) => feed.url === '/journal/tags/events/feed.xml');
    assert.equal(events?.entries, 1);
    assert.ok(feedText(later, '/journal/feed.xml').includes('Spring open house'));
  });
});

/**
 * The addresses of the `<link rel="alternate" type="application/atom+xml">` elements of a page.
 *
 * @param {string} html
 * @returns {string[]}
 */
function advertised(html) {
  return [...html.matchAll(/<link rel="alternate" type="application\/atom\+xml" title="[^"]*" href="([^"]+)">/g)].map(
    (match) => match[1],
  );
}

/**
 * The addresses of the visible feed links in the body of a page.
 *
 * @param {string} html
 * @returns {string[]}
 */
function visibleFeedLinks(html) {
  const body = html.slice(html.indexOf('<body>'));
  return [...body.matchAll(/<p class="feed-link"><a [^>]*href="([^"]+)">/g)].map((match) => match[1]);
}

test('pages advertise their feeds in the head; blog, tag and series pages link to them visibly', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);

    const blogIndex = page(result, '/journal/');
    assert.deepEqual(advertised(blogIndex), ['/journal/feed.xml']);
    assert.deepEqual(visibleFeedLinks(blogIndex), ['/journal/feed.xml']);
    assert.match(blogIndex, /<a rel="alternate" type="application\/atom\+xml" href="\/journal\/feed\.xml">Feed of Workshop journal<\/a>/);

    const tag = page(result, '/journal/tags/workshop/boxes/');
    assert.deepEqual(advertised(tag), ['/journal/feed.xml', '/journal/tags/workshop/boxes/feed.xml']);
    assert.deepEqual(visibleFeedLinks(tag), ['/journal/tags/workshop/boxes/feed.xml']);
    assert.match(tag, />Feed of the tag Boxes<\/a>/);

    const series = page(result, '/journal/series/boxes-by-hand/');
    assert.deepEqual(advertised(series), ['/journal/feed.xml', '/journal/series/boxes-by-hand/feed.xml']);
    assert.deepEqual(visibleFeedLinks(series), ['/journal/series/boxes-by-hand/feed.xml']);

    // A post advertises the feeds of its tags and series, and the blog feed.
    const post = page(result, '/journal/first-dovetail/');
    assert.deepEqual(advertised(post), [
      '/journal/feed.xml',
      '/journal/tags/workshop/boxes/dovetails/feed.xml',
      '/journal/series/boxes-by-hand/feed.xml',
    ]);

    // The blog feed is advertised everywhere else too.
    assert.deepEqual(advertised(page(result, '/')), ['/journal/feed.xml']);
    assert.deepEqual(advertised(page(result, '/journal/tags/')), ['/journal/feed.xml']);
    assert.deepEqual(advertised(readFileSync(join(result.outDir, '404.html'), 'utf8')), ['/journal/feed.xml']);
  });
});

test('every advertised feed exists in the output', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    for (const entry of result.manifest.pages) {
      const html = readFileSync(join(result.outDir, ...entry.file.split('/')), 'utf8');
      for (const url of [...advertised(html), ...visibleFeedLinks(html)]) {
        assert.ok(existsSync(join(result.outDir, ...url.split('/').filter(Boolean))), `${entry.url} links ${url}`);
      }
    }
  });
});

test('a post named feed.xml would collide with the blog feed and fails the build', async () => {
  await withExampleCopy(async (root) => {
    addPost(root, 'feed.xml.md', '---\ntitle: Clash\ndate: 2025-05-01\n---\n\nText.\n');
    await assert.rejects(build(root), /slug "feed\.xml".*collide with the blog's feed/);
  });
});
