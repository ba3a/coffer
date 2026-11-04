import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import exifr from 'exifr';
import sharp from 'sharp';

import { buildSites } from '../src/build.js';
import { checkOutput, checkSite } from '../src/check/index.js';
import { run } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { createImagePipeline } from '../src/images/pipeline.js';
import {
  exifFor,
  isCoarse,
  publishedPosition,
  readOriginalMetadata,
  readPublishedMetadata,
  roundCoordinate,
  sameCamera,
} from '../src/images/metadata.js';
import { PHOTO_CAMERA, PHOTO_POSITION, TINY_PNG, geotaggedPhoto } from './helpers/images.js';

const exampleDir = fileURLToPath(new URL('../example/', import.meta.url));
const exampleConfig = join(exampleDir, 'coffer.yaml');
const NOW = new Date('2026-06-01T12:00:00Z');

/** The made-up position of the example's ridge photo: 47 deg 0' 44.3" N, 11 deg 2' 44.2" E. */
const RIDGE_POSITION = { latitude: 47 + 44.3 / 3600, longitude: 11 + 2 / 60 + 44.2 / 3600 };

/** Distance in metres between two positions (small distances only). */
function metres(/** @type {{ latitude: number, longitude: number }} */ a, /** @type {{ latitude: number, longitude: number }} */ b) {
  const north = (a.latitude - b.latitude) * 111_320;
  const east = (a.longitude - b.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(north, east);
}

/**
 * @template T
 * @param {(root: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTemp(body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-meta-'));
  try {
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {string} root
 * @param {Record<string, string | Buffer>} files
 */
function addFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * Every tag exifr can read from a file, merged, for looking at what a published
 * file really contains (independently of the code that wrote it). exifr does not
 * read WebP, which gives no tags here; use {@link hasExif} for those.
 *
 * @param {string | Buffer} source
 * @returns {Promise<Record<string, any>>}
 */
async function allTags(source) {
  const bytes = typeof source === 'string' ? readFileSync(source) : source;
  try {
    return (await exifr.parse(bytes, { gps: true, mergeOutput: true, translateValues: false })) ?? {};
  } catch {
    return {};
  }
}

/**
 * Whether a file carries EXIF data at all, as sharp (libvips) sees it. This works for WebP too.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function hasExif(path) {
  return (await sharp(path).metadata()).exif !== undefined;
}

/**
 * @param {string | Buffer} source
 * @returns {Promise<{ latitude: number, longitude: number } | null>}
 */
async function gpsOf(source) {
  const tags = await allTags(source);
  return typeof tags.latitude === 'number' && typeof tags.longitude === 'number'
    ? { latitude: tags.latitude, longitude: tags.longitude }
    : null;
}

// ---------------------------------------------------------------------------
// The functions that read, round and write positions and camera fields.

test('a coarse position is the original rounded to two decimals, about a kilometre', () => {
  assert.equal(roundCoordinate(47.0123456), 47.01);
  assert.equal(roundCoordinate(11.0456111), 11.05);
  assert.equal(roundCoordinate(-47.0123456), -47.01);
  assert.equal(roundCoordinate(-0.001), 0);
  assert.equal(Object.is(roundCoordinate(-0.001), -0), false, 'no negative zero');
  for (const [latitude, longitude] of [
    [47.0123456, 11.0456111],
    [-33.86882, 151.20929],
    [0.004999, -0.004999],
    [64.14695, -21.94266],
  ]) {
    const original = { latitude, longitude };
    const coarse = /** @type {NonNullable<ReturnType<typeof publishedPosition>>} */ (publishedPosition(original, 'coarse'));
    assert.equal(coarse.precision, 'coarse');
    assert.ok(isCoarse(coarse));
    assert.ok(metres(original, coarse) < 800, `${metres(original, coarse)} m away`);
  }
});

test('the location policy decides what is published of a position', () => {
  const original = { latitude: 47.0123456, longitude: 11.0456111 };
  assert.equal(publishedPosition(original, 'strip'), null);
  assert.deepEqual(publishedPosition(original, 'coarse'), { latitude: 47.01, longitude: 11.05, precision: 'coarse' });
  assert.deepEqual(publishedPosition(original, 'keep'), { ...original, precision: 'exact' });
  assert.equal(publishedPosition(null, 'keep'), null, 'a picture without a position publishes none');
});

test('positions and camera fields written as EXIF are read back unchanged, in every hemisphere', async () => {
  for (const [latitude, longitude] of [
    [47.0123456, 11.0456111],
    [-33.8688197, 151.2092955],
    [-0.0000123, -179.9999999],
    [59.99999999, 0],
    [-89.9999, 89.99999],
  ]) {
    for (const policy of /** @type {const} */ (['keep', 'coarse'])) {
      const position = /** @type {NonNullable<ReturnType<typeof publishedPosition>>} */ (publishedPosition({ latitude, longitude }, policy));
      const exif = exifFor(position, PHOTO_CAMERA);
      assert.ok(exif);
      const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } }).jpeg().withExif(exif).toBuffer();
      const back = await readPublishedMetadata(jpeg);
      assert.ok(back.gps, `${latitude},${longitude} ${policy}`);
      assert.ok(metres(back.gps, position) < 0.01, `${policy}: ${latitude},${longitude} came back as ${back.gps.latitude},${back.gps.longitude}`);
      assert.ok(sameCamera(back.camera, PHOTO_CAMERA));
    }
  }
  assert.equal(exifFor(null, null), null, 'nothing to write');
});

