import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildError, buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { MarkdownError } from '../src/markdown/render.js';
import { solidImage } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/** Bytes that are not valid UTF-8, so a copy that decodes them would change them. */
const CLIP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80, 0x0a, 0x0d]);

/**
 * Writes a tree of files, runs `body` with its root, and removes the tree.
 *
 * @template T
 * @param {Record<string, string | Uint8Array>} files Relative path (forward slashes) to content.
 * @param {(root: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-video-build-'));
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

const CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    contentLicense: Some rights reserved',
  '    contentDir: notes',
  '    blogs:',
  '      - { id: notes, dir: notes, prefix: log, title: Notes }',
  '',
].join('\n');

/**
 * A post whose body starts on line 6, plus one line for each line of `extra`.
 *
 * @param {string} body
 * @param {string} [extra] More front matter lines.
 * @returns {string}
 */
function post(body, extra = '') {
  return `---\ntitle: Glue-up\ndate: 2026-05-01\n${extra}---\n\n${body}\n`;
}

/** A poster picture, 800 by 450. */
const POSTER = await solidImage(800, 450, 'jpeg');

/**
 * A host that answers every request with 404, so that no test reaches the
 * network.
 *
 * @type {typeof fetch}
 */
const offline = async () => new Response('', { status: 404 });

/**
 * @param {string} root
 * @param {import('../src/build.js').BuildOptions} [options]
 */
function build(root, options = {}) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
    videoFetch: { fetch: offline },
    ...options,
  });
}

test('a local video is published under its normalised name in the folder of the post, unchanged', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.MP4"}\n\nThe clamps go on.', 'index: full\n'),
      'notes/glue/Glue Up.MP4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      const published = join(result.outDir, 'log', 'glue', 'glue-up.mp4');
      assert.ok(existsSync(published));
      assert.deepEqual(readFileSync(published), CLIP);
      assert.ok(!existsSync(join(result.outDir, 'log', 'glue', 'Glue Up.MP4')));
      assert.deepEqual(result.warnings, []);
    },
  );
});

test('a local video of a single-file post is resolved beside the Markdown file and published in the folder of the post', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/clip.md': post('::video{src="clips/__My  Clip (2).WebM"}'),
      'notes/clips/__My  Clip (2).WebM': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(readFileSync(join(result.outDir, 'log', 'clip', 'my-clip-2.webm')), CLIP);
    },
  );
});

test('a local video whose stem has no a-z or 0-9 is published as video', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Склейка.mp4"}'),
      'notes/glue/Склейка.mp4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(readFileSync(join(result.outDir, 'log', 'glue', 'video.mp4')), CLIP);
    },
  );
});

test('the same local video used twice is published once', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.MP4"}\n\n::video{src="Glue%20Up.MP4" id="again"}', 'index: full\n'),
      'notes/glue/Glue Up.MP4': CLIP,
    },
    async (root) => {
      const [result] = await build(root);
      const files = readdirSync(join(result.outDir, 'log', 'glue')).filter((name) => name.endsWith('.mp4'));
      assert.deepEqual(files, ['glue-up.mp4']);
    },
  );
});

test('two local videos of a post with the same published name fail the build, naming both', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video{src="Glue Up.mp4"}\n\n::video{src="glue-up.mp4"}'),
      'notes/glue/Glue Up.mp4': CLIP,
      'notes/glue/glue-up.mp4': CLIP,
    },
    async (root) => {
      await assert.rejects(build(root), (error) => {
        assert.ok(error instanceof BuildError);
        assert.match(error.message, /notes\/glue\/Glue Up\.mp4/);
        assert.match(error.message, /notes\/glue\/glue-up\.mp4/);
        assert.match(error.message, /\/log\/glue\/glue-up\.mp4/);
        return true;
      });
    },
  );
});

test('a missing local video fails the build with V6 at the directive in the post file', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/missing.md': post('Before.\n\n::video{src="gone.mp4"}'),
    },
    async (root) => {
      await assert.rejects(build(root), (error) => {
        assert.ok(error instanceof MarkdownError);
        assert.match(error.message, /missing\.md:8:1: local video "gone\.mp4" does not exist$/);
        return true;
      });
    },
  );
});

