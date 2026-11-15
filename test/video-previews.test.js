import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as engine from '../src/index.js';
import { ImageError, createImagePipeline } from '../src/images/pipeline.js';
import { readVersion } from '../src/version.js';
import { DEFAULT_VIDEO_RULES, matchVideoUrl } from '../src/video/rules.js';
import { MAX_PREVIEW_BYTES, VIDEO_CACHE_DIR, createVideoPreviews } from '../src/video/previews.js';
import { solidImage } from './helpers/images.js';

/** @typedef {import('../src/video/rules.js').VideoMatch} VideoMatch */
/** @typedef {import('../src/video/rules.js').VideoRule} VideoRule */

const META =
  'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DaBcD3fGh1_-';
const THUMB = 'https://i.ytimg.com/vi/aBcD3fGh1_-/hqdefault.jpg';
const KEY = createHash('sha256').update('https://www.youtube.com/watch?v=aBcD3fGh1_-').digest('hex');
const USER_AGENT = 'coffer/9.8.7';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

/**
 * @param {string} url
 * @param {readonly VideoRule[]} [rules]
 * @returns {VideoMatch}
 */
function match(url, rules = DEFAULT_VIDEO_RULES) {
  const found = matchVideoUrl(url, rules);
  assert.ok(found, `${url} matches`);
  return found;
}

const Y = match('https://youtu.be/aBcD3fGh1_-');

/**
 * @typedef {object} Call
 * @property {string} url
 * @property {string | undefined} method
 * @property {string | null} accept
 * @property {string | null} userAgent
 * @property {AbortSignal | null | undefined} signal
 */

/**
 * A fetch that answers from a table and records every request. A missing
 * address fails the test.
 *
 * @param {Record<string, (signal: AbortSignal) => Response | Promise<Response>>} routes
 * @returns {{ fetch: typeof fetch, calls: Call[] }}
 */
function fakeFetch(routes) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {any} */
  const fetchFn = async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
    const headers = new Headers(init.headers);
    calls.push({
      url: String(url),
      method: init.method,
      accept: headers.get('accept'),
      userAgent: headers.get('user-agent'),
      signal: init.signal,
    });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route(/** @type {AbortSignal} */ (init.signal));
  };
  return { fetch: fetchFn, calls };
}

/** @type {any} */
const noFetch = async (/** @type {string} */ url) => {
  throw new Error(`no request expected, got ${url}`);
};

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {() => Response}
 */
