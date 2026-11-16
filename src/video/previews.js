/**
 * The previews of remote videos: a title and a thumbnail fetched from the host
 * at build time and kept in a cache folder (spec sections 9.1 to 9.3).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ImageError } from '../images/pipeline.js';
import { readVersion } from '../version.js';
import { metadataUrl, thumbnailUrl, watchUrl } from './urls.js';

/** @typedef {import('./rules.js').VideoMatch} VideoMatch */

/** Folder of the cache, below the cache root, that keeps video previews. */
export const VIDEO_CACHE_DIR = 'videos';

/** How long a request may take, in milliseconds, unless the caller says otherwise. */
export const DEFAULT_PREVIEW_TIMEOUT_MS = 10000;

/** The largest thumbnail accepted, in bytes (10 MiB). */
export const MAX_PREVIEW_BYTES = 10485760;

/** File extension of a cached thumbnail by its media type. */
const EXTENSIONS = /** @type {Readonly<Record<string, string>>} */ (
  Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })
);

/**
 * @template T
 * @typedef {object} VideoPreviewsOptions
 * @property {string} cacheDir The folder that keeps the previews, usually `{cache root}/videos`.
 * @property {(file: string, match: VideoMatch) => Promise<T>} processImage Processes a thumbnail file. It throws an `ImageError` for a file that is not a usable image.
 * @property {typeof fetch} [fetch] Default the global `fetch`.
 * @property {number} [timeoutMs] Time after which a request is aborted (default 10000).
 * @property {string} [userAgent] Default `coffer/{version}`.
 * @property {boolean} [enabled] Whether requests may be made (default true). A cached preview is used either way.
 */

/**
 * What is known of a video's preview: a title from the host (or null) and
 * either the processed thumbnail or the reason it could not be fetched.
 *
 * @template T
 * @typedef {{ title: string | null, image: T } | { title: string | null, warning: string }} VideoPreviewResult
 */

/**
 * Raised inside a fetch to end it with a reason of spec section 12.3.
 */
class PreviewFailure extends Error {
  /**
   * @param {string} reason
   */
  constructor(reason) {
    super(reason);
    this.name = 'PreviewFailure';
  }
}

/**
 * The cache key of a remote video: the lower-case hex SHA-256 of its watch URL
 * without a time.
 *
 * @param {VideoMatch} match
 * @returns {string}
 */
export function previewCacheKey(match) {
  return createHash('sha256').update(watchUrl(match, null), 'utf8').digest('hex');
}

/**
 * Creates the preview fetcher of one build. It sends at most one request
 * sequence per cache key, however often a key is asked for.
 *
 * @template T
 * @param {VideoPreviewsOptions<T>} options
 */
