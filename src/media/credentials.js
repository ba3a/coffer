import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { runGit } from '../docs/sources.js';
import { MediaStoreError } from './store.js';

/**
 * Where the settings of an S3 media store that must not be in the configuration
 * file come from: the credentials, and the values `${NAME}` placeholders in the
 * endpoint stand for.
 *
 * They are read from the environment first and then from a file named
 * `.env.local` next to the configuration file (never committed). The file is
 * only ever read as data: nothing in it is executed, expanded or exported into
 * the process, and no value is ever written to a message, a log or a file.
 */

/** The file next to the configuration file that holds local settings. */
export const ENV_LOCAL_FILE_NAME = '.env.local';

/** The largest `.env.local` that is read. */
const MAX_ENV_FILE_BYTES = 64 * 1024;

/** The longest value of a credential or placeholder that is accepted. */
const MAX_VALUE_LENGTH = 512;

/**
 * Raised when the settings that an S3 store needs are not available. It carries
 * one message that says everything the person has to do, so a command prints it
 * once and not once per object.
 */
export class MissingCredentialsError extends MediaStoreError {
  /**
   * @param {string} message
   * @param {string[]} missing The names of the variables that are not set.
   */
  constructor(message, missing) {
    super('unavailable', message);
    this.name = 'MissingCredentialsError';
    this.missing = missing;
  }
}

/**
 * Reads the text of a `.env.local` file: `NAME=value` lines, blank lines and
 * `#` comments. A value may be in single or double quotes (which are removed;
 * there are no escapes); after the closing quote a `#` starts a comment, so
 * `KEY="abc" # note` is `abc`; an unquoted value ends at ` #` (a `#` right
 * after a character is part of the value) or at the end of the line. `export NAME=value` is accepted. Nothing is expanded: `$HOME` and
 * `${X}` are text. A line that is not of this form is ignored.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  /** @type {Map<string, string>} */
  const values = new Map();
  for (const rawLine of text.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    const quote = value[0];
    const closing = quote === '"' || quote === "'" ? value.indexOf(quote, 1) : -1;
    if (closing !== -1 && /^\s*(?:#.*)?$/.test(value.slice(closing + 1))) {
      value = value.slice(1, closing);
    } else if (closing !== -1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    values.set(match[1], value);
  }
  return values;
}

/**
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Reads `.env.local` in a folder. A missing file is fine. A link is followed
 * only when it stays inside the folder, so a repository cannot make coffer read
 * a file somewhere else (an SSH key, say) by shipping a link under this name.
 *
 * @param {string} dir The folder of the configuration file.
 * @returns {Promise<Map<string, string>>}
 * @throws {MediaStoreError} For a link that leaves the folder, a file that is not a regular file, or one that is too large.
 */
export async function readEnvLocal(dir) {
  const file = join(dir, ENV_LOCAL_FILE_NAME);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Map();
    throw new MediaStoreError('failed', `${file} cannot be read (${code ?? 'error'})`);
  }
  let target = file;
  if (info.isSymbolicLink()) {
    try {
      target = await realpath(file);
      if (!isInside(await realpath(dir), target)) {
        throw new MediaStoreError('failed', `${file} is a link to a place outside ${dir}, so it is not read; make it a regular file`);
      }
    } catch (error) {
      if (error instanceof MediaStoreError) throw error;
      return new Map(); // a dangling link: no file
    }
  }
  const real = await lstat(target);
  if (!real.isFile()) throw new MediaStoreError('failed', `${file} is not a regular file`);
  if (real.size > MAX_ENV_FILE_BYTES) throw new MediaStoreError('failed', `${file} is larger than ${MAX_ENV_FILE_BYTES} bytes`);
  return parseEnvFile(await readFile(target, 'utf8'));
}

/** How long one git call that checks `.env.local` may take. */
const GIT_CHECK_TIMEOUT_MS = 10_000;

/**
 * Says whether `.env.local` is in danger of being committed: tracked by git, or
 * not ignored by it. This only ever warns. It says nothing when the file does
 * not exist, when the folder is not in a git repository, or when git is not
 * available or does not answer.
 *
 * @param {string} dir The folder of the configuration file.
 * @param {Record<string, string | undefined>} env The environment git runs in; any `GIT_*` variable is left out (it could point git at another repository).
 * @returns {Promise<string | null>} The warning, or null.
 */