function json(body, status = 200) {
  return () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * @param {Uint8Array} bytes
 * @param {string | null} [type]
 * @param {number} [status]
 * @returns {() => Response}
 */
function image(bytes, type = 'image/jpeg', status = 200) {
  return () => new Response(new Uint8Array(bytes), { status, headers: type === null ? {} : { 'content-type': type } });
}

const OEMBED = json({ title: '  Cutting a mortise ', thumbnail_url: THUMB });

/**
 * A processImage stub that records its calls and returns the path it was given.
 *
 * @returns {{ processImage: (file: string, match: VideoMatch) => Promise<{ file: string, provider: string }>, processed: string[] }}
 */
function stubImages() {
  /** @type {string[]} */
  const processed = [];
  return {
    processed,
    async processImage(file, found) {
      assert.ok(existsSync(file), 'the thumbnail is written before it is processed');
      processed.push(file);
      return { file, provider: found.provider };
    },
  };
}

/**
 * Runs `body` with an empty temporary directory and removes it afterwards.
 *
 * @template T
 * @param {(root: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-video-previews-'));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} cacheDir
 * @returns {string[]}
 */
function cached(cacheDir) {
  return existsSync(cacheDir) ? readdirSync(cacheDir).sort() : [];
}

test('VIDEO_CACHE_DIR is "videos" and an export of the engine', () => {
  assert.equal(VIDEO_CACHE_DIR, 'videos');
  assert.equal(engine.VIDEO_CACHE_DIR, 'videos');
});

test('a YouTube video is fetched with the oEmbed request, then the thumbnail request, and cached', () =>
  inTemp(async (root) => {
    const cacheDir = join(root, VIDEO_CACHE_DIR);
    const { fetch, calls } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const images = stubImages();
    const previews = createVideoPreviews({ cacheDir, fetch, userAgent: USER_AGENT, processImage: images.processImage });

    const result = await previews.preview(Y);

    assert.deepEqual(
      calls.map(({ url, method, accept, userAgent }) => ({ url, method, accept, userAgent })),
      [
        { url: META, method: 'GET', accept: 'application/json', userAgent: USER_AGENT },
        { url: THUMB, method: 'GET', accept: 'image/*', userAgent: USER_AGENT },
      ],
    );
    for (const call of calls) assert.ok(call.signal instanceof AbortSignal, 'every request has a signal');
    assert.deepEqual(cached(cacheDir), [`${KEY}.jpg`, `${KEY}.json`]);
    assert.deepEqual(readFileSync(join(cacheDir, `${KEY}.jpg`)), JPEG);
    assert.equal(
      readFileSync(join(cacheDir, `${KEY}.json`), 'utf8'),
      `{"title":"Cutting a mortise","thumbnail":"${KEY}.jpg"}`,
    );
    assert.deepEqual(images.processed, [join(cacheDir, `${KEY}.jpg`)]);
    assert.deepEqual(result, {
      title: 'Cutting a mortise',
      image: { file: join(cacheDir, `${KEY}.jpg`), provider: 'youtube' },
    });
  }));

test('the default User-Agent is coffer/{package version}', () =>
  inTemp(async (root) => {
    const { fetch, calls } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
    await previews.preview(Y);
    assert.deepEqual(
      calls.map((call) => call.userAgent),
      [`coffer/${readVersion()}`, `coffer/${readVersion()}`],
    );
  }));

test('a warm cache is used without a request, by the same fetcher and by a new one', () =>
  inTemp(async (root) => {
    const { fetch, calls } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const first = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
    await first.preview(Y);
    assert.equal(calls.length, 2);

    const again = await first.preview(match('https://www.youtube.com/watch?v=aBcD3fGh1_-'));
    assert.equal(calls.length, 2);
    assert.equal(again?.title, 'Cutting a mortise');

    const images = stubImages();
    const second = createVideoPreviews({ cacheDir: root, fetch: noFetch, processImage: images.processImage });
    const result = await second.preview(Y);
    assert.deepEqual(result, {
      title: 'Cutting a mortise',
      image: { file: join(root, `${KEY}.jpg`), provider: 'youtube' },
    });
    assert.deepEqual(images.processed, [join(root, `${KEY}.jpg`)]);
  }));

test('a warm cache is used even when fetching is disabled', () =>
  inTemp(async (root) => {
    writeFileSync(join(root, `${KEY}.png`), JPEG);
    writeFileSync(join(root, `${KEY}.json`), JSON.stringify({ title: null, thumbnail: `${KEY}.png` }));
    const previews = createVideoPreviews({
      cacheDir: root,
      fetch: noFetch,
      enabled: false,
      processImage: stubImages().processImage,
    });
    assert.deepEqual(await previews.preview(Y), {
      title: null,
      image: { file: join(root, `${KEY}.png`), provider: 'youtube' },
    });
  }));

test('an invalid cache entry is fetched again', async (t) => {
  /** @type {[string, string | null][]} */
  const entries = [
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['a title that is not a string', JSON.stringify({ title: 3, thumbnail: `${KEY}.jpg` })],
    ['no thumbnail', JSON.stringify({ title: 'x' })],
    ['a thumbnail that does not exist', JSON.stringify({ title: 'x', thumbnail: `${KEY}.webp` })],
    ['a thumbnail outside the folder', JSON.stringify({ title: 'x', thumbnail: `../${KEY}.jpg` })],
  ];
  for (const [label, content] of entries) {
    await t.test(label, () =>
      inTemp(async (root) => {
        const cacheDir = join(root, 'videos');
        mkdirSync(cacheDir);
        writeFileSync(join(cacheDir, `${KEY}.jpg`), JPEG);
        writeFileSync(join(root, `${KEY}.jpg`), JPEG);
        if (content !== null) writeFileSync(join(cacheDir, `${KEY}.json`), content);
        const { fetch, calls } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
        const previews = createVideoPreviews({ cacheDir, fetch, processImage: stubImages().processImage });
        const result = await previews.preview(Y);
        assert.equal(calls.length, 2);
        assert.equal(result?.title, 'Cutting a mortise');
      }),
    );
  }
});

test('the extension of the cached thumbnail follows its media type', async (t) => {
  /** @type {[string, string][]} */
  const types = [
    ['image/jpeg', 'jpg'],
    ['IMAGE/PNG ; charset=binary', 'png'],
    [' image/webp', 'webp'],
  ];
  for (const [type, ext] of types) {
    await t.test(type, () =>
      inTemp(async (root) => {
        const { fetch } = fakeFetch({ [META]: json({ thumbnail_url: THUMB }), [THUMB]: image(JPEG, type) });
        const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
        const result = await previews.preview(Y);
        assert.equal(result?.title, null);
        assert.deepEqual(cached(root), [`${KEY}.${ext}`, `${KEY}.json`].sort());
        assert.equal(
          readFileSync(join(root, `${KEY}.json`), 'utf8'),
          `{"title":null,"thumbnail":"${KEY}.${ext}"}`,
        );
      }),
    );
  }
});

test('an empty or non-string title is no title', () =>
  inTemp(async (root) => {
    const { fetch } = fakeFetch({ [META]: json({ title: '   ', thumbnail_url: THUMB }), [THUMB]: image(JPEG) });
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
    assert.equal((await previews.preview(Y))?.title, null);

    const other = createVideoPreviews({
      cacheDir: join(root, 'other'),
      fetch: fakeFetch({ [META]: json({ title: 5, thumbnail_url: THUMB }), [THUMB]: image(JPEG) }).fetch,
      processImage: stubImages().processImage,
    });
    assert.equal((await other.preview(Y))?.title, null);
  }));

/**
 * @typedef {object} FailureCase
 * @property {string} label
 * @property {Record<string, (signal: AbortSignal) => Response | Promise<Response>>} routes
 * @property {string | null} title
 * @property {string} warning
 * @property {number} [timeoutMs]
 * @property {(file: string, match: VideoMatch) => Promise<unknown>} [processImage]
 */

/** @type {FailureCase[]} */
const FAILURES = [
  {
    label: 'the metadata request answers 404',
    routes: { [META]: json({}, 404) },
    title: null,
    warning: `${META} answered 404`,
  },
  {
    label: 'the metadata request answers 204',
    routes: { [META]: () => new Response(null, { status: 204 }) },
    title: null,
    warning: `${META} answered 204`,
  },
  {
    label: 'the thumbnail request answers 500',
    routes: { [META]: OEMBED, [THUMB]: image(JPEG, 'image/jpeg', 500) },
    title: 'Cutting a mortise',
    warning: `${THUMB} answered 500`,
  },
  {
    label: 'the metadata request times out',
    routes: {
      [META]: (signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    },
    timeoutMs: 20,
    title: null,
    warning: `${META} did not answer within 20 ms`,
  },
  {
    label: 'the thumbnail body times out',
    routes: {
      [META]: OEMBED,
      [THUMB]: (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    },
    timeoutMs: 20,
    title: 'Cutting a mortise',
    warning: `${THUMB} did not answer within 20 ms`,
  },
  {
    label: 'the metadata host cannot be reached',
    routes: {
      [META]: () => {
        throw new TypeError('fetch failed');
      },
    },
    title: null,
    warning: `${META} could not be reached`,
  },
  {
    label: 'the thumbnail host cannot be reached',
    routes: {
      [META]: OEMBED,
      [THUMB]: () => Promise.reject(new Error('ECONNRESET')),
    },
    title: 'Cutting a mortise',
    warning: `${THUMB} could not be reached`,
  },
  {
    label: 'the metadata is not JSON',
    routes: { [META]: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) },
    title: null,
    warning: `${META} did not return a JSON object`,
  },
  {
    label: 'the metadata is a JSON array',
    routes: { [META]: json([{ title: 'x', thumbnail_url: THUMB }]) },
    title: null,
    warning: `${META} did not return a JSON object`,
  },
  {
    label: 'the metadata is JSON null',
    routes: { [META]: json(null) },
    title: null,
    warning: `${META} did not return a JSON object`,
  },
  {
    label: 'the metadata has no thumbnail_url',
    routes: { [META]: json({ title: 'Cutting a mortise' }) },
    title: 'Cutting a mortise',
    warning: `${META} returned no thumbnail`,
  },
  {
    label: 'the thumbnail_url is not http(s)',
    routes: { [META]: json({ title: 'Cutting a mortise', thumbnail_url: 'ftp://i.ytimg.com/a.jpg' }) },
    title: 'Cutting a mortise',
    warning: `${META} returned no thumbnail`,
  },
  {
    label: 'the thumbnail is of another type',
    routes: { [META]: OEMBED, [THUMB]: image(JPEG, 'Text/HTML; charset=utf-8') },
    title: 'Cutting a mortise',
    warning: `${THUMB} returned text/html, not a JPEG, PNG or WebP image`,
  },
  {
    label: 'the thumbnail is a GIF',
    routes: { [META]: OEMBED, [THUMB]: image(JPEG, 'image/gif') },
    title: 'Cutting a mortise',
    warning: `${THUMB} returned image/gif, not a JPEG, PNG or WebP image`,
  },
  {
    label: 'the thumbnail has no type',
    routes: { [META]: OEMBED, [THUMB]: image(JPEG, null) },
    title: 'Cutting a mortise',
    warning: `${THUMB} returned no type, not a JPEG, PNG or WebP image`,
  },
  {
    label: 'the thumbnail is larger than 10 MiB',
    routes: { [META]: OEMBED, [THUMB]: image(Buffer.alloc(MAX_PREVIEW_BYTES + 1)) },
    title: 'Cutting a mortise',
    warning: `${THUMB} is larger than 10 MiB`,
  },
  {
    label: 'the thumbnail says it is larger than 10 MiB',
    routes: {
      [META]: OEMBED,
      [THUMB]: () =>
        new Response(new Uint8Array(JPEG), {
          headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_PREVIEW_BYTES + 1) },
        }),
    },
    title: 'Cutting a mortise',
    warning: `${THUMB} is larger than 10 MiB`,
  },
  {
    label: 'the thumbnail cannot be decoded',
    routes: { [META]: OEMBED, [THUMB]: image(JPEG) },
    processImage: async () => {
      throw new ImageError('cannot read the image: bad');
    },
    title: 'Cutting a mortise',
    warning: `the image from ${THUMB} could not be decoded`,
  },
];