test('only the position and the camera fields are ever copied from an original', async () => {
  const original = await readOriginalMetadata(await geotaggedPhoto());
  assert.ok(original.gps);
  assert.ok(metres(original.gps, PHOTO_POSITION) < 0.01);
  assert.ok(sameCamera(original.camera, PHOTO_CAMERA));
  assert.deepEqual(await readOriginalMetadata(TINY_PNG), { gps: null, camera: null });
  assert.deepEqual(await readOriginalMetadata(Buffer.from('not an image')), { gps: null, camera: null });
});

// ---------------------------------------------------------------------------
// The pipeline.

/**
 * @param {string} root
 * @param {Partial<import('../src/images/pipeline.js').MetadataPolicy> | undefined} policy
 * @param {Buffer} [bytes]
 */
async function processPhoto(root, policy, bytes) {
  addFiles(root, { 'photo.jpg': bytes ?? (await geotaggedPhoto()) });
  const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
  const image = await pipeline.process(join(root, 'photo.jpg'), policy);
  return { pipeline, image };
}

test('location strip: no published file has a position, not even the viewer JPEG', async () => {
  await inTemp(async (root) => {
    for (const policy of [undefined, { location: /** @type {const} */ ('strip') }, { location: /** @type {const} */ ('strip'), camera: /** @type {const} */ ('keep') }]) {
      const { image } = await processPhoto(root, policy);
      assert.equal(image.gps, null);
      for (const file of [...image.variants, image.viewer]) {
        const tags = await allTags(join(image.dir, file.file));
        assert.equal(tags.latitude, undefined, file.file);
        assert.equal(tags.longitude, undefined, file.file);
        assert.equal(tags.GPSLatitude, undefined, file.file);
        assert.equal(tags.GPSAltitude, undefined, file.file);
        if (policy?.camera !== 'keep' || file !== image.viewer) {
          assert.equal(await hasExif(join(image.dir, file.file)), false, `${file.file} has no EXIF data at all`);
        }
      }
    }
  });
});

test('location coarse: the viewer JPEG has the position rounded to about a kilometre, the variants none', async () => {
  await inTemp(async (root) => {
    const { image } = await processPhoto(root, { location: 'coarse' });
    assert.deepEqual(image.gps, { latitude: 47.01, longitude: 11.05, precision: 'coarse' });
    const published = await gpsOf(join(image.dir, image.viewer.file));
    assert.ok(published);
    assert.ok(Math.abs(published.latitude - 47.01) < 1e-7 && Math.abs(published.longitude - 11.05) < 1e-7, JSON.stringify(published));
    assert.ok(metres(published, PHOTO_POSITION) < 1000, 'within about a kilometre of the original');
    assert.ok(metres(published, PHOTO_POSITION) > 10, 'but not the original position');
    for (const variant of image.variants) assert.equal(await hasExif(join(image.dir, variant.file)), false, variant.file);
  });
});

