import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { removeQuietly, renameReplacing, temporaryNameFor } from './fsutil.js';
import { assertKey, MediaStoreError, OBJECT_PREFIX } from './store.js';

/**
 * A store that keeps its objects as files in a folder, `{dir}/originals/{sha256}`.
 * Tests use it, and so can anyone who keeps originals on a network drive.
 *
 * Writes are atomic (a temporary file in the same folder, renamed when
 * complete), so a reader never sees half an object, and every object is hashed
 * while it is copied: an object is only kept under the key of its own content,
 * and a corrupt object is never handed out.
 */

const CHUNK_BYTES = 1024 * 1024;

/**
 * Copies `source` to the new file `target`, hashing the bytes on the way, and
 * fails (leaving no `target`) when the hash is not `key`.
 *
 * @param {string} source
 * @param {string} target A path that does not exist.
 * @param {string} key The expected SHA-256.
 * @param {'put' | 'get'} direction Which way the bytes go, for the message.
 * @returns {Promise<void>}
 */
async function copyVerified(source, target, key, direction) {
  const hash = createHash('sha256');
  try {
    await pipeline(
      createReadStream(source, { highWaterMark: CHUNK_BYTES }),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(target, { flags: 'wx', flush: true }),
    );
    if (hash.digest('hex') !== key) {
      throw new MediaStoreError(
        direction === 'put' ? 'mismatch' : 'corrupt',
        direction === 'put'
          ? `the file does not have the SHA-256 ${key}; it changed after it was hashed (run "coffer media lock" again)`
          : `the stored object ${key} is corrupt: its content does not hash to its key`,
      );
    }
  } catch (error) {
    await removeQuietly(target);
    throw error;
  }
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} Whether a regular file (not a link) is there.
 */
async function isRegularFile(file) {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * @param {{ dir: string }} options `dir` is the folder of the store; it is created by the first `put`.
 * @returns {import('./store.js').MediaStore}
 */
export function createFsStore({ dir }) {
  const root = resolve(dir);
  const objects = join(root, OBJECT_PREFIX);
  /** @param {string} key */
  const objectPath = (key) => join(objects, assertKey(key));

  return {
    description: `folder ${root}`,

    async has(key) {
      return isRegularFile(objectPath(key));
    },

    async put(key, file) {
      const final = objectPath(key);
      if (await isRegularFile(final)) return;
      await mkdir(objects, { recursive: true });
      const temporary = temporaryNameFor(final);
      await copyVerified(file, temporary, key, 'put');
      try {
        await renameReplacing(temporary, final);
      } catch (error) {
        await removeQuietly(temporary);
        throw error;
      }
    },

    async get(key, file) {
      const source = objectPath(key);
      if (!(await isRegularFile(source))) {
        throw new MediaStoreError('missing', `the store has no object ${key}`);
      }
      await copyVerified(source, file, key, 'get');
    },
  };
}