test('each failure gives its exact reason and caches nothing', async (t) => {
  for (const failure of FAILURES) {
    await t.test(failure.label, () =>
      inTemp(async (root) => {
        const cacheDir = join(root, VIDEO_CACHE_DIR);
        const { fetch } = fakeFetch(failure.routes);
        const previews = createVideoPreviews({
          cacheDir,
          fetch,
          timeoutMs: failure.timeoutMs,
          processImage: failure.processImage ?? stubImages().processImage,
        });
        const result = await previews.preview(Y);
        assert.deepEqual(result, { title: failure.title, warning: failure.warning });
        assert.deepEqual(cached(cacheDir), []);
      }),
    );
  }
});

test('a thumbnail of exactly 10 MiB is accepted', () =>
  inTemp(async (root) => {
    const { fetch } = fakeFetch({ [META]: OEMBED, [THUMB]: image(Buffer.alloc(MAX_PREVIEW_BYTES)) });
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
    const result = await previews.preview(Y);
    assert.ok(result && 'image' in result);
    assert.equal(MAX_PREVIEW_BYTES, 10485760);
  }));

test('a failure is not cached, so the next fetcher tries again', () =>
  inTemp(async (root) => {
    const failing = fakeFetch({ [META]: json({}, 503) });
    const first = createVideoPreviews({ cacheDir: root, fetch: failing.fetch, processImage: stubImages().processImage });
    assert.deepEqual(await first.preview(Y), { title: null, warning: `${META} answered 503` });
    assert.equal(failing.calls.length, 1);

    const working = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const second = createVideoPreviews({ cacheDir: root, fetch: working.fetch, processImage: stubImages().processImage });
    assert.equal((await second.preview(Y))?.title, 'Cutting a mortise');
    assert.equal(working.calls.length, 2);
  }));

