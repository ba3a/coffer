import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { simplifyPictures } from '../src/feeds.js';
import {
  DEFAULT_WIDTHS,
  ImageError,
  createImagePipeline,
  createLimiter,
  imageFileUrl,
  pickVariant,
  variantWidths,
} from '../src/images/pipeline.js';
import { isHeic, orientPixels } from '../src/images/decode.js';
import { renderMarkdown } from '../src/markdown/render.js';
import { TINY_JPEG, TINY_PNG, noisyImage, sidewaysPhoto, solidImage } from './helpers/images.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));

/** After the example's published posts and before its future-dated one. */
const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * Runs `body` with an empty temporary directory and removes it afterwards.
 *
 * @template T
 * @param {(root: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-images-'));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} files Relative path (forward slashes) to content.
 */
function addFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Copies the example site (without a previous build or cache) into a temporary
 * directory, adds files, and runs `body` with its root.
 *
 * @param {(root: string) => Promise<void>} body
 * @param {Record<string, string | Buffer>} [extra]
 */
async function withExampleCopy(body, extra = {}) {
  await inTemp(async (root) => {
    cpSync(exampleDir, root, {
      recursive: true,
      filter: (source) => !/[\\/](dist|\.cache|\.coffer)([\\/]|$)/.test(source),
    });
    addFiles(root, extra);
    await body(root);
  });
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
 * Build errors of a build that is expected to fail because of its sources.
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function buildErrors(root) {
  try {
    await build(root);
  } catch (error) {
    return /** @type {{ errors: string[] }} */ (error).errors;
  }
  assert.fail('the build should have failed');
}

/**
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} url
 * @returns {string}
 */
function pageHtml(result, url) {
  return readFileSync(join(result.outDir, ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * Every file below a directory, as forward-slash paths relative to it.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path).map((name) => `${entry.name}/${name}`));
    else found.push(entry.name);
  }
  return found.sort();
}

/**
 * @param {string} html
 * @returns {string[]} The `<img>` tags of a page.
 */
function imgTags(html) {
  return [...html.matchAll(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map((match) => match[0]);
}

/**
 * @param {string} tag
 * @param {string} name
 * @returns {string | null}
 */
function attribute(tag, name) {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

test('variantWidths never enlarges and always offers the full width of a small image', () => {
  assert.deepEqual(variantWidths(DEFAULT_WIDTHS, 6000), [480, 800, 1200, 1600, 2400]);
  assert.deepEqual(variantWidths(DEFAULT_WIDTHS, 2400), [480, 800, 1200, 1600, 2400]);
  assert.deepEqual(variantWidths(DEFAULT_WIDTHS, 1000), [480, 800, 1000]);
  assert.deepEqual(variantWidths(DEFAULT_WIDTHS, 300), [300]);
  assert.deepEqual(variantWidths([100, 200], 150), [100, 150]);
});

test('pickVariant takes the widest variant up to 1200 pixels, else the narrowest', () => {
  const widths = (/** @type {number[]} */ list) => list.map((width) => ({ width }));
  assert.equal(pickVariant(widths([480, 800, 1200, 1600])).width, 1200);
  assert.equal(pickVariant(widths([480, 800, 1000])).width, 1000);
  assert.equal(pickVariant(widths([1600, 2400])).width, 1600);
  assert.equal(pickVariant(widths([300])).width, 300);
  assert.equal(pickVariant(widths([480, 800, 1200]), 600).width, 480);
});

test('the limiter runs at most the given number of jobs at once and keeps order', async () => {
  const limit = createLimiter(2);
  let running = 0;
  let peak = 0;
  /** @type {number[]} */
  const started = [];
  const results = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      limit(async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return index * 2;
      }),
    ),
  );
  assert.equal(peak, 2);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6]);

  // A failing job frees its place.
  await assert.rejects(limit(async () => Promise.reject(new Error('boom'))), /boom/);
  assert.equal(await limit(async () => 'still works'), 'still works');
});

test('an image gets WebP variants at the configured widths, none wider than the original, and a capped viewer JPEG', async () => {
  await inTemp(async (root) => {
    addFiles(root, { 'wide.jpg': await solidImage(3000, 2000), 'small.png': await solidImage(300, 200, 'png') });
    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });

    const wide = await pipeline.process(join(root, 'wide.jpg'));
    assert.deepEqual(
      wide.variants.map((variant) => [variant.width, variant.height, variant.file]),
      [
        [480, 320, 'wide-480.webp'],
        [800, 533, 'wide-800.webp'],
        [1200, 800, 'wide-1200.webp'],
        [1600, 1067, 'wide-1600.webp'],
        [2400, 1600, 'wide-2400.webp'],
      ],
    );
    for (const variant of wide.variants) {
      const metadata = await sharp(join(wide.dir, variant.file)).metadata();
      assert.equal(metadata.format, 'webp');
      assert.equal(metadata.width, variant.width);
      assert.equal(metadata.height, variant.height);
    }
    // 3000 pixels are within the default cap of 3200, so the viewer image keeps the full size.
    assert.deepEqual([wide.viewer.file, wide.viewer.width, wide.viewer.height], ['wide-full.jpg', 3000, 2000]);
    assert.equal((await sharp(join(wide.dir, wide.viewer.file)).metadata()).format, 'jpeg');

    const small = await pipeline.process(join(root, 'small.png'));
    assert.deepEqual(small.variants.map((variant) => variant.width), [300], 'a small image is not enlarged');
    assert.deepEqual([small.viewer.width, small.viewer.height], [300, 200]);

    const capped = createImagePipeline({ cacheDir: join(root, 'cache2'), widths: [400], viewerMaxEdge: 1000 });
    const smaller = await capped.process(join(root, 'wide.jpg'));
    assert.deepEqual(smaller.variants.map((variant) => variant.width), [400]);
    assert.deepEqual([smaller.viewer.width, smaller.viewer.height], [1000, 667], 'the long edge is capped');
  });
});

