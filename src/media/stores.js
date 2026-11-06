import { createFsStore } from './fs-store.js';
import { MediaStoreError } from './store.js';

/**
 * Where the kinds of store are listed. The commands only ever call
 * {@link createStore}; adding a kind of store means registering a factory here
 * (the S3 store replaces the `s3` entry below) and changes no command.
 */

/**
 * What a factory is given besides the configuration of the store.
 *
 * @typedef {object} StoreContext
 * @property {Record<string, string | undefined>} [env] The environment credentials are read from (default: the process's).
 * @property {string} [configDir] Folder of the configuration file.
 */

/**
 * @typedef {(config: import('./config.js').MediaStoreConfig, context: StoreContext) => import('./store.js').MediaStore | Promise<import('./store.js').MediaStore>} StoreFactory
 */

/** @type {Map<string, StoreFactory>} */
const factories = new Map();

/**
 * Registers (or replaces) the factory of a kind of store.
 *
 * @param {string} type The value of `media.store.type`.
 * @param {StoreFactory} factory
 */
export function registerStoreType(type, factory) {
  factories.set(type, factory);
}

registerStoreType('fs', (config) => {
  if (config.type !== 'fs') throw new MediaStoreError('failed', 'not a folder store');
  return createFsStore({ dir: config.dir });
});

registerStoreType('s3', () => {
  throw new MediaStoreError(
    'unavailable',
    'the "s3" media store is not implemented in this build yet: the configuration is accepted and checked, but nothing can be uploaded or downloaded. Use "type: fs" for now',
  );
});

/**
 * Makes the store a configuration describes.
 *
 * @param {import('./config.js').MediaStoreConfig} config
 * @param {StoreContext} [context]
 * @returns {Promise<import('./store.js').MediaStore>}
 * @throws {MediaStoreError} For a kind of store that is not available in this build.
 */
export async function createStore(config, context = {}) {
  const factory = factories.get(config.type);
  if (factory === undefined) throw new MediaStoreError('unavailable', `there is no media store of type "${config.type}"`);
  return factory(config, context);
}