test('a local video outside the content directory does not exist for the post', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/outside.md': post('::video{src="../clip.mp4"}'),
      'clip.mp4': CLIP,
    },
    async (root) => {
      await assert.rejects(
        build(root),
        (error) => error instanceof MarkdownError && /outside\.md:6:1: local video "\.\.\/clip\.mp4" does not exist$/.test(error.message),
      );
    },
  );
});

test('W1 to W4 of a post are build warnings with the file, line and column, reported once', async () => {
  const body = [
    '::video{src="https://vkvideo.ru/video-12345_456239017" start="5" end="1:00"}',
    '',
    ':::video{src="https://vkvideo.ru/video-12345_456239017"}',
    '- 0:00 Intro',
    '- 1:00 Cut',
    ':::',
    '',
    'See :t[0:30].',
  ].join('\n');
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/vk.md': post(body, 'index: full\n'),
    },
    async (root) => {
      const [result] = await build(root);
      assert.deepEqual(result.warnings, [
        'notes/vk.md:7:1: VK Video videos cannot start at a given time; start="5" is ignored',
        'notes/vk.md:7:1: VK Video videos cannot stop at a given time; end="1:00" is ignored',
        'notes/vk.md:9:1: VK Video videos cannot seek to a time; the chapters are shown without links',
        'notes/vk.md:14:5: VK Video videos cannot seek to a time; the seek link is shown as text',
      ]);
    },
  );
});

test('feeds, the meta description and the share summary of a post with a video hold no placeholder', async () => {
  const config = CONFIG.replace(
    '{ id: notes, dir: notes, prefix: log, title: Notes }',
    '{ id: notes, dir: notes, prefix: log, title: Notes, shareSummary: true }',
  );
  await inTree(
    {
      'coffer.yaml': config,
      'notes/remote.md': post('https://youtu.be/aBcD3fGh1_-\n\nThe dovetails come next.', 'tags: [wood]\n'),
    },
    async (root) => {
      const [result] = await build(root);
      for (const feed of [['log', 'feed.xml'], ['log', 'tags', 'wood', 'feed.xml']]) {
        const xml = readFileSync(join(result.outDir, ...feed), 'utf8');
        assert.match(xml, /The dovetails come next\./);
        assert.doesNotMatch(xml, /data-coffer-video/);
      }
      const page = readFileSync(join(result.outDir, 'log', 'remote', 'index.html'), 'utf8');
      assert.match(page, /<meta name="description" content="The dovetails come next\.">/);
      const share = readFileSync(join(result.outDir, 'log', 'remote', 'share.txt'), 'utf8');
      assert.match(share, /The dovetails come next\./);
      assert.doesNotMatch(share, /data-coffer-video/);
    },
  );
});

/**
 * The page of a post.
 *
 * @param {string} outDir
 * @param {string} slug
 * @returns {string}
 */
function pageOf(outDir, slug) {
  return readFileSync(join(outDir, 'log', slug, 'index.html'), 'utf8');
}

/**
 * The figure of the video `htmlId` in a page.
 *
 * @param {string} page
 * @param {string} htmlId
 * @returns {string}
 */
function figureOf(page, htmlId) {
  const start = page.indexOf(`<figure class="video" id="${htmlId}"`);
  assert.ok(start >= 0, `no figure ${htmlId}`);
  const end = page.indexOf('</figure>', start);
  return page.slice(start, end + '</figure>'.length);
}