test('an image with EXIF orientation 6 is made upright, with its true size and no metadata', async () => {
  await inTemp(async (root) => {
    // Stored 1200 by 800 and turned a quarter clockwise on display: 800 by 1200.
    addFiles(root, { 'phone.jpg': await sidewaysPhoto(1200, 800) });
    const source = await sharp(join(root, 'phone.jpg')).metadata();
    assert.deepEqual([source.width, source.height, source.orientation], [1200, 800, 6]);
    assert.ok(source.exif, 'the original has EXIF data, including its position');

    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
    const image = await pipeline.process(join(root, 'phone.jpg'));
    assert.deepEqual([image.width, image.height], [800, 1200]);
    assert.deepEqual(
      image.variants.map((variant) => [variant.width, variant.height]),
      [
        [480, 720],
        [800, 1200],
      ],
    );
    assert.deepEqual([image.viewer.width, image.viewer.height], [800, 1200]);

    for (const file of [...image.variants, image.viewer]) {
      const path = join(image.dir, file.file);
      const metadata = await sharp(path).metadata();
      assert.deepEqual([metadata.width, metadata.height], [file.width, file.height], file.file);
      assert.ok(metadata.height > metadata.width, `${file.file} is upright`);
      assert.equal(metadata.exif, undefined, `${file.file} carries no EXIF data`);
      assert.ok(metadata.orientation === undefined || metadata.orientation === 1, `${file.file} needs no turning`);

      // The red corner was top-left in the stored picture; turned a quarter clockwise it is top-right.
      const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
      const pixel = (/** @type {number} */ x, /** @type {number} */ y) => {
        const offset = (y * info.width + x) * info.channels;
        return [data[offset], data[offset + 1], data[offset + 2]];
      };
      const topRight = pixel(info.width - 4, 4);
      const topLeft = pixel(4, 4);
      assert.ok(topRight[0] > 180 && topRight[2] < 100, `${file.file}: red in the top-right corner, got ${topRight}`);
      assert.ok(topLeft[2] > 120 && topLeft[0] < 100, `${file.file}: blue in the top-left corner, got ${topLeft}`);
    }
  });
});

test('processed images are cached by the hash of the original and the options', async () => {
  await inTemp(async (root) => {
    addFiles(root, { 'big.jpg': await noisyImage(3000, 2000), 'other.jpg': await solidImage(900, 600) });
    const cacheDir = join(root, 'cache');

    const first = createImagePipeline({ cacheDir });
    const started = performance.now();
    const processed = await first.process(join(root, 'big.jpg'));
    const firstTime = performance.now() - started;
    assert.equal(processed.cached, false);
    assert.deepEqual(first.stats, { generated: 1, reused: 0 });
    const times = new Map(
      listFiles(processed.dir).map((name) => [name, statSync(join(processed.dir, name)).mtimeMs]),
    );

    const second = createImagePipeline({ cacheDir });
    const restarted = performance.now();
    const again = await second.process(join(root, 'big.jpg'));
    const secondTime = performance.now() - restarted;
    assert.equal(again.cached, true);
    assert.deepEqual(second.stats, { generated: 0, reused: 1 });
    assert.equal(again.key, processed.key);
    assert.deepEqual(again.variants, processed.variants);
    for (const [name, time] of times) assert.equal(statSync(join(again.dir, name)).mtimeMs, time, `${name} is not rewritten`);
    assert.ok(secondTime * 3 < firstTime, `the cached run (${secondTime.toFixed(0)} ms) is much faster than the first (${firstTime.toFixed(0)} ms)`);

    // The same pipeline asked twice for the same file does the work once.
    await second.process(join(root, 'big.jpg'));
    assert.deepEqual(second.stats, { generated: 0, reused: 1 });

    // Other options mean other files; other content means other files too.
    const narrower = createImagePipeline({ cacheDir, widths: [480] });
    const different = await narrower.process(join(root, 'big.jpg'));
    assert.notEqual(different.key, processed.key);
    assert.equal(different.cached, false);
    const quality = createImagePipeline({ cacheDir, webpQuality: 50 });
    assert.notEqual((await quality.process(join(root, 'big.jpg'))).key, processed.key);

    addFiles(root, { 'big.jpg': await solidImage(3000, 2000) });
    const changed = await createImagePipeline({ cacheDir }).process(join(root, 'big.jpg'));
    assert.notEqual(changed.sha256, processed.sha256);
    assert.notEqual(changed.key, processed.key);

    // A damaged cache folder is made again instead of being trusted.
    rmSync(join(changed.dir, changed.variants[0].file));
    const repaired = createImagePipeline({ cacheDir });
    const fixed = await repaired.process(join(root, 'big.jpg'));
    assert.equal(fixed.cached, false);
    assert.ok(existsSync(join(fixed.dir, fixed.variants[0].file)));
    assert.deepEqual(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp')), [], 'no temporary folders are left');
  });
});

test('only JPEG, PNG and WebP images are accepted, and a broken file is an ImageError', async () => {
  await inTemp(async (root) => {
    addFiles(root, {
      'ok.webp': await solidImage(500, 300, 'webp'),
      'anim.gif': 'GIF89a',
      'vector.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      'broken.jpg': 'this is not a picture',
      'gif-as.jpg': await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).gif().toBuffer(),
    });
    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
    assert.equal((await pipeline.process(join(root, 'ok.webp'))).variants.length, 2);
    for (const [name, message] of [
      ['anim.gif', /unsupported image format ".gif"/],
      ['vector.svg', /unsupported image format ".svg"/],
      ['broken.jpg', /cannot read the image/],
      ['gif-as.jpg', /unsupported image format "gif"/],
      ['missing.jpg', /cannot read the image/],
    ]) {
      await assert.rejects(
        pipeline.process(join(root, /** @type {string} */ (name))),
        (error) => error instanceof ImageError && /** @type {RegExp} */ (message).test(error.message),
        String(name),
      );
    }
    assert.deepEqual(pipeline.stats, { generated: 1, reused: 0 });
  });
});