test('location keep: the viewer JPEG has the exact position, the variants none', async () => {
  await inTemp(async (root) => {
    const { image } = await processPhoto(root, { location: 'keep' });
    assert.equal(image.gps?.precision, 'exact');
    const published = await gpsOf(join(image.dir, image.viewer.file));
    assert.ok(published);
    assert.ok(metres(published, PHOTO_POSITION) < 0.01, `${JSON.stringify(published)} is not ${JSON.stringify(PHOTO_POSITION)}`);
    for (const variant of image.variants) {
      assert.equal(await hasExif(join(image.dir, variant.file)), false, `${variant.file} has no metadata at all`);
    }
  });
});

test('positions south of the equator and west of Greenwich keep their sign under every policy', async () => {
  await inTemp(async (root) => {
    const bytes = await geotaggedPhoto({ southWest: true });
    const keep = await processPhoto(root, { location: 'keep' }, bytes);
    const kept = await gpsOf(join(keep.image.dir, keep.image.viewer.file));
    assert.ok(kept && kept.latitude < 0 && kept.longitude < 0);
    assert.ok(metres(kept, { latitude: -PHOTO_POSITION.latitude, longitude: -PHOTO_POSITION.longitude }) < 0.01);
    const coarse = await processPhoto(root, { location: 'coarse' }, bytes);
    assert.deepEqual(await gpsOf(join(coarse.image.dir, coarse.image.viewer.file)), { latitude: -47.01, longitude: -11.05 });
  });
});

test('camera fields are published only when the camera policy is keep, whatever the location policy says', async () => {
  await inTemp(async (root) => {
    for (const location of /** @type {const} */ (['strip', 'coarse', 'keep'])) {
      const stripped = await processPhoto(root, { location, camera: 'strip' });
      assert.equal(stripped.image.camera, null);
      const tags = await allTags(join(stripped.image.dir, stripped.image.viewer.file));
      for (const name of ['Make', 'Model', 'LensModel', 'ExposureTime', 'FNumber', 'ISO', 'FocalLength']) {
        assert.equal(tags[name], undefined, `${location}/strip: ${name}`);
      }

      const kept = await processPhoto(root, { location, camera: 'keep' });
      assert.ok(sameCamera(kept.image.camera, PHOTO_CAMERA));
      const keptTags = await allTags(join(kept.image.dir, kept.image.viewer.file));
      assert.equal(keptTags.Make, 'Examplecam');
      assert.equal(keptTags.Model, 'Made-up 1');
      assert.equal(keptTags.LensModel, '35mm f/1.8');
      assert.equal(keptTags.ISO, 200);
      assert.equal(keptTags.FNumber, 5.6);
      assert.equal(keptTags.FocalLength, 35);
      assert.ok(Math.abs(keptTags.ExposureTime - 1 / 250) < 1e-9);
      for (const variant of kept.image.variants) {
        assert.equal((await sharp(join(kept.image.dir, variant.file)).metadata()).exif, undefined, variant.file);
      }
    }
  });
});

test('nothing but the position and the camera fields is copied, and the viewer JPEG is upright without an orientation', async () => {
  await inTemp(async (root) => {
    const { image } = await processPhoto(root, { location: 'keep', camera: 'keep' }, await geotaggedPhoto({ width: 1200, height: 800, orientation: 6 }));
    assert.deepEqual([image.width, image.height], [800, 1200]);
    const path = join(image.dir, image.viewer.file);
    const tags = await allTags(path);
    assert.equal(tags.BodySerialNumber, undefined, 'serial number');
    assert.equal(tags.DateTimeOriginal, undefined, 'time');
    assert.equal(tags.GPSAltitude, undefined, 'altitude');
    assert.ok(tags.Orientation === undefined || /Horizontal|^1$/.test(String(tags.Orientation)), `orientation ${tags.Orientation}`);
    const metadata = await sharp(path).metadata();
    assert.ok(metadata.orientation === undefined || metadata.orientation === 1);
    assert.deepEqual([metadata.width, metadata.height], [800, 1200]);
    assert.ok(metadata.xmp === undefined && metadata.iptc === undefined);
    assert.ok(metres(/** @type {any} */ (await gpsOf(path)), PHOTO_POSITION) < 0.01, 'the position survives the turning');
  });
});

