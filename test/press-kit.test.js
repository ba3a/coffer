import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';

import { buildSites } from '../src/build.js';
import { checkOutput } from '../src/check/index.js';
import { loadConfig } from '../src/config.js';
import { parseProjectSource } from '../src/content/projects.js';
import { createImagePipeline } from '../src/images/pipeline.js';
import { inspectSvg } from '../src/images/svg.js';
import { PHOTO_POSITION, geotaggedPhoto, solidImage, TINY_PNG } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * @param {string} lang
 * @param {string} [extra] More lines of the site's configuration, indented by four spaces.
 */
function configOf(lang = 'en', extra = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    `    lang: ${lang}`,
    '    title: Demo',
    '    description: A demo site.',
    '    blogs:',
    '      - { id: journal, dir: content/journal, prefix: journal, title: Journal }',
    '    projects: { dir: content/projects }',
    ...(extra === '' ? [] : [extra]),
    '',
  ].join('\n');
}

const HOME = '---\ntitle: Demo\n---\n\nAbout the demo.\n';
const POST = '---\ntitle: A post\ndate: 2026-01-10\n---\n\nText.\n';
const MINIMAL = 'name: Tumble\npitch: Falling joints.\nkind: game\nstatus: in-development\ncard: card.png\n';

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60" fill="#c33"/></svg>\n';

/**
 * A PNG with a fully transparent left half and an opaque red right half.
 *
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Buffer>}
 */
function halfTransparentPng(width, height) {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = width / 2; x < width; x += 1) {
      const at = (y * width + x) * 4;
      raw[at] = 255;
      raw[at + 3] = 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

/**
 * The files of one game.
 *
 * @param {string} yaml The text of project.yaml.
 * @param {Record<string, string | Buffer>} [extra] More files of the project folder, by name.
 * @param {string} [page] The text of index.md.
 * @returns {Record<string, string | Buffer>}
 */
function game(yaml, extra = {}, page = 'The page text.\n') {
  return {
    'content/projects/tumble/project.yaml': yaml,
    'content/projects/tumble/index.md': page,
    'content/projects/tumble/card.png': TINY_PNG,
    ...Object.fromEntries(Object.entries(extra).map(([name, content]) => [`content/projects/tumble/${name}`, content])),
  };
}

/**
 * Writes a site into a temporary directory, runs `body` with its root and removes it.
 *
 * @param {Record<string, string | Buffer>} files
 * @param {(root: string) => Promise<void>} body
 * @param {string} [config] The text of coffer.yaml.
 */
async function inSite(files, body, config = configOf()) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-press-'));
  try {
    const all = { 'coffer.yaml': config, 'content/home.md': HOME, 'content/journal/first/index.md': POST, ...files };
    for (const [name, content] of Object.entries(all)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 */
function build(root) {
  return buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function buildErrors(root) {
  try {
    await build(root);
  } catch (error) {
    assert.ok(error instanceof Error && 'errors' in error, `expected a build error, got ${error}`);
    return /** @type {string[]} */ (error.errors);
  }
  return assert.fail('the build should have failed');
}

/**
 * @param {string} root
 * @param {string} url
 * @returns {string}
 */
function pageHtml(root, url) {
  return readFileSync(join(root, 'out', 'demo', ...url.split('/').filter(Boolean), 'index.html'), 'utf8');
}

/**
 * @param {string} root
 * @param {string} address Site-relative address of a published file.
 * @returns {string}
 */
function publishedPath(root, address) {
  return join(root, 'out', 'demo', ...address.split('/').filter(Boolean));
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function checkFailures(root) {
  const result = await checkOutput(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out') });
  return result.failures.map((failure) => `${failure.file}: ${failure.message}`);
}

/**
 * What a published picture says about its position, read the way a stranger would.
 *
 * @param {Buffer} bytes
 * @returns {Promise<Record<string, any> | undefined>}
 */
async function exifOf(bytes) {
  return exifr.parse(bytes, { gps: true, mergeOutput: true, translateKeys: true, translateValues: false, reviveValues: false });
}

/**
 * The page's press kit section.
 *
 * @param {string} html
 * @returns {string}
 */
function sectionOf(html) {
  return /<section class="press-kit"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
}

// ---------------------------------------------------------------------------
// The pipeline: full-resolution downloads.

/**
 * @param {(dir: string) => Promise<void>} body
 */
async function inTemp(body) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-download-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a download has the pixel size of the upright original, even when that is more than the viewer image has', async () => {
  await inTemp(async (dir) => {
    // 3600 by 2400 stored sideways: shown upright it is 2400 by 3600, wider than nothing and taller than the viewer's 3200 limit.
    const original = join(dir, 'big.jpg');
    writeFileSync(original, await geotaggedPhoto({ width: 3600, height: 2400, orientation: 6 }));
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });
    const download = await pipeline.download(original, { location: 'strip', camera: 'strip' });
    assert.deepEqual([download.width, download.height], [2400, 3600]);
    assert.equal(download.format, 'jpeg');
    assert.equal(download.extension, '.jpg');
    const metadata = await sharp(download.path).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [2400, 3600, 'jpeg']);
    assert.equal(metadata.orientation ?? 1, 1, 'the picture is upright, so it needs no orientation tag');

    const processed = await pipeline.process(original, { location: 'strip', camera: 'strip' });
    assert.equal(Math.max(processed.viewer.width, processed.viewer.height), 3200, 'the viewer image is capped');
  });
});

test('under strip a download has no position and no camera; under keep it has both; under coarse the position is rounded', async () => {
  await inTemp(async (dir) => {
    const original = join(dir, 'photo.jpg');
    writeFileSync(original, await geotaggedPhoto({ width: 800, height: 600 }));
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });

    const stripped = readFileSync((await pipeline.download(original, { location: 'strip', camera: 'strip' })).path);
    const none = await exifOf(stripped);
    assert.equal(none?.latitude, undefined);
    assert.equal(none?.longitude, undefined);
    assert.equal(none?.Make, undefined);
    assert.equal(none?.BodySerialNumber, undefined);
    assert.equal(none?.DateTimeOriginal, undefined);

    const kept = await pipeline.download(original, { location: 'keep', camera: 'keep' });
    const exact = await exifOf(readFileSync(kept.path));
    assert.ok(Math.abs(exact?.latitude - PHOTO_POSITION.latitude) < 1e-6);
    assert.ok(Math.abs(exact?.longitude - PHOTO_POSITION.longitude) < 1e-6);
    assert.equal(exact?.Make, 'Examplecam');
    assert.equal(exact?.BodySerialNumber, undefined, 'a serial number is never copied');
    assert.equal(kept.gps?.precision, 'exact');

    const coarse = await pipeline.download(original, { location: 'coarse', camera: 'strip' });
    const rounded = await exifOf(readFileSync(coarse.path));
    assert.ok(Math.abs(rounded?.latitude - Math.round(PHOTO_POSITION.latitude * 100) / 100) < 1e-6);
    assert.equal(rounded?.Make, undefined);
    assert.equal(coarse.gps?.precision, 'coarse');
    assert.notEqual(kept.path, coarse.path);
  });
});

test('a PNG stays a PNG with its transparency, and is not resized', async () => {
  await inTemp(async (dir) => {
    const original = join(dir, 'logo.png');
    writeFileSync(original, await halfTransparentPng(4000, 40));
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });
    const download = await pipeline.download(original, {});
    assert.equal(download.format, 'png');
    assert.equal(download.extension, '.png');
    assert.equal(download.mime, 'image/png');
    const { data, info } = await sharp(download.path).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [4000, 40, 4]);
    assert.equal(data[3], 0, 'the left pixel is still transparent');
    assert.equal(data[(2000 * 4) + 3], 255, 'the right pixel is still opaque');
    assert.deepEqual([...data.subarray(2000 * 4, 2000 * 4 + 3)], [255, 0, 0]);
  });
});

test('a PNG keeps its position only when the policy says so', async () => {
  await inTemp(async (dir) => {
    const original = join(dir, 'shot.png');
    writeFileSync(
      original,
      await sharp(await solidImage(64, 48, 'png'))
        .png()
        .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '47/1 0/1 44444/1000', GPSLongitudeRef: 'E', GPSLongitude: '11/1 2/1 44199/1000' } })
        .toBuffer(),
    );
    assert.ok(Math.abs(((await exifOf(readFileSync(original)))?.latitude ?? 0) - PHOTO_POSITION.latitude) < 1e-6, 'the original has a position');
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });
    const stripped = await pipeline.download(original, { location: 'strip' });
    assert.equal((await exifOf(readFileSync(stripped.path)))?.latitude, undefined);
    assert.equal(stripped.format, 'png');
    const kept = await pipeline.download(original, { location: 'keep' });
    assert.ok(Math.abs(((await exifOf(readFileSync(kept.path)))?.latitude ?? 0) - PHOTO_POSITION.latitude) < 1e-6);
  });
});

