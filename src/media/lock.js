import { checkMediaPath, collisionKey, compareBytes } from './paths.js';

/**
 * The lock file, `media.lock.json`: which originals a working copy has, by
 * content.
 *
 * The file is valid JSON and is laid out for version control: one line for
 * every original, sorted by the bytes of the path, so that adding, changing or
 * removing a photo changes one line and two people adding different photos
 * merge without a conflict.
 *
 * ```
 * {"version":1,"files":[
 * {"path":"content/a/one.jpg","sha256":"...","size":123},
 * {"path":"content/a/two.jpg","sha256":"...","size":456}
 * ]}
 * ```
 *
 * The text is exactly what {@link renderLock} makes (LF line ends, a final
 * newline, no spaces), and {@link parseLock} refuses anything else, so a file
 * edited by hand or half merged is reported with the line to look at.
 */

/** The first line of a lock file. */
export const LOCK_HEADER = '{"version":1,"files":[';

/** The last line of a lock file (before the final newline). */
export const LOCK_FOOTER = ']}';

/** The most entries a lock file may hold. */
export const MAX_LOCK_ENTRIES = 200_000;

/** The largest lock file that is read, in bytes. */
export const MAX_LOCK_BYTES = 128 * 1024 * 1024;

/** How many problems are listed before the rest is summarised. */
const MAX_PROBLEMS = 20;

/**
 * One original in the lock.
 *
 * @typedef {object} LockEntry
 * @property {string} path Path relative to the media root, with `/`.
 * @property {string} sha256 Lowercase hexadecimal SHA-256 of the content.
 * @property {number} size Size in bytes.
 */

/**
 * Raised for a lock file that cannot be used; every problem is in `errors`.
 */
export class LockError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'LockError';
    this.errors = errors;
  }
}

/**
 * @param {LockEntry} entry
 * @returns {string} The line of the entry, without a comma.
 */
function entryLine(entry) {
  return JSON.stringify({ path: entry.path, sha256: entry.sha256, size: entry.size });
}

/**
 * The text of a lock file for these entries: sorted by the bytes of the path,
 * one per line, LF line ends and a final newline. The same entries always give
 * the same text, on every platform.
 *
 * @param {Iterable<LockEntry>} entries
 * @returns {string}
 */
export function renderLock(entries) {
  const sorted = [...entries].sort((a, b) => compareBytes(a.path, b.path));
  const lines = [LOCK_HEADER];
  sorted.forEach((entry, index) => {
    lines.push(`${entryLine(entry)}${index < sorted.length - 1 ? ',' : ''}`);
  });
  lines.push(LOCK_FOOTER);
  return `${lines.join('\n')}\n`;
}

/**
 * Parses a lock file strictly: the exact layout of {@link renderLock}, every
 * path acceptable to {@link checkMediaPath}, a hash of 64 lowercase
 * hexadecimal characters, a size that is a whole number, entries sorted and
 * without duplicates, and no two paths that a case-insensitive file system
 * would take for one file, or where one is a file and the other a folder
 * below it. A line ending in CR LF is accepted (a checkout may have converted
 * it); anything else that is not the layout is a problem.
 *
 * @param {string} text
 * @param {string} [label] How the file is named in messages.
 * @returns {LockEntry[]}
 * @throws {LockError} With every problem found (the first 20), each naming the line.
 */
export function parseLock(text, label = 'media.lock.json') {
  /** @type {string[]} */
  const problems = [];
  const add = (/** @type {number} */ line, /** @type {string} */ message) => {
    if (problems.length < MAX_PROBLEMS) problems.push(`${label}:${line}: ${message}`);
    else if (problems.length === MAX_PROBLEMS) problems.push(`${label}: more problems follow`);
  };
  if (text.startsWith('﻿')) throw new LockError([`${label}:1: starts with a byte order mark`]);
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('\r')) throw new LockError([`${label}: contains a bare CR; the file must use LF line ends`]);
  if (normalized === '' || !normalized.endsWith('\n')) throw new LockError([`${label}: must end with a newline`]);
  const lines = normalized.slice(0, -1).split('\n');
  if (lines[0] !== LOCK_HEADER) {
    throw new LockError([`${label}:1: expected ${LOCK_HEADER} (is this a lock file, or an unfinished merge?)`]);
  }
  if (lines.length < 2 || lines[lines.length - 1] !== LOCK_FOOTER) {
    throw new LockError([`${label}:${lines.length}: expected ${LOCK_FOOTER} as the last line`]);
  }
  const body = lines.slice(1, -1);
  if (body.length > MAX_LOCK_ENTRIES) throw new LockError([`${label}: more than ${MAX_LOCK_ENTRIES} entries`]);

  /** @type {LockEntry[]} */
  const entries = [];
  /** @type {Map<string, string>} */
  const collisions = new Map();
  /** @type {Set<string>} */
  const folders = new Set();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string | undefined} */
  let previous;

  body.forEach((raw, index) => {
    const number = index + 2;
    if (/^(<<<<<<<|=======|>>>>>>>)/.test(raw)) {
      add(number, 'a merge conflict marker; resolve the conflict (keep every line, any order) and run "coffer media lock"');
      return;
    }
    const last = index === body.length - 1;
    if (last ? raw.endsWith(',') : !raw.endsWith(',')) {
      add(number, last ? 'the last entry must not end with a comma' : 'every entry but the last must end with a comma');
      return;
    }
    const line = last ? raw : raw.slice(0, -1);
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      add(number, 'is not valid JSON');
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      add(number, 'is not an entry');
      return;
    }
    const keys = Object.keys(value);
    if (keys.length !== 3 || !keys.every((key) => key === 'path' || key === 'sha256' || key === 'size')) {
      add(number, 'must have exactly "path", "sha256" and "size"');
      return;
    }
    const { path, sha256, size } = value;
    const checkedPath = checkMediaPath(path);
    if ('problem' in checkedPath) {
      add(number, `the path ${checkedPath.problem}`);
      return;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      add(number, 'the sha256 must be 64 lowercase hexadecimal characters');
      return;
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      add(number, 'the size must be a whole number of bytes, 0 or more');
      return;
    }
    /** @type {LockEntry} */
    const entry = { path: checkedPath.value, sha256, size };
    if (entryLine(entry) !== line) {
      add(number, 'is not written the way "coffer media lock" writes it');
      return;
    }
    if (seen.has(entry.path)) {
      add(number, `"${entry.path}" is listed twice`);
      return;
    }
    seen.add(entry.path);
    const key = collisionKey(entry.path);
    const other = collisions.get(key);
    if (other !== undefined) {
      add(number, `"${entry.path}" and "${other}" are the same file on a case-insensitive file system`);
      return;
    }
    collisions.set(key, entry.path);
    if (previous !== undefined && compareBytes(previous, entry.path) >= 0) {
      add(number, `"${entry.path}" is out of order; entries are sorted by path`);
    }
    previous = entry.path;
    entries.push(entry);
    const names = key.split('/');
    for (let count = 1; count < names.length; count += 1) folders.add(names.slice(0, count).join('/'));
  });

  // A path that is a file must not also be the folder of another path.
  for (const entry of entries) {
    if (folders.has(collisionKey(entry.path))) {
      problems.push(`${label}: "${entry.path}" is both a file and a folder holding other entries`);
      break;
    }
  }
  if (problems.length > 0) throw new LockError(problems);
  return entries;
}