test('the policy is part of the cache key, and a cached image keeps its position and camera', async () => {
  await inTemp(async (root) => {
    const first = await processPhoto(root, { location: 'keep', camera: 'keep' });
    const strip = await first.pipeline.process(join(root, 'photo.jpg'), { location: 'strip' });
    const coarse = await first.pipeline.process(join(root, 'photo.jpg'), { location: 'coarse' });
    const keys = new Set([first.image.key, strip.key, coarse.key]);
    assert.equal(keys.size, 3, 'each policy has a folder of its own');
    assert.equal(first.pipeline.stats.generated, 3);

    const again = createImagePipeline({ cacheDir: join(root, 'cache') });
    const reused = await again.process(join(root, 'photo.jpg'), { location: 'keep', camera: 'keep' });
    assert.equal(reused.cached, true);
    assert.equal(reused.key, first.image.key);
    assert.deepEqual(reused.gps, first.image.gps);
    assert.deepEqual(reused.camera, first.image.camera);
    assert.deepEqual(reused.policy, { location: 'keep', camera: 'keep' });
    assert.equal((await again.process(join(root, 'photo.jpg'), { location: 'strip' })).gps, null);
  });
});

test('a picture without a position publishes none, whatever the policy, and a bad policy is refused', async () => {
  await inTemp(async (root) => {
    addFiles(root, { 'plain.png': TINY_PNG });
    const pipeline = createImagePipeline({ cacheDir: join(root, 'cache') });
    const image = await pipeline.process(join(root, 'plain.png'), { location: 'keep', camera: 'keep' });
    assert.equal(image.gps, null);
    assert.equal(image.camera, null);
    assert.throws(() => pipeline.process(join(root, 'plain.png'), { location: /** @type {any} */ ('exact') }), /location must be one of: strip, coarse, keep/);
    assert.throws(() => pipeline.process(join(root, 'plain.png'), { camera: /** @type {any} */ ('coarse') }), /camera must be one of: strip, keep/);
  });
});

// ---------------------------------------------------------------------------
// The build.

/**
 * Copies the example site (without a previous build or cache) and runs `body`
 * with its root.
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
 * @param {string} file Path relative to the root.
 * @param {(text: string) => string} change
 */
function rewrite(root, file, change) {
  const path = join(root, ...file.split('/'));
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `${file} did not change`);
  writeFileSync(path, after);
}

/**
 * @param {string} root
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'dist'),
    now: NOW,
  });
  return result;
}

/**
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
 * @param {import('../src/build.js').Manifest} manifest
 * @param {string} name File name of the original.
 * @returns {import('../src/build.js').ManifestImage}
 */
function entryOf(manifest, name) {
  const entry = manifest.images.find((image) => image.source.endsWith(`/${name}`));
  assert.ok(entry, `${name} is in the manifest`);
  return entry;
}

/**
 * @param {string} outDir
 * @param {import('../src/build.js').ManifestImage} entry
 * @returns {string} Path of the viewer JPEG.
 */
function viewerPath(outDir, entry) {
  const viewer = entry.outputs.find((output) => output.role === 'viewer');
  assert.ok(viewer);
  return join(outDir, ...viewer.file.split('/'));
}

/** The example build, made once and read by several tests. */
let pristine = '';
/** @type {import('../src/build.js').SiteResult} */
let example;

before(async () => {
  pristine = mkdtempSync(join(tmpdir(), 'coffer-meta-base-'));
  [example] = await buildSites(loadConfig({ configPath: exampleConfig }), {
    out: join(pristine, 'dist'),
    now: NOW,
    cacheDir: join(pristine, 'cache'),
    reportDir: join(pristine, 'report'),
  });
});

after(() => {
  rmSync(pristine, { recursive: true, force: true });
});

