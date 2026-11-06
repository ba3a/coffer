import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Small file helpers shared by the media commands: streaming hashes,
 * temporary files next to their target, and renames that replace.
 */

/** Chunk size when reading originals; large enough to be quick, small enough that a video never sits in memory. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * The name of a temporary file next to `file`. It starts with a dot, so the
 * media scan never takes it for an original, and it is never the final name.
 *
 * @param {string} file Absolute path of the file the temporary one is for.
 * @returns {string}
 */
export function temporaryNameFor(file) {
  const base = basename(file).slice(0, 60);
  return join(dirname(file), `.${base}.coffer-${randomBytes(6).toString('hex')}.part`);
}

/**
 * Hashes a file by streaming it; the file is never held in memory.
 *
 * @param {string} file
 * @returns {Promise<{ sha256: string, size: number }>}
 */
export async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK_BYTES })) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

/**
 * Removes a file and ignores the failure of a file that is already gone or
 * cannot be removed (this is only used to clean up after another failure).
 *
 * @param {string} file
 * @returns {Promise<void>}
 */
export async function removeQuietly(file) {
  try {
    await rm(file, { force: true });
  } catch {
    // Nothing more can be done for a leftover temporary file.
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function pause(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Renames `from` over `to`, replacing it. On Windows a virus scanner or an
 * indexer can hold a file for a moment, so a few busy failures are retried.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<void>}
 */
export async function renameReplacing(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await pause(30 * (attempt + 1));
    }
  }
}

/**
 * Writes a file so that a reader sees either the old content or the new, never
 * half of it: the content goes to a temporary file in the same folder, is
 * flushed to disk and is renamed over the target. The folder must exist.
 *
 * @param {string} file Absolute path.
 * @param {string | Uint8Array} data
 * @returns {Promise<void>}
 */
export async function writeFileAtomic(file, data) {
  const temporary = temporaryNameFor(file);
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameReplacing(temporary, file);
  } catch (error) {
    await removeQuietly(temporary);
    throw error;
  }
}