export function createVideoPreviews(options) {
  const { cacheDir, processImage } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS;
  const userAgent = options.userAgent ?? `coffer/${readVersion()}`;
  const enabled = options.enabled ?? true;
  /** @type {Map<string, Promise<VideoPreviewResult<T> | undefined>>} */
  const pending = new Map();

  /**
   * The cache entry of a key, or null when there is no valid one.
   *
   * @param {string} key
   * @returns {{ title: string | null, file: string } | null}
   */
  function readEntry(key) {
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(cacheDir, `${key}.json`), 'utf8'));
    } catch {
      return null;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const { title, thumbnail } = entry;
    if (!(title === null || typeof title === 'string') || typeof thumbnail !== 'string') return null;
    // The entry names a file of the cache folder, nothing else.
    if (basename(thumbnail) !== thumbnail) return null;
    const file = join(cacheDir, thumbnail);
    try {
      if (!statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    return { title, file };
  }

  /**
   * Sends a GET request and hands the response to `read`, all under one
   * timeout. Turns a timeout or a failed request into its reason.
   *
   * @template R
   * @param {string} url
   * @param {string} accept
   * @param {(response: Response) => Promise<R>} read
   * @returns {Promise<R>}
   */
  async function request(url, accept, read) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { Accept: accept, 'User-Agent': userAgent },
        redirect: 'follow',
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new PreviewFailure(`${url} answered ${response.status}`);
      }
      return await read(response);
    } catch (error) {
      if (error instanceof PreviewFailure) throw error;
      if (signal.aborted) throw new PreviewFailure(`${url} did not answer within ${timeoutMs} ms`);
      throw new PreviewFailure(`${url} could not be reached`);
    }
  }

  /**
   * Reads a body of at most `limit` bytes, or returns null when it is longer.
   *
   * @param {Response} response
   * @param {number} limit
   * @returns {Promise<Buffer | null>}
   */
  async function readLimited(response, limit) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.body) return Buffer.from(await response.arrayBuffer());
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Fetches, processes and caches the preview of a video.
   *
   * @param {VideoMatch} match
   * @param {string} key
   * @param {string | null} metadata
   * @param {string | null} template
   * @returns {Promise<VideoPreviewResult<T>>}
   */
  async function fetchPreview(match, key, metadata, template) {
    /** @type {string | null} */
    let title = null;
    try {
      let thumbnail = template;
      if (metadata !== null) {
        const body = await request(metadata, 'application/json', async (response) => {
          const text = await response.text();
          try {
            return JSON.parse(text);
          } catch {
            return undefined;
          }
        });
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new PreviewFailure(`${metadata} did not return a JSON object`);
        }
        if (typeof body.title === 'string' && body.title.trim() !== '') title = body.title.trim();
        const found = body.thumbnail_url;
        thumbnail =
          typeof found === 'string' && (found.startsWith('https://') || found.startsWith('http://')) ? found : null;
        if (thumbnail === null) throw new PreviewFailure(`${metadata} returned no thumbnail`);
      }
      const url = /** @type {string} */ (thumbnail);
      const { ext, bytes } = await request(url, 'image/*', async (response) => {
        const header = response.headers.get('content-type');
        // A missing header and an empty media type are the same: no type.
        const type = (header ?? '').split(';')[0].trim().toLowerCase() || 'no type';
        const ext = EXTENSIONS[type];
        if (!ext) {
          await response.body?.cancel().catch(() => {});
          throw new PreviewFailure(`${url} returned ${type}, not a JPEG, PNG or WebP image`);
        }
        const bytes = await readLimited(response, MAX_PREVIEW_BYTES);
        if (bytes === null) throw new PreviewFailure(`${url} is larger than 10 MiB`);
        return { ext, bytes };
      });
      const name = `${key}.${ext}`;
      const file = join(cacheDir, name);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, bytes);
      let image;
      try {
        image = await processImage(file, match);
      } catch (error) {
        rmSync(file, { force: true });
        if (error instanceof ImageError) throw new PreviewFailure(`the image from ${url} could not be decoded`);
        throw error;
      }
      writeFileSync(join(cacheDir, `${key}.json`), JSON.stringify({ title, thumbnail: name }));
      return { title, image };
    } catch (error) {
      if (error instanceof PreviewFailure) return { title, warning: error.message };
      throw error;
    }
  }

  /**
   * @param {VideoMatch} match
   * @param {string} key
   * @returns {Promise<VideoPreviewResult<T> | undefined>}
   */
  async function resolve(match, key) {
    const entry = readEntry(key);
    if (entry) {
      try {
        return { title: entry.title, image: await processImage(entry.file, match) };
      } catch (error) {
        if (!(error instanceof ImageError)) throw error;
        // A cached file that no longer decodes is no cache entry: fetch again.
        rmSync(join(cacheDir, `${key}.json`), { force: true });
        rmSync(entry.file, { force: true });
      }
    }
    if (!enabled) return undefined;
    const metadata = metadataUrl(match);
    const template = metadata === null ? thumbnailUrl(match) : null;
    if (metadata === null && template === null) return undefined;
    return fetchPreview(match, key, metadata, template);
  }

  return {
    /**
     * The preview of a remote video: from the cache, else fetched from the
     * host. Nothing when fetching is disabled or the provider offers neither
     * metadata nor a thumbnail. A failure gives the reason as `warning`, with
     * the title from the host when the metadata request succeeded.
     *
     * @param {VideoMatch} match
     * @returns {Promise<VideoPreviewResult<T> | undefined>}
     */
    preview(match) {
      const key = previewCacheKey(match);
      let found = pending.get(key);
      if (!found) {
        found = resolve(match, key);
        pending.set(key, found);
      }
      return found;
    },
  };
}