test('a WebP with transparency becomes a PNG and one without becomes a JPEG; other originals become JPEGs', async () => {
  await inTemp(async (dir) => {
    const translucent = join(dir, 'a.webp');
    writeFileSync(translucent, await sharp(await halfTransparentPng(40, 20)).webp({ lossless: true }).toBuffer());
    const opaque = join(dir, 'b.webp');
    writeFileSync(opaque, await solidImage(40, 20, 'webp'));
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });
    const withAlpha = await pipeline.download(translucent, {});
    const without = await pipeline.download(opaque, {});
    assert.deepEqual([withAlpha.format, without.format], ['png', 'jpeg']);
    assert.equal((await sharp(withAlpha.path).metadata()).hasAlpha, true);
    assert.deepEqual([without.width, without.height], [40, 20]);
  });
});

test('a download is made once: the cache serves the next run, and a different policy is a different file', async () => {
  await inTemp(async (dir) => {
    const original = join(dir, 'photo.jpg');
    writeFileSync(original, await geotaggedPhoto({ width: 300, height: 200 }));
    const cacheDir = join(dir, 'cache');
    const first = createImagePipeline({ cacheDir });
    const made = await first.download(original, { location: 'keep' });
    assert.equal(made.cached, false);
    assert.equal(first.stats.generated, 1);
    const second = createImagePipeline({ cacheDir });
    const found = await second.download(original, { location: 'keep' });
    assert.equal(found.cached, true);
    assert.equal(found.path, made.path);
    assert.deepEqual(found.gps, made.gps);
    assert.notEqual((await second.download(original, { location: 'strip' })).path, made.path);
  });
});

test('a download that is not an image is an error that says so', async () => {
  await inTemp(async (dir) => {
    const original = join(dir, 'broken.png');
    writeFileSync(original, 'not an image');
    const pipeline = createImagePipeline({ cacheDir: join(dir, 'cache') });
    await assert.rejects(pipeline.download(original, {}), /cannot read the image/);
    await assert.rejects(pipeline.download(join(dir, 'x.gif'), {}), /unsupported image format/);
    await assert.rejects(async () => pipeline.download(original, { location: /** @type {any} */ ('everything') }), /location must be one of/);
  });
});

// ---------------------------------------------------------------------------
// SVG logos.

