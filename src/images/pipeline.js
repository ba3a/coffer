import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';

import { HEIC_DECODER_VERSION, HEIC_EXTENSIONS, decodeHeic, isHeic } from './decode.js';
import {
  DEFAULT_DOWNLOAD_JPEG_QUALITY,
  DEFAULT_IMAGE_WIDTH,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SIZES,
  DEFAULT_VIEWER_MAX_EDGE,
  DEFAULT_WEBP_QUALITY,
  DEFAULT_WIDTHS,
  IMAGE_EXTENSIONS,
} from './defaults.js';
import { exifFor, publishedPosition, readOriginalMetadata } from './metadata.js';
import { CAMERA_POLICIES, LOCATION_POLICIES } from './policy.js';

export {
  DEFAULT_DOWNLOAD_JPEG_QUALITY,
  DEFAULT_IMAGE_WIDTH,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SIZES,
  DEFAULT_VIEWER_MAX_EDGE,
  DEFAULT_WEBP_QUALITY,
  DEFAULT_WIDTHS,
  IMAGE_EXTENSIONS,
};

/** Image formats (as sharp names them) the pipeline accepts, whatever the file is called. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/** What to tell a person whose HEIC picture cannot be decoded. */
const CONVERT_HINT = 'convert the file to JPEG or PNG (for example by exporting it from your photo app) and use that instead';

/** Folder of the output (and address prefix) in which processed images are published. */
export const IMAGES_OUT_DIR = 'img';

/** Folder of the cache, below the cache root, that keeps processed images. */
export const IMAGES_CACHE_DIR = 'images';

/** Name of the file in a cache folder that lists what was produced. */
const INFO_FILE_NAME = 'info.json';

/**
 * Changes whenever the processing code changes in a way that alters the
 * files, so that images cached by an older engine are not reused.
 */
const PIPELINE_VERSION = 2;

/** Like {@link PIPELINE_VERSION}, for the full-resolution downloads. */
const DOWNLOAD_VERSION = 1;

/** Name of the file, without its extension, that a download is kept under in the cache. */
const DOWNLOAD_FILE_STEM = 'download';

/** The metadata policy of an image that is given none: nothing is published. */
const STRICT_POLICY = Object.freeze({ location: 'strip', camera: 'strip' });

// Do not keep files open between operations. The pipeline reads each original a
// few times and the originals change while a preview runs; on Windows an open
// file can neither be replaced nor deleted.
sharp.cache({ files: 0 });

/** Raised for an image that cannot be processed. */
export class ImageError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

/**
 * One file the pipeline produced.
 *
 * @typedef {object} ImageFile
 * @property {string} file File name inside the image's folder, such as `dovetail-800.webp`.
 * @property {number} width
 * @property {number} height
 * @property {number} bytes
 */

/**
 * An original image with everything made from it. All sizes are of the picture
 * as it is shown, with the EXIF orientation applied.
 *
 * @typedef {object} ProcessedImage
 * @property {string} source Absolute path of the original.
 * @property {string} sha256 Hash of the original.
 * @property {string} key Hash of the original and of the options; names the folder the files are published in.
 * @property {string} name Base name of the files, made from the name of the original.
 * @property {number} width Upright width of the original.
 * @property {number} height Upright height of the original.
 * @property {ImageFile[]} variants The WebP variants, narrowest first. Never wider than the original.
 * @property {ImageFile} viewer The full-size JPEG for the viewer, downloads and press kits.
 * @property {MetadataPolicy} policy The metadata policy the files were made under.
 * @property {import('./metadata.js').PublishedPosition | null} gps The position written into the viewer JPEG (exact, or rounded for `coarse`), or null when it carries none. No other file carries a position.
 * @property {import('./metadata.js').CameraFields | null} camera The camera fields written into the viewer JPEG, or null when it carries none.
 * @property {string} dir Absolute path of the folder in the cache that holds the files.
 * @property {string} url Site-relative address of the folder the files are published in, ending in a slash.
 * @property {boolean} cached True when the files were found in the cache.
 */

