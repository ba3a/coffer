import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { matchGlob } from '../docs/glob.js';

/**
 * The paths of originals, as the lock file and the state files write them, and
 * the only way the media commands turn such a path into a place on disk.
 *
 * A lock file comes out of a git repository, so it can be written by someone
 * else: every path in it is untrusted. A path is accepted when it is plain,
 * relative, portable to every platform and made of ordinary names (see
 * {@link checkMediaPath}), and it is only used through
 * {@link resolveMediaFile}, which refuses to go through a symbolic link or a
 * junction.
 */

/** The longest path of an original, in bytes of UTF-8. */
export const MAX_PATH_BYTES = 1024;

/** The longest name of one file or folder, in bytes of UTF-8 (the limit of most file systems). */
export const MAX_NAME_BYTES = 255;

/** Characters no path may contain: control characters, line and paragraph separators, bidirectional controls and the byte order mark. */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Zl}\p{Zp}‎‏‪-‮⁦-⁩﻿]/u;

/** Characters Windows does not allow in a name (and `:` also starts a drive or a data stream). */
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;

/** Names Windows reserves for devices, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Checks the path of an original and says what is wrong with it. The rules
 * hold on every platform, so a lock file made on Linux is safe on Windows:
 * relative, written with `/`, no empty, `.` or `..` names, no name starting
 * with a dot (which keeps `.git`, `.coffer` and hooks out of reach), no
 * `:` (drive letters, data streams) or other character Windows forbids, no
 * device names such as `CON` or `NUL`, no name ending in a dot or a space, no
 * control characters, and bounded lengths.
 *
 * @param {unknown} value
 * @returns {{ value: string } | { problem: string }}
 */
export function checkMediaPath(value) {
  if (typeof value !== 'string' || value === '') return { problem: 'is not a path' };
  if (/\p{Surrogate}/u.test(value)) return { problem: 'is not valid text' };
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) return { problem: `is longer than ${MAX_PATH_BYTES} bytes` };
  if (FORBIDDEN_CHARS.test(value)) return { problem: 'contains a control character' };
  if (value.includes('\\')) return { problem: 'contains "\\"; paths are written with "/"' };
  if (value.startsWith('/')) return { problem: 'is absolute' };
  if (WINDOWS_FORBIDDEN.test(value)) return { problem: 'contains a character that is not allowed in a file name on every platform (one of < > : " | ? *)' };
  for (const name of value.split('/')) {
    if (name === '') return { problem: 'has an empty name (a leading, trailing or doubled "/")' };
    if (name === '.' || name === '..') return { problem: `contains "${name}"` };
    if (name.startsWith('.')) return { problem: `has the name "${name}", which starts with a dot; hidden files and folders are never originals` };
    if (name.endsWith('.') || name.endsWith(' ')) return { problem: `has the name "${name}", which ends in a dot or a space` };
    if (Buffer.byteLength(name) > MAX_NAME_BYTES) return { problem: `has a name longer than ${MAX_NAME_BYTES} bytes` };
    if (WINDOWS_DEVICE.test(name.split('.')[0].trimEnd())) return { problem: `has the name "${name}", which Windows reserves for a device` };
  }
  return { value };
}

/**
 * The key two paths share when a case-insensitive or Unicode-normalizing file
 * system (Windows, macOS) would take them for the same file.
 *
 * @param {string} path
 * @returns {string}
 */
export function collisionKey(path) {
  return path.normalize('NFC').toLowerCase();
}

/**
 * Compares two paths by the bytes of their UTF-8, which does not depend on the
 * locale of the machine.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * Whether a path matches any of the compiled `include` patterns.
 *
 * @param {import('../docs/glob.js').CompiledGlob[]} globs
 * @param {string} path
 * @returns {boolean}
 */
export function matchesAny(globs, path) {
  return globs.some((glob) => matchGlob(glob, path));
}

/**
 * Whether a relative path (from `path.relative`) stays inside its base.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function staysInside(rel) {
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where an original is (or would be) on disk.
 *
 * @typedef {{ ok: true, path: string, exists: boolean }
 *   | { ok: false, message: string }} MediaFileLocation
 */

/**
 * Turns the path of an original into an absolute path inside the media root,
 * for reading, writing or deleting it.
 *
 * The path is checked with {@link checkMediaPath}. Then every folder on the way
 * is looked at without following links: a symbolic link or a junction
 * anywhere on the path (also one that points inside the root) is refused, as
 * is a folder where a file must be and a file where a folder must be. With
 * `createFolders` the missing folders are made, one at a time, with the same
 * checks. The result is also checked against the real path of the root.
 *
 * @param {string} root Absolute path of the media root.
 * @param {string} rel The path of the original, with `/`.
 * @param {{ createFolders?: boolean }} [options]
 * @returns {Promise<MediaFileLocation>}
 */