export async function envLocalWarning(dir, env) {
  try {
    await lstat(join(dir, ENV_LOCAL_FILE_NAME));
  } catch {
    return null;
  }
  /** @type {Record<string, string>} */
  const gitEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !key.toUpperCase().startsWith('GIT_')) gitEnv[key] = value;
  }
  gitEnv.GIT_TERMINAL_PROMPT = '0';
  gitEnv.GIT_OPTIONAL_LOCKS = '0';
  /** @param {string[]} args */
  const git = (args) => runGit(args, { cwd: dir, env: gitEnv, timeoutMs: GIT_CHECK_TIMEOUT_MS, maxOutputBytes: 4096 });
  const tracked = await git(['ls-files', '--error-unmatch', '--', ENV_LOCAL_FILE_NAME]);
  if (tracked.spawnError !== undefined || tracked.timedOut) return null;
  if (tracked.code === 0) {
    return `${ENV_LOCAL_FILE_NAME} is tracked by git, so its secrets are in your repository. Run "git rm --cached ${ENV_LOCAL_FILE_NAME}", add it to .gitignore, and replace the keys if it was ever committed or pushed.`;
  }
  if (tracked.code !== 1) return null; // not a repository, or git failed
  const ignored = await git(['check-ignore', '-q', '--', ENV_LOCAL_FILE_NAME]);
  if (ignored.spawnError !== undefined || ignored.timedOut) return null;
  if (ignored.code === 1) {
    return `${ENV_LOCAL_FILE_NAME} is not ignored by git, so "git add ." would commit its secrets. Add ${ENV_LOCAL_FILE_NAME} to your .gitignore ("coffer media gitignore" lists it).`;
  }
  return null;
}

/**
 * @typedef {object} Lookup
 * @property {Map<string, string>} values The values found, by variable name.
 * @property {string[]} missing The names that are set nowhere.
 */

/**
 * Looks the named variables up: the environment first, then `.env.local`. An
 * empty value counts as not set.
 *
 * When `.env.local` is read and `warn` is given, `warn` is called once if the
 * file is tracked by git or not ignored (see {@link envLocalWarning}).
 *
 * @param {string[]} names
 * @param {{ env: Record<string, string | undefined>, configDir: string | undefined, warn?: (message: string) => void }} where
 * @returns {Promise<Lookup>}
 */
export async function lookUpVariables(names, { env, configDir, warn }) {
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {string[]} */
  const unresolved = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') values.set(name, value);
    else unresolved.push(name);
  }
  if (unresolved.length > 0 && configDir !== undefined) {
    const local = await readEnvLocal(configDir);
    if (warn !== undefined) {
      const warning = await envLocalWarning(configDir, env);
      if (warning !== null) warn(warning);
    }
    for (const name of unresolved) {
      const value = local.get(name);
      if (value !== undefined && value !== '') values.set(name, value);
    }
  }
  return { values, missing: names.filter((name) => !values.has(name)) };
}

/**
 * The one message for settings that are missing: what is missing, where to put
 * it, a template with placeholder values only, and the reminder to keep the
 * file out of git.
 *
 * @param {string[]} missing
 * @param {{ configDir: string | undefined, bucket: string, accessKeyIdEnv: string, secretAccessKeyEnv: string }} details
 * @returns {string}
 */
export function missingCredentialsMessage(missing, { configDir, bucket, accessKeyIdEnv, secretAccessKeyEnv }) {
  const placeholder = (/** @type {string} */ name) =>
    name === accessKeyIdEnv ? 'your-access-key-id' : name === secretAccessKeyEnv ? 'your-secret-access-key' : 'your-value';
  const file = configDir === undefined ? ENV_LOCAL_FILE_NAME : join(configDir, ENV_LOCAL_FILE_NAME);
  return [
    `coffer: the media store "${bucket}" cannot be used: ${missing.length === 1 ? 'the variable' : 'the variables'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
    `Create the file ${file} with these lines, using the values of an S3 API token that may read and write the bucket:`,
    '',
    ...missing.map((name) => `  ${name}=${placeholder(name)}`),
    '',
    `Or set ${missing.length === 1 ? 'that variable' : 'those variables'} in the environment (in CI, from the secrets of the workflow).`,
    `${ENV_LOCAL_FILE_NAME} holds secrets: it must be ignored by git ("coffer media gitignore" lists it) and never committed. See docs/media.md.`,
  ].join('\n');
}

/**
 * Whether a value can be used as a credential: printable ASCII without spaces
 * and of sensible length. The value is never shown.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isUsableCredential(value) {
  return value.length >= 1 && value.length <= MAX_VALUE_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

/**
 * The longest value a `${NAME}` placeholder of the endpoint can stand for.
 */
export const MAX_PLACEHOLDER_LENGTH = 253;