/**
 * What a published image keeps of the metadata of its original.
 *
 * @typedef {object} MetadataPolicy
 * @property {'strip' | 'coarse' | 'keep'} location Whether the viewer JPEG has no position, a position rounded to about a kilometre, or the exact position.
 * @property {'strip' | 'keep'} camera Whether the viewer JPEG has the camera's make, model, lens and exposure fields.
 */

/**
 * What a folder of the cache lists in its `info.json`.
 *
 * @typedef {object} CachedInfo
 * @property {number} width
 * @property {number} height
 * @property {ImageFile[]} variants
 * @property {ImageFile} viewer
 * @property {import('./metadata.js').PublishedPosition | null} gps
 * @property {import('./metadata.js').CameraFields | null} camera
 */

/**
 * A full-resolution file made from an original for people to download, such
 * as a screenshot in a press kit: the picture at the pixel size of the
 * original, upright, in the original's own kind of format (see
 * `download` of the pipeline), with the metadata its policy allows and
 * nothing else.
 *
 * @typedef {object} DownloadImage
 * @property {string} source Absolute path of the original.
 * @property {string} sha256 Hash of the original.
 * @property {string} key Hash of the original and of the options.
 * @property {'jpeg' | 'png'} format
 * @property {string} mime Media type of the file.
 * @property {string} extension File extension with the dot, lower case: `.jpg` or `.png`.
 * @property {number} width Upright width, the same as the original's.
 * @property {number} height Upright height, the same as the original's.
 * @property {number} bytes Size of the file.
 * @property {MetadataPolicy} policy The metadata policy the file was made under.
 * @property {import('./metadata.js').PublishedPosition | null} gps The position the file carries, or null when it carries none.
 * @property {import('./metadata.js').CameraFields | null} camera The camera fields the file carries, or null.
 * @property {string} path Absolute path of the file in the cache.
 * @property {boolean} cached True when the file was found in the cache.
 */

/**
 * What a folder of the cache lists about a download.
 *
 * @typedef {object} CachedDownload
 * @property {'jpeg' | 'png'} format
 * @property {number} width
 * @property {number} height
 * @property {number} bytes
 * @property {import('./metadata.js').PublishedPosition | null} gps
 * @property {import('./metadata.js').CameraFields | null} camera
 */

/**
 * @typedef {object} ImagePipelineOptions
 * @property {string} cacheDir Directory in which processed images are kept by hash (created when needed).
 * @property {readonly number[]} [widths] Widths of the WebP variants (default 480, 800, 1200, 1600, 2400).
 * @property {number} [viewerMaxEdge] Longest edge of the viewer JPEG (default 3200).
 * @property {number} [webpQuality] WebP quality, 1 to 100 (default 80).
 * @property {number} [jpegQuality] JPEG quality, 1 to 100 (default 85).
 * @property {number} [downloadJpegQuality] JPEG quality of the downloads of JPEG and HEIC originals, 1 to 100 (default 95).
 * @property {number} [concurrency] Images processed at the same time (default the number of CPU cores, at most 4).
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function integerOption(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Runs at most `limit` jobs at the same time; the rest wait their turn.
 *
 * @param {number} limit
 * @returns {<T>(job: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(limit) {
  let running = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  return async (job) => {
    // A finishing job hands its place straight to the next one in line.
    if (running >= limit) await new Promise((resolve) => waiting.push(() => resolve(undefined)));
    else running += 1;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * How to read the pixels of an original, and how big the picture is.
 *
 * @typedef {object} OpenedOriginal
 * @property {() => import('sharp').Sharp} open Starts a new sharp pipeline on the original; the picture is not yet turned upright.
 * @property {number} width Upright width.
 * @property {number} height Upright height.
 * @property {string} format The format of the file as sharp names it (`heic` for a HEIC picture).
 * @property {boolean} hasAlpha Whether the file has a transparency channel.
 */