test('a post with a local video and a poster shows the local figure with the published poster and file', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post('::video[Glue-up, sped up]{src="Glue Up.MP4" start="5" poster="glue.jpg"}'),
      'notes/glue/Glue Up.MP4': CLIP,
      'notes/glue/glue.jpg': POSTER,
    },
    async (root) => {
      const [result] = await build(root);
      const [entry] = result.manifest.posts;
      const poster = entry.videos[0].preview;
      assert.ok(poster !== null && poster.startsWith('/img/'), String(poster));
      const image = result.manifest.images.find((candidate) => candidate.source === 'notes/glue/glue.jpg');
      assert.ok(image, 'the poster is listed in the manifest');
      assert.equal(image.use, 'body');
      assert.equal(image.post, '/log/glue/');
      assert.ok(image.outputs.some((output) => output.role === 'variant' && output.url === poster));
      assert.ok(existsSync(join(result.outDir, ...poster.split('/').filter(Boolean))), 'the poster is published');
      const page = pageOf(result.outDir, 'glue');
      assert.ok(
        page.includes(
          [
            '<figure class="video" id="video-1" data-video="file">',
            `<video controls preload="metadata" poster="${poster}"><source src="/log/glue/glue-up.mp4#t=5" type="video/mp4"><a href="/log/glue/glue-up.mp4">Download the video</a></video>`,
            '<figcaption><span class="video-title">Glue-up, sped up</span></figcaption>',
            '</figure>',
          ].join('\n'),
        ),
        page,
      );
      assert.doesNotMatch(page, /data-coffer-video/);
      assert.deepEqual(result.warnings, []);
    },
  );
});

test('a remote video with a poster shows the click-mode figure with the poster under /img/', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/plane/index.md': post('::video[Planing end grain]{src="https://youtu.be/aBcD3fGh1_-" poster="cover.jpg"}'),
      'notes/plane/cover.jpg': POSTER,
    },
    async (root) => {
      const [result] = await build(root);
      const figure = figureOf(pageOf(result.outDir, 'plane'), 'video-1');
      const lines = figure.split('\n');
      assert.equal(
        lines[0],
        '<figure class="video" id="video-1" data-video="youtube" data-video-load="click" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?autoplay=1" data-video-title="Planing end grain">',
      );
      assert.match(
        lines[1],
        /^<a class="video-preview" href="https:\/\/www\.youtube\.com\/watch\?v=aBcD3fGh1_-"><img src="\/img\/[^"]+\.webp" srcset="[^"]+ \d+w" sizes="\(min-width: 44rem\) 41rem, calc\(100vw - 2rem\)" width="\d+" height="\d+" alt="" loading="lazy" decoding="async"><span class="video-play">Play: Planing end grain<\/span><\/a>$/,
      );
      assert.equal(
        lines[2],
        '<figcaption><span class="video-title">Planing end grain</span> <a class="video-source" href="https://www.youtube.com/watch?v=aBcD3fGh1_-">Watch on YouTube</a></figcaption>',
      );
      assert.equal(lines[3], '</figure>');
      const image = result.manifest.images.find((candidate) => candidate.source === 'notes/plane/cover.jpg');
      assert.equal(image?.use, 'body');
    },
  );
});

test('a remote video without a poster has a placeholder preview and the untitled title, in the language of the site', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG.replace('lang: en', 'lang: ru'),
      'notes/remote.md': post('https://youtu.be/aBcD3fGh1_-'),
    },
    async (root) => {
      const [result] = await build(root);
      assert.equal(
        figureOf(pageOf(result.outDir, 'remote'), 'video-1'),
        [
          '<figure class="video" id="video-1" data-video="youtube" data-video-load="click" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?autoplay=1" data-video-title="Видео">',
          '<a class="video-preview" href="https://www.youtube.com/watch?v=aBcD3fGh1_-"><span class="video-placeholder"></span><span class="video-play">Смотреть: Видео</span></a>',
          '<figcaption><a class="video-source" href="https://www.youtube.com/watch?v=aBcD3fGh1_-">Смотреть на YouTube</a></figcaption>',
          '</figure>',
        ].join('\n'),
      );
      assert.equal(result.manifest.posts[0].videos[0].title, null);
      assert.equal(result.manifest.posts[0].videos[0].preview, null);
    },
  );
});