test('example: the tag that says keep publishes the exact position and the camera of its photo', async () => {
  const ridge = entryOf(example.manifest, 'ridge.jpg');
  assert.equal(ridge.policy.location.value, 'keep');
  assert.deepEqual(ridge.policy.location.source, { level: 'tag', origin: 'trips/mountains' });
  assert.equal(ridge.policy.camera.value, 'keep');
  assert.equal(ridge.gps?.precision, 'exact');
  const original = await gpsOf(join(exampleDir, 'content', 'journal', 'photos', 'ridge.jpg'));
  assert.ok(original && ridge.gps);
  assert.ok(metres(ridge.gps, original) < 0.01, 'the manifest has the exact position, for maps');
  assert.deepEqual(ridge.camera, { make: 'Examplecam', model: 'Made-up 1' });

  const published = await gpsOf(viewerPath(example.outDir, ridge));
  assert.ok(published && metres(published, original) < 0.01, 'and so does the viewer JPEG');
  const tags = await allTags(viewerPath(example.outDir, ridge));
  assert.equal(tags.Make, 'Examplecam');
  assert.equal(tags.Model, 'Made-up 1');
});

test('example: the post that says coarse publishes the position rounded to about a kilometre', async () => {
  const joint = entryOf(example.manifest, 'dovetail-joint.jpg');
  assert.equal(joint.policy.location.value, 'coarse');
  assert.deepEqual(joint.policy.location.source, { level: 'post', origin: 'content/journal/first-dovetail/index.md' });
  assert.deepEqual(joint.policy.camera, { value: 'strip', source: { level: 'site', origin: null } });
  assert.deepEqual(joint.gps, { latitude: 52.39, longitude: 9.73, precision: 'coarse' });
  assert.equal(joint.camera, null);

  const original = await gpsOf(join(exampleDir, 'content', 'journal', 'first-dovetail', 'dovetail-joint.jpg'));
  const published = await gpsOf(viewerPath(example.outDir, joint));
  assert.ok(original && published);
  assert.ok(Math.abs(published.latitude - 52.39) < 1e-7 && Math.abs(published.longitude - 9.73) < 1e-7);
  assert.ok(metres(original, published) < 1000);
  assert.notDeepEqual(published, original);
});

test('example: a photo without a position publishes none, and no variant ever carries metadata', async () => {
  const gauge = entryOf(example.manifest, 'marking-gauge.jpg');
  assert.equal(gauge.policy.location.value, 'coarse', 'the post says coarse for all of its photos');
  assert.equal(gauge.gps, null);
  assert.equal(await gpsOf(viewerPath(example.outDir, gauge)), null);
  for (const image of example.manifest.images) {
    for (const output of image.outputs.filter((entry) => entry.role === 'variant')) {
      const metadata = await sharp(join(example.outDir, ...output.file.split('/'))).metadata();
      assert.equal(metadata.exif, undefined, output.file);
      assert.equal(metadata.xmp, undefined, output.file);
    }
  }
});

test('example: the build report lists the posts that publish exact locations', () => {
  assert.deepEqual(example.exactLocations, [
    { site: 'workshop', file: 'content/journal/mountain-weekend.md', images: 1 },
  ]);
  const report = JSON.parse(readFileSync(join(pristine, 'report', 'report.json'), 'utf8'));
  assert.deepEqual(report.exactLocations, example.exactLocations);
  assert.deepEqual(report.errors, []);
});

test('coffer build prints the posts that publish exact locations after every build', async () => {
  await withExampleCopy(async (root) => {
    /** @param {string[]} args */
    const runBuild = async (args) => {
      let out = '';
      let err = '';
      const code = await run(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'dist'), '--now', '2026-06-01', ...args], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      return { code, out, err };
    };
    const first = await runBuild([]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^Posts publishing exact locations \(1\)\n {2}content\/journal\/mountain-weekend\.md: 1 image\(s\)$/m);

    rewrite(root, 'content/journal/tags.yaml', (text) => text.replace('location: keep', 'location: coarse'));
    const second = await runBuild([]);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^Posts publishing exact locations: none$/m);
    assert.doesNotMatch(second.out, /mountain-weekend\.md: \d/);
  });
});

test('the camera policy of a tag can strip the camera while the location is kept', async () => {
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/tags.yaml', (text) => text.replace('camera: keep', 'camera: strip'));
    const result = await build(root);
    const ridge = entryOf(result.manifest, 'ridge.jpg');
    assert.equal(ridge.policy.location.value, 'keep');
    assert.equal(ridge.policy.camera.value, 'strip');
    assert.equal(ridge.camera, null);
    const tags = await allTags(viewerPath(result.outDir, ridge));
    assert.equal(tags.Make, undefined);
    assert.equal(tags.Model, undefined);
    assert.ok(tags.latitude !== undefined, 'the position is still there');
  });
});

