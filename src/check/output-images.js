import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

import {
  isCoarse,
  publishedPosition,
  readOriginalMetadata,
  readPublishedMetadata,
  sameCamera,
  samePosition,
} from '../images/metadata.js';
import { CAMERA_POLICIES, LOCATION_POLICIES } from '../images/policy.js';
import { inspectSvg } from '../images/svg.js';

/**
 * @typedef {import('../build.js').Manifest} Manifest
 * @typedef {import('../build.js').ManifestImage} ManifestImage
 */

/**
 * One problem found in a published image.
 *
 * @typedef {object} ImageFinding
 * @property {string} file Path of the file with the problem, relative to the site's output directory.
 * @property {string} message
 */

/**
 * @typedef {object} ImageCheckOptions
 * @property {string} [rootDir] Directory the manifest's `source` paths are relative to (the directory of the configuration file). When the original is found there, unchanged, the check compares the published position with the original's instead of trusting the manifest alone.
 */

/**
 * Whether the effective policy of an image, as the manifest records it, is a
 * usable one.
 *
 * @param {any} policy
 * @returns {boolean}
 */
function policyIsUsable(policy) {
  return (
    typeof policy === 'object' &&
    policy !== null &&
    LOCATION_POLICIES.includes(policy.location?.value) &&
    CAMERA_POLICIES.includes(policy.camera?.value)
  );
}

/**
 * Reads back every image the manifest lists and checks that what the files
 * say matches the metadata policy the manifest records for them:
 *
 * - `strip`: no position anywhere; `coarse`: the position of the viewer JPEG is
 *   the original's rounded to two decimals; `keep`: it is the original's;
 * - the camera fields are in the viewer JPEG only when the camera policy is
 *   `keep`, and then they are the ones the manifest lists;
 * - the WebP variants carry no metadata at all;
 * - the downloads of a press kit (listed under `projects[].downloads`) follow
 *   the same rules, have the pixel size of the original, and an SVG logo is
 *   the original file and contains nothing that could run script.
 *
 * The messages never contain a coordinate: a log of a failed check must not
 * give away the position a policy was meant to hide.
 *
 * @param {string} outDir Output directory of the site.
 * @param {Manifest} manifest
 * @param {ImageCheckOptions} [options]
 * @returns {Promise<{ findings: ImageFinding[], checked: number }>}
 */
