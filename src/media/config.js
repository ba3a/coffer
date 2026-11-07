import { isAbsolute, relative, resolve, sep } from 'node:path';

import { checkGlobPattern, compileGlob } from '../docs/glob.js';
import { cleanRelativePath } from '../docs/sources.js';
import { checkMediaPath, matchesAny } from './paths.js';
import { STATE_DIR_NAME } from './state.js';

/**
 * Reads the `media` block of the configuration. The block belongs to the whole
 * configuration file, not to a site: one lock file, one store and one set of
 * patterns cover the content folders of all the sites in it.
 */

/** The keys of the `media` block. */
export const MEDIA_KEYS = Object.freeze(['store', 'include', 'lock']);

/** The keys of `media.store` for each type. */
export const STORE_KEYS = Object.freeze({
  fs: Object.freeze(['type', 'dir']),
  s3: Object.freeze(['type', 'endpoint', 'bucket', 'region', 'prefix', 'accessKeyIdEnv', 'secretAccessKeyEnv']),
});

/** The kinds of store that can be configured. */
export const STORE_TYPES = Object.freeze(Object.keys(STORE_KEYS));

/** The file the lock is written to unless `media.lock` says otherwise. */
export const DEFAULT_LOCK_FILE = 'media.lock.json';

/** The environment variables the credentials of an S3 store are read from unless the configuration names others. */
export const DEFAULT_ACCESS_KEY_ID_ENV = 'COFFER_MEDIA_ACCESS_KEY_ID';
export const DEFAULT_SECRET_ACCESS_KEY_ENV = 'COFFER_MEDIA_SECRET_ACCESS_KEY';

/** The most patterns `media.include` may hold. */
export const MAX_INCLUDE_PATTERNS = 100;

/**
 * Photo formats that are originals by default.
 */
export const IMAGE_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'tiff']);

/**
 * Video formats that are originals by default.
 */
export const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'webm', 'm4v', 'mkv']);

/**
 * Where originals are kept: a folder, or an S3-compatible bucket. The S3 block
 * holds only the places and the NAMES of the environment variables that carry
 * the credentials; a key is never read from the configuration file.
 *
 * @typedef {{ type: 'fs', dir: string }
 *   | { type: 's3', endpoint: string, bucket: string, region: string, prefix: string, accessKeyIdEnv: string, secretAccessKeyEnv: string }} MediaStoreConfig
 */

/**
 * The media settings of a configuration.
 *
 * @typedef {object} MediaConfig
 * @property {MediaStoreConfig} store Where the originals are kept.
 * @property {string[]} include Patterns (see `docs/glob.js`) of the originals, relative to the folder of the configuration file.
 * @property {boolean} includeIsDefault Whether `include` was made from the content folders because the configuration gave none.
 * @property {string} lock Path of the lock file relative to the folder of the configuration file, with `/`.
 * @property {string} lockFile Absolute path of the lock file.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A pattern for every spelling of an extension: `jpg` is `[jJ][pP][gG]`, for
 * the matcher is case-sensitive and cameras write `IMG_0001.JPG`.
 *
 * @param {string} extension
 * @returns {string}
 */
function anyCase(extension) {
  return Array.from(extension, (char) => (char.toLowerCase() === char.toUpperCase() ? char : `[${char.toLowerCase()}${char.toUpperCase()}]`)).join('');
}

/**
 * Writes a folder name so that the matcher takes it literally. Returns
 * `undefined` for a name with something the matcher cannot express.
 *
 * @param {string} name
 * @returns {string | undefined}
 */