test('an ordinary SVG is accepted and its size is read from width and height, or from the viewBox', () => {
  assert.deepEqual(inspectSvg(LOGO_SVG), { problems: [], width: 120, height: 60 });
  assert.deepEqual(
    inspectSvg('<?xml version="1.0"?>\n<!-- a comment -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="64px" height="32"><path d="M0 0"/></svg>'),
    { problems: [], width: 64, height: 32 },
  );
  assert.deepEqual(inspectSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 10 5"/>'), { problems: [], width: 10, height: 5 });
  assert.deepEqual(inspectSvg('<svg xmlns="http://www.w3.org/2000/svg" width="200" viewBox="0 0 10 5"/>'), { problems: [], width: 200, height: 100 });
  assert.deepEqual(inspectSvg('<svg xmlns="http://www.w3.org/2000/svg"/>'), { problems: [], width: null, height: null });
});

test('an SVG that could run script is refused, however the script is spelled', () => {
  const bad = [
    ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT src="x.js"/></svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', /event handler/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" onclick = "x()"/></svg>', /event handler/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>', /javascript:/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="&#106;avascript:alert(1)"><rect/></a></svg>', /javascript:/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a href="java\tscript:alert(1)"><rect/></a></svg>', /javascript:/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6A;&#x61;vascript&colon;alert(1)"><rect/></a></svg>', /javascript:/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,<b>x</b>"><rect/></a></svg>', /data:text\/html/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>', /foreignObject/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/></svg>', /iframe/],
    ['<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>', /entities/],
    ['<html><body>not an svg</body></html>', /first element must be <svg>/],
    ['', /first element must be <svg>/],
    // A namespace prefix, other cases and other spellings of the same elements.
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="http://www.w3.org/2000/svg"><a:script>alert(1)</a:script></svg>', /<script>/],
    ['<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg:svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:ScRiPt/></svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:foreignobject><div/></x:foreignobject></svg>', /foreignObject/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xhtml"><x:IFRAME src="x"/></svg>', /iframe/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xhtml"><x:embed src="x"/></svg>', /embed/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xhtml"><x:object data="x"/></svg>', /object/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT/></svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><ScRiPt\n>alert(1)</ScRiPt></svg>', /<script>/],
    ['<svg xmlns="http://www.w3.org/2000/svg"/OnLoad=alert(1)></svg>', /event handler/],
    ['<svg/onload=alert(1)></svg>', /event handler/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><rect title="a > b" ONCLICK="x()"/></svg>', /event handler/],
    // Other vectors.
    ['<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E#a"/></svg>', /data: address in an href/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="&#100;ata:image/svg+xml,x"/></svg>', /data: address in an href/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="#x"/></a></svg>', /animation of an href/],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a><s:animate xmlns:s="http://www.w3.org/2000/svg" attributeName="xlink:href" values="a;b"/></a></svg>', /animation of an href/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>', /javascript:/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://example.com/x.css);</style></svg>', /stylesheet from elsewhere/],
    ['<svg xmlns="http://www.w3.org/2000/svg"><style>@IMPORT "x.css";</style></svg>', /stylesheet from elsewhere/],
    ['<?xml-stylesheet href="x.xsl" type="text/xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>', /stylesheet from elsewhere/],
  ];
  for (const [text, pattern] of /** @type {[string, RegExp][]} */ (bad)) {
    const { problems } = inspectSvg(text);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${JSON.stringify(text)}: ${problems.join(' | ') || 'accepted'}`);
  }
  assert.ok(inspectSvg(Buffer.alloc(3 * 1024 * 1024, 'a')).problems[0]?.includes('at most'));
});

test('an SVG with text that only looks like script is accepted', () => {
  const fine = [
    '<svg xmlns="http://www.w3.org/2000/svg"><title>one = two</title><desc>once = twice, onload = never</desc><rect width="1" height="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text>if (a > b) once = 1</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- a script is not here --><rect fill="url(#a)" data-once="x = y"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image href="data:image/png;base64,AAAA" width="1" height="1"/><use xlink:href="#a"/><set attributeName="opacity" to="0"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.a { fill: red }</style><defs><linearGradient id="a"/></defs></svg>',
  ];
  for (const text of fine) {
    assert.deepEqual(inspectSvg(text).problems, [], text);
  }
});

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

test('script that hides behind a fake tag in a comment, an instruction or a CDATA section is still refused', () => {
  const hidden = ['<!-- < b " -->', "<!-- < b ' -->", '<? < b " ?>', '<![CDATA[ < b " ]]>'];
  /** @type {[string, RegExp][]} */
  const bad = [];
  for (const fake of hidden) {
    const tail = fake.startsWith('<![CDATA[') ? '' : '<text>"</text>';
    // The fake tag is inside the root for the instruction and CDATA; a CDATA section cannot come before the root.
    const before = fake.startsWith('<![CDATA[') ? '' : fake;
    const inside = fake.startsWith('<![CDATA[') ? fake : '';
    bad.push(
      [`${before}<svg ${SVG_NS} onload="document.title='PWNED'" viewBox="0 0 10 10">${inside}${tail}</svg>`, /event handler/],
      [`<svg ${SVG_NS} viewBox="0 0 10 10">${fake}<svg onload="document.title='PWNED'"/>${tail}</svg>`, /event handler/],
      [`<svg ${SVG_NS} viewBox="0 0 10 10">${fake}<rect width="10" height="10" onclick="alert(1)"/>${tail}</svg>`, /event handler/],
      [`<svg ${SVG_NS} viewBox="0 0 10 10">${fake}<a><set attributeName="href" to="#x"/></a>${tail}</svg>`, /animation of an href/],
      [`<svg ${SVG_NS} viewBox="0 0 10 10">${fake}<use href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E#a"/>${tail}</svg>`, /data: address in an href/],
    );
  }
  for (const [text, pattern] of bad) {
    const { problems } = inspectSvg(text);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${text}: ${problems.join(' | ') || 'accepted'}`);
  }
  // A script inside CDATA, a comment or a processing instruction is found by the checks over the whole text.
  for (const text of [
    `<svg ${SVG_NS}><style><![CDATA[ </style><script>alert(1)</script> ]]></style></svg>`,
    `<svg ${SVG_NS}><!-- <script>alert(1)</script> --></svg>`,
    `<svg ${SVG_NS}><?x <script>alert(1)</script> ?></svg>`,
    `<svg ${SVG_NS}><![CDATA[ <a href="javascript:alert(1)"> ]]></svg>`,
  ]) {
    assert.ok(inspectSvg(text).problems.length > 0, text);
  }
});

test('an SVG that a browser would read differently through a declared encoding is refused', () => {
  const ESC_B = '\u001b(B';
  /** @param {string} encoding @param {string} body */
  const declared = (encoding, body) => Buffer.from(`<?xml version="1.0" encoding="${encoding}"?>\n<svg ${SVG_NS} viewBox="0 0 10 10">${body}</svg>`, 'latin1');
  const comment = `<!-- x -${ESC_B}-> <rect width="10" height="10" onclick="parent.pm(1)"/> -->`;
  const attributeName = `<rect width="10" height="10" on${ESC_B}click="parent.pm(2)"/>`;
  const elementName = `<scr${ESC_B}ipt>parent.pm(3)</scr${ESC_B}ipt>`;
  /** @type {[string, Buffer][]} */
  const bad = [
    ['iso-2022-jp comment', declared('iso-2022-jp', comment)],
    ['ISO-2022-JP comment', declared('ISO-2022-JP', comment)],
    ['csISO2022JP comment', declared('csISO2022JP', comment)],
    ['iso-2022-jp attribute name', declared('iso-2022-jp', attributeName)],
    ['iso-2022-jp element name', declared('iso-2022-jp', elementName)],
    // The escape sequence alone is enough, whatever the declaration says (or when there is none).
    ['ESC under a UTF-8 declaration', declared('UTF-8', comment)],
    ['ESC without a declaration', Buffer.from(`<svg ${SVG_NS}>${attributeName}</svg>`, 'latin1')],
    ['SO and SI', Buffer.from(`<svg ${SVG_NS}><!-- \u000e\u000f --></svg>`, 'latin1')],
    ['NUL', Buffer.from(`<svg ${SVG_NS}>\u0000</svg>`, 'latin1')],
    ['vertical tab', Buffer.from(`<svg ${SVG_NS}>\u000b</svg>`, 'latin1')],
    ['U+FFFE', Buffer.from(`<svg ${SVG_NS}>￾</svg>`, 'utf8')],
    ['U+FFFF', Buffer.from(`<svg ${SVG_NS}>￿</svg>`, 'utf8')],
  ];
  for (const [name, bytes] of bad) {
    const { problems } = inspectSvg(bytes);
    assert.ok(problems.length > 0, `${name}: accepted`);
    assert.ok(problems.some((problem) => /control character/.test(problem) || /not a text file/.test(problem)), `${name}: ${problems.join(' | ')}`);
  }
  // A string with an unpaired surrogate (a Buffer cannot carry one) is refused too.
  assert.ok(inspectSvg(`<svg ${SVG_NS}>\ud800</svg>`).problems.some((problem) => /control character/.test(problem)));

  // Any encoding but UTF-8 is refused, even with clean content, because the check reads UTF-8.
  const encodings = ['shift_jis', 'euc-jp', 'utf-16', 'UTF-16LE', 'utf-7', 'windows-1252', 'us-ascii', 'x-user-defined', 'iso-8859-1', 'latin1', 'no-such-encoding', '', 'utf-8x', ' utf-8', 'utf-8 '];
  for (const encoding of encodings) {
    const { problems } = inspectSvg(declared(encoding, '<rect width="1" height="1"/>'));
    assert.ok(problems.some((problem) => /encoding other than UTF-8/.test(problem)), `${JSON.stringify(encoding)}: ${problems.join(' | ') || 'accepted'}`);
  }
  for (const text of [
    `<?xml version="1.0" encoding='shift_jis'?><svg ${SVG_NS}/>`,
    `<?xml version="1.0" ENCODING="shift_jis"?><svg ${SVG_NS}/>`,
    `<?xml\tversion="1.0"\nencoding\n=\n"euc-jp"?><svg ${SVG_NS}/>`,
    `<?xml version="1.0" encoding=euc-jp?><svg ${SVG_NS}/>`,
    // A decoy that looks like UTF-8 must not stand in for the real encoding.
    `<?xml version="1.0" standalone=' encoding="utf-8" ' encoding="iso-2022-jp"?><svg ${SVG_NS}/>`,
    // The declaration after a byte order mark counts.
    `﻿<?xml version="1.0" encoding="shift_jis"?><svg ${SVG_NS}/>`,
  ]) {
    assert.ok(inspectSvg(text).problems.some((problem) => /encoding other than UTF-8/.test(problem)), text);
  }
  // An XML declaration anywhere but the very start is refused (a browser would ignore it, a reader of the file might not).
  for (const text of [
    ` <?xml version="1.0" encoding="iso-2022-jp"?><svg ${SVG_NS}/>`,
    `<!-- a --><?xml version="1.0" encoding="iso-2022-jp"?><svg ${SVG_NS}/>`,
    `<svg ${SVG_NS}><?XML version="1.0" encoding="iso-2022-jp"?></svg>`,
    `<?xml version="1.0"?><?xml version="1.0" encoding="iso-2022-jp"?><svg ${SVG_NS}/>`,
  ]) {
    assert.ok(inspectSvg(text).problems.some((problem) => /"xml" declaration that is not at the very start/.test(problem)), text);
  }
});

test('ordinary SVGs with tabs, line breaks, a byte order mark, non-ASCII text and UTF-8 declarations are still accepted', () => {
  const body = `<svg ${SVG_NS} viewBox="0 0 4 4">\n\t<title>Tumble ü 日本語 \u{1F600}</title>\r\n\t<rect width="1" height="1"/>\r\n</svg>\n`;
  /** @type {(string | Buffer)[]} */
  const fine = [
    body,
    Buffer.from(body, 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]),
    Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, 'utf8'),
    Buffer.from(`<?xml version='1.0' encoding='utf-8'?>\n${body}`, 'utf8'),
    Buffer.from(`<?xml version="1.0" encoding="utf8" standalone="no"?>\r\n${body}`, 'utf8'),
    Buffer.from(`<?xml\tversion="1.0"\tencoding = "UTF-8"?>${body}`, 'utf8'),
    Buffer.from(`<?xml version="1.0"?>\n${body}`, 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, 'utf8')]),
    // Processing instructions that merely start with "xml" are not a declaration.
    Buffer.from(`<?xmlnote keep?><svg ${SVG_NS} viewBox="0 0 4 4"/>`, 'utf8'),
  ];
  for (const content of fine) {
    assert.deepEqual(inspectSvg(content).problems, [], JSON.stringify(content.toString().slice(0, 60)));
  }
});

test('an SVG that animates an event handler attribute is refused', () => {
  const bad = [
    `<svg ${SVG_NS}><rect id="r" width="1" height="1"/><set attributeName="onclick" to="parent.pm(1)"/></svg>`,
    `<svg ${SVG_NS}><rect width="1" height="1"><animate attributeName='onmouseover' values="a;b"/></rect></svg>`,
    `<svg ${SVG_NS}><rect width="1" height="1"><animate attributeName=onload to="x"/></rect></svg>`,
    `<svg ${SVG_NS}><rect width="1" height="1"><SET ATTRIBUTENAME = "OnClick" to="x"/></rect></svg>`,
    `<svg ${SVG_NS} xmlns:s="http://www.w3.org/2000/svg"><rect width="1" height="1"><s:set attributeName="onclick" to="x"/></rect></svg>`,
    `<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="1" height="1"><set attributeName="xlink:onclick" to="x"/></rect></svg>`,
  ];
  for (const text of bad) {
    assert.ok(inspectSvg(text).problems.some((problem) => /animation of an event handler/.test(problem)), text);
  }
  assert.deepEqual(inspectSvg(`<svg ${SVG_NS}><rect width="1" height="1"><animate attributeName="opacity" values="0;1"/><set attributeName="offset" to="1"/></rect></svg>`).problems, []);
});

test('a script address spelled with zero-padded character references is refused', () => {
  const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
  const zeros = '0'.repeat(300);
  /** @type {[string, RegExp][]} */
  const bad = [
    [`<svg ${SVG_NS} ${XLINK}><a xlink:href="&#x000006A;avascript:parent.pm(1)"><rect width="9" height="9"/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="&#x000006A;avascript:parent.pm(1)"><rect width="9" height="9"/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS} ${XLINK}><a xlink:href="&#00000106;avascript:parent.pm(1)"><rect width="9" height="9"/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS} ${XLINK}><a xlink:href="&#0000106;&#00000097;vascript:parent.pm(1)"><rect width="9" height="9"/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="&#x${zeros}6A;avascript:x"><rect/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="&#${zeros}106;avascript:x"><rect/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="&#X${zeros}6A;avascript:x"><rect/></a></svg>`, /upper-case X/],
    [`<svg ${SVG_NS}><a href="javascript&#x0000003A;x"><rect/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="javascript&#00000058;x"><rect/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href="vbscript&#x000003a;x"><rect/></a></svg>`, /vbscript:/],
    [`<svg ${SVG_NS}><a target="_self" href="&#x0000064;ata:text/html,&lt;script&gt;1&lt;/script&gt;"><rect/></a></svg>`, /data:text\/html/],
    [`<svg ${SVG_NS}><use href="&#x00000064;ata:image/svg+xml,x"/></svg>`, /data: address in an href/],
    [`<svg ${SVG_NS}><style>&#x0000040;import "x.css";</style></svg>`, /stylesheet from elsewhere/],
    [`<svg ${SVG_NS}><style>&#0000064;import "x.css";</style></svg>`, /stylesheet from elsewhere/],
    [`<svg ${SVG_NS}><a><set attributeName="h&#x0000072;ef" to="#x"/></a></svg>`, /animation of an href/],
    [`<svg ${SVG_NS}><rect width="1" height="1"><set attributeName="&#x000006F;nclick" to="x"/></rect></svg>`, /animation of an event handler/],
  ];
  for (const [text, pattern] of bad) {
    const { problems } = inspectSvg(text);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${text.slice(0, 120)}: ${problems.join(' | ') || 'accepted'}`);
  }
});

test('only the character references that XML knows are accepted, and the others are refused with a message', () => {
  /** @type {[string, RegExp][]} */
  const bad = [
    // Above U+10FFFF, however many digits it has; zero; a forbidden character.
    [`<svg ${SVG_NS}><title>&#x110000;</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title>&#99999999999;</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title>&#x${'0'.repeat(50)}110000;</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title>&#x1${'0'.repeat(50)};</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title>&#0;</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title title="&#x1B;">a</title></svg>`, /character that XML does not allow/],
    [`<svg ${SVG_NS}><title>&#xD800;</title></svg>`, /character that XML does not allow/],
    // Upper-case X is an error in XML, so it is refused instead of decoded.
    [`<svg ${SVG_NS}><title>&#X6A;</title></svg>`, /upper-case X/],
    [`<svg ${SVG_NS}><a href="&#X6A;avascript:x"><rect/></a></svg>`, /upper-case X/],
    // No closing semicolon.
    [`<svg ${SVG_NS}><a href="&#106avascript:x"><rect/></a></svg>`, /is not a reference that XML knows/],
    [`<svg ${SVG_NS}><a href="&#x6Aavascript:x"><rect/></a></svg>`, /is not a reference that XML knows/],
    [`<svg ${SVG_NS}><title>&amp</title></svg>`, /is not a reference that XML knows/],
    [`<svg ${SVG_NS}><title>a & b</title></svg>`, /is not a reference that XML knows/],
    [`<svg ${SVG_NS}><a href=&#106;avascript:x><rect/></a></svg>`, /javascript:/],
    [`<svg ${SVG_NS}><a href=&#106avascript:x><rect/></a></svg>`, /is not a reference that XML knows/],
    // Names that only HTML defines.
    [`<svg ${SVG_NS}><a href="javascript&colon;x"><rect/></a></svg>`, /HTML name/],
    [`<svg ${SVG_NS}><a href="java&Tab;script:x"><rect/></a></svg>`, /HTML name/],
    [`<svg ${SVG_NS}><a href="java&NewLine;script:x"><rect/></a></svg>`, /HTML name/],
    [`<svg ${SVG_NS}><title>&nbsp;&lpar;</title></svg>`, /HTML name/],
    [`<svg ${SVG_NS}><title>&LT;</title></svg>`, /HTML name/],
  ];
  for (const [text, pattern] of bad) {
    const { problems } = inspectSvg(text);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${text.slice(0, 120)}: ${problems.join(' | ') || 'accepted'}`);
  }
  // The five names and well-formed numeric references (any case of the hex digits, any padding) are fine.
  const fine = [
    `<svg ${SVG_NS}><title>&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#65; &#x41; &#x0000041; &#0000065; &#xe9; &#xE9; &#x1F600; &#9; &#10;</title></svg>`,
    `<svg ${SVG_NS}><rect width="1" height="1" title="&lt;&#x26;&#38;&quot;&apos;"/></svg>`,
    `<svg ${SVG_NS}><style><![CDATA[ a && b { fill: red } ]]></style><!-- a & b --></svg>`,
  ];
  for (const text of fine) assert.deepEqual(inspectSvg(text).problems, [], text);
});