test('a missing poster fails the build with its position in the post file', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/plane.md': post('Before.\n\n::video{src="https://youtu.be/aBcD3fGh1_-" poster="nope.jpg"}'),
    },
    async (root) => {
      await assert.rejects(build(root), (error) => {
        assert.ok(error instanceof BuildError);
        assert.equal(error.message, 'notes/plane.md:8:1: poster "nope.jpg" does not exist');
        return true;
      });
    },
  );
});

test('a page with a video loads the video script with defer, a page without one does not', async () => {
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/remote.md': post('https://youtu.be/aBcD3fGh1_-'),
      'notes/plain.md': post('No video here.'),
    },
    async (root) => {
      const [result] = await build(root);
      assert.equal(pageOf(result.outDir, 'remote').match(/<script src="\/assets\/video\.js" defer><\/script>/g)?.length, 1);
      assert.ok(!pageOf(result.outDir, 'plain').includes('video.js'));
      assert.ok(existsSync(join(result.outDir, 'assets', 'video.js')));
    },
  );
});

test('the manifest entry of a post lists its videos in document order', async () => {
  const body = [
    ':::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-?t=12" id="drawer" end="4:00" load="iframe"}',
    '- 0:12 Marking out',
    '- 1:05 Sawing the *tails*',
    ':::',
    '',
    '::video{src="Glue Up.MP4" poster="glue.jpg"}',
    '',
    'https://vimeo.com/76979871',
  ].join('\n');
  await inTree(
    {
      'coffer.yaml': CONFIG,
      'notes/glue/index.md': post(body),
      'notes/glue/Glue Up.MP4': CLIP,
      'notes/glue/glue.jpg': POSTER,
    },
    async (root) => {
      const [result] = await build(root);
      const { videos } = result.manifest.posts[0];
      const poster = videos[1].preview;
      assert.ok(poster !== null && poster.startsWith('/img/'));
      assert.deepEqual(videos, [
        {
          index: 0,
          id: 'drawer',
          provider: 'youtube',
          src: 'https://youtu.be/aBcD3fGh1_-?t=12',
          title: 'Fitting the drawer',
          start: 12,
          end: 240,
          load: 'iframe',
          preview: null,
          file: null,
          chapters: [12, 65],
        },
        {
          index: 1,
          id: null,
          provider: 'file',
          src: 'Glue Up.MP4',
          title: null,
          start: null,
          end: null,
          load: null,
          preview: poster,
          file: '/log/glue/glue-up.mp4',
          chapters: [],
        },
        {
          index: 2,
          id: null,
          provider: 'vimeo',
          src: 'https://vimeo.com/76979871',
          title: null,
          start: null,
          end: null,
          load: 'click',
          preview: null,
          file: null,
          chapters: [],
        },
      ]);
    },
  );
});

test('a post without videos has an empty list of videos in the manifest', async () => {
  await inTree({ 'coffer.yaml': CONFIG, 'notes/plain.md': post('No video here.') }, async (root) => {
    const [result] = await build(root);
    assert.deepEqual(result.manifest.posts[0].videos, []);
  });
});

// Vector 15.8: a build that fetches the preview of a remote video.

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const OEMBED = 'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaBcD3fGh1_-';
const THUMBNAIL = 'https://i.ytimg.com/vi/aBcD3fGh1_-/hqdefault.jpg';
const KEY = createHash('sha256').update('https://www.youtube.com/watch?v=aBcD3fGh1_-', 'utf8').digest('hex');
const CLIP_CONFIG = [
  'sites:',
  '  - id: demo',
  '    baseUrl: https://demo.example',
  '    lang: en',
  '    title: Demo',
  '    contentLicense: Some rights reserved',
  '    contentDir: content',
  '    blogs:',
  '      - { id: journal, dir: content/journal, prefix: journal, title: Journal }',
  '',
].join('\n');
/** The post of the vector; its body, the single line, is on line 6. */
const CLIP_POST = post('https://youtu.be/aBcD3fGh1_-');
/** A valid 480 by 360 JPEG, as the thumbnail host answers. */
const THUMBNAIL_JPEG = await solidImage(480, 360, 'jpeg');