test('an error other than ImageError from processImage is not a warning', () =>
  inTemp(async (root) => {
    const { fetch } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const previews = createVideoPreviews({
      cacheDir: root,
      fetch,
      processImage: async () => {
        throw new Error('disk full');
      },
    });
    await assert.rejects(previews.preview(Y), /disk full/);
  }));

test('concurrent calls for the same cache key send one request sequence', () =>
  inTemp(async (root) => {
    const { fetch, calls } = fakeFetch({ [META]: OEMBED, [THUMB]: image(JPEG) });
    const images = stubImages();
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: images.processImage });
    const results = await Promise.all([
      previews.preview(Y),
      previews.preview(match('https://www.youtube.com/watch?v=aBcD3fGh1_-&t=30')),
      previews.preview(match('https://www.youtube.com/shorts/aBcD3fGh1_-')),
    ]);
    assert.deepEqual(
      calls.map((call) => call.url),
      [META, THUMB],
    );
    assert.equal(images.processed.length, 1);
    for (const result of results) assert.equal(result?.title, 'Cutting a mortise');
  }));

test('concurrent failing calls for the same key send one request and share the warning', () =>
  inTemp(async (root) => {
    const { fetch, calls } = fakeFetch({ [META]: json({}, 404) });
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: stubImages().processImage });
    const results = await Promise.all([previews.preview(Y), previews.preview(Y)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(results[0], results[1]);
  }));