test('invalid pipeline options are rejected', () => {
  assert.throws(() => createImagePipeline({ cacheDir: 'c', widths: [] }), /widths/);
  assert.throws(() => createImagePipeline({ cacheDir: 'c', widths: [4] }), /width/);
  assert.throws(() => createImagePipeline({ cacheDir: 'c', webpQuality: 0 }), /webpQuality/);
  assert.throws(() => createImagePipeline({ cacheDir: 'c', concurrency: 0 }), /concurrency/);
  assert.throws(() => createImagePipeline({ cacheDir: 'c', viewerMaxEdge: 10 }), /viewerMaxEdge/);
});

test('publishing copies the variants and the viewer image, never the original', async () => {
  await inTemp(async (root) => {
    addFiles(root, { 'Dovetail Photo (1).JPG': await solidImage(1000, 700) });
    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
    const image = await pipeline.process(join(root, 'Dovetail Photo (1).JPG'));
    assert.equal(image.name, 'dovetail-photo-1');
    const out = join(root, 'out');
    pipeline.publish(image, out);
    pipeline.publish(image, out);
    assert.deepEqual(listFiles(out), [
      `img/${image.key}/dovetail-photo-1-1000.webp`,
      `img/${image.key}/dovetail-photo-1-480.webp`,
      `img/${image.key}/dovetail-photo-1-800.webp`,
      `img/${image.key}/dovetail-photo-1-full.jpg`,
    ]);
    assert.equal(imageFileUrl(image, image.viewer), `/img/${image.key}/dovetail-photo-1-full.jpg`);
  });
});

/**
 * A stand-in resolver for the Markdown renderer: every local image is 1600 by
 * 1200 with variants at 480 and 1200.
 *
 * @returns {{ resolve: import('../src/markdown/render.js').ImageOptions['resolve'], asked: string[] }}
 */
function fakeResolver() {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    resolve: async ({ src }) => {
      asked.push(src);
      if (/^https?:/.test(src)) return null;
      return {
        src: `/img/k/${src}-1200.webp`,
        width: 1200,
        height: 900,
        srcset: [
          { url: `/img/k/${src}-480.webp`, width: 480 },
          { url: `/img/k/${src}-1200.webp`, width: 1200 },
        ],
      };
    },
  };
}

test('a Markdown image becomes a figure with picture, srcset, sizes, size attributes and a caption', async () => {
  const { resolve } = fakeResolver();
  const { html } = await renderMarkdown('![A hill & a "tree"](hill "Day one <i>").', { images: { resolve, sizes: '100vw' } });
  assert.equal(
    html,
    '<p><picture><source type="image/webp" srcset="/img/k/hill-480.webp 480w, /img/k/hill-1200.webp 1200w" sizes="100vw"><img src="/img/k/hill-1200.webp" alt="A hill &#x26; a &#x22;tree&#x22;" title="Day one <i>" width="1200" height="900"></picture>.</p>',
    'an image inside a sentence stays inline, with its title',
  );

  const alone = await renderMarkdown('![A hill](hill.jpg "Day one <i>")', { images: { resolve, sizes: '100vw' } });
  assert.equal(
    alone.html,
    '<figure><picture><source type="image/webp" srcset="/img/k/hill.jpg-480.webp 480w, /img/k/hill.jpg-1200.webp 1200w" sizes="100vw"><img src="/img/k/hill.jpg-1200.webp" alt="A hill" width="1200" height="900"></picture><figcaption>Day one &#x3C;i></figcaption></figure>',
  );

  const plain = await renderMarkdown('![](hill.jpg)', { images: { resolve, sizes: '100vw' } });
  assert.ok(plain.html.startsWith('<figure>'), plain.html);
  assert.ok(plain.html.includes('alt=""'), 'alt is present even when empty');
  assert.ok(!plain.html.includes('<figcaption'), 'no caption without a title');
});