test('an entry in the images map of a post overrides the tag for one image', async () => {
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/mountain-weekend.md', (text) =>
      text.replace('summary:', 'images:\n  ridge.jpg:\n    location: strip\nsummary:'),
    );
    const result = await build(root);
    const ridge = entryOf(result.manifest, 'ridge.jpg');
    assert.equal(ridge.policy.location.value, 'strip');
    assert.deepEqual(ridge.policy.location.source, { level: 'image', origin: 'ridge.jpg' });
    assert.equal(ridge.policy.camera.value, 'keep', 'the camera setting still comes from the tag');
    assert.equal(ridge.gps, null);
    assert.equal(await gpsOf(viewerPath(result.outDir, ridge)), null);
    assert.deepEqual(result.exactLocations, []);
    assert.deepEqual(result.warnings.filter((warning) => /images:/.test(warning)), []);
  });
});

test('an images entry that no image of the post uses is a warning', async () => {
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/mountain-weekend.md', (text) =>
      text.replace('summary:', 'images:\n  ridge.jpg: { camera: strip }\n  nowhere.jpg: { location: keep }\nsummary:'),
    );
    const result = await build(root);
    assert.deepEqual(
      result.warnings.filter((warning) => /images:/.test(warning)),
      ['content/journal/mountain-weekend.md: images: "nowhere.jpg" matches no image of the post'],
    );
  });
});

test('a value the policy does not accept fails the build with the file and the key', async () => {
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/mountain-weekend.md', (text) => text.replace('summary:', 'location: precise\nsummary:'));
    const errors = await buildErrors(root);
    assert.deepEqual(errors, ['content/journal/mountain-weekend.md: location: must be one of: strip, coarse, keep']);
  });
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/tags.yaml', (text) => text.replace('location: keep', 'location: everywhere'));
    const errors = await buildErrors(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /^content\/journal\/tags\.yaml: trips\/mountains\.location: must be one of: strip, coarse, keep$/);
  });
  await withExampleCopy(async (root) => {
    rewrite(root, 'content/journal/mountain-weekend.md', (text) => text.replace('summary:', 'images:\n  ridge.jpg: { camera: coarse }\nsummary:'));
    const errors = await buildErrors(root);
    assert.deepEqual(errors, ['content/journal/mountain-weekend.md: images.ridge.jpg.camera: must be one of: strip, keep']);
  });
});

test('the same photo in two posts is published once per policy', async () => {
  await withExampleCopy(
    async (root) => {
      const result = await build(root);
      const entries = result.manifest.images.filter((image) => image.source.endsWith('/ridge.jpg'));
      assert.deepEqual(entries.map((entry) => [entry.post, entry.policy.location.value]), [
        ['/journal/mountain-weekend/', 'keep'],
        ['/journal/photo-notes/', 'strip'],
        ['/journal/ridge-again/', 'strip'],
      ]);
      const [kept, , stripped] = entries;
      assert.notEqual(kept?.outputs[0]?.file.split('/')[1], stripped?.outputs[0]?.file.split('/')[1], 'different folders');
      assert.ok(kept?.gps && stripped?.gps === null);
      assert.equal(await gpsOf(viewerPath(result.outDir, /** @type {any} */ (stripped))), null);
      assert.ok(await gpsOf(viewerPath(result.outDir, /** @type {any} */ (kept))));
      assert.deepEqual(result.exactLocations.map((entry) => entry.file), ['content/journal/mountain-weekend.md']);
    },
    {
      'content/journal/ridge-again.md': '---\ntitle: The ridge again\ndate: 2025-02-21\ntags: [notes]\n---\n\n![The same ridge.](photos/ridge.jpg)\n',
    },
  );
});

test('a second build reuses the cache and still knows what it published', async () => {
  await withExampleCopy(async (root) => {
    const first = await build(root);
    const second = await build(root);
    assert.deepEqual(second.images, { generated: 0, reused: 6 });
    assert.deepEqual(second.manifest.images, first.manifest.images);
    assert.deepEqual(second.exactLocations, first.exactLocations);
  });
});

// ---------------------------------------------------------------------------
// coffer check.