export async function checkImages(outDir, manifest, options = {}) {
  /** @type {ImageFinding[]} */
  const findings = [];
  /** @type {Set<string>} */
  const reported = new Set();
  /**
   * @param {string} file
   * @param {string} message
   */
  const fail = (file, message) => {
    const id = `${file}\n${message}`;
    if (reported.has(id)) return;
    reported.add(id);
    findings.push({ file, message });
  };

  const entries = Array.isArray(manifest.images) ? manifest.images : [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, ReturnType<typeof readFile>>} */
  const originals = new Map();

  for (const image of entries) {
    const viewer = image.outputs?.find((output) => output.role === 'viewer');
    const label = `the image ${image.source} on ${image.post}`;
    if (!policyIsUsable(image.policy)) {
      fail(viewer?.file ?? image.source, `${label}: the manifest records no metadata policy for it`);
      continue;
    }
    const location = image.policy.location.value;
    const cameraPolicy = image.policy.camera.value;

    // What the manifest says is published has to follow from the policy.
    const claimed = image.gps ?? null;
    if (location === 'strip' && claimed !== null) {
      fail(viewer?.file ?? image.source, `${label}: the manifest lists a position, but the location policy is "strip"`);
    }
    if (location === 'coarse' && claimed !== null && !isCoarse(claimed)) {
      fail(viewer?.file ?? image.source, `${label}: the manifest lists a position that is not rounded, but the location policy is "coarse"`);
    }
    if (cameraPolicy === 'strip' && image.camera != null) {
      fail(viewer?.file ?? image.source, `${label}: the manifest lists camera fields, but the camera policy is "strip"`);
    }

    // The original, when it is at hand and unchanged, is the reference.
    /** @type {import('../images/metadata.js').PublishedPosition | null} */
    let expected = claimed;
    if (options.rootDir !== undefined && !originals.has(image.source)) {
      originals.set(image.source, readFile(join(options.rootDir, ...image.source.split('/')), image.sha256));
    }
    const original = await originals.get(image.source);
    if (original) {
      expected = publishedPosition(original.gps, location);
      const listed = claimed;
      const agrees =
        expected === null ? listed === null : listed !== null && listed.precision === expected.precision && samePosition(listed, expected);
      if (!agrees) {
        fail(viewer?.file ?? image.source, `${label}: the position in the manifest is not the one the location policy "${location}" gives for the original`);
      }
    }

    for (const output of image.outputs ?? []) {
      if (seen.has(output.file)) continue;
      seen.add(output.file);
      const path = join(outDir, ...output.file.split('/'));
      if (!existsSync(path)) {
        fail(output.file, `the manifest lists this image file, but it is missing`);
        continue;
      }
      /** @type {Buffer} */
      let bytes;
      try {
        bytes = readFileSync(path);
      } catch (error) {
        fail(output.file, `cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (output.role === 'viewer') {
        await checkViewer(output.file, bytes, { location, cameraPolicy, expected, camera: image.camera ?? null }, fail);
      } else {
        await checkVariant(output.file, bytes, fail);
      }
    }
  }

  const downloads = (Array.isArray(manifest.projects) ? manifest.projects : []).flatMap((project) =>
    Array.isArray(project.downloads) ? project.downloads : [],
  );
  for (const download of downloads) {
    await checkDownload(outDir, download, options, originals, fail);
  }
  return { findings, checked: entries.length + downloads.length };
}

/**
 * Reads back one download of a press kit.
 *
 * @param {string} outDir
 * @param {import('../build.js').ManifestDownload} download
 * @param {ImageCheckOptions} options
 * @param {Map<string, ReturnType<typeof readFile>>} originals
 * @param {(file: string, message: string) => void} fail
 */
async function checkDownload(outDir, download, options, originals, fail) {
  const file = download.file;
  const label = `the download ${download.source}`;
  const path = join(outDir, ...String(file).split('/'));
  if (!existsSync(path)) {
    fail(file, 'the manifest lists this download, but it is missing');
    return;
  }
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    fail(file, `cannot read the download: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // An SVG is published as it is, so it has to be the file that was built from, and safe to open.
  if (download.type === 'image/svg+xml') {
    if (createHash('sha256').update(bytes).digest('hex') !== download.sha256) {
      fail(file, `${label}: the published SVG is not the original file, but an SVG is published as it is`);
    }
    for (const problem of inspectSvg(bytes).problems) fail(file, `${label}: the SVG ${problem}`);
    return;
  }

  if (!policyIsUsable(download.policy)) {
    fail(file, `${label}: the manifest records no metadata policy for it`);
    return;
  }
  const location = download.policy?.location.value ?? 'strip';
  const cameraPolicy = download.policy?.camera.value ?? 'strip';
  const claimed = download.gps ?? null;
  if (location === 'strip' && claimed !== null) {
    fail(file, `${label}: the manifest lists a position, but the location policy is "strip"`);
  }
  if (location === 'coarse' && claimed !== null && !isCoarse(claimed)) {
    fail(file, `${label}: the manifest lists a position that is not rounded, but the location policy is "coarse"`);
  }
  if (cameraPolicy === 'strip' && download.camera != null) {
    fail(file, `${label}: the manifest lists camera fields, but the camera policy is "strip"`);
  }

  /** @type {import('../images/metadata.js').PublishedPosition | null} */
  let expected = claimed;
  let originalSize = null;
  if (options.rootDir !== undefined) {
    const sourcePath = join(options.rootDir, ...download.source.split('/'));
    if (!originals.has(download.source)) originals.set(download.source, readFile(sourcePath, download.sha256));
    const original = await originals.get(download.source);
    if (original) {
      expected = publishedPosition(original.gps, location);
      const agrees =
        expected === null ? claimed === null : claimed !== null && claimed.precision === expected.precision && samePosition(claimed, expected);
      if (!agrees) {
        fail(file, `${label}: the position in the manifest is not the one the location policy "${location}" gives for the original`);
      }
      try {
        const meta = await sharp(sourcePath).metadata();
        const turned = (meta.orientation ?? 1) >= 5;
        if (meta.width && meta.height) originalSize = { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height };
      } catch {
        // A format sharp cannot read (HEIC) has no size to compare with.
      }
    }
  }

  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch (error) {
    fail(file, `cannot read the download: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const format = download.type === 'image/png' ? 'png' : download.type === 'image/jpeg' ? 'jpeg' : null;
  if (format === null || metadata.format !== format) {
    fail(file, `is ${metadata.format ?? 'not an image'}, but the manifest says ${download.type}`);
  }
  if (metadata.width !== download.width || metadata.height !== download.height) {
    fail(file, `is ${metadata.width} by ${metadata.height} pixels, but the manifest says ${download.width} by ${download.height}`);
  }
  if (originalSize !== null && (metadata.width !== originalSize.width || metadata.height !== originalSize.height)) {
    fail(file, `is ${metadata.width} by ${metadata.height} pixels, but the original is ${originalSize.width} by ${originalSize.height}; a download is never resized`);
  }
  await checkViewer(file, bytes, { location, cameraPolicy, expected, camera: download.camera ?? null }, fail);
}

/**
 * @param {string} path
 * @param {string} sha256 Hash the manifest records for the original.
 * @returns {Promise<import('../images/metadata.js').OriginalMetadata | null>} The metadata of the original, or null when it is missing or is not the file that was built.
 */
async function readFile(path, sha256) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) return null;
  return readOriginalMetadata(bytes);
}

/**
 * @param {string} file
 * @param {Buffer} bytes
 * @param {{ location: string, cameraPolicy: string, expected: import('../images/metadata.js').PublishedPosition | null, camera: import('../images/metadata.js').CameraFields | null }} want
 * @param {(file: string, message: string) => void} fail
 */
async function checkViewer(file, bytes, want, fail) {
  const found = await readPublishedMetadata(bytes);

  if (want.expected === null) {
    if (found.gps !== null) {
      fail(file, `publishes a position, but the location policy "${want.location}" allows none for this image`);
    }
  } else if (found.gps === null) {
    fail(file, `has no position, but the location policy is "${want.location}"`);
  } else if (!samePosition(found.gps, want.expected)) {
    fail(
      file,
      want.location === 'coarse'
        ? 'its position is not the original position rounded to two decimals, as the location policy "coarse" requires'
        : `its position is not the original position, as the location policy "${want.location}" requires`,
    );
  }

  if (want.cameraPolicy === 'strip') {
    if (found.cameraTags.length > 0) {
      fail(file, `has camera fields (${found.cameraTags.join(', ')}), but the camera policy is "strip"`);
    }
  } else if (!sameCamera(found.camera, want.camera)) {
    fail(file, 'its camera fields are not the ones the manifest lists');
  }

  await checkNoOtherMetadata(file, bytes, fail);
}

/**
 * A WebP variant carries no metadata at all.
 *
 * @param {string} file
 * @param {Buffer} bytes
 * @param {(file: string, message: string) => void} fail
 */
async function checkVariant(file, bytes, fail) {
  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch (error) {
    fail(file, `cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (metadata.exif !== undefined) fail(file, 'carries EXIF data, but only the full-size JPEG may');
  await checkNoOtherMetadata(file, bytes, fail, metadata);
}

/**
 * XMP and IPTC can carry a position and a camera too; nothing published has them.
 *
 * @param {string} file
 * @param {Buffer} bytes
 * @param {(file: string, message: string) => void} fail
 * @param {import('sharp').Metadata} [known]
 */
async function checkNoOtherMetadata(file, bytes, fail, known) {
  let metadata = known;
  if (metadata === undefined) {
    try {
      metadata = await sharp(bytes).metadata();
    } catch (error) {
      fail(file, `cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  if (metadata.xmp !== undefined) fail(file, 'carries XMP data');
  if (metadata.iptc !== undefined) fail(file, 'carries IPTC data');
}