/**
 * Reads the format and the size of an original, decoding a HEIC picture,
 * which sharp cannot read, to pixels first.
 *
 * @param {string} source
 * @param {Buffer} bytes The content of the original.
 * @param {boolean} heic Whether the original is a HEIC picture.
 * @returns {Promise<OpenedOriginal>}
 * @throws {ImageError} When the file is not an image of an accepted format or cannot be decoded.
 */
async function openOriginal(source, bytes, heic) {
  /** @type {() => import('sharp').Sharp} */
  let open;
  let width;
  let height;
  let format;
  let hasAlpha;
  if (heic) {
    /** @type {import('./decode.js').DecodedImage} */
    let decoded;
    try {
      decoded = await decodeHeic(bytes);
    } catch (error) {
      throw new ImageError(`cannot decode the HEIC image "${basename(source)}": ${error instanceof Error ? error.message : String(error)}; ${CONVERT_HINT}`);
    }
    // The pixels are already upright, so there is no orientation left to apply.
    const { data, channels } = decoded;
    open = () => sharp(data, { raw: { width: decoded.width, height: decoded.height, channels } });
    ({ width, height } = decoded);
    format = 'heic';
    hasAlpha = channels === 4;
  } else {
    let metadata;
    try {
      metadata = await sharp(source).metadata();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (HEIC_EXTENSIONS.includes(extname(source).toLowerCase())) {
        throw new ImageError(`cannot decode the HEIC image "${basename(source)}": the file is not a valid HEIC picture (${reason}); ${CONVERT_HINT}`);
      }
      throw new ImageError(`cannot read the image: ${reason}`);
    }
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
      throw new ImageError(`unsupported image format "${metadata.format ?? 'unknown'}" (use JPEG, PNG, WebP or HEIC)`);
    }
    if (!metadata.width || !metadata.height) throw new ImageError('the image has no size');
    // Orientations 5 to 8 turn the picture by a quarter.
    const turned = (metadata.orientation ?? 1) >= 5;
    width = turned ? metadata.height : metadata.width;
    height = turned ? metadata.width : metadata.height;
    open = () => sharp(source);
    format = metadata.format;
    hasAlpha = metadata.hasAlpha === true;
  }
  return { open, width, height, format, hasAlpha };
}

/**
 * The part of a file name that is safe in a URL: lower-case letters and digits
 * separated by hyphens.
 *
 * @param {string} file
 * @returns {string}
 */
function baseNameOf(file) {
  const stem = basename(file, extname(file))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem === '' ? 'image' : stem.slice(0, 60).replace(/-+$/, '');
}

/**
 * The widths of the variants of an image: the requested widths that are
 * narrower than the image, and the image's own width when it is not wider than
 * the widest request, so that nothing is ever enlarged and the full picture is
 * always available at its best.
 *
 * @param {readonly number[]} widths Requested widths, ascending.
 * @param {number} imageWidth
 * @returns {number[]}
 */
export function variantWidths(widths, imageWidth) {
  const chosen = widths.filter((width) => width < imageWidth);
  if (imageWidth <= /** @type {number} */ (widths[widths.length - 1])) chosen.push(imageWidth);
  return chosen;
}

/**
 * Picks the variant to show where no `srcset` is understood: the widest one
 * not wider than `width`, else the narrowest.
 *
 * @template {{ width: number }} T
 * @param {readonly T[]} variants Narrowest first.
 * @param {number} [width]
 * @returns {T}
 */
export function pickVariant(variants, width = DEFAULT_IMAGE_WIDTH) {
  let picked = /** @type {T} */ (variants[0]);
  for (const variant of variants) {
    if (variant.width <= width) picked = variant;
  }
  return picked;
}

/**
 * Creates the image pipeline of one site. For each original it makes WebP
 * variants at the configured widths, which never carry metadata, and one
 * full-size JPEG for the viewer, whose position and camera fields follow the
 * metadata policy given to `process`. All are rotated upright by their EXIF
 * orientation. They are kept in a cache keyed by the hash of the original, the
 * policy and the options, so an unchanged photo is processed once. Originals
 * are never published.
 *
 * @param {ImagePipelineOptions} options
 */