/**
 * @typedef {object} Call
 * @property {string} url
 * @property {string | undefined} method
 * @property {string | null} accept
 * @property {string | null} userAgent
 */

/**
 * A fetch that answers from `routes` (404 for any other address) and records
 * every request.
 *
 * @param {Record<string, () => Response | Promise<Response>>} routes
 * @returns {{ fetch: typeof fetch, calls: Call[] }}
 */
function fakeFetch(routes) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {typeof globalThis.fetch} */
  const answer = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method, accept: headers.get('accept'), userAgent: headers.get('user-agent') });
    const route = routes[url];
    return route ? route() : new Response('', { status: 404 });
  };
  return { fetch: answer, calls };
}

/** The routes of a host that knows the video. */
const HOST = {
  [OEMBED]: () =>
    Response.json({ title: 'Cutting a mortise', thumbnail_url: THUMBNAIL }, { headers: { 'content-type': 'application/json' } }),
  [THUMBNAIL]: () => new Response(new Uint8Array(THUMBNAIL_JPEG), { headers: { 'content-type': 'image/jpeg' } }),
};

/**
 * The files of the video cache.
 *
 * @param {string} cacheDir
 * @returns {string[]}
 */
function videoCache(cacheDir) {
  const folder = join(cacheDir, 'videos');
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

test('vector 15.8: the preview is fetched with two requests, cached, shown on the page and listed in the manifest', async () => {
  await inTree({ 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    const cacheDir = join(root, 'cache');
    const { fetch, calls } = fakeFetch(HOST);
    const [result] = await build(root, { cacheDir, videoFetch: { fetch } });

    // 1. Two requests, in this order.
    const userAgent = `coffer/${VERSION}`;
    assert.deepEqual(calls, [
      { url: OEMBED, method: 'GET', accept: 'application/json', userAgent },
      { url: THUMBNAIL, method: 'GET', accept: 'image/*', userAgent },
    ]);

    // 2. The cache.
    assert.deepEqual(videoCache(cacheDir), [`${KEY}.jpg`, `${KEY}.json`]);
    assert.equal(
      readFileSync(join(cacheDir, 'videos', `${KEY}.json`), 'utf8'),
      `{"title":"Cutting a mortise","thumbnail":"${KEY}.jpg"}`,
    );

    // 3. The page.
    const page = readFileSync(join(result.outDir, 'journal', 'clip-test', 'index.html'), 'utf8');
    const lines = figureOf(page, 'video-1').split('\n');
    assert.equal(
      lines[0],
      '<figure class="video" id="video-1" data-video="youtube" data-video-load="click" data-video-play="https://www.youtube-nocookie.com/embed/aBcD3fGh1_-?autoplay=1" data-video-title="Cutting a mortise">',
    );
    const src = lines[1].match(/<img src="([^"]+)"/)?.[1];
    assert.ok(src !== undefined, lines[1]);
    assert.match(src, /^\/img\/[^"]*youtube-preview-480\.webp$/);
    assert.ok(lines[1].endsWith('<span class="video-play">Play: Cutting a mortise</span></a>'), lines[1]);
    assert.equal(
      lines[2],
      '<figcaption><span class="video-title">Cutting a mortise</span> <a class="video-source" href="https://www.youtube.com/watch?v=aBcD3fGh1_-">Watch on YouTube</a></figcaption>',
    );
    assert.equal(lines[3], '</figure>');
    assert.match(page, /<script src="\/assets\/video\.js" defer><\/script>/);
    assert.ok(existsSync(join(result.outDir, ...src.split('/').filter(Boolean))), 'the preview is published');

    // 4. The manifest.
    assert.deepEqual(result.manifest.posts[0].videos, [
      {
        index: 0,
        id: null,
        provider: 'youtube',
        src: 'https://youtu.be/aBcD3fGh1_-',
        title: 'Cutting a mortise',
        start: null,
        end: null,
        load: 'click',
        preview: src,
        file: null,
        chapters: [],
      },
    ]);
    // A fetched preview is not an image of the author (plan.md assumption 6).
    assert.deepEqual(result.manifest.images, []);
    assert.deepEqual(result.warnings, []);

    // 5. A second build with the same cache makes no request and writes the same page.
    const again = fakeFetch(HOST);
    const [second] = await build(root, { cacheDir, videoFetch: { fetch: again.fetch } });
    assert.deepEqual(again.calls, []);
    assert.equal(readFileSync(join(second.outDir, 'journal', 'clip-test', 'index.html'), 'utf8'), page);
    assert.deepEqual(second.manifest.posts[0].videos, result.manifest.posts[0].videos);
    assert.deepEqual(second.warnings, []);
  });
});

test('vector 15.8: an oEmbed answer of 404 is a warning, the figure has the placeholder, nothing is cached and the build succeeds', async () => {
  await inTree({ 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    const cacheDir = join(root, 'cache');
    const { fetch, calls } = fakeFetch({});
    const [result] = await build(root, { cacheDir, videoFetch: { fetch } });
    assert.deepEqual(calls.map((call) => call.url), [OEMBED]);
    assert.deepEqual(result.warnings, [
      `content/journal/clip-test.md:6:1: video "https://youtu.be/aBcD3fGh1_-": preview not fetched: ${OEMBED} answered 404`,
    ]);
    const figure = figureOf(readFileSync(join(result.outDir, 'journal', 'clip-test', 'index.html'), 'utf8'), 'video-1');
    assert.match(figure, /data-video-title="Video">/);
    assert.match(figure, /<span class="video-placeholder"><\/span>/);
    assert.doesNotMatch(figure, /<span class="video-title">/);
    assert.deepEqual(videoCache(cacheDir), []);
    assert.equal(result.manifest.posts[0].videos[0].preview, null);
    assert.equal(result.manifest.posts[0].videos[0].title, null);
    const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
    assert.ok(JSON.stringify(report).includes('preview not fetched'), 'the warning is in the report');
  });
});

test('vector 15.8: with fetchPreviews false and an empty cache the build makes no request and has no warning', async () => {
  const config = CLIP_CONFIG.replace('    blogs:', '    video: { fetchPreviews: false }\n    blogs:');
  await inTree({ 'coffer.yaml': config, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    const cacheDir = join(root, 'cache');
    const { fetch, calls } = fakeFetch(HOST);
    const [result] = await build(root, { cacheDir, videoFetch: { fetch } });
    assert.deepEqual(calls, []);
    assert.deepEqual(result.warnings, []);
    assert.match(figureOf(readFileSync(join(result.outDir, 'journal', 'clip-test', 'index.html'), 'utf8'), 'video-1'), /data-video-title="Video">/);
  });
});

test('with fetchPreviews false a preview already in the cache is still used', async () => {
  await inTree({ 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    const cacheDir = join(root, 'cache');
    await build(root, { cacheDir, videoFetch: { fetch: fakeFetch(HOST).fetch } });
    writeFileSync(join(root, 'coffer.yaml'), CLIP_CONFIG.replace('    blogs:', '    video: { fetchPreviews: false }\n    blogs:'));
    const { fetch, calls } = fakeFetch(HOST);
    const [result] = await build(root, { cacheDir, videoFetch: { fetch } });
    assert.deepEqual(calls, []);
    assert.equal(result.manifest.posts[0].videos[0].title, 'Cutting a mortise');
    assert.match(String(result.manifest.posts[0].videos[0].preview), /youtube-preview-480\.webp$/);
  });
});

test('a title from the host is kept when the thumbnail cannot be fetched', async () => {
  await inTree({ 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    const cacheDir = join(root, 'cache');
    const { fetch } = fakeFetch({ [OEMBED]: HOST[OEMBED] });
    const [result] = await build(root, { cacheDir, videoFetch: { fetch } });
    assert.deepEqual(result.warnings, [
      `content/journal/clip-test.md:6:1: video "https://youtu.be/aBcD3fGh1_-": preview not fetched: ${THUMBNAIL} answered 404`,
    ]);
    const figure = figureOf(readFileSync(join(result.outDir, 'journal', 'clip-test', 'index.html'), 'utf8'), 'video-1');
    assert.match(figure, /data-video-title="Cutting a mortise">/);
    assert.match(figure, /<span class="video-placeholder"><\/span>/);
    assert.match(figure, /<span class="video-title">Cutting a mortise<\/span>/);
    assert.equal(result.manifest.posts[0].videos[0].title, 'Cutting a mortise');
    assert.deepEqual(videoCache(cacheDir), []);
  });
});

test('the own title of a video wins over the title from the host', async () => {
  await inTree(
    { 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': post('::video[Mortise, take two]{src="https://youtu.be/aBcD3fGh1_-"}') },
    async (root) => {
      const [result] = await build(root, { cacheDir: join(root, 'cache'), videoFetch: { fetch: fakeFetch(HOST).fetch } });
      const { videos } = result.manifest.posts[0];
      assert.equal(videos[0].title, 'Mortise, take two');
      assert.match(String(videos[0].preview), /youtube-preview-480\.webp$/);
    },
  );
});

test('a timeout is a warning with the time the build waited', async () => {
  await inTree({ 'coffer.yaml': CLIP_CONFIG, 'content/journal/clip-test.md': CLIP_POST }, async (root) => {
    /** @type {typeof fetch} */
    const hang = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const [result] = await build(root, { cacheDir: join(root, 'cache'), videoFetch: { fetch: hang, timeoutMs: 20 } });
    assert.deepEqual(result.warnings, [
      `content/journal/clip-test.md:6:1: video "https://youtu.be/aBcD3fGh1_-": preview not fetched: ${OEMBED} did not answer within 20 ms`,
    ]);
  });
});

test('one request sequence per video address in a build; each video warns once, though its post is also shown in full on the list pages', async () => {
  const config = CLIP_CONFIG.replace('title: Journal }', 'title: Journal, index: full }');
  await inTree(
    {
      'coffer.yaml': config,
      'content/journal/clip-test.md': post('https://youtu.be/aBcD3fGh1_-\n\n::video{src="https://www.youtube.com/watch?v=aBcD3fGh1_-" id="again"}'),
      'content/journal/other.md': post('https://youtu.be/aBcD3fGh1_-', 'tags: [wood]\n'),
    },
    async (root) => {
      const { fetch, calls } = fakeFetch({});
      const [result] = await build(root, { cacheDir: join(root, 'cache'), videoFetch: { fetch } });
      assert.deepEqual(calls.map((call) => call.url), [OEMBED]);
      const reason = `preview not fetched: ${OEMBED} answered 404`;
      assert.deepEqual([...result.warnings].sort(), [
        `content/journal/clip-test.md:6:1: video "https://youtu.be/aBcD3fGh1_-": ${reason}`,
        `content/journal/clip-test.md:8:1: video "https://www.youtube.com/watch?v=aBcD3fGh1_-": ${reason}`,
        `content/journal/other.md:7:1: video "https://youtu.be/aBcD3fGh1_-": ${reason}`,
      ]);
    },
  );
});

test('a successful fetch is shared by every video of the build with the same address', async () => {
  await inTree(
    {
      'coffer.yaml': CLIP_CONFIG,
      'content/journal/clip-test.md': CLIP_POST,
      'content/journal/other.md': post('https://www.youtube.com/watch?v=aBcD3fGh1_-'),
    },
    async (root) => {
      const { fetch, calls } = fakeFetch(HOST);
      const [result] = await build(root, { cacheDir: join(root, 'cache'), videoFetch: { fetch } });
      assert.equal(calls.length, 2);
      const previews = result.manifest.posts.map((entry) => entry.videos[0].preview);
      assert.match(String(previews[0]), /youtube-preview-480\.webp$/);
      assert.equal(previews[1], previews[0]);
    },
  );
});