function literalName(name) {
  if (/[{}\\]/.test(name) || name.startsWith('!')) return undefined;
  return name.replace(/[*?[]/g, (char) => `[${char}]`);
}

/**
 * The default patterns: every image and video extension below each content
 * folder.
 *
 * @param {string[]} contentRels Content folders relative to the configuration folder, with `/`; the empty string is the folder itself.
 * @returns {string[]}
 */
export function defaultInclude(contentRels) {
  const extensions = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
  /** @type {string[]} */
  const patterns = [];
  for (const rel of contentRels) {
    const prefix = rel === '' ? '' : `${rel.split('/').map((name) => literalName(name) ?? name).join('/')}/`;
    for (const extension of extensions) patterns.push(`${prefix}**/*.${anyCase(extension)}`);
  }
  return patterns;
}

/**
 * Whether an environment variable NAME looks like one, and not like the key
 * somebody pasted in its place.
 *
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeVariableName(name) {
  return /^[A-Z_][A-Z0-9_]{0,63}$/.test(name) && !/^(AKIA|ASIA)[A-Z0-9]{12,}$/.test(name) && !/^[A-F0-9]{24,}$/.test(name);
}

/**
 * @typedef {object} MediaProblem
 * @property {string} path Key path below `media`, such as `store.bucket`; empty for the block itself.
 * @property {string} message
 */

/**
 * Checks the `media` block and applies the defaults.
 *
 * @param {unknown} raw The value of the `media` key (not null or undefined).
 * @param {{ dir: string, file: string, contentDirs: string[] }} context `dir` is the folder of the configuration file (relative paths start there); `file` is the configuration file itself; `contentDirs` are the absolute content folders of the sites.
 * @returns {{ value?: MediaConfig, problems: MediaProblem[] }}
 */
export function normalizeMediaConfig(raw, context) {
  /** @type {MediaProblem[]} */
  const problems = [];
  const add = (/** @type {string} */ path, /** @type {string} */ message) => problems.push({ path, message });
  if (!isMapping(raw)) {
    add('', 'must be a mapping with a "store" (and optionally "include" and "lock")');
    return { problems };
  }
  for (const key of Object.keys(raw)) {
    if (!MEDIA_KEYS.includes(key)) add(key, `unknown key (expected one of: ${MEDIA_KEYS.join(', ')})`);
  }

  const store = normalizeStore(raw.store, context, add);

  // lock
  let lock = DEFAULT_LOCK_FILE;
  if (raw.lock !== undefined && raw.lock !== null) {
    const cleaned = cleanRelativePath(raw.lock);
    if ('problem' in cleaned) {
      add('lock', cleaned.problem);
    } else if ('problem' in checkMediaPath(cleaned.value)) {
      add('lock', `"${cleaned.value}" is not a plain path (no hidden folders, no characters Windows forbids)`);
    } else {
      lock = cleaned.value;
    }
  }

  if (store !== undefined && store.type === 'fs') checkStoreFolder(store.dir, lock, context, (message) => add('store.dir', message));

  // include
  /** @type {string[]} */
  let include = [];
  let includeIsDefault = false;
  if (raw.include !== undefined && raw.include !== null) {
    if (!Array.isArray(raw.include)) {
      add('include', 'must be a list of patterns');
    } else if (raw.include.length === 0) {
      add('include', 'must not be empty (leave it out for the images and videos below the content folders)');
    } else if (raw.include.length > MAX_INCLUDE_PATTERNS) {
      add('include', `at most ${MAX_INCLUDE_PATTERNS} patterns`);
    } else {
      raw.include.forEach((item, index) => {
        const here = `include[${index}]`;
        if (typeof item !== 'string') return add(here, 'must be text');
        const cleaned = cleanRelativePath(item);
        if ('problem' in cleaned) return add(here, cleaned.problem);
        const checked = checkGlobPattern(item.trim());
        if ('problem' in checked) return add(here, checked.problem);
        if (include.includes(item.trim())) return add(here, `"${item.trim()}" is listed twice`);
        include.push(item.trim());
      });
    }
  } else {
    includeIsDefault = true;
    /** @type {string[]} */
    const rels = [];
    for (const contentDir of context.contentDirs) {
      const rel = relative(context.dir, contentDir);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        add('include', `the content folder ${contentDir} is outside the folder of the configuration file, so there is no default; list the patterns in "include"`);
        continue;
      }
      const posixRel = rel === '' ? '' : rel.split(sep).join('/');
      if (posixRel !== '' && posixRel.split('/').some((name) => literalName(name) === undefined)) {
        add('include', `the content folder "${posixRel}" has a character the patterns cannot express; list the patterns in "include"`);
        continue;
      }
      rels.push(posixRel);
    }
    // A content folder below another one is covered by it.
    const unique = [...new Set(rels)];
    const outer = unique.filter((rel) => !unique.some((other) => other !== rel && (other === '' || rel.startsWith(`${other}/`))));
    include = defaultInclude(outer);
  }
  const configFileRel = relative(context.dir, context.file).split(sep).join('/');
  for (const pattern of include) {
    let glob;
    try {
      glob = compileGlob(pattern);
    } catch (error) {
      add('include', error instanceof Error ? error.message : String(error));
      break;
    }
    // The lock and the configuration are never originals: a pattern that took them would hash the lock into
    // itself, or let an entry of the lock overwrite the configuration.
    if (matchesAny([glob], lock)) add('include', `"${pattern}" matches the lock file ${lock}; narrow the pattern (for example to image and video extensions)`);
    if (!configFileRel.startsWith('..') && matchesAny([glob], configFileRel)) add('include', `"${pattern}" matches the configuration file ${configFileRel}; narrow the pattern (for example to image and video extensions)`);
  }

  if (problems.length > 0 || store === undefined) return { problems };
  return {
    value: { store, include, includeIsDefault, lock, lockFile: resolve(context.dir, ...lock.split('/')) },
    problems,
  };
}