export function createImagePipeline(options) {
  const widths = [...new Set(options.widths ?? DEFAULT_WIDTHS)].sort((a, b) => a - b);
  if (widths.length === 0) throw new TypeError('widths must not be empty');
  for (const width of widths) integerOption(width, 'every width', 16, 20000, 0);
  const viewerMaxEdge = integerOption(options.viewerMaxEdge, 'viewerMaxEdge', 64, 30000, DEFAULT_VIEWER_MAX_EDGE);
  const webpQuality = integerOption(options.webpQuality, 'webpQuality', 1, 100, DEFAULT_WEBP_QUALITY);
  const jpegQuality = integerOption(options.jpegQuality, 'jpegQuality', 1, 100, DEFAULT_JPEG_QUALITY);
  const downloadJpegQuality = integerOption(
    options.downloadJpegQuality,
    'downloadJpegQuality',
    1,
    100,
    DEFAULT_DOWNLOAD_JPEG_QUALITY,
  );
  const concurrency = integerOption(
    options.concurrency,
    'concurrency',
    1,
    64,
    Math.max(1, Math.min(4, availableParallelism())),
  );
  const cacheDir = options.cacheDir;
  const limit = createLimiter(concurrency);
  const stats = { generated: 0, reused: 0 };
  /** @type {Map<string, Promise<ProcessedImage>>} */
  const processing = new Map();
  /** @type {Set<string>} */
  const published = new Set();
  /** @type {Map<string, Promise<DownloadImage>>} */
  const downloading = new Map();

  /**
   * @param {string} folder
   * @returns {CachedInfo | null} What a folder of the cache holds, or null when it is missing or incomplete.
   */
  function readCached(folder) {
    try {
      const info = JSON.parse(readFileSync(join(folder, INFO_FILE_NAME), 'utf8'));
      /** @type {ImageFile[]} */
      const files = [...info.variants, info.viewer];
      for (const entry of files) {
        if (statSync(join(folder, entry.file)).size !== entry.bytes) return null;
      }
      return info;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} source
   * @param {Buffer} bytes The content of the original.
   * @param {string} sha256
   * @param {string} name
   * @param {string} key
   * @param {boolean} heic Whether the original is a HEIC picture, which sharp cannot read.
   * @param {MetadataPolicy} policy
   * @returns {Promise<ProcessedImage>}
   */
  async function produce(source, bytes, sha256, name, key, heic, policy) {
    const folder = join(cacheDir, key);
    const found = readCached(folder);
    if (found) {
      stats.reused += 1;
      return describe(source, sha256, name, key, folder, found, policy, true);
    }

    // Only what the policy lets through is ever taken from the original.
    const original =
      policy.location === 'strip' && policy.camera === 'strip'
        ? { gps: null, camera: null }
        : await readOriginalMetadata(bytes);
    const gps = publishedPosition(original.gps, policy.location);
    const camera = policy.camera === 'keep' ? original.camera : null;
    const exif = exifFor(gps, camera);

    const { open, width, height } = await openOriginal(source, bytes, heic);

    const work = join(cacheDir, `${key}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      /** @type {ImageFile[]} */
      const variants = [];
      for (const target of variantWidths(widths, width)) {
        const file = `${name}-${target}.webp`;
        const info = await open()
          .autoOrient()
          .resize({ width: target, withoutEnlargement: true })
          .webp({ quality: webpQuality })
          .toFile(join(work, file));
        variants.push({ file, width: info.width, height: info.height, bytes: info.size });
      }
      const viewerFile = `${name}-full.jpg`;
      // The variants never carry metadata. The viewer JPEG gets only the EXIF
      // data the policy allows (sharp writes none unless it is told to), and it
      // is upright, so it needs no orientation tag.
      const viewerImage = open()
        .autoOrient()
        .flatten({ background: '#ffffff' })
        .resize({ width: viewerMaxEdge, height: viewerMaxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: jpegQuality, mozjpeg: true });
      if (exif !== null) viewerImage.withExif(exif);
      const viewerInfo = await viewerImage.toFile(join(work, viewerFile));
      const viewer = { file: viewerFile, width: viewerInfo.width, height: viewerInfo.height, bytes: viewerInfo.size };
      /** @type {CachedInfo} */
      const info = { width, height, variants, viewer, gps, camera };
      writeFileSync(join(work, INFO_FILE_NAME), `${JSON.stringify(info)}\n`);
      rmSync(folder, { recursive: true, force: true });
      renameSync(work, folder);
      stats.generated += 1;
      return describe(source, sha256, name, key, folder, info, policy, false);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      if (error instanceof ImageError) throw error;
      throw new ImageError(`cannot process the image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @param {string} folder
   * @returns {CachedDownload | null} What a folder of the cache holds for a download, or null when it is missing or incomplete.
   */
  function readCachedDownload(folder) {
    try {
      /** @type {CachedDownload} */
      const info = JSON.parse(readFileSync(join(folder, INFO_FILE_NAME), 'utf8'));
      const file = join(folder, `${DOWNLOAD_FILE_STEM}${info.format === 'png' ? '.png' : '.jpg'}`);
      return statSync(file).size === info.bytes ? info : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} source
   * @param {Buffer} bytes The content of the original.
   * @param {string} sha256
   * @param {string} key
   * @param {boolean} heic
   * @param {MetadataPolicy} policy
   * @returns {Promise<DownloadImage>}
   */
  async function produceDownload(source, bytes, sha256, key, heic, policy) {
    const folder = join(cacheDir, `dl-${key}`);
    const found = readCachedDownload(folder);
    if (found) {
      stats.reused += 1;
      return describeDownload(source, sha256, key, folder, found, policy, true);
    }

    // Only what the policy lets through is ever taken from the original.
    const original =
      policy.location === 'strip' && policy.camera === 'strip'
        ? { gps: null, camera: null }
        : await readOriginalMetadata(bytes);
    const gps = publishedPosition(original.gps, policy.location);
    const camera = policy.camera === 'keep' ? original.camera : null;
    const exif = exifFor(gps, camera);

    const { open, width, height, format: sourceFormat, hasAlpha } = await openOriginal(source, bytes, heic);
    // A PNG stays a PNG, and so does a WebP picture that has transparency;
    // anything else becomes a JPEG, which every viewer opens.
    const format = sourceFormat === 'png' || (sourceFormat === 'webp' && hasAlpha) ? 'png' : 'jpeg';
    const file = `${DOWNLOAD_FILE_STEM}${format === 'png' ? '.png' : '.jpg'}`;

    const work = join(cacheDir, `dl-${key}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      // The picture is turned upright and never resized. Sharp writes no
      // metadata unless it is told to, so only what the policy allows is added.
      const image = open().autoOrient();
      if (format === 'png') {
        image.png({ compressionLevel: 9 });
      } else {
        image
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: downloadJpegQuality, mozjpeg: true, chromaSubsampling: '4:4:4' });
      }
      if (exif !== null) image.withExif(exif);
      const info = await image.toFile(join(work, file));
      if (info.width !== width || info.height !== height) {
        throw new Error(`the file is ${info.width} by ${info.height} pixels, not ${width} by ${height}`);
      }
      /** @type {CachedDownload} */
      const cachedInfo = { format, width, height, bytes: info.size, gps, camera };
      writeFileSync(join(work, INFO_FILE_NAME), `${JSON.stringify(cachedInfo)}\n`);
      rmSync(folder, { recursive: true, force: true });
      renameSync(work, folder);
      stats.generated += 1;
      return describeDownload(source, sha256, key, folder, cachedInfo, policy, false);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      if (error instanceof ImageError) throw error;
      throw new ImageError(`cannot process the image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @param {string} source
   * @param {string} sha256
   * @param {string} key
   * @param {string} folder
   * @param {CachedDownload} info
   * @param {MetadataPolicy} policy
   * @param {boolean} cached
   * @returns {DownloadImage}
   */
  function describeDownload(source, sha256, key, folder, info, policy, cached) {
    const png = info.format === 'png';
    return {
      source,
      sha256,
      key,
      format: info.format,
      mime: png ? 'image/png' : 'image/jpeg',
      extension: png ? '.png' : '.jpg',
      width: info.width,
      height: info.height,
      bytes: info.bytes,
      policy: { ...policy },
      gps: info.gps ?? null,
      camera: info.camera ?? null,
      path: join(folder, `${DOWNLOAD_FILE_STEM}${png ? '.png' : '.jpg'}`),
      cached,
    };
  }

  /**
   * @param {Partial<MetadataPolicy>} policy
   * @returns {MetadataPolicy}
   */
  function effectivePolicy(policy) {
    const effective = {
      location: /** @type {MetadataPolicy['location']} */ (policy.location ?? STRICT_POLICY.location),
      camera: /** @type {MetadataPolicy['camera']} */ (policy.camera ?? STRICT_POLICY.camera),
    };
    if (!LOCATION_POLICIES.includes(effective.location)) {
      throw new TypeError(`location must be one of: ${LOCATION_POLICIES.join(', ')}`);
    }
    if (!CAMERA_POLICIES.includes(effective.camera)) {
      throw new TypeError(`camera must be one of: ${CAMERA_POLICIES.join(', ')}`);
    }
    return effective;
  }

  /**
   * @param {string} source
   * @param {string} sha256
   * @param {string} name
   * @param {string} key
   * @param {string} folder
   * @param {CachedInfo} info
   * @param {MetadataPolicy} policy
   * @param {boolean} cached
   * @returns {ProcessedImage}
   */
  function describe(source, sha256, name, key, folder, info, policy, cached) {
    return {
      source,
      sha256,
      key,
      name,
      width: info.width,
      height: info.height,
      variants: info.variants,
      viewer: info.viewer,
      policy: { ...policy },
      gps: info.gps ?? null,
      camera: info.camera ?? null,
      dir: folder,
      url: `/${IMAGES_OUT_DIR}/${key}/`,
      cached,
    };
  }

  return {
    /** The options in effect. */
    options: Object.freeze({
      widths: Object.freeze(widths),
      viewerMaxEdge,
      webpQuality,
      jpegQuality,
      downloadJpegQuality,
      concurrency,
    }),
    /** Images processed and images found in the cache since the pipeline was created. */
    stats,

    /**
     * Processes an original, or finds its files in the cache. An original is
     * processed once per pipeline, however often it is asked for.
     *
     * @param {string} source Absolute path of a JPEG, PNG, WebP or HEIC file.
     * @param {Partial<MetadataPolicy>} [policy] What the viewer JPEG keeps of the original's location and camera fields (default `strip` for both).
     * @returns {Promise<ProcessedImage>}
     * @throws {ImageError} When the file is not an image of an accepted format or cannot be decoded.
     * @throws {TypeError} When the policy has an unknown value.
     */
    process(source, policy = {}) {
      const effective = effectivePolicy(policy);
      const id = `${source}\n${effective.location}\n${effective.camera}`;
      let pending = processing.get(id);
      if (!pending) {
        pending = limit(async () => {
          if (!IMAGE_EXTENSIONS.includes(extname(source).toLowerCase())) {
            throw new ImageError(`unsupported image format "${extname(source) || source}" (use JPEG, PNG, WebP or HEIC)`);
          }
          let bytes;
          try {
            bytes = readFileSync(source);
          } catch (error) {
            throw new ImageError(`cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const heic = isHeic(bytes);
          const name = baseNameOf(source);
          const key = createHash('sha256')
            .update(
              JSON.stringify({
                version: PIPELINE_VERSION,
                sharp: sharp.versions.sharp,
                vips: sharp.versions.vips,
                sha256,
                ...(heic ? { heic: HEIC_DECODER_VERSION } : {}),
                name,
                location: effective.location,
                camera: effective.camera,
                widths,
                viewerMaxEdge,
                webpQuality,
                jpegQuality,
              }),
            )
            .digest('hex')
            .slice(0, 16);
          return produce(source, bytes, sha256, name, key, heic, effective);
        });
        processing.set(id, pending);
      }
      return pending;
    },

    /**
     * Makes the full-resolution file of an original, for people to download
     * (the images of a press kit), or finds it in the cache. Unlike the
     * viewer JPEG it is never resized: it has the pixel size of the upright
     * original. A PNG stays a PNG, with its transparency; a WebP picture with
     * transparency becomes a PNG; every other original becomes a JPEG at
     * `downloadJpegQuality`. The file carries the position and the camera
     * fields its policy allows, and no other metadata.
     *
     * @param {string} source Absolute path of a JPEG, PNG, WebP or HEIC file.
     * @param {Partial<MetadataPolicy>} [policy] What the file keeps of the original's location and camera fields (default `strip` for both).
     * @returns {Promise<DownloadImage>}
     * @throws {ImageError} When the file is not an image of an accepted format or cannot be decoded.
     * @throws {TypeError} When the policy has an unknown value.
     */
    download(source, policy = {}) {
      const effective = effectivePolicy(policy);
      const id = `${source}\n${effective.location}\n${effective.camera}`;
      let pending = downloading.get(id);
      if (!pending) {
        pending = limit(async () => {
          if (!IMAGE_EXTENSIONS.includes(extname(source).toLowerCase())) {
            throw new ImageError(`unsupported image format "${extname(source) || source}" (use JPEG, PNG, WebP or HEIC)`);
          }
          let bytes;
          try {
            bytes = readFileSync(source);
          } catch (error) {
            throw new ImageError(`cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const heic = isHeic(bytes);
          const key = createHash('sha256')
            .update(
              JSON.stringify({
                download: DOWNLOAD_VERSION,
                sharp: sharp.versions.sharp,
                vips: sharp.versions.vips,
                sha256,
                ...(heic ? { heic: HEIC_DECODER_VERSION } : {}),
                location: effective.location,
                camera: effective.camera,
                downloadJpegQuality,
              }),
            )
            .digest('hex')
            .slice(0, 16);
          return produceDownload(source, bytes, sha256, key, heic, effective);
        });
        downloading.set(id, pending);
      }
      return pending;
    },

    /**
     * Copies a download into the output of a site, to the given address.
     *
     * @param {DownloadImage} image
     * @param {string} outDir Output directory of the site.
     * @param {string} address Site-relative address of the published file, such as `/made/game/press-kit/game-logo-01.png`. The caller makes it from checked text.
     */
    publishDownload(image, outDir, address) {
      const target = join(outDir, ...address.split('/').filter(Boolean));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(image.path, target);
    },

    /**
     * Copies the files made from an original into the output of a site, to
     * `img/{key}/`. The original itself is never copied.
     *
     * @param {ProcessedImage} image
     * @param {string} outDir Output directory of the site.
     */
    publish(image, outDir) {
      const id = `${outDir}\n${image.key}`;
      if (published.has(id)) return;
      const target = join(outDir, IMAGES_OUT_DIR, image.key);
      mkdirSync(target, { recursive: true });
      for (const entry of [...image.variants, image.viewer]) {
        const file = join(target, entry.file);
        if (!existsSync(file)) copyFileSync(join(image.dir, entry.file), file);
      }
      published.add(id);
    },
  };
}

/**
 * Site-relative address of a file made from an image.
 *
 * @param {ProcessedImage} image
 * @param {ImageFile} file
 * @returns {string}
 */
export function imageFileUrl(image, file) {
  return `${image.url}${file.file}`;
}