test('with fetching disabled no request is made and there is no preview', () =>
  inTemp(async (root) => {
    const previews = createVideoPreviews({
      cacheDir: root,
      fetch: noFetch,
      enabled: false,
      processImage: stubImages().processImage,
    });
    assert.equal(await previews.preview(Y), undefined);
    assert.deepEqual(cached(root), []);
  }));

test('a VK Video match makes no request and has no preview', () =>
  inTemp(async (root) => {
    const previews = createVideoPreviews({ cacheDir: root, fetch: noFetch, processImage: stubImages().processImage });
    const vk = match('https://vk.com/video_ext.php?oid=-12345&id=456239017&hash=a1b2c3d4e5f60718');
    assert.equal(await previews.preview(vk), undefined);
    assert.deepEqual(cached(root), []);
  }));

/** @type {import('../src/video/rules.js').GenericProvider} */
const GENERIC = {
  name: 'Example Tube',
  embed: 'https://player.tube.example/e/{id}',
  watch: 'https://tube.example/v/{id}',
  startParam: 't',
  endParam: null,
  autoplayParam: 'autoplay',
  thumbnail: 'https://img.tube.example/{id}/cover.jpg',
  oembed: null,
};

/** @type {VideoRule} */
const GENERIC_RULE = {
  pattern: 'https://tube\\.example/v/(?<id>[a-z0-9]+)(?:\\?.*)?',
  flags: '',
  provider: 'generic',
  generic: GENERIC,
};

test('a generic provider with a thumbnail template fetches only the thumbnail', () =>
  inTemp(async (root) => {
    const cover = 'https://img.tube.example/abcd1234/cover.jpg';
    const { fetch, calls } = fakeFetch({ [cover]: image(JPEG, 'image/png') });
    const images = stubImages();
    const previews = createVideoPreviews({ cacheDir: root, fetch, processImage: images.processImage });
    const result = await previews.preview(match('https://tube.example/v/abcd1234?t=15', [GENERIC_RULE]));
    const key = createHash('sha256').update('https://tube.example/v/abcd1234').digest('hex');
    assert.deepEqual(
      calls.map(({ url, method, accept }) => ({ url, method, accept })),
      [{ url: cover, method: 'GET', accept: 'image/*' }],
    );
    assert.deepEqual(result, { title: null, image: { file: join(root, `${key}.png`), provider: 'generic' } });
    assert.equal(readFileSync(join(root, `${key}.json`), 'utf8'), `{"title":null,"thumbnail":"${key}.png"}`);
  }));

test('a generic provider without metadata or thumbnail makes no request', () =>
  inTemp(async (root) => {
    /** @type {VideoRule} */
    const rule = { ...GENERIC_RULE, generic: { ...GENERIC, thumbnail: null } };
    const previews = createVideoPreviews({ cacheDir: root, fetch: noFetch, processImage: stubImages().processImage });
    assert.equal(await previews.preview(match('https://tube.example/v/abcd1234', [rule])), undefined);
  }));

test('with the image pipeline the preview is published as {provider}-preview', () =>
  inTemp(async (root) => {
    const pipeline = createImagePipeline({ cacheDir: join(root, 'images') });
    /** @param {string} file @param {VideoMatch} found */
    const processImage = (file, found) =>
      pipeline.process(file, { location: 'strip', camera: 'strip' }, { name: `${found.provider}-preview` });
    const { fetch } = fakeFetch({ [META]: OEMBED, [THUMB]: image(await solidImage(480, 360)) });
    const previews = createVideoPreviews({ cacheDir: join(root, VIDEO_CACHE_DIR), fetch, processImage });
    const result = await previews.preview(Y);
    assert.ok(result && 'image' in result);
    assert.equal(result.image.name, 'youtube-preview');
    assert.ok(result.image.variants.some((variant) => variant.file === 'youtube-preview-480.webp'));

    const broken = fakeFetch({ [META]: OEMBED, [THUMB]: image(Buffer.from('not an image')) });
    const other = createVideoPreviews({ cacheDir: join(root, 'other'), fetch: broken.fetch, processImage });
    assert.deepEqual(await other.preview(Y), {
      title: 'Cutting a mortise',
      warning: `the image from ${THUMB} could not be decoded`,
    });
    assert.deepEqual(cached(join(root, 'other')), []);
  }));
