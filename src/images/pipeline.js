import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';

import {
  DEFAULT_IMAGE_WIDTH,
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SIZES,
  DEFAULT_VIEWER_MAX_EDGE,
  DEFAULT_WEBP_QUALITY,
  DEFAULT_WIDTHS,
  IMAGE_EXTENSIONS,
} from './defaults.js';

export {
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
const PIPELINE_VERSION = 1;

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
 * @property {string} dir Absolute path of the folder in the cache that holds the files.
 * @property {string} url Site-relative address of the folder the files are published in, ending in a slash.
 * @property {boolean} cached True when the files were found in the cache.
 */

/**
 * @typedef {object} ImagePipelineOptions
 * @property {string} cacheDir Directory in which processed images are kept by hash (created when needed).
 * @property {readonly number[]} [widths] Widths of the WebP variants (default 480, 800, 1200, 1600, 2400).
 * @property {number} [viewerMaxEdge] Longest edge of the viewer JPEG (default 3200).
 * @property {number} [webpQuality] WebP quality, 1 to 100 (default 80).
 * @property {number} [jpegQuality] JPEG quality, 1 to 100 (default 85).
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
 * variants at the configured widths and one full-size JPEG for the viewer, all
 * rotated upright by their EXIF orientation and without any metadata, and
 * keeps them in a cache keyed by the hash of the original and the options, so
 * an unchanged photo is processed once. Originals are never published.
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

  /**
   * @param {string} folder
   * @returns {{ width: number, height: number, variants: ImageFile[], viewer: ImageFile } | null} What a folder of the cache holds, or null when it is missing or incomplete.
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
   * @param {string} sha256
   * @param {string} name
   * @param {string} key
   * @returns {Promise<ProcessedImage>}
   */
  async function produce(source, sha256, name, key) {
    const folder = join(cacheDir, key);
    const found = readCached(folder);
    if (found) {
      stats.reused += 1;
      return describe(source, sha256, name, key, folder, found, true);
    }

    let metadata;
    try {
      metadata = await sharp(source).metadata();
    } catch (error) {
      throw new ImageError(`cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format)) {
      throw new ImageError(`unsupported image format "${metadata.format ?? 'unknown'}" (use JPEG, PNG or WebP)`);
    }
    if (!metadata.width || !metadata.height) throw new ImageError('the image has no size');
    // Orientations 5 to 8 turn the picture by a quarter.
    const turned = (metadata.orientation ?? 1) >= 5;
    const width = turned ? metadata.height : metadata.width;
    const height = turned ? metadata.width : metadata.height;

    const work = join(cacheDir, `${key}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      /** @type {ImageFile[]} */
      const variants = [];
      for (const target of variantWidths(widths, width)) {
        const file = `${name}-${target}.webp`;
        const info = await sharp(source)
          .autoOrient()
          .resize({ width: target, withoutEnlargement: true })
          .webp({ quality: webpQuality })
          .toFile(join(work, file));
        variants.push({ file, width: info.width, height: info.height, bytes: info.size });
      }
      const viewerFile = `${name}-full.jpg`;
      const viewerInfo = await sharp(source)
        .autoOrient()
        .flatten({ background: '#ffffff' })
        .resize({ width: viewerMaxEdge, height: viewerMaxEdge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toFile(join(work, viewerFile));
      const viewer = { file: viewerFile, width: viewerInfo.width, height: viewerInfo.height, bytes: viewerInfo.size };
      const info = { width, height, variants, viewer };
      writeFileSync(join(work, INFO_FILE_NAME), `${JSON.stringify(info)}\n`);
      rmSync(folder, { recursive: true, force: true });
      renameSync(work, folder);
      stats.generated += 1;
      return describe(source, sha256, name, key, folder, info, false);
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      if (error instanceof ImageError) throw error;
      throw new ImageError(`cannot process the image: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * @param {string} source
   * @param {string} sha256
   * @param {string} name
   * @param {string} key
   * @param {string} folder
   * @param {{ width: number, height: number, variants: ImageFile[], viewer: ImageFile }} info
   * @param {boolean} cached
   * @returns {ProcessedImage}
   */
  function describe(source, sha256, name, key, folder, info, cached) {
    return {
      source,
      sha256,
      key,
      name,
      width: info.width,
      height: info.height,
      variants: info.variants,
      viewer: info.viewer,
      dir: folder,
      url: `/${IMAGES_OUT_DIR}/${key}/`,
      cached,
    };
  }

  return {
    /** The options in effect. */
    options: Object.freeze({ widths: Object.freeze(widths), viewerMaxEdge, webpQuality, jpegQuality, concurrency }),
    /** Images processed and images found in the cache since the pipeline was created. */
    stats,

    /**
     * Processes an original, or finds its files in the cache. An original is
     * processed once per pipeline, however often it is asked for.
     *
     * @param {string} source Absolute path of a JPEG, PNG or WebP file.
     * @returns {Promise<ProcessedImage>}
     * @throws {ImageError} When the file is not an image of an accepted format or cannot be decoded.
     */
    process(source) {
      let pending = processing.get(source);
      if (!pending) {
        pending = limit(async () => {
          if (!IMAGE_EXTENSIONS.includes(extname(source).toLowerCase())) {
            throw new ImageError(`unsupported image format "${extname(source) || source}" (use JPEG, PNG or WebP)`);
          }
          let bytes;
          try {
            bytes = readFileSync(source);
          } catch (error) {
            throw new ImageError(`cannot read the image: ${error instanceof Error ? error.message : String(error)}`);
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const name = baseNameOf(source);
          const key = createHash('sha256')
            .update(
              JSON.stringify({
                version: PIPELINE_VERSION,
                sharp: sharp.versions.sharp,
                vips: sharp.versions.vips,
                sha256,
                name,
                widths,
                viewerMaxEdge,
                webpQuality,
                jpegQuality,
              }),
            )
            .digest('hex')
            .slice(0, 16);
          return produce(source, sha256, name, key);
        });
        processing.set(source, pending);
      }
      return pending;
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