test('a very long run of zeros in a character reference is judged quickly and the same way every time', () => {
  const megabyte = 1024 * 1024;
  const zeros = '0'.repeat(megabyte);
  /** @type {Record<string, [string, boolean]>} */
  const shapes = {
    'hex zeros then 6A': [`<svg ${SVG_NS}><a href="&#x${zeros}6A;avascript:x"><rect/></a></svg>`, true],
    'decimal zeros then 106': [`<svg ${SVG_NS}><a href="&#${zeros}106;avascript:x"><rect/></a></svg>`, true],
    'zeros only (U+0000)': [`<svg ${SVG_NS}><title>&#x${zeros};</title></svg>`, true],
    'zeros in text, no semicolon': [`<svg ${SVG_NS}><title>&#${zeros}</title></svg>`, true],
    'zeros then a letter, harmless': [`<svg ${SVG_NS}><title>&#x${zeros}41;</title></svg>`, false],
    'zeros then a letter, in a comment': [`<svg ${SVG_NS}><!-- &#x${zeros}6A; --></svg>`, false],
    'many references': [`<svg ${SVG_NS}><title>${'&#x41;'.repeat(megabyte / 6)}</title></svg>`, false],
    'many unfinished references in a comment': [`<svg ${SVG_NS}><!-- ${'&#x1'.repeat(megabyte / 4)} --></svg>`, false],
    'significant digits only': [`<svg ${SVG_NS}><title>&#${'9'.repeat(megabyte)};</title></svg>`, true],
  };
  for (const [name, [text, refused]] of Object.entries(shapes)) {
    const started = performance.now();
    const { problems } = inspectSvg(text);
    const took = performance.now() - started;
    assert.ok(took < 2000, `${name}: took ${Math.round(took)} ms`);
    assert.equal(problems.length > 0, refused, `${name}: ${problems.join(' | ') || 'accepted'}`);
  }
});