/**
 * Copies the pristine example build, lets `edit` change it, and passes the
 * output root and the copy's manifest to `body`.
 *
 * @param {(site: string, manifest: import('../src/build.js').Manifest) => void | Promise<void>} edit
 * @param {(out: string, manifest: import('../src/build.js').Manifest) => Promise<void>} body
 */
async function withBuild(edit, body) {
  await inTemp(async (root) => {
    cpSync(join(pristine, 'dist'), root, { recursive: true });
    const site = join(root, 'workshop');
    const manifest = JSON.parse(readFileSync(join(site, '.coffer-manifest.json'), 'utf8'));
    await edit(site, manifest);
    await body(root, JSON.parse(readFileSync(join(site, '.coffer-manifest.json'), 'utf8')));
  });
}

/**
 * Replaces the viewer JPEG of an image with a picture that carries the given
 * position and camera.
 *
 * @param {string} site
 * @param {import('../src/build.js').Manifest} manifest
 * @param {string} name File name of the original.
 * @param {import('../src/images/metadata.js').PublishedPosition | null} position
 * @param {import('../src/images/metadata.js').CameraFields | null} [camera]
 */
async function replaceViewer(site, manifest, name, position, camera = null) {
  const entry = entryOf(manifest, name);
  const exif = exifFor(position, camera);
  let image = sharp({ create: { width: 64, height: 48, channels: 3, background: '#445566' } }).jpeg();
  if (exif) image = image.withExif(exif);
  writeFileSync(viewerPath(site, entry), await image.toBuffer());
}

/**
 * @param {string} out
 * @returns {Promise<import('../src/check/index.js').Finding[]>}
 */
async function checkFindings(out) {
  const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out });
  return result.failures;
}

/**
 * @param {string} out
 * @param {RegExp} pattern
 */
async function assertFinding(out, pattern) {
  const failures = await checkFindings(out);
  assert.ok(failures.some((failure) => pattern.test(`${failure.file}: ${failure.message}`)), JSON.stringify(failures, null, 1));
  return failures;
}

test('coffer check reads every published image back and passes on a build that follows its policies', async () => {
  const result = await checkOutput(loadConfig({ configPath: exampleConfig }), { out: join(pristine, 'dist') });
  assert.deepEqual(result.failures, []);
  assert.equal(result.sites[0]?.checked.images, 6);
});

test('coffer check fails when a coarse image publishes the exact position', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'dovetail-joint.jpg', { ...PHOTO_POSITION, precision: 'exact' }),
    async (out, manifest) => {
      const file = entryOf(manifest, 'dovetail-joint.jpg').outputs.find((output) => output.role === 'viewer')?.file ?? '';
      const failures = await assertFinding(out, new RegExp(`^${file.replace(/[.\\/]/g, '\\$&')}: its position is not the original position rounded to two decimals`));
      for (const failure of failures) assert.doesNotMatch(failure.message, /\d+\.\d{3}/, 'the message gives no coordinates away');
    },
  );
});

test('coffer check fails when a strip image publishes a position', async () => {
  await withBuild(
    async (site, manifest) => {
      const entry = entryOf(manifest, 'dovetail-joint.jpg');
      entry.policy.location.value = 'strip';
      entry.gps = null;
      writeFileSync(join(site, '.coffer-manifest.json'), JSON.stringify(manifest));
    },
    async (out) => {
      await assertFinding(out, /dovetail-joint-full\.jpg: publishes a position, but the location policy "strip" allows none/);
    },
  );
});

test('coffer check fails when a strip image of a build carries a position in the viewer JPEG', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'marking-gauge.jpg', { latitude: 52.39, longitude: 9.73, precision: 'coarse' }),
    async (out) => {
      await assertFinding(out, /marking-gauge-full\.jpg: publishes a position, but the location policy "coarse" allows none for this image/);
    },
  );
});

test('coffer check fails when a keep image lost its position or publishes a rounded one', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'ridge.jpg', null),
    async (out) => {
      await assertFinding(out, /ridge-full\.jpg: has no position, but the location policy is "keep"/);
    },
  );
  await withBuild(
    (site, manifest) =>
      replaceViewer(site, manifest, 'ridge.jpg', { latitude: 47.01, longitude: 11.05, precision: 'coarse' }, { make: 'Examplecam', model: 'Made-up 1' }),
    async (out) => {
      await assertFinding(out, /ridge-full\.jpg: its position is not the original position, as the location policy "keep" requires/);
    },
  );
});