test('all images but the first of a page are lazy, and the resolver is asked once per image', async () => {
  const { resolve, asked } = fakeResolver();
  const text = '![a](one.jpg "First")\n\n![b](two.jpg)\n\nText ![c](three.jpg) more.\n\n```md\n![d](code.jpg)\n```\n\n![e](four.jpg)';
  const { html, firstImage } = await renderMarkdown(text, { images: { resolve, sizes: '100vw' } });
  assert.deepEqual(asked.sort(), ['four.jpg', 'one.jpg', 'three.jpg', 'two.jpg']);
  assert.equal(firstImage?.src, 'one.jpg', 'the plain result still reports the image as written');
  const tags = imgTags(html);
  assert.equal(tags.length, 4);
  assert.equal(attribute(tags[0], 'loading'), null);
  assert.equal(attribute(tags[0], 'decoding'), null);
  for (const tag of tags.slice(1)) {
    assert.equal(attribute(tag, 'loading'), 'lazy', tag);
    assert.equal(attribute(tag, 'decoding'), 'async', tag);
  }
  for (const tag of tags) {
    assert.equal(attribute(tag, 'width'), '1200', tag);
    assert.equal(attribute(tag, 'height'), '900', tag);
  }
  assert.equal(html.match(/<figure>/g)?.length, 3, 'three images stand alone, one is inline');
  assert.ok(html.includes('code.jpg'), 'a code block is left alone');
});

test('images that the resolver leaves alone stay plain, and still count as the first image', async () => {
  const { resolve } = fakeResolver();
  const { html } = await renderMarkdown('![remote](https://img.example/a.jpg)\n\n![local](b.jpg)\n\n![x](https://img.example/c.jpg) ![y](d.jpg)', {
    images: { resolve, sizes: '100vw' },
  });
  assert.ok(html.includes('<p><img src="https://img.example/a.jpg" alt="remote"></p>'), html);
  assert.equal(imgTags(html).filter((tag) => tag.includes('loading="lazy"')).length, 2, 'the local images are lazy');
  assert.ok(html.includes('<img src="https://img.example/c.jpg" alt="x">'), html);
});

test('several images in one paragraph, on lines of their own, become several figures', async () => {
  const { resolve } = fakeResolver();
  const { html } = await renderMarkdown('![a](a.jpg "One")\n![b](b.jpg "Two")', { images: { resolve, sizes: '100vw' } });
  assert.equal(html.match(/<figure>/g)?.length, 2);
  assert.ok(html.includes('<figcaption>One</figcaption>') && html.includes('<figcaption>Two</figcaption>'));
  assert.ok(!html.includes('<p>'), html);
});

test('without an image resolver an image stays a plain img', async () => {
  const { html } = await renderMarkdown('![A hill](hill.jpg "t")');
  assert.equal(html, '<p><img src="hill.jpg" alt="A hill" title="t"></p>');
});

test('simplifyPictures keeps the img with its size and drops srcset, loading and decoding', () => {
  const picture =
    '<figure><picture><source type="image/webp" srcset="/a-480.webp 480w, /a-1200.webp 1200w" sizes="100vw"><img src="/a-1200.webp" alt="a &#x3E; b" width="1200" height="900" loading="lazy" decoding="async"></picture><figcaption>c</figcaption></figure>';
  assert.equal(
    simplifyPictures(picture),
    '<figure><img src="/a-1200.webp" alt="a &#x3E; b" width="1200" height="900"><figcaption>c</figcaption></figure>',
  );
  const foreign = '<picture><source srcset="a.avif"><source srcset="a.webp"><img src="a.jpg"></picture>';
  assert.equal(simplifyPictures(foreign), foreign, 'a picture written by hand is left as it was');
});

test('the example site publishes resized WebP variants and never the originals', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const files = listFiles(result.outDir);
    assert.ok(files.some((name) => /^img\/[0-9a-f]{16}\/dovetail-joint-1200\.webp$/.test(name)), files.join('\n'));
    assert.ok(files.some((name) => /^img\/[0-9a-f]{16}\/dovetail-joint-full\.jpg$/.test(name)));
    for (const name of files) {
      assert.ok(!/(^|\/)(dovetail-joint|marking-gauge|ridge)\.jpe?g$/.test(name), `${name} is an original`);
      if (name.startsWith('img/')) assert.match(name, /^img\/[0-9a-f]{16}\/[a-z0-9-]+-(\d+\.webp|full\.jpg)$/);
    }
    assert.ok(!files.some((name) => name.startsWith('covers/')));

    // Every image in the output is the same bytes as in the manifest, and not larger than its original.
    for (const image of result.manifest.images) {
      for (const output of image.outputs) {
        assert.ok(existsSync(join(result.outDir, ...output.file.split('/'))), output.file);
      }
      const original = statSync(join(root, ...image.source.split('/'))).size;
      const viewer = image.outputs.find((output) => output.role === 'viewer');
      assert.ok(viewer && statSync(join(result.outDir, ...viewer.file.split('/'))).size <= original * 1.5);
    }
  });
});