/**
 * Whether `child` is `parent` or below it.
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Refuses a folder store that would share space with the working copy: below
 * a content folder its objects could be taken for originals by a wide
 * `include` pattern; around the configuration folder (or at it) the store and
 * the working copy would be one tree; in `.coffer` it would be private to one
 * copy and lost with it.
 *
 * @param {string} storeDir Absolute path of the store folder.
 * @param {string} lock The lock path, relative with `/`.
 * @param {{ dir: string, contentDirs: string[] }} context
 * @param {(message: string) => unknown} report
 */
function checkStoreFolder(storeDir, lock, context, report) {
  const contentDir = context.contentDirs.find((dir) => isInside(dir, storeDir) || isInside(storeDir, dir));
  if (isInside(storeDir, context.dir) || isInside(storeDir, resolve(context.dir, ...lock.split('/')))) {
    report(`the store folder ${storeDir} must not be the folder of the configuration file or contain it; use a folder of its own, for example "../originals"`);
  } else if (contentDir !== undefined) {
    report(`the store folder ${storeDir} must not be inside a content folder or contain one (${contentDir}); originals in the store would look like originals of the site`);
  } else if (isInside(resolve(context.dir, STATE_DIR_NAME), storeDir)) {
    report(`the store folder ${storeDir} must not be inside ${STATE_DIR_NAME}, which belongs to one working copy and is not kept`);
  }
}

/**
 * @param {unknown} raw
 * @param {{ dir: string }} context
 * @param {(path: string, message: string) => unknown} add
 * @returns {MediaStoreConfig | undefined}
 */