export async function resolveMediaFile(root, rel, options = {}) {
  const checked = checkMediaPath(rel);
  if ('problem' in checked) return { ok: false, message: `"${String(rel).slice(0, 80)}" ${checked.problem}` };
  let realRoot;
  try {
    realRoot = await realpath(root);
  } catch {
    return { ok: false, message: `the media root ${root} does not exist` };
  }
  const names = rel.split('/');
  let current = realRoot;
  for (const name of names.slice(0, -1)) {
    const next = join(current, name);
    let info = await lstatOrNull(next);
    if (info === null && options.createFolders) {
      try {
        await mkdir(next);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
      }
      info = await lstatOrNull(next);
    }
    if (info === null) return { ok: true, path: join(realRoot, ...names), exists: false };
    if (info.isSymbolicLink()) return { ok: false, message: `"${rel}" goes through "${name}", which is a symbolic link or junction` };
    if (!info.isDirectory()) return { ok: false, message: `"${rel}" needs "${name}" to be a folder, but it is a file` };
    current = next;
  }
  const target = join(current, names[names.length - 1]);
  if (!staysInside(relative(realRoot, target))) return { ok: false, message: `"${rel}" leads out of the media root` };
  const info = await lstatOrNull(target);
  if (info === null) return { ok: true, path: target, exists: false };
  if (info.isSymbolicLink()) return { ok: false, message: `"${rel}" is a symbolic link or junction` };
  if (!info.isFile()) return { ok: false, message: `"${rel}" is a folder or another kind of file, not a file` };
  // Belt and braces: the real path of the file must be inside the real root too.
  // (This is the check `resolveInside` makes for documentation sources; that
  // helper limits a path to 200 characters, which is too short for the paths
  // of photos in long folder names, so the same check is made here.)
  let real;
  try {
    real = await realpath(target);
  } catch {
    return { ok: false, message: `"${rel}" cannot be resolved` };
  }
  if (!staysInside(relative(realRoot, real))) return { ok: false, message: `"${rel}" leads out of the media root (a link points outside it)` };
  return { ok: true, path: target, exists: true };
}

/**
 * @param {string} path
 * @returns {Promise<import('node:fs').Stats | null>} The status of the path itself (a link is not followed), or null when nothing is there.
 */
async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * The folders worth walking for a pattern: the leading names of the pattern
 * that have no wildcard in them. `content/posts/**` + `/*.jpg` starts at
 * `content/posts`.
 *
 * @param {string} pattern
 * @returns {string} A path with `/`, or the empty string for the root.
 */
export function literalPrefix(pattern) {
  const names = pattern.split('/').filter((name) => name !== '' && name !== '.');
  const prefix = [];
  for (const name of names.slice(0, -1)) {
    if (/[*?[]/.test(name)) break;
    prefix.push(name);
  }
  return prefix.join('/');
}

/** The folders that are never walked, whatever the patterns say. */
const SKIPPED_FOLDERS = new Set(['node_modules']);

/** How deep the scan goes below a starting folder. */
const MAX_DEPTH = 64;

/**
 * An original found on disk.
 *
 * @typedef {object} LocalFile
 * @property {string} path Path relative to the root, with `/`.
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * Finds the files that match the `include` patterns. Only regular files count;
 * links are not followed (a link that matches is reported in `links` and
 * left out), and hidden files and folders and `node_modules` are not entered.
 *
 * @param {string} root Absolute path of the media root.
 * @param {string[]} include The `include` patterns.
 * @param {import('../docs/glob.js').CompiledGlob[]} globs The same patterns, compiled.
 * @returns {Promise<{ files: LocalFile[], links: string[] }>}
 */
export async function scanOriginals(root, include, globs) {
  /** @type {Set<string>} */
  const starts = new Set(include.map(literalPrefix));
  // A start inside another start would be walked twice.
  const roots = [...starts].filter((start) => ![...starts].some((other) => other !== start && (other === '' || start.startsWith(`${other}/`))));
  /** @type {Map<string, LocalFile>} */
  const found = new Map();
  /** @type {string[]} */
  const links = [];

  /**
   * @param {string} relDir
   * @param {number} depth
   */
  const walk = async (relDir, depth) => {
    if (depth > MAX_DEPTH) return;
    const absDir = relDir === '' ? root : join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw error;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.')) continue;
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (entry.isSymbolicLink()) {
        if (matchesAny(globs, rel)) links.push(rel);
      } else if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(name)) await walk(rel, depth + 1);
      } else if (entry.isFile() && matchesAny(globs, rel)) {
        const info = await lstat(join(absDir, name));
        found.set(rel, { path: rel, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  };

  // The walk starts from a folder; if that folder is itself a link it is left alone.
  for (const start of roots) {
    if (start !== '') {
      const names = start.split('/');
      if (names.some((name) => name.startsWith('.') || SKIPPED_FOLDERS.has(name))) continue;
      let usable = true;
      for (let count = 1; count <= names.length && usable; count += 1) {
        const info = await lstatOrNull(join(root, ...names.slice(0, count)));
        usable = info !== null && !info.isSymbolicLink() && info.isDirectory();
      }
      if (!usable) continue;
    }
    await walk(start, 0);
  }
  return { files: [...found.values()], links };
}

/**
 * Turns the separators of a native path into `/`.
 *
 * @param {string} path
 * @returns {string}
 */
export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/');
}