test('a photo with EXIF orientation 6 is published upright with matching width and height attributes', async () => {
  await withExampleCopy(async (root) => {
    const original = await sharp(join(root, 'content', 'journal', 'photos', 'ridge.jpg')).metadata();
    assert.deepEqual([original.width, original.height, original.orientation], [1200, 800, 6]);
    assert.ok(original.exif, 'the example photo has EXIF data, with a made-up position');

    const result = await build(root);
    const html = pageHtml(result, '/journal/mountain-weekend/');
    const [tag] = imgTags(html);
    assert.equal(attribute(tag, 'width'), '800');
    assert.equal(attribute(tag, 'height'), '1200');
    const src = attribute(tag, 'src') ?? '';
    const metadata = await sharp(join(result.outDir, ...src.split('/').filter(Boolean))).metadata();
    assert.deepEqual([metadata.width, metadata.height], [800, 1200], 'the file has the size the attributes say');
    assert.equal(metadata.exif, undefined);

    const entry = result.manifest.images.find((image) => image.source.endsWith('journal/photos/ridge.jpg'));
    assert.ok(entry);
    assert.deepEqual([entry.width, entry.height], [800, 1200]);
    assert.equal(entry.post, '/journal/mountain-weekend/');
    assert.equal(entry.use, 'body');
    for (const output of entry.outputs) {
      const size = await sharp(join(result.outDir, ...output.file.split('/'))).metadata();
      assert.ok(size.height > size.width, `${output.file} is upright`);
      assert.ok(size.orientation === undefined || size.orientation === 1, `${output.file} needs no turning`);
      // The example's tag for walking days says "keep", so the viewer JPEG has a position; variants never do.
      assert.equal(size.exif === undefined, output.role === 'variant', `${output.file}: EXIF data only in the viewer JPEG`);
    }
  });
});

test('a page serves figures with srcset; images after the first are lazy, every img has a size, captions are figcaptions', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const html = pageHtml(result, '/journal/first-dovetail/');
    const tags = imgTags(html);
    assert.equal(tags.length, 2);
    assert.equal(attribute(tags[0], 'loading'), null, 'the first image is loaded at once');
    assert.equal(attribute(tags[1], 'loading'), 'lazy');
    assert.equal(attribute(tags[1], 'decoding'), 'async');
    assert.match(html, /<figure><a href="[^"]*\/marking-gauge-full\.jpg" class="viewer-link" data-viewer="0"><picture><source type="image\/webp" srcset="[^"]*\/marking-gauge-480\.webp 480w, [^"]*\/marking-gauge-800\.webp 800w, [^"]*\/marking-gauge-1200\.webp 1200w"/);
    assert.match(html, /<picture><source [^>]*sizes="\(min-width: 44rem\) 41rem, calc\(100vw - 2rem\)"/);
    assert.match(html, /<figcaption>The sixth attempt, unglued, on the bench\.<\/figcaption>/);
    assert.equal(html.match(/<figcaption>/g)?.length, 1, 'only the image with a title has a caption');
    assert.ok(!html.includes('title="The sixth attempt'), 'the caption is not repeated as a tooltip');

    // Every img of every page has a size; all but the first of the page are lazy.
    for (const entry of result.manifest.pages) {
      const found = imgTags(readFileSync(join(result.outDir, ...entry.file.split('/')), 'utf8'));
      for (const [index, tag] of found.entries()) {
        assert.ok(attribute(tag, 'width') && attribute(tag, 'height'), `${entry.file}: ${tag} has no size`);
        if (index > 0) assert.equal(attribute(tag, 'loading'), 'lazy', `${entry.file}: ${tag}`);
      }
    }

    // The files the srcset names exist, and the check for links in the output would find them.
    for (const url of html.match(/\/img\/[0-9a-f]{16}\/[a-z0-9-]+\.(?:webp|jpg)/g) ?? []) {
      assert.ok(existsSync(join(result.outDir, ...url.split('/').filter(Boolean))), url);
    }
  });
});

test('the manifest records every image with its original, its page and its outputs', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    assert.deepEqual(
      result.manifest.images.map((image) => [image.source, image.post, image.use]),
      [
        ['content/journal/first-dovetail/dovetail-joint.jpg', '/journal/first-dovetail/', 'body'],
        ['content/journal/first-dovetail/marking-gauge.jpg', '/journal/first-dovetail/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/mountain-weekend/', 'body'],
        ['content/journal/first-dovetail/dovetail-joint.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/first-dovetail/marking-gauge.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/photo-notes/', 'body'],
        ['content/journal/photos/ridge.jpg', '/journal/ridge-walk/', 'body'],
      ],
    );
    const [joint] = result.manifest.images;
    assert.equal(joint.sha256.length, 64);
    assert.deepEqual([joint.width, joint.height], [1200, 800]);
    assert.deepEqual(
      joint.outputs.map((output) => [output.role, output.type, output.width]),
      [
        ['variant', 'image/webp', 480],
        ['variant', 'image/webp', 800],
        ['variant', 'image/webp', 1200],
        ['viewer', 'image/jpeg', 1200],
      ],
    );
    for (const output of joint.outputs) assert.equal(output.url, `/${output.file}`);
  });
});