function normalizeStore(raw, context, add) {
  if (raw === undefined || raw === null) {
    add('store', 'is required (for example { type: fs, dir: ../originals })');
    return undefined;
  }
  if (!isMapping(raw)) {
    add('store', 'must be a mapping with a "type"');
    return undefined;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !STORE_TYPES.includes(type)) {
    add('store.type', `must be one of: ${STORE_TYPES.join(', ')}`);
    return undefined;
  }
  const allowed = /** @type {readonly string[]} */ (STORE_KEYS[/** @type {'fs' | 's3'} */ (type)]);
  let ok = true;
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    ok = false;
    if (/^(secret|password|token|access.?key|key.?id|credentials?)/i.test(key)) {
      add(`store.${key}`, `credentials are never read from the configuration file; name the environment variables that hold them with accessKeyIdEnv and secretAccessKeyEnv`);
    } else {
      add(`store.${key}`, `unknown key for a "${type}" store (expected one of: ${allowed.join(', ')})`);
    }
  }

  /**
   * @param {string} key
   * @param {{ required?: boolean, fallback?: string }} [options]
   * @returns {string | undefined}
   */
  const text = (key, options = {}) => {
    const value = raw[key];
    if (value === undefined || value === null) {
      if (options.required) {
        add(`store.${key}`, 'is required');
        ok = false;
      }
      return options.fallback;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      add(`store.${key}`, 'must be a non-empty string');
      ok = false;
      return undefined;
    }
    return value.trim();
  };

  if (type === 'fs') {
    const dir = text('dir', { required: true });
    if (dir === undefined) return undefined;
    if (/^~(?:[\\/]|$)/.test(dir)) {
      add('store.dir', '"~" is not expanded here (neither are environment variables); write the full path of the folder, or a path relative to the configuration file');
      return undefined;
    }
    return ok ? { type: 'fs', dir: resolve(context.dir, dir) } : undefined;
  }

  // type === 's3': the keys are checked here, the client comes later.
  const endpoint = text('endpoint', { required: true });
  if (endpoint !== undefined) {
    const placeholders = endpoint.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'x');
    if (placeholders.length > 500 || /\s/.test(placeholders)) {
      add('store.endpoint', 'must be an address without spaces, at most 500 characters');
      ok = false;
    } else {
      let parsed;
      try {
        parsed = new URL(placeholders);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined || parsed.protocol !== 'https:') {
        add('store.endpoint', 'must be an https address (a ${NAME} placeholder stands for an environment variable)');
        ok = false;
      } else if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
        add('store.endpoint', 'must not contain credentials, a query or a fragment');
        ok = false;
      }
    }
  }
  const bucket = text('bucket', { required: true });
  if (bucket !== undefined && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    add('store.bucket', 'must be a bucket name: 3 to 63 lowercase letters, digits, "." and "-"');
    ok = false;
  }
  const region = text('region', { fallback: 'auto' });
  if (region !== undefined && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(region)) {
    add('store.region', 'must be a region name such as "auto" or "eu-central-1"');
    ok = false;
  }
  let prefix = '';
  if (raw.prefix !== undefined && raw.prefix !== null) {
    const cleaned = typeof raw.prefix === 'string' ? cleanRelativePath(raw.prefix) : { problem: 'must be text' };
    if ('problem' in cleaned || !/^[A-Za-z0-9._/-]+$/.test(cleaned.value)) {
      add('store.prefix', 'must be a folder-like prefix of letters, digits, ".", "_", "-" and "/", with no ".."');
      ok = false;
    } else {
      prefix = cleaned.value;
    }
  }
  const accessKeyIdEnv = text('accessKeyIdEnv', { fallback: DEFAULT_ACCESS_KEY_ID_ENV });
  const secretAccessKeyEnv = text('secretAccessKeyEnv', { fallback: DEFAULT_SECRET_ACCESS_KEY_ENV });
  for (const [key, value] of [['accessKeyIdEnv', accessKeyIdEnv], ['secretAccessKeyEnv', secretAccessKeyEnv]]) {
    if (value !== undefined && !looksLikeVariableName(value)) {
      add(`store.${key}`, 'must be the NAME of an environment variable (capital letters, digits and "_"); put the credential itself in that variable, never in this file');
      ok = false;
    }
  }
  if (accessKeyIdEnv !== undefined && accessKeyIdEnv === secretAccessKeyEnv) {
    add('store.secretAccessKeyEnv', 'must name another variable than accessKeyIdEnv');
    ok = false;
  }
  if (!ok || endpoint === undefined || bucket === undefined || region === undefined || accessKeyIdEnv === undefined || secretAccessKeyEnv === undefined) return undefined;
  return { type: 's3', endpoint, bucket, region, prefix, accessKeyIdEnv, secretAccessKeyEnv };
}