test('coffer check fails when camera fields are published although the camera policy is strip', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'marking-gauge.jpg', null, { make: 'Examplecam' }),
    async (out) => {
      await assertFinding(out, /marking-gauge-full\.jpg: has camera fields \(Make\), but the camera policy is "strip"/);
    },
  );
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'dovetail-joint.jpg', { latitude: 52.39, longitude: 9.73, precision: 'coarse' }, { iso: 100, model: 'Secret' }),
    async (out) => {
      await assertFinding(out, /dovetail-joint-full\.jpg: has camera fields \(Model, ISO\), but the camera policy is "strip"/);
    },
  );
});

test('coffer check fails when the camera fields of a keep image are not the ones the manifest lists', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'ridge.jpg', { ...RIDGE_POSITION, precision: 'exact' }, { make: 'Other' }),
    async (out) => {
      await assertFinding(out, /ridge-full\.jpg: its camera fields are not the ones the manifest lists/);
    },
  );
});

test('coffer check fails when a WebP variant carries metadata', async () => {
  await withBuild(
    async (site, manifest) => {
      const variant = entryOf(manifest, 'ridge.jpg').outputs[0];
      assert.ok(variant && variant.role === 'variant');
      const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
        .webp()
        .withExif({ IFD0: { Make: 'Examplecam' } })
        .toBuffer();
      writeFileSync(join(site, ...variant.file.split('/')), bytes);
    },
    async (out) => {
      await assertFinding(out, /ridge-480\.webp: carries EXIF data, but only the full-size JPEG may/);
    },
  );
});

test('coffer check fails when the manifest and the policy disagree, and when a file is missing', async () => {
  await withBuild(
    (site, manifest) => {
      const entry = entryOf(manifest, 'ridge.jpg');
      entry.gps = { latitude: 47.01, longitude: 11.05, precision: 'coarse' };
      writeFileSync(join(site, '.coffer-manifest.json'), JSON.stringify(manifest));
    },
    async (out) => {
      await assertFinding(out, /the position in the manifest is not the one the location policy "keep" gives for the original/);
    },
  );
  await withBuild(
    (site, manifest) => {
      delete (/** @type {any} */ (entryOf(manifest, 'ridge.jpg')).policy);
      writeFileSync(join(site, '.coffer-manifest.json'), JSON.stringify(manifest));
    },
    async (out) => {
      await assertFinding(out, /the manifest records no metadata policy for it/);
    },
  );
  await withBuild(
    (site, manifest) => rmSync(viewerPath(site, entryOf(manifest, 'ridge.jpg'))),
    async (out) => {
      await assertFinding(out, /ridge-full\.jpg: the manifest lists this image file, but it is missing/);
    },
  );
});

test('checkSite alone, without the originals, still holds a build to the policy its manifest records', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'marking-gauge.jpg', { latitude: 52.39, longitude: 9.73, precision: 'coarse' }),
    async (out) => {
      const check = await checkSite(join(out, 'workshop'), 'workshop');
      assert.ok(check.failures.some((failure) => /marking-gauge-full\.jpg: publishes a position/.test(`${failure.file}: ${failure.message}`)));
    },
  );
  const clean = await checkSite(join(pristine, 'dist', 'workshop'), 'workshop');
  assert.deepEqual(clean.failures, []);
});

test('the check command exits 1 and names the image that does not match its policy', async () => {
  await withBuild(
    (site, manifest) => replaceViewer(site, manifest, 'dovetail-joint.jpg', { ...PHOTO_POSITION, precision: 'exact' }),
    async (out) => {
      let err = '';
      let stdout = '';
      const code = await run(['check', '--config', exampleConfig, '--out', out], {
        out: (text) => (stdout += text),
        err: (text) => (err += text),
      });
      assert.equal(code, 1);
      assert.match(err, /workshop\/img\/[0-9a-f]{16}\/dovetail-joint-full\.jpg: its position is not the original position rounded to two decimals/);
      assert.match(stdout, /^workshop: \d+ page\(s\), 7 feed\(s\), 6 image\(s\) checked, 1 failure\(s\)$/m);
    },
  );
});