test('a second build reuses the cached images', async () => {
  await withExampleCopy(async (root) => {
    const first = await build(root);
    // Three originals, each in the post that owns it and again in the carousel post, which has other settings.
    assert.deepEqual(first.images, { generated: 6, reused: 0 });
    const cacheDir = join(root, '.cache', 'images');
    const cached = readdirSync(cacheDir).sort();
    assert.equal(cached.length, 6);
    const times = new Map(cached.map((name) => [name, statSync(join(cacheDir, name, 'info.json')).mtimeMs]));
    const published = listFiles(first.outDir).filter((name) => name.startsWith('img/'));

    const second = await build(root);
    assert.deepEqual(second.images, { generated: 0, reused: 6 });
    assert.deepEqual(readdirSync(cacheDir).sort(), cached);
    for (const [name, time] of times) assert.equal(statSync(join(cacheDir, name, 'info.json')).mtimeMs, time, name);
    assert.deepEqual(listFiles(second.outDir).filter((name) => name.startsWith('img/')), published, 'the output is the same');
    assert.deepEqual(second.manifest.images, first.manifest.images);

    // A replaced photo is processed again, once for each way it is published; the others stay cached.
    addFiles(root, { 'content/journal/first-dovetail/marking-gauge.jpg': await solidImage(1000, 600) });
    const third = await build(root);
    assert.deepEqual(third.images, { generated: 2, reused: 4 });
  });
});

test('image settings of the site decide the widths, the viewer size and the sizes attribute', async () => {
  await withExampleCopy(async (root) => {
    const config = readFileSync(join(root, 'coffer.yaml'), 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(
      join(root, 'coffer.yaml'),
      `${config.trimEnd()}\n    images: { widths: [300, 900], viewerMaxEdge: 1000, sizes: "50vw" }\n`,
    );
    const result = await build(root);
    const html = pageHtml(result, '/journal/first-dovetail/');
    assert.match(html, /marking-gauge-300\.webp 300w, [^"]*marking-gauge-900\.webp 900w"/);
    assert.ok(!html.includes('-480.webp'));
    assert.match(html, /sizes="50vw"/);
    const viewer = result.manifest.images[0].outputs.find((output) => output.role === 'viewer');
    assert.deepEqual([viewer?.width, viewer?.height], [1000, 667]);
  });
});

test('missing alt text is a warning with the place of the image, and the page still builds', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const warnings = result.warnings.filter((warning) => warning.includes('no alt text'));
      assert.deepEqual(warnings, [
        'content/journal/alt/index.md:8:1: the image "pic.png" has no alt text',
        'content/journal/alt/index.md:10:1: the image "https://img.example/x.jpg" has no alt text',
      ]);
      assert.ok(pageHtml(result, '/journal/alt/').includes('alt=""'));
    },
    {
      'content/journal/alt/index.md': '---\ntitle: Alt\ndate: 2025-05-02\n---\n\nText.\n\n![](pic.png)\n\n![](https://img.example/x.jpg)\n\n![fine](pic.png)\n',
      'content/journal/alt/pic.png': await solidImage(600, 400, 'png'),
    },
  );
});

test('an image that cannot be used fails the build with the file, line and column', async () => {
  await withExampleCopy(
    async (root) => {
      assert.deepEqual(await buildErrors(root), [
        "content/journal/bad/index.md:8:1 unsupported image format 'spin.gif' (use JPEG, PNG, WebP or HEIC)",
        "content/journal/bad/index.md:10:1 image 'broken.jpg': cannot read the image: Input file contains unsupported image format",
        "content/journal/bad/index.md:12:1 missing image 'nowhere.jpg'",
      ]);
    },
    {
      'content/journal/bad/index.md':
        '---\ntitle: Bad\ndate: 2025-05-02\n---\n\nText.\n\n![gif](spin.gif)\n\n![broken](broken.jpg)\n\n![missing](nowhere.jpg)\n',
      'content/journal/bad/spin.gif': 'GIF89a',
      'content/journal/bad/broken.jpg': 'not a picture',
    },
  );
});

test('the home page text can have pictures too', async () => {
  await withExampleCopy(
    async (root) => {
      const home = readFileSync(join(root, 'content', 'home.md'), 'utf8');
      writeFileSync(join(root, 'content', 'home.md'), `${home.trimEnd()}\n\n![The workshop](workshop.jpg "Where it happens")\n`);
      const result = await build(root);
      const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
      assert.match(html, /<figure><a href="\/img\/[0-9a-f]{16}\/workshop-full\.jpg" class="viewer-link" data-viewer="0"><picture><source [^>]*><img src="\/img\/[0-9a-f]{16}\/workshop-1200\.webp" alt="The workshop" width="1200" height="800"><\/picture><\/a><figcaption>Where it happens<\/figcaption><\/figure>/);
      assert.ok(result.manifest.images.some((image) => image.post === '/' && image.source === 'content/workshop.jpg'));
    },
    { 'content/workshop.jpg': await solidImage(1500, 1000) },
  );
});

