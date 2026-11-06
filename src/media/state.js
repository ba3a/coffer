import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { hashFile, writeFileAtomic } from './fsutil.js';
import { checkMediaPath, compareBytes } from './paths.js';

/**
 * The two files the media commands keep in `.coffer/` beside the configuration.
 * Neither is committed (the folder is ignored), both are written atomically and
 * both can be lost or damaged without harm:
 *
 * - `media-cache.json` remembers the hash of a file together with its size and
 *   modification time, so that a file that has not changed is not read again;
 *   without it everything is hashed again.
 * - `media-state.json` remembers what this working copy has in common with the
 *   lock: the content of each file as it was when it was last locked, pushed or
 *   pulled. It is what lets `pull` delete a file that was removed elsewhere
 *   (only when the file is still exactly what was recorded) and is the reason
 *   a file that was never synced is never deleted. Without it nothing is
 *   deleted.
 */

/** The folder, beside the configuration file. */
export const STATE_DIR_NAME = '.coffer';

/** The hash cache. */
export const CACHE_FILE_NAME = 'media-cache.json';

/** The record of what was synced. */
export const STATE_FILE_NAME = 'media-state.json';

/** The largest cache or state file that is read; a larger one is taken for damaged. */
const MAX_STATE_BYTES = 128 * 1024 * 1024;

/**
 * A file modified less than this long before it was hashed is hashed again
 * next time, whatever its size and time say: on a file system with coarse
 * timestamps a second edit could otherwise hide behind the first.
 */
export const RACY_WINDOW_MS = 2500;

/**
 * Reads a JSON file that may be missing or damaged.
 *
 * @param {string} file
 * @returns {Promise<unknown>} The parsed value, or null when the file is missing, too large or not JSON.
 */
async function readJsonLeniently(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return null;
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} root Absolute path of the media root.
 * @returns {Promise<string>} The folder `.coffer` (made if it is missing).
 */
async function ensureStateDir(root) {
  const dir = join(root, STATE_DIR_NAME);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What the hash cache knows about a file.
 *
 * @typedef {object} CacheEntry
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} hashedAt When the hash was made, in milliseconds since the epoch.
 * @property {string} sha256
 */

/**
 * The hash cache.
 */
export class HashCache {
  /**
   * @param {string} root Absolute path of the media root.
   * @param {Map<string, CacheEntry>} entries
   */
  constructor(root, entries) {
    this.root = root;
    this.entries = entries;
  }

  /**
   * Loads the cache; a missing or damaged file gives an empty cache.
   *
   * @param {string} root
   * @returns {Promise<HashCache>}
   */
  static async load(root) {
    const data = await readJsonLeniently(join(root, STATE_DIR_NAME, CACHE_FILE_NAME));
    /** @type {Map<string, CacheEntry>} */
    const entries = new Map();
    if (isObject(data) && data.version === 1 && isObject(data.files)) {
      for (const [path, entry] of Object.entries(data.files)) {
        if (!isObject(entry) || !('value' in checkMediaPath(path))) continue;
        const { size, mtimeMs, hashedAt, sha256 } = entry;
        if (
          typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 &&
          typeof mtimeMs === 'number' && Number.isFinite(mtimeMs) &&
          typeof hashedAt === 'number' && Number.isFinite(hashedAt) &&
          typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)
        ) {
          entries.set(path, { size, mtimeMs, hashedAt, sha256 });
        }
      }
    }
    return new HashCache(root, entries);
  }

  /**
   * The hash of a file: from the cache when its size and modification time
   * are what was recorded (and the record is not racy), otherwise by reading
   * it. The file is read in chunks. A file that changes while it is being read
   * is an error rather than a wrong hash.
   *
   * @param {string} rel The path of the original, with `/`.
   * @param {string} file Absolute path.
   * @param {{ size: number, mtimeMs: number }} info The file's status as the caller saw it.
   * @returns {Promise<{ sha256: string, size: number, cached: boolean }>}
   */
  async hash(rel, file, info) {
    const known = this.entries.get(rel);
    if (
      known !== undefined &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs &&
      known.hashedAt - known.mtimeMs >= RACY_WINDOW_MS
    ) {
      return { sha256: known.sha256, size: known.size, cached: true };
    }
    const hashedAt = Date.now();
    const result = await hashFile(file);
    const after = await stat(file);
    if (result.size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error(`${rel} changed while it was being read; try again when nothing is writing to it`);
    }
    this.entries.set(rel, { size: info.size, mtimeMs: info.mtimeMs, hashedAt, sha256: result.sha256 });
    return { sha256: result.sha256, size: result.size, cached: false };
  }

  /**
   * Forgets every path that is not in `keep`.
   *
   * @param {Set<string>} keep
   */
  retain(keep) {
    for (const path of [...this.entries.keys()]) {
      if (!keep.has(path)) this.entries.delete(path);
    }
  }

  /**
   * Writes the cache, atomically.
   *
   * @returns {Promise<void>}
   */
  async save() {
    const dir = await ensureStateDir(this.root);
    /** @type {Record<string, CacheEntry>} */
    const files = {};
    for (const path of [...this.entries.keys()].sort(compareBytes)) {
      files[path] = /** @type {CacheEntry} */ (this.entries.get(path));
    }
    await writeFileAtomic(join(dir, CACHE_FILE_NAME), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
  }
}

/**
 * What this working copy last had in common with the lock for one file.
 *
 * @typedef {object} StateEntry
 * @property {string} sha256
 * @property {number} size
 */

/**
 * The record of what was synced.
 */
export class SyncState {
  /**
   * @param {string} root Absolute path of the media root.
   * @param {Map<string, StateEntry>} entries
   */
  constructor(root, entries) {
    this.root = root;
    this.entries = entries;
  }

  /**
   * Loads the record; a missing or damaged file gives an empty record, which
   * only means that nothing counts as synced and nothing will be deleted.
   *
   * @param {string} root
   * @returns {Promise<SyncState>}
   */
  static async load(root) {
    const data = await readJsonLeniently(join(root, STATE_DIR_NAME, STATE_FILE_NAME));
    /** @type {Map<string, StateEntry>} */
    const entries = new Map();
    if (isObject(data) && data.version === 1 && isObject(data.files)) {
      for (const [path, entry] of Object.entries(data.files)) {
        if (!isObject(entry) || !('value' in checkMediaPath(path))) continue;
        const { sha256, size } = entry;
        if (typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) {
          entries.set(path, { sha256, size });
        }
      }
    }
    return new SyncState(root, entries);
  }

  /**
   * Writes the record, atomically.
   *
   * @returns {Promise<void>}
   */
  async save() {
    const dir = await ensureStateDir(this.root);
    /** @type {Record<string, StateEntry>} */
    const files = {};
    for (const path of [...this.entries.keys()].sort(compareBytes)) {
      const entry = /** @type {StateEntry} */ (this.entries.get(path));
      files[path] = { sha256: entry.sha256, size: entry.size };
    }
    await writeFileAtomic(join(dir, STATE_FILE_NAME), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
  }
}