test('an SVG whose markup is not well-formed is refused with a message that says why', () => {
  const malformed = [
    [`<svg ${SVG_NS}><!-- never closed </svg>`, /comment is never closed/],
    [`<svg ${SVG_NS}><!-- two -- dashes --></svg>`, /comment contains "--"/],
    [`<svg ${SVG_NS}><!-- ends with a dash ---></svg>`, /comment contains "--"/],
    [`<svg ${SVG_NS}><![CDATA[ never closed </svg>`, /CDATA section is never closed/],
    [`<svg ${SVG_NS}>text ]]> more</svg>`, /"\]\]>" outside a CDATA section/],
    [`<svg ${SVG_NS}><?pi never closed </svg>`, /processing instruction is never closed/],
    [`<!DOCTYPE svg SYSTEM `, /DOCTYPE is never closed/],
    [`<!DOCTYPE svg SYSTEM "never closed <svg ${SVG_NS}/>`, /quoted text in the DOCTYPE is never closed/],
    [`<svg ${SVG_NS}><rect width="1`, /attribute value is never closed/],
    [`<svg ${SVG_NS}><rect width='1"/></svg>`, /attribute value is never closed/],
    [`<svg ${SVG_NS}><rect width="1"`, /tag is never closed/],
    [`<svg ${SVG_NS}><rect`, /tag is never closed/],
    [`<svg ${SVG_NS}><text>a < b</text></svg>`, /does not start a tag/],
    [`<svg ${SVG_NS}><rect "x"/></svg>`, /stray "/],
    [`<svg ${SVG_NS}><rect a=b"c/></svg>`, /stray "/],
    [`<svg ${SVG_NS}><!ELEMENT x></svg>`, /"<!" is followed by something/],
    [`<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg ${SVG_NS}/>`, /entities/],
  ];
  for (const [text, pattern] of /** @type {[string, RegExp][]} */ (malformed)) {
    const { problems } = inspectSvg(text);
    assert.ok(problems.some((problem) => pattern.test(problem)), `${text}: ${problems.join(' | ') || 'accepted'}`);
  }
});

test('realistic SVGs with comments, CDATA, instructions, a simple DOCTYPE, nesting and prefixes are accepted', () => {
  const fine = [
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: an editor -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg ${SVG_NS} xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="60" viewBox="0 0 120 60">
  <title lang="en" data-note="a > b">Tumble &gt; the logo</title>
  <defs>
    <style type="text/css"><![CDATA[
      .a { fill: #c33; stroke: none }
      .b > .a { opacity: 0.5 }
      /* if (a < b && c > d) */
    ]]></style>
    <linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
  </defs>
  <!-- the body -->
  <g id="outer"><g id="inner" transform="translate(1 2)"><rect class="a" width="10" height="10" fill="url(#g)"/></g></g>
  <?editor-note keep me?>
  <text x="1" y="2">if (a &lt; b) once = 1 &amp; twice = 2</text>
  <use xlink:href="#inner"/>
</svg>
`,
    `<svg:svg xmlns:svg="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><svg:g><svg:circle r="1"/></svg:g></svg:svg>`,
    `<svg ${SVG_NS} viewBox="0 0 4 4"><!----><!-- a - b --><rect width="1" height="1" title='say "hi"'/></svg>`,
    `\uFEFF<svg ${SVG_NS} viewBox="0 0 4 4"/>`,
  ];
  for (const text of fine) {
    assert.deepEqual(inspectSvg(text).problems, [], text);
  }
  assert.deepEqual(inspectSvg(fine[0] ?? ''), { problems: [], width: 120, height: 60 });
});

test('a hostile SVG of about a megabyte is judged in well under a second, whatever its shape', () => {
  const megabyte = 1024 * 1024;
  /** @param {string} unit @returns {string} */
  const repeated = (unit) => unit.repeat(Math.ceil(megabyte / unit.length));
  const shapes = {
    'repeated "<?"': repeated('<?'),
    'repeated "<!--"': repeated('<!--'),
    'repeated "<![CDATA["': repeated('<![CDATA['),
    'repeated "<!DOCTYPE "': repeated('<!DOCTYPE '),
    'repeated "<!DOCTYPE x [ "': repeated('<!DOCTYPE x [ '),
    '"<" and a long run of "a"': `<${'a'.repeat(megabyte)}`,
    'repeated "<a:"': repeated('<a:'),
    'repeated "<a \\"\'"': repeated('<a "\''),
    'repeated "<a "': repeated('<a '),
    'repeated "<a b="': repeated('<a b='),
    'repeated "<a b=\\""': repeated('<a b="'),
    'repeated "</"': repeated('</'),
    'a run of quotes': '"'.repeat(megabyte),
    'a tag, then quotes': `<a ${'"'.repeat(megabyte)}`,
    'a tag, then blanks': `<a${' '.repeat(megabyte)}`,
    'a long width': `<svg ${SVG_NS} width="1${' '.repeat(megabyte)}x"/>`,
    'repeated "]]>"': repeated(']]>'),
    'repeated "--"': repeated('<!--  -- -->'),
    'repeated "&#"': repeated('&#x'),
    '600000 "<a>"': '<a>'.repeat(600000),
    'repeated "<svg a=b>"': `<svg ${SVG_NS}>${repeated('<g a=b onx=1 data-x="1">')}</svg>`,
    'repeated ">"': repeated('>'),
    'a declaration with a long run of blanks after "encoding"': `<?xml version="1.0" encoding${' '.repeat(megabyte)}x="a"?><svg ${SVG_NS}/>`,
    'a declaration that is never closed, with many "encoding"': `<?xml ${repeated(' encoding = ')}`,
    'repeated "<?xml "': repeated('<?xml '),
    'repeated " encoding "': `<?xml version="1.0"${repeated(' encoding ')}?><svg ${SVG_NS}/>`,
    'repeated "\\u001b"': repeated('\u001b'),
    'repeated unpaired surrogates': repeated('\ud800'),
    'repeated "<set attributeName=on"': `<svg ${SVG_NS}>${repeated('<set attributeName="on ')}`,
  };
  for (const [name, text] of Object.entries(shapes)) {
    const started = performance.now();
    const { problems } = inspectSvg(text);
    const took = performance.now() - started;
    assert.ok(took < 2000, `${name}: took ${Math.round(took)} ms`);
    assert.ok(Array.isArray(problems), name);
  }
  // The ones that cannot be drawn are refused, not just fast.
  for (const name of ['repeated "<?"', 'repeated "<!--"', 'repeated "<!DOCTYPE "', '"<" and a long run of "a"', 'repeated "<a:"', 'repeated "<a "', 'a run of quotes']) {
    assert.ok(inspectSvg(shapes[/** @type {keyof typeof shapes} */ (name)]).problems.length > 0, name);
  }
});

// ---------------------------------------------------------------------------
// The schema of `pressKit`.

/**
 * Parses a game's project.yaml in a folder that holds the given files.
 *
 * @param {string} yaml
 * @param {(project: ReturnType<typeof parseProjectSource>, errors: string[], file: string, dir: string) => void} body
 * @param {Record<string, string | Buffer>} [files]
 */
function parse(yaml, body, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-press-schema-'));
  try {
    for (const [name, content] of Object.entries({ 'card.png': TINY_PNG, ...files })) {
      const target = join(dir, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const file = join(dir, 'project.yaml');
    /** @type {string[]} */
    const errors = [];
    const project = parseProjectSource({ slug: 'tumble', dir, file, text: yaml }, errors);
    body(project, errors, file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('pressKit is a mapping: facts, descriptions and lists of picture files, all normalized', () => {
  parse(
    `${MINIMAL}pressKit:\n  developer: " Sawdust Studio "\n  releaseStatus: Early access\n  platforms: [Linux, Web]\n  price: "9.99 EUR"\n  shortDescription: One line.\n  longDescription: |\n    Many\n    lines.\n  logos:\n    - logo.png\n    - { file: logo.svg, alt: The logo }\n  screenshots:\n    - shot.jpg\n`,
    (project, errors) => {
      assert.deepEqual(errors, []);
      const kit = /** @type {any} */ (project?.fields.pressKit);
      assert.equal(kit.dir, null);
      assert.equal(kit.developer, 'Sawdust Studio');
      assert.equal(kit.releaseStatus, 'Early access');
      assert.deepEqual(kit.platforms, ['Linux', 'Web']);
      assert.equal(kit.price, '9.99 EUR');
      assert.deepEqual(kit.shortDescription, { text: 'One line.', line: 11 });
      assert.deepEqual(kit.longDescription, { text: 'Many\nlines.', line: 13 }, 'the line of the first line of the text, after the "|"');
      assert.deepEqual(kit.logos, [
        { file: 'logo.png', alt: '', kind: 'raster' },
        { file: 'logo.svg', alt: 'The logo', kind: 'svg' },
      ]);
      assert.deepEqual(kit.screenshots, [{ file: 'shot.jpg', alt: '', kind: 'raster' }]);
    },
    { 'logo.png': TINY_PNG, 'logo.svg': LOGO_SVG, 'shot.jpg': 'jpeg' },
  );
});

test('the files of a press kit can be listed relative to a folder of the project', () => {
  parse(
    `${MINIMAL}pressKit:\n  dir: press\n  logos: [logo.png]\n  screenshots: [shots/one.png]\n`,
    (project, errors) => {
      assert.deepEqual(errors, []);
      const kit = /** @type {any} */ (project?.fields.pressKit);
      assert.equal(kit.dir, 'press');
      assert.deepEqual(kit.logos.map((/** @type {any} */ asset) => asset.file), ['press/logo.png']);
      assert.deepEqual(kit.screenshots.map((/** @type {any} */ asset) => asset.file), ['press/shots/one.png']);
    },
    { 'press/logo.png': TINY_PNG, 'press/shots/one.png': TINY_PNG },
  );
});

test('the same file listed with another letter case is a duplicate', () => {
  parse(
    `${MINIMAL}pressKit:\n  logos: [logo.png, LOGO.png]\n`,
    (_project, errors) => {
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? '', /logos: item 2: "LOGO\.png" is listed twice/);
    },
    { 'logo.png': TINY_PNG, 'LOGO.png': TINY_PNG },
  );
});

test('without a pressKit, or with an empty one, the game has none', () => {
  parse(MINIMAL, (project, errors) => {
    assert.deepEqual(errors, []);
    assert.equal(project?.fields.pressKit, null);
  });
  parse(`${MINIMAL}pressKit: {}\n`, (project, errors) => {
    assert.deepEqual(errors, []);
    assert.equal(project?.fields.pressKit, null);
  });
});

test('mistakes in pressKit are all reported, each with the file, the field and what to do', () => {
  parse(
    `${MINIMAL}pressKit:\n  developer: 5\n  platforms: [A, A]\n  colour: red\n  logos:\n    - missing.png\n    - doc.txt\n    - ../outside.png\n    - /etc/passwd\n    - logo.png\n    - logo.png\n  screenshots: not-a-list\n`,
    (_project, errors, file) => {
      assert.equal(errors.length, 1);
      const message = /** @type {string} */ (errors[0]);
      assert.ok(message.startsWith(`${file}: pressKit: `), message);
      for (const part of [
        'developer: must be a non-empty string',
        'platforms: "A" is listed twice',
        'colour: unknown key (expected one of: dir, developer, releaseStatus, platforms, price, shortDescription, longDescription, logos, screenshots)',
        'logos: item 1: the file "missing.png" does not exist in the project folder',
        'logos: item 2: "doc.txt" must be a logo file',
        'logos: item 3: must be a logo file inside the project folder',
        'logos: item 4: must be a logo file inside the project folder',
        'logos: item 6: "logo.png" is listed twice',
        'screenshots: must be a list of picture files',
      ]) {
        assert.ok(message.includes(part), `${part}\n--- in ---\n${message}`);
      }
    },
    { 'logo.png': TINY_PNG, 'doc.txt': 'text' },
  );
  parse(`${MINIMAL}pressKit: press\n`, (_project, errors, file) => {
    assert.match(errors[0] ?? '', new RegExp(`^${file.replace(/[\\.]/g, '\\$&')}: pressKit: must be a mapping with some of: dir, developer`));
  });
  parse(`${MINIMAL}pressKit:\n  dir: ../elsewhere\n`, (_project, errors) => {
    assert.match(errors[0] ?? '', /pressKit: dir: must name a folder inside the project folder/);
  });
  parse(`${MINIMAL}pressKit:\n  dir: nothing\n`, (_project, errors) => {
    assert.match(errors[0] ?? '', /pressKit: dir: must name a folder inside the project folder|dir: the folder "nothing" does not exist/);
  });
  parse(`${MINIMAL}pressKit:\n  screenshots: [{ file: a.png, tilt: 3 }]\n`, (_project, errors) => {
    assert.match(errors[0] ?? '', /screenshots: item 1: unknown key "tilt" \(expected file and alt\)/);
  }, { 'a.png': TINY_PNG });
  parse(`${MINIMAL}pressKit:\n  screenshots: [a.svg]\n`, (_project, errors) => {
    assert.match(errors[0] ?? '', /screenshots: item 1: "a\.svg" must be a screenshot file: one of \.jpg/);
  }, { 'a.svg': LOGO_SVG });
});

test('an SVG logo that could run script fails the schema, naming the file and the reason', () => {
  parse(
    `${MINIMAL}pressKit:\n  logos: [evil.svg]\n`,
    (_project, errors, file) => {
      assert.equal(errors.length, 1);
      assert.ok((errors[0] ?? '').startsWith(`${file}: pressKit: logos: item 1: "evil.svg" contains a <script> element`));
    },
    { 'evil.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
  );
  parse(
    `${MINIMAL}pressKit:
  logos: [prefixed.svg]
`,
    (_project, errors, file) => {
      assert.equal(errors.length, 1);
      assert.ok((errors[0] ?? '').startsWith(`${file}: pressKit: logos: item 1: "prefixed.svg" contains a <script> element`));
    },
    { 'prefixed.svg': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="http://www.w3.org/2000/svg"><a:script>alert(1)</a:script></svg>' },
  );
  parse(
    `${MINIMAL}pressKit:
  logos: [mixed.svg]
`,
    (_project, errors) => {
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? '', /"mixed.svg" contains a <foreignObject> element/);
    },
    { 'mixed.svg': '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:ForeignObject><div/></svg:ForeignObject></svg:svg>' },
  );
});

test('a link that leads out of the project folder is not accepted as a press kit file', (context) => {
  const outside = mkdtempSync(join(tmpdir(), 'coffer-press-outside-'));
  try {
    writeFileSync(join(outside, 'secret.png'), TINY_PNG);
    const dir = mkdtempSync(join(tmpdir(), 'coffer-press-link-'));
    try {
      writeFileSync(join(dir, 'card.png'), TINY_PNG);
      try {
        symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'), 'file');
      } catch {
        context.skip('symbolic links cannot be made here');
        return;
      }
      /** @type {string[]} */
      const errors = [];
      parseProjectSource({ slug: 'tumble', dir, file: join(dir, 'project.yaml'), text: `${MINIMAL}pressKit:\n  logos: [link.png]\n` }, errors);
      assert.match(errors[0] ?? '', /logos: item 1: "link\.png" must be a file inside the project folder \(a link that leads out of it is not accepted\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The press kit on the page.

const FULL_KIT = [
  'pressKit:',
  '  developer: Sawdust Studio',
  '  releaseStatus: Early access',
  '  shortDescription: "A **short** pitch."',
  '  longDescription: |',
  '    The *long* text.',
  '',
  '    - one',
  '    - two',
  '  logos:',
  '    - { file: logo.png, alt: The logo }',
  '    - logo.svg',
  '  screenshots:',
  '    - { file: shot.jpg, alt: A screenshot }',
  '',
].join('\n');

const KIT_FILES = async () => ({
  'logo.png': await halfTransparentPng(300, 100),
  'logo.svg': LOGO_SVG,
  'shot.jpg': await geotaggedPhoto({ width: 1600, height: 900 }),
});

test('the press kit section shows the factsheet, both descriptions and every asset, from project.yaml', async () => {
  await inSite(game(`${MINIMAL}platforms: [Linux]\nprice: Free\n${FULL_KIT}`, await KIT_FILES()), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    const section = sectionOf(html);
    assert.match(section, /^<section class="press-kit" id="press-kit" aria-labelledby="press-kit-title">/);
    assert.match(section, /<h2 id="press-kit-title">Press kit<\/h2>/);
    assert.match(section, /<dt>Developer<\/dt>\s*<dd>Sawdust Studio<\/dd>/);
    assert.match(section, /<dt>Release status<\/dt>\s*<dd>Early access<\/dd>/);
    assert.match(section, /<dt>Platforms<\/dt>\s*<dd>Linux<\/dd>/);
    assert.match(section, /<dt>Price<\/dt>\s*<dd>Free<\/dd>/);
    assert.match(section, /<h3>Short description<\/h3>\s*<p>A <strong>short<\/strong> pitch\.<\/p>/);
    assert.match(section, /<h3>Description<\/h3>\s*<p>The <em>long<\/em> text\.<\/p>\s*<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
    assert.match(section, /<h3>Logos<\/h3>/);
    assert.match(section, /<h3>Screenshots<\/h3>/);
    assert.equal((section.match(/<li class="press-asset /g) ?? []).length, 3);
    // Thumbnails: responsive pictures, and the SVG itself.
    assert.match(section, /<img src="\/img\/[0-9a-f]{16}\/logo-[0-9]+\.webp" alt="The logo" width="300" height="100" loading="lazy"/);
    assert.match(section, /<img src="\/made\/tumble\/press-kit\/tumble-logo-02\.svg" alt="" width="120" height="60"/);
    // Downloads: descriptive names, the download attribute, format, size in pixels.
    assert.match(section, /<a class="press-download" href="\/made\/tumble\/press-kit\/tumble-logo-01\.png" download="tumble-logo-01\.png">Download Logo 1 \(PNG, 300 × 100 px, [0-9]+ KB\)<\/a>/);
    assert.match(section, /href="\/made\/tumble\/press-kit\/tumble-logo-02\.svg" download="tumble-logo-02\.svg">Download Logo 2 \(SVG, 120 × 60 px, 1 KB\)/);
    assert.match(section, /href="\/made\/tumble\/press-kit\/tumble-screenshot-01\.jpg" download="tumble-screenshot-01\.jpg">Download Screenshot 1 \(JPEG, 1600 × 900 px, [0-9]+ KB\)/);
    // The section closes the body of the page and sits inside the game wrapper.
    assert.ok(html.indexOf('game-details') < html.indexOf('id="press-kit"'));
    assert.equal(html.match(/id="press-kit"/g)?.length, 1);
  });
});

test('the press kit is reachable by its anchor, and a link to it passes the link check', async () => {
  await inSite(
    game(`${MINIMAL}${FULL_KIT}`, await KIT_FILES(), 'See the [press kit](#press-kit).\n'),
    async (root) => {
      await build(root);
      assert.match(pageHtml(root, '/made/tumble/'), /<a href="#press-kit">press kit<\/a>/);
    },
  );
  await inSite(
    {
      ...game(`${MINIMAL}${FULL_KIT}`, await KIT_FILES()),
      'content/journal/first/index.md': `${POST}\nThe [kit](../../projects/tumble/#press-kit).\n`,
    },
    async (root) => {
      await build(root);
    },
  );
});

test('missing facts are left out, not shown empty; the game platforms and price fill in; the status is always known', async () => {
  // Only logos listed: no developer, no description; platforms and price come from the game; status from the project.
  await inSite(game(`${MINIMAL}platforms: [Linux, Web]\npressKit:\n  logos: [logo.svg]\n`, { 'logo.svg': LOGO_SVG }), async (root) => {
    await build(root);
    const section = sectionOf(pageHtml(root, '/made/tumble/'));
    assert.doesNotMatch(section, /Developer|press-fact-developer/);
    assert.doesNotMatch(section, /Price|press-fact-price/);
    assert.doesNotMatch(section, /Short description|press-short|press-long|<h3>Description/);
    assert.doesNotMatch(section, /Screenshots/);
    assert.match(section, /<dt>Release status<\/dt>\s*<dd>In development<\/dd>/);
    assert.match(section, /<dt>Platforms<\/dt>\s*<dd>Linux, Web<\/dd>/);
    assert.equal((section.match(/<dt>/g) ?? []).length, 2);
    assert.doesNotMatch(section, /<(dd|dt|p|div|ul|li|dl|h3)>\s*<\/\1>/);
    assert.doesNotMatch(section, /undefined|null/);
  });
  // Nothing but a developer: the factsheet is the whole section, and no list or description is written.
  await inSite(game(`${MINIMAL}pressKit:\n  developer: Sawdust\n`), async (root) => {
    await build(root);
    const section = sectionOf(pageHtml(root, '/made/tumble/'));
    assert.match(section, /<dd>Sawdust<\/dd>/);
    assert.doesNotMatch(section, /Platforms|Price|press-assets|press-description|<ul/);
  });
  // The press kit's own platforms and price win over the game's.
  await inSite(game(`${MINIMAL}platforms: [Linux]\nprice: Free\npressKit:\n  platforms: [Switch]\n  price: 20 EUR\n`), async (root) => {
    await build(root);
    const section = sectionOf(pageHtml(root, '/made/tumble/'));
    assert.match(section, /<dd>Switch<\/dd>/);
    assert.match(section, /<dd>20 EUR<\/dd>/);
    assert.doesNotMatch(section, /Linux|Free/);
  });
});

test('a game without a press kit has no press kit section and no press-kit folder', async () => {
  await inSite(game(MINIMAL), async (root) => {
    await build(root);
    assert.doesNotMatch(pageHtml(root, '/made/tumble/'), /press-kit|Press kit/);
    assert.equal(existsSync(publishedPath(root, '/made/tumble/press-kit')), false);
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'demo', '.coffer-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.projects[0].downloads, []);
  });
});

test('the press kit speaks the language of the site', async () => {
  await inSite(
    game(`${MINIMAL}${FULL_KIT}`, await KIT_FILES()),
    async (root) => {
      await build(root);
      const section = sectionOf(pageHtml(root, '/made/tumble/'));
      assert.match(section, /<h2 id="press-kit-title">Пресс-кит<\/h2>/);
      assert.match(section, /<dt>Разработчик<\/dt>/);
      assert.match(section, /<dt>Статус выпуска<\/dt>/);
      assert.match(section, /Скачать: Логотип 1 \(PNG, 300 × 100 пикс\., [0-9]+ КБ\)/);
      assert.match(section, /<h3>Скриншоты<\/h3>/);
    },
    configOf('ru'),
  );
});

test('texts of the press kit are escaped, raw HTML in a description is handled like in the pages, and a description cannot break the page', async () => {
  const yaml = [
    MINIMAL,
    'pressKit:',
    '  developer: "<script>alert(1)</script> & Co"',
    '  releaseStatus: "<b>soon</b>"',
    '  shortDescription: "Has <b>bold</b> HTML and a [link](https://a.example/?x=1&y=2)."',
    '  longDescription: |',
    '    ::map',
    '',
    '    Text after the map.',
    '  logos:',
    '    - { file: logo.svg, alt: "A \\"quoted\\" <alt>" }',
    '',
  ].join('\n');
  await inSite(game(yaml, { 'logo.svg': LOGO_SVG }), async (root) => {
    await build(root);
    const html = pageHtml(root, '/made/tumble/');
    const section = sectionOf(html);
    assert.match(section, /<dd>&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; Co<\/dd>/);
    assert.match(section, /<dd>&lt;b&gt;soon&lt;\/b&gt;<\/dd>/);
    assert.doesNotMatch(section, /<script/);
    assert.match(section, /Has <b>bold<\/b> HTML/, 'raw HTML in Markdown passes through, as in every page text of the site');
    assert.match(section, /alt="A &quot;quoted&quot; &lt;alt&gt;"/);
    assert.match(section, /<p>Text after the map\.<\/p>/);
    assert.doesNotMatch(section, /data-coffer-map/, 'no empty map placeholder is left');
    assert.doesNotMatch(html, /map\.js|leaflet/i);
  });
});

test('a ::map in a description is left out with a warning; an unknown directive fails the build with the project.yaml line', async () => {
  await inSite(game(`${MINIMAL}pressKit:\n  longDescription: |\n    Text.\n\n    ::map\n`), async (root) => {
    const result = await build(root);
    const warnings = result[0]?.warnings ?? [];
    assert.ok(
      warnings.some((warning) => /project\.yaml:\d+: pressKit\.longDescription: the ::map directive is only for posts and is left out/.test(warning)),
      warnings.join('\n'),
    );
  });
  await inSite(game(`${MINIMAL}pressKit:\n  shortDescription: Fine.\n  longDescription: |\n    Text.\n\n    ::nonsense\n`), async (root) => {
    await assert.rejects(build(root), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /project\.yaml:11:\d+: unknown directive "nonsense"/);
      return true;
    });
  });
});

test('a broken link in a description fails the build with the file of project.yaml and the line', async () => {
  await inSite(
    game(`${MINIMAL}pressKit:\n  longDescription: |\n    Fine text.\n\n    A [broken](../nowhere/) link.\n`),
    async (root) => {
      const errors = await buildErrors(root);
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? '', /content\/projects\/tumble\/project\.yaml:10:\d+ broken link '\.\.\/nowhere\/'/);
    },
  );
  // A project: reference in a description is checked, and rewritten to the page.
  await inSite(game(`${MINIMAL}pressKit:\n  shortDescription: "See [other](project:ghost)."\n`), async (root) => {
    const errors = await buildErrors(root);
    assert.match(errors[0] ?? '', /project\.yaml:\d+:\d+ unknown project 'ghost'/);
  });
  await inSite(game(`${MINIMAL}pressKit:\n  shortDescription: "See [me](project:tumble#press-kit)."\n`), async (root) => {
    await build(root);
    assert.match(sectionOf(pageHtml(root, '/made/tumble/')), /<a href="\/made\/tumble\/#press-kit">me<\/a>/);
  });
  // The descriptions are shown inside the press kit section, so its own anchor is a valid link in them.
  await inSite(
    game(`${MINIMAL}pressKit:\n  shortDescription: "Back to [the top of the kit](#press-kit)."\n  longDescription: "And [here](#press-kit) too."\n`),
    async (root) => {
      await build(root);
      const html = pageHtml(root, '/made/tumble/');
      assert.match(sectionOf(html), /<a href="#press-kit">the top of the kit<\/a>/);
      assert.match(sectionOf(html), /<a href="#press-kit">here<\/a>/);
      assert.match(html, /id="press-kit"/);
    },
  );
  // Any other anchor is still checked.
  await inSite(game(`${MINIMAL}pressKit:\n  shortDescription: "See [x](#nowhere)."\n`), async (root) => {
    const errors = await buildErrors(root);
    assert.match(errors[0] ?? '', /project\.yaml:\d+:\d+ broken link '#nowhere'/);
  });
});

// ---------------------------------------------------------------------------
// The files to download.

test('a downloaded screenshot has the original pixel size and, under the default policy, no location and no camera', async () => {
  const photo = await geotaggedPhoto({ width: 2400, height: 1350 });
  await inSite(game(`${MINIMAL}${FULL_KIT}`, { ...(await KIT_FILES()), 'shot.jpg': photo }), async (root) => {
    await build(root);
    const file = publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg');
    const bytes = readFileSync(file);
    const metadata = await sharp(bytes).metadata();
    assert.deepEqual([metadata.width, metadata.height, metadata.format], [2400, 1350, 'jpeg']);
    const tags = await exifOf(bytes);
    assert.equal(tags?.latitude, undefined);
    assert.equal(tags?.longitude, undefined);
    assert.equal(tags?.GPSLatitude, undefined);
    assert.equal(tags?.Make, undefined);
    assert.equal(tags?.Model, undefined);
    assert.equal(tags?.BodySerialNumber, undefined);
    assert.equal(tags?.DateTimeOriginal, undefined);
    assert.equal(metadata.xmp, undefined);
    assert.equal(metadata.iptc, undefined);
    // The original is not published either.
    assert.equal(existsSync(join(root, 'out', 'demo', 'made', 'tumble', 'shot.jpg')), false);
  });
});

test('a sideways screenshot is downloaded upright at its full size', async () => {
  const sideways = await geotaggedPhoto({ width: 3600, height: 2000, orientation: 6 });
  await inSite(game(`${MINIMAL}pressKit:\n  screenshots: [shot.jpg]\n`, { 'shot.jpg': sideways }), async (root) => {
    await build(root);
    const metadata = await sharp(publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg')).metadata();
    assert.deepEqual([metadata.width, metadata.height], [2000, 3600]);
  });
});

test('the location policy of the site applies to the downloads: keep and coarse write the position, camera needs its own switch', async () => {
  const photo = await geotaggedPhoto({ width: 800, height: 450 });
  const files = game(`${MINIMAL}pressKit:\n  screenshots: [shot.jpg]\n`, { 'shot.jpg': photo });
  await inSite(
    files,
    async (root) => {
      await build(root);
      const tags = await exifOf(readFileSync(publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg')));
      assert.ok(Math.abs(tags?.latitude - PHOTO_POSITION.latitude) < 1e-6);
      assert.equal(tags?.Make, undefined, 'the camera switch is separate and stays on strip');
      const manifest = JSON.parse(readFileSync(join(root, 'out', 'demo', '.coffer-manifest.json'), 'utf8'));
      const [download] = manifest.projects[0].downloads;
      assert.equal(download.gps.precision, 'exact');
      assert.equal(download.policy.location.value, 'keep');
      assert.deepEqual(await checkFailures(root), []);
    },
    configOf('en', '    location: { default: keep }'),
  );
  await inSite(
    files,
    async (root) => {
      await build(root);
      const tags = await exifOf(readFileSync(publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg')));
      assert.equal(Math.round(tags?.latitude * 100) / 100, tags?.latitude, 'the position is rounded to two decimals');
      assert.equal(tags?.Make, 'Examplecam');
      assert.deepEqual(await checkFailures(root), []);
    },
    configOf('en', '    location: { default: coarse, camera: keep }'),
  );
});

test('a PNG logo is downloaded as a PNG with its transparency, and an SVG logo as the very same file', async () => {
  const png = await halfTransparentPng(300, 100);
  await inSite(game(`${MINIMAL}${FULL_KIT}`, { ...(await KIT_FILES()), 'logo.png': png }), async (root) => {
    await build(root);
    const { data, info } = await sharp(publishedPath(root, '/made/tumble/press-kit/tumble-logo-01.png')).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([info.width, info.height, info.channels], [300, 100, 4]);
    assert.equal(data[3], 0);
    assert.equal(data[150 * 4 + 3], 255);
    assert.deepEqual(readFileSync(publishedPath(root, '/made/tumble/press-kit/tumble-logo-02.svg')), Buffer.from(LOGO_SVG));
  });
});

test('the manifest lists every download with its policy, position, camera and size, and coffer check passes', async () => {
  await inSite(game(`${MINIMAL}${FULL_KIT}`, await KIT_FILES()), async (root) => {
    await build(root);
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'demo', '.coffer-manifest.json'), 'utf8'));
    const downloads = manifest.projects[0].downloads;
    assert.deepEqual(
      downloads.map((/** @type {any} */ entry) => [entry.field, entry.source, entry.file, entry.fileName, entry.type, entry.width, entry.height]),
      [
        ['logos', 'content/projects/tumble/logo.png', 'made/tumble/press-kit/tumble-logo-01.png', 'tumble-logo-01.png', 'image/png', 300, 100],
        ['logos', 'content/projects/tumble/logo.svg', 'made/tumble/press-kit/tumble-logo-02.svg', 'tumble-logo-02.svg', 'image/svg+xml', 120, 60],
        ['screenshots', 'content/projects/tumble/shot.jpg', 'made/tumble/press-kit/tumble-screenshot-01.jpg', 'tumble-screenshot-01.jpg', 'image/jpeg', 1600, 900],
      ],
    );
    assert.equal(downloads[0].policy.location.value, 'strip');
    assert.equal(downloads[0].gps, null);
    assert.equal(downloads[1].policy, null, 'an SVG is published as it is');
    assert.match(downloads[2].sha256, /^[0-9a-f]{64}$/);
    for (const entry of downloads) {
      assert.equal(readFileSync(join(root, 'out', 'demo', ...entry.file.split('/'))).length, entry.bytes);
    }
    assert.deepEqual(await checkFailures(root), []);
    const result = await checkOutput(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out') });
    // The card, the PNG logo and the screenshot (the SVG is not re-encoded), and the three downloads.
    assert.equal(result.sites[0]?.checked.images, 3 + 3);
  });
});

test('coffer check fails a download that leaks a position, was resized, or is a modified SVG', async () => {
  const photo = await geotaggedPhoto({ width: 1600, height: 900 });
  await inSite(game(`${MINIMAL}${FULL_KIT}`, { ...(await KIT_FILES()), 'shot.jpg': photo }), async (root) => {
    await build(root);
    assert.deepEqual(await checkFailures(root), []);
    const shot = publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg');
    const clean = readFileSync(shot);

    // The original, with its position, in place of the stripped download.
    writeFileSync(shot, photo);
    let failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-screenshot-01\.jpg: publishes a position, but the location policy "strip" allows none/.test(failure)), failures.join('\n'));
    assert.ok(failures.some((failure) => /has camera fields .*but the camera policy is "strip"/.test(failure)), failures.join('\n'));
    assert.ok(failures.every((failure) => !/47\.0|11\.0/.test(failure)), 'no coordinate in a message');

    // A downscaled copy.
    writeFileSync(shot, await sharp(clean).resize({ width: 800 }).jpeg().toBuffer());
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-screenshot-01\.jpg: is 800 by 450 pixels, but the manifest says 1600 by 900/.test(failure)), failures.join('\n'));

    // A missing file.
    rmSync(shot);
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /the manifest lists this download, but it is missing/.test(failure)), failures.join('\n'));
    writeFileSync(shot, clean);
    assert.deepEqual(await checkFailures(root), []);

    // An SVG that was changed after the build, into one that runs script.
    const svg = publishedPath(root, '/made/tumble/press-kit/tumble-logo-02.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the published SVG is not the original file/.test(failure)), failures.join('\n'));
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the SVG contains an event handler attribute/.test(failure)), failures.join('\n'));

    // A handler hidden behind a fake tag in a comment, which the re-inspection must see as well.
    writeFileSync(svg, '<!-- < b " --><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>"</text></svg>');
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the SVG contains an event handler attribute/.test(failure)), failures.join('\n'));

    // A prefixed element in mixed case, which the re-inspection must see as well.
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" xmlns:a="http://www.w3.org/2000/svg"><a:ScRipt>alert(1)</a:ScRipt></svg>');
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the SVG contains a <script> element/.test(failure)), failures.join('\n'));

    // A file in ISO-2022-JP, in which a browser drops the escape sequence and so sees a live handler in a comment.
    writeFileSync(
      svg,
      Buffer.from('<?xml version="1.0" encoding="iso-2022-jp"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- x -\u001b(B-> <rect width="10" height="10" onclick="parent.pm(1)"/> --></svg>', 'latin1'),
    );
    failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the SVG contains a control character/.test(failure)), failures.join('\n'));
    assert.ok(failures.some((failure) => /tumble-logo-02\.svg: .*the SVG declares an encoding other than UTF-8/.test(failure)), failures.join('\n'));
  });
});

test('coffer check also fails when the manifest claims a position the policy forbids', async () => {
  const photo = await geotaggedPhoto({ width: 400, height: 300 });
  await inSite(game(`${MINIMAL}pressKit:\n  screenshots: [shot.jpg]\n`, { 'shot.jpg': photo }), async (root) => {
    await build(root);
    const manifestPath = join(root, 'out', 'demo', '.coffer-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.projects[0].downloads[0].gps = { latitude: 1, longitude: 2, precision: 'exact' };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const failures = await checkFailures(root);
    assert.ok(failures.some((failure) => /the manifest lists a position, but the location policy is "strip"/.test(failure)), failures.join('\n'));
  });
});

test('a download whose original is not an image fails the build and names project.yaml', async () => {
  await inSite(game(`${MINIMAL}pressKit:\n  screenshots: [shot.png]\n`, { 'shot.png': 'this is not a picture' }), async (root) => {
    const errors = await buildErrors(root);
    assert.ok(errors.length >= 1);
    assert.match(errors[0] ?? '', /content\/projects\/tumble\/project\.yaml pressKit\.screenshots: item 1: image 'shot\.png': cannot read the image/);
  });
});

test('a rebuild reuses the downloads from the cache and produces the same files', async () => {
  await inSite(game(`${MINIMAL}${FULL_KIT}`, await KIT_FILES()), async (root) => {
    await build(root);
    const first = readFileSync(publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg'));
    await build(root);
    assert.deepEqual(readFileSync(publishedPath(root, '/made/tumble/press-kit/tumble-screenshot-01.jpg')), first);
    assert.ok(existsSync(join(root, '.cache', 'images')));
  });
});