test('feeds carry the 1200 pixel variant as a plain image with absolute links', async () => {
  await withExampleCopy(async (root) => {
    const result = await build(root);
    const feed = readFileSync(join(result.outDir, 'journal', 'feed.xml'), 'utf8');
    assert.match(
      feed,
      /&lt;img src="https:\/\/tove-marlowe\.example\/img\/[0-9a-f]{16}\/dovetail-joint-1200\.webp" alt="[^"]*" width="1200" height="800"&gt;/,
    );
    assert.match(feed, /ridge-800\.webp" alt="[^"]*" width="800" height="1200"/, 'the upright photo keeps its true size');
    assert.ok(!feed.includes('&lt;picture'), 'feeds have no picture element');
    assert.ok(!feed.includes('srcset'));
  });
});

/**
 * Small HEIC pictures made by `test/helpers/make-heic-fixture.js`: 64 by 48
 * pixels as stored, shown upright as 48 by 64 with the red corner at the top
 * right. `sideways.heic` says so with an `irot` property, `exif-sideways.heic`
 * with an Exif orientation only.
 */
const HEIC_FIXTURES = ['sideways.heic', 'exif-sideways.heic'];

/**
 * @param {string} name
 * @returns {Buffer}
 */
function heicFixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * @param {string} path
 * @returns {Promise<{ width: number, height: number, at: (x: number, y: number) => number[] }>}
 */
async function pixelsOf(path) {
  const { data, info } = await sharp(path).raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x, y) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)),
  };
}

/**
 * @param {number[]} pixel
 * @param {'red' | 'blue'} colour
 */
function assertColour(pixel, colour) {
  const [red = 0, green = 0, blue = 0] = pixel;
  if (colour === 'red') assert.ok(red > 200 && green < 60 && blue < 60, `red expected, got ${pixel}`);
  else assert.ok(blue > 130 && red < 110 && green < 140, `blue expected, got ${pixel}`);
}

test('isHeic judges by the brand in the file, not by its name', () => {
  for (const name of HEIC_FIXTURES) assert.equal(isHeic(heicFixture(name)), true, name);
  const box = (/** @type {string} */ major, /** @type {string[]} */ compatible) => {
    const body = Buffer.concat([Buffer.from(major), Buffer.alloc(4), ...compatible.map((brand) => Buffer.from(brand))]);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write('ftyp', 4);
    return Buffer.concat([head, body]);
  };
  assert.equal(isHeic(box('heix', [])), true);
  assert.equal(isHeic(box('mif1', ['miaf', 'heic'])), true);
  assert.equal(isHeic(box('mif1', ['miaf', 'avif'])), false, 'a generic HEIF file without HEVC may be AVIF');
  assert.equal(isHeic(box('avif', ['mif1'])), false);
  assert.equal(isHeic(TINY_JPEG), false);
  assert.equal(isHeic(TINY_PNG), false);
  assert.equal(isHeic(Buffer.alloc(0)), false);
  assert.equal(isHeic(Buffer.from('ftyp')), false);
});

test('orientPixels turns pixels like each of the eight Exif orientations', () => {
  // A 3 by 2 picture, one byte per pixel: 1 2 3 / 4 5 6.
  const data = Buffer.from([1, 2, 3, 4, 5, 6]);
  /** @type {Record<number, [number, number, number[]]>} */
  const expected = {
    1: [3, 2, [1, 2, 3, 4, 5, 6]],
    2: [3, 2, [3, 2, 1, 6, 5, 4]],
    3: [3, 2, [6, 5, 4, 3, 2, 1]],
    4: [3, 2, [4, 5, 6, 1, 2, 3]],
    5: [2, 3, [1, 4, 2, 5, 3, 6]],
    6: [2, 3, [4, 1, 5, 2, 6, 3]],
    7: [2, 3, [6, 3, 5, 2, 4, 1]],
    8: [2, 3, [3, 6, 2, 5, 1, 4]],
  };
  for (const [orientation, [width, height, pixels]] of Object.entries(expected)) {
    const turned = orientPixels(data, 3, 2, 1, Number(orientation));
    assert.deepEqual([turned.width, turned.height, Array.from(turned.data)], [width, height, pixels], `orientation ${orientation}`);
  }
});

