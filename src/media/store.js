/**
 * The interface of a media store, and the rules every store follows.
 *
 * A store keeps the original files of a site's media by the SHA-256 of their
 * content, under the object name `originals/{sha256}`. It knows nothing about
 * paths, locks or working copies: the commands in `sync.js` only ask it
 * whether it has an object, to keep a local file as an object and to write an
 * object to a local file. A new kind of store (see `stores.js`) needs nothing
 * else.
 */

/** What a key looks like: 64 lowercase hexadecimal characters. */
export const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** The folder (or key prefix) every original is kept under. */
export const OBJECT_PREFIX = 'originals/';

/**
 * A store of originals.
 *
 * @typedef {object} MediaStore
 * @property {string} description Where the store keeps its objects, for messages (never contains a credential).
 * @property {(key: string) => Promise<boolean>} has Whether the store holds the object.
 * @property {(key: string, file: string) => Promise<void>} put Keeps the local file `file` (whose SHA-256 is `key`) as the object. Streams the file, verifies that its hash is `key` and fails without keeping anything when it is not. Keeping an object the store already has is not an error.
 * @property {(key: string, file: string) => Promise<void>} get Writes the object to `file`, a path that does not exist yet and belongs to the caller. Streams, verifies the hash against `key`, and removes `file` again when it fails.
 */

/**
 * The kinds of failure a store reports.
 *
 * @typedef {'invalid-key' | 'missing' | 'corrupt' | 'mismatch' | 'unavailable' | 'failed'} MediaStoreErrorCode
 */

/**
 * Raised by a store, and by the creation of one.
 */
export class MediaStoreError extends Error {
  /**
   * @param {MediaStoreErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'MediaStoreError';
    this.code = code;
  }
}

/**
 * @param {unknown} key
 * @returns {key is string}
 */
export function isValidKey(key) {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

/**
 * Refuses a key that is not 64 lowercase hexadecimal characters, so a key can
 * never carry a path.
 *
 * @param {unknown} key
 * @returns {string} The key.
 * @throws {MediaStoreError}
 */
export function assertKey(key) {
  if (!isValidKey(key)) throw new MediaStoreError('invalid-key', 'a media key must be 64 lowercase hexadecimal characters (a SHA-256)');
  return key;
}

/**
 * The name of an object: `originals/{sha256}`.
 *
 * @param {string} key
 * @returns {string}
 */
export function objectName(key) {
  return `${OBJECT_PREFIX}${assertKey(key)}`;
}