for (const fixture of HEIC_FIXTURES) {
  test(`a HEIC photo (${fixture}) is published as upright WebP and JPEG files without metadata`, async () => {
    await inTemp(async (root) => {
      addFiles(root, { 'IMG_0042.HEIC': heicFixture(fixture) });
      const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
      const image = await pipeline.process(join(root, 'IMG_0042.HEIC'));
      assert.deepEqual([image.width, image.height], [48, 64]);
      assert.equal(image.name, 'img-0042');
      assert.deepEqual(
        image.variants.map((variant) => [variant.file, variant.width, variant.height]),
        [['img-0042-48.webp', 48, 64]],
      );
      assert.deepEqual([image.viewer.file, image.viewer.width, image.viewer.height], ['img-0042-full.jpg', 48, 64]);

      for (const file of [...image.variants, image.viewer]) {
        const path = join(image.dir, file.file);
        const metadata = await sharp(path).metadata();
        assert.equal(metadata.format, file.file.endsWith('.webp') ? 'webp' : 'jpeg');
        assert.equal(metadata.exif, undefined, `${file.file} carries no EXIF data`);
        assert.equal(metadata.hasAlpha, false, `${file.file} has no empty alpha channel`);
        const pixels = await pixelsOf(path);
        assert.deepEqual([pixels.width, pixels.height], [48, 64], file.file);
        assertColour(pixels.at(47, 0), 'red');
        assertColour(pixels.at(0, 0), 'blue');
        assertColour(pixels.at(0, 63), 'blue');
        assertColour(pixels.at(47, 63), 'blue');
      }

      // The second run finds the files in the cache.
      const again = await createImagePipeline({ cacheDir: join(root, 'cache') }).process(join(root, 'IMG_0042.HEIC'));
      assert.equal(again.cached, true);
      assert.equal(again.key, image.key);
    });
  });
}

test('a HEIC photo in a post is published at several sizes, never as the original', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const html = pageHtml(result, '/journal/phone/');
      const [tag] = imgTags(html);
      assert.match(attribute(/** @type {string} */ (tag), 'src') ?? '', /^\/img\/[0-9a-f]{16}\/camera-roll-48\.webp$/);
      assert.equal(attribute(/** @type {string} */ (tag), 'width'), '48');
      assert.equal(attribute(/** @type {string} */ (tag), 'height'), '64');
      const entry = result.manifest.images.find((image) => image.source.endsWith('phone/Camera Roll.HEIC'));
      assert.ok(entry);
      assert.deepEqual([entry.width, entry.height], [48, 64]);
      assert.deepEqual(entry.outputs.map((output) => output.type), ['image/webp', 'image/jpeg']);
      const published = listFiles(result.outDir);
      assert.ok(published.some((name) => name.endsWith('/camera-roll-48.webp')));
      assert.ok(published.some((name) => name.endsWith('/camera-roll-full.jpg')));
      assert.ok(!published.some((name) => /\.hei[cf]$/i.test(name)), 'the original is not published');
    },
    {
      'content/journal/phone/index.md': '---\ntitle: Phone\ndate: 2025-05-02\n---\n\nText.\n\n![A sideways photo.](<Camera Roll.HEIC>)\n',
      'content/journal/phone/Camera Roll.HEIC': heicFixture('sideways.heic'),
    },
  );
});

test('a HEIC cover is processed like any other cover', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      assert.deepEqual(result.warnings.filter((warning) => warning.includes('cover')), []);
      const entry = result.manifest.images.find((image) => image.use === 'cover' && image.source.endsWith('cover.heic'));
      assert.ok(entry);
      assert.equal(entry.outputs[0]?.type, 'image/webp');
    },
    {
      'content/journal/covered/index.md': '---\ntitle: Covered\ndate: 2025-05-02\ncover: cover.heic\n---\n\nText.\n',
      'content/journal/covered/cover.heic': heicFixture('sideways.heic'),
    },
  );
});

test('a HEIC file that cannot be decoded is an ImageError that names the file and says what to do', async () => {
  await inTemp(async (root) => {
    const good = heicFixture('sideways.heic');
    addFiles(root, {
      'truncated.heic': good.subarray(0, 120),
      'scrambled.heic': Buffer.concat([good.subarray(0, 40), Buffer.alloc(good.length - 40, 0x5a)]),
      'only-header.heic': Buffer.concat([good.subarray(0, 24), Buffer.alloc(40)]),
      'not-a-picture.heic': 'this is not a picture',
      'renamed.jpg': good.subarray(0, 120),
    });
    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
    for (const name of ['truncated.heic', 'scrambled.heic', 'only-header.heic', 'not-a-picture.heic', 'renamed.jpg']) {
      await assert.rejects(
        pipeline.process(join(root, name)),
        (error) =>
          error instanceof ImageError &&
          error.message.includes(`"${name}"`) &&
          /cannot decode the HEIC image/.test(error.message) &&
          /convert the file to JPEG or PNG/.test(error.message),
        name,
      );
    }
    assert.deepEqual(pipeline.stats, { generated: 0, reused: 0 });
    assert.deepEqual(existsSync(join(root, 'cache')) ? readdirSync(join(root, 'cache')) : [], [], 'nothing is left in the cache');
  });
});

test('a corrupt HEIC image fails the build and names the file', async () => {
  await withExampleCopy(
    async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1);
      assert.match(
        errors[0] ?? '',
        /^content\/journal\/bad-heic\/index\.md:8:1 image 'IMG_1\.heic': cannot decode the HEIC image "IMG_1\.heic": .+; convert the file to JPEG or PNG/,
      );
    },
    {
      'content/journal/bad-heic/index.md': '---\ntitle: Bad\ndate: 2025-05-02\n---\n\nText.\n\n![Broken](IMG_1.heic)\n',
      'content/journal/bad-heic/IMG_1.heic': heicFixture('sideways.heic').subarray(0, 200),
    },
  );
});
