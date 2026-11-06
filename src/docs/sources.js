import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { checkGlobPattern } from './glob.js';
import { checkReferenceConfig } from './reference-config.js';

/**
 * Where the documentation of a tool project comes from.
 *
 * A tool's `docs` block names a source (a git repository to clone, or a folder
 * to read in place), the GitHub repository that file links point at, the
 * guides to publish and, later, a generated reference. This module checks the
 * block ({@link checkDocsConfig}, registered as the `docs` field type of the
 * `tool` kind) and fetches the source ({@link fetchDocsSources}). Nothing in
 * it renders anything: the guides are rendered from the fetched folder by a
 * later step.
 *
 * Git is the risky part, because the address comes from a configuration file
 * and the content from a repository that may not be the author's own. Every
 * call is an argument list (never a shell string), the address follows `--`,
 * the environment and the configuration git sees are controlled (see
 * {@link gitEnvironment} and {@link gitConfigArguments}), only the transport the
 * address uses is allowed, hooks, credential helpers, prompts and submodules
 * are off, and a slow or silent server is killed after a timeout.
 */

/** The keys a `docs` mapping can have. */
export const DOCS_KEYS = Object.freeze(['source', 'github', 'guides', 'reference']);

/** The keys a `docs.guides` item can have. */
export const GUIDE_KEYS = Object.freeze(['dir', 'order', 'include', 'exclude']);

/** The most guides a project can publish. */
export const MAX_GUIDES = 20;

/** The most file names `order` can list in one guide. */
export const MAX_GUIDE_ORDER = 200;

/** The most patterns `include` (or `exclude`) can list in one guide. */
export const MAX_GUIDE_GLOBS = 50;

/** The longest path or pattern a guide can name. */
export const MAX_GUIDE_PATH_LENGTH = 200;

/** The longest address of a git repository. */
export const MAX_GIT_URL_LENGTH = 500;

/** What `include` is when a guide does not say. */
export const DEFAULT_GUIDE_INCLUDE = Object.freeze(['**/*.md']);

/** How long one git command can run before it is killed, in milliseconds. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** How long a killed git command is waited for, in milliseconds. */
const KILL_GRACE_MS = 3000;

/** The most output of one git command that is kept (the end of it), per stream. */
export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

/** Name of the folder, inside the cache of repositories, that holds the files that make git's environment controlled. */
const SANDBOX_DIR_NAME = '.coffer-git';

/**
 * A guide: a folder of the documentation source and the files of it to publish.
 *
 * @typedef {object} DocsGuide
 * @property {string} dir Folder inside the source, with `/`; `.` for the source's root.
 * @property {string[]} order File names, relative to `dir`, that come first in the sidebar, in this order.
 * @property {string[]} include Glob patterns, relative to `dir`, of the files that are published.
 * @property {string[]} exclude Glob patterns, relative to `dir`, of the files that are left out although `include` matches them.
 */

/**
 * The source of a project's documentation: a git repository at a branch or tag,
 * or a folder on disk.
 *
 * @typedef {{ git: string, ref: string } | { path: string, dir: string }} DocsSource
 */

/**
 * The checked `docs` block of a project.
 *
 * @typedef {object} DocsConfig
 * @property {DocsSource} source For a folder: `path` as written, and `dir`, the absolute path it resolves to (relative paths are relative to the project's folder).
 * @property {string | null} github `owner/repo` of the GitHub repository that links to files point at; null when the source is not on GitHub and none is given.
 * @property {DocsGuide[]} guides
 * @property {import('./reference-config.js').ReferenceConfig | null} reference The command that generates the reference, and what to do with its output; null when the project has none.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} inside The result of `relative(root, target)`.
 * @returns {boolean} Whether the target is inside the root (or is the root itself).
 */
function isInside(inside) {
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

// ---------------------------------------------------------------------------
// Addresses

/** Characters that never occur in an address we accept: white space, control characters and anything a shell, a quote or a markup would give meaning to. */
const URL_FORBIDDEN = /[\s\u0000-\u001f\u007f"'`\\<>|$;{}^]/u;

/** A percent-encoded control character. */
const ENCODED_CONTROL = /%(?:[01][0-9a-f]|7f)/i;

/** `user@host:path`, the short form of an ssh address. */
const SCP_ADDRESS = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):([A-Za-z0-9._~][A-Za-z0-9._~/-]*)$/;

/** The host of an address with a scheme. */
const HOST_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])$/;

/** The schemes of an address, and the transport git uses for each. */
const SCHEMES = Object.freeze({ 'https:': 'https', 'ssh:': 'ssh', 'file:': 'file' });

/**
 * Checks the address of a git repository. An address is accepted when it is an
 * `https://`, `ssh://` or `file://` URL, or `user@host:path`; it has no white
 * space, control or quoting characters, and neither the host nor the user
 * starts with "-" (which ssh would read as an option). `ext::` and `fd::`
 * transports, local paths and anything else are refused.
 *
 * @param {unknown} value
 * @returns {{ value: string, transport: 'https' | 'ssh' | 'file' } | { problem: string }}
 */
export function checkGitUrl(value) {
  const allowed = 'an https:// or ssh:// URL, a file:// URL, or user@host:owner/repo';
  if (typeof value !== 'string' || value.trim() === '') return { problem: `must be the address of a git repository: ${allowed}` };
  const text = value.trim();
  if (text.length > MAX_GIT_URL_LENGTH) return { problem: `must be at most ${MAX_GIT_URL_LENGTH} characters` };
  if (text.startsWith('-')) return { problem: 'must not start with "-"' };
  if (URL_FORBIDDEN.test(text) || ENCODED_CONTROL.test(text)) {
    return { problem: 'must not contain white space, control characters, quotes, backslashes or any of < > | $ ; { } ^' };
  }
  // A git remote needs neither; a token in a query or fragment would be copied into messages and the manifest.
  if (text.includes('?') || text.includes('#')) {
    return { problem: 'must not contain a query ("?") or a fragment ("#"); put credentials in the user information or use ssh' };
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (scheme === null) {
    const scp = SCP_ADDRESS.exec(text);
    // The text is not echoed: it is not an address we understand, so there is no telling where a password in it would be.
    if (scp === null) return { problem: `is not a usable address (use ${allowed})` };
    if (scp[3].split('/').includes('..')) return { problem: 'must not contain ".." in the path' };
    return { value: text, transport: 'ssh' };
  }
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (!Object.hasOwn(SCHEMES, protocol)) {
    return { problem: `the scheme "${scheme[1]}" is not allowed (use ${allowed})` };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { problem: 'is not a valid URL' };
  }
  const transport = SCHEMES[/** @type {keyof typeof SCHEMES} */ (protocol)];
  // A URL parser resolves ".." away, so the text is looked at as well.
  if (url.pathname.split('/').includes('..') || text.split(/[/?#]/).includes('..')) return { problem: 'must not contain ".." in the path' };
  if (transport === 'file') {
    if ((url.hostname !== '' && url.hostname !== 'localhost') || url.pathname.length < 2) {
      return { problem: 'a file URL must be file:///absolute/path' };
    }
    return { value: text, transport };
  }
  if (!HOST_NAME.test(url.hostname) || url.hostname.startsWith('-')) return { problem: 'must have a valid host name' };
  if (url.username.startsWith('-')) return { problem: 'the user name must not start with "-"' };
  if (transport === 'ssh') {
    // ssh reads a host or user that starts with "-" as an option. Percent-escapes would hide that from the checks above (and git's own
    // handling of them differs between versions), so they are not accepted in the user or the host of an ssh address at all.
    if (url.username.includes('%') || url.hostname.includes('%')) {
      return { problem: 'the user name and the host of an ssh address must not contain percent-escapes ("%")' };
    }
    if (decodedStartsWithDash(url.username) || decodedStartsWithDash(url.hostname)) {
      return { problem: 'the host and the user name must not start with "-"' };
    }
    if (url.port === '0') return { problem: 'the port must be between 1 and 65535' };
  }
  if (url.pathname.length < 2) return { problem: 'must name a repository after the host' };
  if (transport === 'https' && url.protocol !== 'https:') return { problem: 'must be https' };
  return { value: text, transport };
}

/**
 * @param {string} text
 * @returns {boolean} Whether the text, once percent-decoded, starts with "-".
 */
function decodedStartsWithDash(text) {
  if (text.startsWith('-')) return true;
  try {
    return decodeURIComponent(text).startsWith('-');
  } catch {
    return false;
  }
}

/**
 * The address with the credentials left out, for messages and the manifest:
 * an https address loses its whole user information; an ssh address keeps the
 * user name and loses a password. A query and a fragment (where a token might
 * be put) are dropped from every address in the text. It works on any text, so
 * it also cleans the output of git.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactUrl(text) {
  return (
    text
      .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]*)@/g, (_whole, scheme, info) => {
        if (/^https?:\/\//i.test(scheme)) return scheme;
        const colon = info.indexOf(':');
        return `${scheme}${colon === -1 ? info : info.slice(0, colon)}@`;
      })
      // The forms without a scheme, `user:password@host:path` and `user:password@host`: the password is whatever follows the first ":" up
      // to the "@". A "//" or "/" right after the ":" is not one (that is a scheme, or a path such as `C:/dir/a@b`).
      .replace(/(?<![A-Za-z0-9._~%+-])([A-Za-z0-9][A-Za-z0-9._~%+-]*):(?!\/)[^\s@'"`<>]*@/g, '$1@')
      .replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s'"`<>?#]*)[?#][^\s'"`<>]*/g, '$1')
  );
}

/**
 * @param {string} text
 * @returns {string | null} `owner/repo` when the address is a GitHub repository.
 */
export function githubOf(text) {
  const clean = redactUrl(text);
  const match =
    /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(clean) ??
    /^ssh:\/\/[^/@]+@github\.com(?::[0-9]+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(clean) ??
    /^[A-Za-z0-9._-]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(clean);
  if (match === null) return null;
  const repo = `${match[1]}/${match[2]}`;
  return GITHUB_REPO.test(repo) && match[2] !== '.' && match[2] !== '..' ? repo : null;
}

/** `owner/repo` on GitHub. */
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** A branch or tag name, conservatively. */
const REF_NAME = /^[A-Za-z0-9._/-]+$/;

/**
 * @param {unknown} value
 * @returns {{ value: string } | { problem: string }}
 */
function checkRef(value) {
  if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be a branch or tag name' };
  const text = value.trim();
  if (
    text.length > 200 ||
    !REF_NAME.test(text) ||
    text.startsWith('-') ||
    text.startsWith('/') ||
    text.endsWith('/') ||
    text.endsWith('.') ||
    text.endsWith('.lock') ||
    text.includes('..') ||
    text.includes('//')
  ) {
    // Not echoed: a ref is not a secret, but a pasted address or token must not end up in a message.
    return { problem: 'is not a usable branch or tag name (letters, digits, ".", "_", "-" and "/", at most 200 characters)' };
  }
  return { value: text };
}

// ---------------------------------------------------------------------------
// Paths inside a source

/**
 * Checks a path that must stay inside a folder and normalizes it: `/` as the
 * separator, no empty or `.` segments, no trailing slash. `.` alone is the
 * folder itself.
 *
 * @param {unknown} value
 * @param {{ allowRoot?: boolean }} [options] Whether `.` (the folder itself) is accepted.
 * @returns {{ value: string } | { problem: string }}
 */
export function cleanRelativePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be a non-empty path' };
  const text = value.trim();
  if (text.length > MAX_GUIDE_PATH_LENGTH) return { problem: `must be at most ${MAX_GUIDE_PATH_LENGTH} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return { problem: 'must not contain control characters' };
  if (text.includes('\\')) return { problem: 'must use "/" as the separator' };
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) return { problem: 'must be relative to the repository, not absolute' };
  const segments = text.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) return { problem: 'must stay inside the repository (no "..")' };
  if (segments.length === 0) return allowRoot ? { value: '.' } : { problem: 'must name a file' };
  return { value: segments.join('/') };
}

/**
 * Where a relative path of a source leads, with symbolic links followed.
 *
 * @typedef {{ ok: true, path: string } | { ok: false, reason: 'invalid' | 'outside' | 'missing', message: string }} InsideResult
 */

/**
 * Resolves a path inside a folder, for reading a file of a source that may not
 * be the author's own. The path is checked lexically (see
 * {@link cleanRelativePath}), must exist, and must still be inside the folder
 * once symbolic links are followed: a link in a repository that points at
 * `/etc` or at `../..` leads out of it and is refused, so a guide can never
 * read a file outside the repository.
 *
 * @param {string} root Absolute path of the folder.
 * @param {string} rel The path inside it, with `/`; `.` or an empty string is the folder itself.
 * @returns {InsideResult} The real path of the target.
 */
export function resolveInside(root, rel) {
  const cleaned = cleanRelativePath(rel === '' ? '.' : rel, { allowRoot: true });
  if ('problem' in cleaned) return { ok: false, reason: 'invalid', message: `"${rel}" ${cleaned.problem}` };
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: 'missing', message: `the folder "${root}" does not exist` };
  }
  const target = resolve(realRoot, ...cleaned.value.split('/'));
  if (!isInside(relative(realRoot, target))) return { ok: false, reason: 'outside', message: `"${rel}" leads out of the repository` };
  let real;
  try {
    real = realpathSync(target);
  } catch {
    return { ok: false, reason: 'missing', message: `"${rel}" does not exist` };
  }
  if (!isInside(relative(realRoot, real))) {
    return { ok: false, reason: 'outside', message: `"${rel}" leads out of the repository (a symbolic link points outside it)` };
  }
  return { ok: true, path: real };
}

// ---------------------------------------------------------------------------
// The docs block

/**
 * @param {unknown} value
 * @param {string} what
 * @param {number} max
 * @param {string[]} problems
 * @param {(item: string) => { value: string } | { problem: string }} check
 * @returns {string[]} The checked items; the ones with a problem are left out.
 */
function checkList(value, what, max, problems, check) {
  if (!Array.isArray(value)) {
    problems.push(`${what}: must be a list`);
    return [];
  }
  if (value.length > max) {
    problems.push(`${what}: at most ${max} items`);
    return [];
  }
  /** @type {string[]} */
  const items = [];
  for (const [index, item] of value.entries()) {
    const checked = typeof item === 'string' ? check(item) : { problem: 'must be text' };
    if ('problem' in checked) {
      problems.push(`${what}: item ${index + 1} ${checked.problem}`);
    } else if (items.includes(checked.value)) {
      problems.push(`${what}: "${checked.value}" is listed twice`);
    } else {
      items.push(checked.value);
    }
  }
  return items;
}

/**
 * A glob for `include` or `exclude`: relative, inside the guide, no control
 * characters, and written in the syntax the guides step matches (see
 * `glob.js`), so a pattern it cannot match is refused here, by name.
 *
 * @param {string} text
 * @returns {{ value: string } | { problem: string }}
 */
function checkGlob(text) {
  const cleaned = cleanRelativePath(text);
  if ('problem' in cleaned) return cleaned;
  const checked = checkGlobPattern(text.trim());
  return 'problem' in checked ? checked : { value: text.trim() };
}

/**
 * @param {unknown} item
 * @param {number} index
 * @param {string[]} problems
 * @returns {DocsGuide | undefined}
 */
function checkGuide(item, index, problems) {
  const label = `guides: item ${index + 1}`;
  if (!isMapping(item)) {
    problems.push(`${label}: must be a mapping with ${GUIDE_KEYS.join(', ')}`);
    return undefined;
  }
  /** @type {string[]} */
  const own = [];
  for (const key of Object.keys(item)) {
    if (!GUIDE_KEYS.includes(key)) own.push(`${label}: unknown key "${key}" (expected one of: ${GUIDE_KEYS.join(', ')})`);
  }
  let dir = '.';
  if (item.dir === undefined || item.dir === null) {
    own.push(`${label}: dir is required (the folder of the guide in the repository, "." for its root)`);
  } else {
    const cleaned = cleanRelativePath(item.dir, { allowRoot: true });
    if ('problem' in cleaned) own.push(`${label}: dir ${cleaned.problem}`);
    else dir = cleaned.value;
  }
  const order = item.order === undefined || item.order === null ? [] : checkList(item.order, `${label}: order`, MAX_GUIDE_ORDER, own, (name) => cleanRelativePath(name));
  const include =
    item.include === undefined || item.include === null
      ? [...DEFAULT_GUIDE_INCLUDE]
      : checkList(item.include, `${label}: include`, MAX_GUIDE_GLOBS, own, checkGlob);
  const exclude = item.exclude === undefined || item.exclude === null ? [] : checkList(item.exclude, `${label}: exclude`, MAX_GUIDE_GLOBS, own, checkGlob);
  problems.push(...own);
  return own.length > 0 ? undefined : { dir, order, include, exclude };
}

/**
 * @param {unknown} source
 * @param {string} projectDir
 * @param {string[]} problems
 * @returns {DocsSource | undefined}
 */
function checkSource(source, projectDir, problems) {
  if (!isMapping(source)) {
    problems.push('source: is required: {git: URL, ref: branch-or-tag} or {path: folder}');
    return undefined;
  }
  const before = problems.length;
  for (const key of Object.keys(source)) {
    if (!['git', 'ref', 'path'].includes(key)) problems.push(`source: unknown key "${key}" (expected git and ref, or path)`);
  }
  const hasGit = source.git !== undefined && source.git !== null;
  const hasPath = source.path !== undefined && source.path !== null;
  if (hasGit === hasPath) {
    problems.push('source: needs exactly one of git (with ref) or path');
    return undefined;
  }
  if (hasGit) {
    const url = checkGitUrl(source.git);
    if ('problem' in url) problems.push(`source.git: ${url.problem}`);
    if (source.ref === undefined || source.ref === null) {
      problems.push('source.ref: is required with git (a branch or tag)');
    }
    const ref = source.ref === undefined || source.ref === null ? undefined : checkRef(source.ref);
    if (ref !== undefined && 'problem' in ref) problems.push(`source.ref: ${ref.problem}`);
    if (problems.length > before || 'problem' in url || ref === undefined || 'problem' in ref) return undefined;
    return { git: url.value, ref: ref.value };
  }
  if (source.ref !== undefined && source.ref !== null) problems.push('source.ref: only applies to a git source');
  if (typeof source.path !== 'string' || source.path.trim() === '' || /[\u0000-\u001f\u007f]/.test(source.path)) {
    problems.push('source.path: must be a folder (relative to the project folder, or absolute)');
    return undefined;
  }
  const text = source.path.trim();
  const dir = resolve(projectDir, text);
  try {
    if (!statSync(dir).isDirectory()) {
      problems.push(`source.path: "${redactUrl(text)}" is not a folder`);
      return undefined;
    }
  } catch {
    problems.push(`source.path: the folder "${redactUrl(text)}" does not exist (a relative path is relative to the project folder)`);
    return undefined;
  }
  return problems.length > before ? undefined : { path: text, dir };
}

/**
 * Checks a tool's `docs` block and normalizes it. All problems are returned
 * together, in one text.
 *
 * - `source` (required): `{git: URL, ref: branch-or-tag}` or `{path: folder}`;
 * - `github`: `owner/repo`, inferred from a github.com address;
 * - `guides`: a list of `{dir, order, include, exclude}`;
 * - `reference`: `{command, format, output, title, undocumented}` (see `reference-config.js`).
 *
 * @param {unknown} value
 * @param {{ dir: string }} context `dir` is the project's folder, which a relative `source.path` is relative to.
 * @returns {{ value: DocsConfig } | { problem: string }}
 */
export function checkDocsConfig(value, { dir }) {
  if (!isMapping(value)) {
    return { problem: `must be a mapping with some of: ${DOCS_KEYS.join(', ')} (see the documentation of docs sources)` };
  }
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(value)) {
    if (!DOCS_KEYS.includes(key)) problems.push(`${key}: unknown key (expected one of: ${DOCS_KEYS.join(', ')})`);
  }
  const source = checkSource(value.source, dir, problems);

  /** @type {string | null} */
  let github = null;
  if (value.github !== undefined && value.github !== null) {
    if (typeof value.github !== 'string' || !GITHUB_REPO.test(value.github.trim()) || /\.git$|\/\.\.?$/.test(value.github.trim())) {
      problems.push('github: must be owner/repo, such as "octo-org/widget"');
    } else {
      github = value.github.trim();
    }
  } else if (source !== undefined && 'git' in source) {
    github = githubOf(source.git);
  }

  /** @type {DocsGuide[]} */
  const guides = [];
  if (value.guides !== undefined && value.guides !== null) {
    if (!Array.isArray(value.guides)) {
      problems.push('guides: must be a list of {dir, order, include, exclude}');
    } else if (value.guides.length > MAX_GUIDES) {
      problems.push(`guides: at most ${MAX_GUIDES} guides`);
    } else {
      for (const [index, item] of value.guides.entries()) {
        const guide = checkGuide(item, index, problems);
        if (guide === undefined) continue;
        if (guides.some((other) => other.dir === guide.dir)) {
          problems.push(`guides: item ${index + 1}: the folder "${guide.dir}" is listed twice`);
        } else {
          guides.push(guide);
        }
      }
    }
  }

  /** @type {import('./reference-config.js').ReferenceConfig | null} */
  let reference = null;
  if (value.reference !== undefined && value.reference !== null) {
    if (!isMapping(value.reference)) {
      problems.push('reference: must be a mapping');
    } else {
      const checked = checkReferenceConfig(value.reference);
      if ('problems' in checked) problems.push(...checked.problems);
      else reference = checked.value;
    }
  }

  if (problems.length > 0 || source === undefined) return { problem: problems.join('; ') };
  return { value: { source, github, guides, reference } };
}

// ---------------------------------------------------------------------------
// Running git

/**
 * What a git call needs.
 *
 * @typedef {object} GitCall
 * @property {string} cwd
 * @property {Record<string, string>} env The complete environment of the process.
 * @property {number} timeoutMs
 * @property {number} maxOutputBytes
 */

/**
 * What a git call returned.
 *
 * @typedef {object} GitResult
 * @property {number | null} code The exit code; null when the process was killed or did not start.
 * @property {string} stdout The end of what it wrote, at most `maxOutputBytes`.
 * @property {string} stderr
 * @property {boolean} timedOut Whether it was killed because it ran out of time.
 * @property {string} [spawnError] Why it did not start (such as `git` not being installed).
 */

/**
 * Runs a git command: `exec` of {@link fetchDocsSources}. No shell is involved
 * and the command is killed, with everything it started (ssh, the transport
 * helpers), when it runs out of time.
 *
 * @param {string[]} args
 * @param {GitCall} call
 * @returns {Promise<GitResult>}
 */
export function runGit(args, { cwd, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(gitExecutable(env), args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group on POSIX, so that the whole tree can be killed.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    /** @param {Partial<GitResult>} extra */
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, timedOut: false, ...extra });
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // The process is given a moment to go away, so that it no longer holds files in the folder it worked in.
      setTimeout(() => finish({ timedOut: true }), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-maxOutputBytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-maxOutputBytes);
    });
    child.on('error', (error) => finish({ spawnError: error.message }));
    child.on('close', (code) => finish({ code, timedOut }));
    // A killed process is gone at "exit", but its pipes can stay open for a while (a helper it started may hold them): do not wait long for them.
    child.on('exit', () => {
      if (timedOut) setTimeout(() => finish({ timedOut: true }), KILL_PIPE_MS).unref();
    });
  });
}

/** How long, after a killed git process has exited, its output pipes are waited for, in milliseconds. */
const KILL_PIPE_MS = 300;

/** @type {Map<string, string | null>} */
const executableCache = new Map();

/**
 * Finds a program the way a shell would, but only in absolute folders of the
 * `PATH`: the current folder, an empty entry and any relative entry are
 * skipped. On Windows a program is searched in the current folder before
 * `PATH`, so a `git.exe` in a folder of a repository that is not yours could
 * otherwise be run.
 *
 * @param {string} name Program name without an extension.
 * @param {string | undefined} pathValue The value of `PATH`.
 * @param {NodeJS.Platform} [platform]
 * @returns {string | null} The absolute path, or null when it is not found.
 */
export function findExecutable(name, pathValue, platform = process.platform) {
  const windows = platform === 'win32';
  const names = windows ? [`${name}.exe`, `${name}.com`] : [name];
  for (const raw of (pathValue ?? '').split(windows ? ';' : delimiter)) {
    const folder = windows ? raw.trim().replace(/^"(.*)"$/, '$1') : raw;
    if (folder === '' || !isAbsolute(folder)) continue;
    for (const candidate of names) {
      const file = join(folder, candidate);
      try {
        if (!statSync(file).isFile()) continue;
        if (!windows) accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Not here.
      }
    }
  }
  return null;
}

/**
 * The `git` program, found once per `PATH` and used by its absolute path, so
 * that no folder git is run in can supply it.
 *
 * @param {Record<string, string>} env The environment git is run with.
 * @returns {string} The absolute path; `git` itself when none is found (the spawn then fails with "not found").
 */
function gitExecutable(env) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const pathValue = pathKey === undefined ? '' : env[pathKey];
  if (!executableCache.has(pathValue)) executableCache.set(pathValue, findExecutable('git', pathValue));
  return executableCache.get(pathValue) ?? 'git-not-found-on-PATH';
}

/**
 * Kills a process and what it started.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
export function killTree(child) {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      // The system's own program, by its absolute path and from a folder of the system, never from the folder coffer is run in.
      const system = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
      spawn(join(system, 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: system }).on('error', () => {});
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/**
 * The environment git runs in: the process's environment without any `GIT_*`
 * variable (which could point git at another repository or configuration),
 * and with prompts off, no system or user configuration, and only the
 * transport of the address allowed. `GIT_ASKPASS` is set to nothing, so that
 * no helper program is asked for a password.
 *
 * @param {object} sandbox
 * @param {string} sandbox.emptyConfig Path of an empty file, which stands in for the user's git configuration.
 * @param {'https' | 'ssh' | 'file' | null} transport The only transport git may use; null for none (commands that touch no remote).
 * @param {Record<string, string | undefined>} [base] The environment to start from (default the process's).
 * @returns {Record<string, string>}
 */
export function gitEnvironment({ emptyConfig }, transport, base = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    const name = key.toUpperCase();
    if (value === undefined) continue;
    // GIT_SSH_VARIANT only says which command line the user's own ssh program takes (ssh, plink, ...).
    if (name !== 'GIT_SSH_VARIANT' && (name.startsWith('GIT_') || name === 'SSH_ASKPASS' || name === 'SSH_ASKPASS_REQUIRE')) continue;
    env[key] = value;
  }
  const own = base.GIT_SSH_COMMAND ?? (base.GIT_SSH ? `"${base.GIT_SSH}"` : undefined);
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ALLOW_PROTOCOL: transport ?? 'none',
    GIT_SSH_COMMAND: sshCommand(own),
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

/**
 * The ssh command git runs. Without one of the user's own it is `ssh`; ssh is
 * told never to ask anything (`-o BatchMode=yes`). The user's own
 * `GIT_SSH_COMMAND` (or `GIT_SSH`) is kept, and gets the same option only when
 * it is OpenSSH: another client (`plink`, `TortoiseGitPlink`, a wrapper
 * script) does not take `-o`, so it is run exactly as the user set it up.
 *
 * @param {string | undefined} own
 * @returns {string}
 */
export function sshCommand(own) {
  if (own === undefined || own.trim() === '') return 'ssh -o BatchMode=yes';
  const first = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(own);
  const program = (first?.[1] ?? first?.[2] ?? first?.[3] ?? '').split(/[\\/]/).pop() ?? '';
  return /^ssh(?:\.exe)?$/i.test(program) ? `${own} -o BatchMode=yes` : own;
}

/**
 * The `-c` settings of every git call: no hooks, no credential helper, no
 * file system monitor, no submodule recursion, and objects are checked as they
 * arrive.
 *
 * @param {object} sandbox
 * @param {string} sandbox.hooksDir Path of an empty folder.
 * @returns {string[]}
 */
export function gitConfigArguments({ hooksDir }) {
  // Values are config syntax, where a backslash starts an escape: use "/".
  const hooks = hooksDir.split(sep).join('/');
  return [
    '-c', `core.hooksPath=${hooks}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'credential.helper=',
    '-c', 'submodule.recurse=false',
    '-c', 'transfer.fsckObjects=true',
    '-c', 'advice.detachedHead=false',
  ];
}

// ---------------------------------------------------------------------------
// Fetching

/**
 * Raised when documentation sources cannot be fetched. Every failure is in
 * {@link DocsSourceError#errors}, one entry per project, each naming the
 * project and the repository.
 */
export class DocsSourceError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'DocsSourceError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

/**
 * Where a project's documentation was read from.
 *
 * @typedef {{ type: 'git', git: string, ref: string, sha: string } | { type: 'path', path: string, sha: string | null, dirty: boolean | null }} FetchedSource
 */

/**
 * A fetched documentation source.
 *
 * @typedef {object} FetchedDocs
 * @property {string} slug
 * @property {string} root Absolute path of the folder the guides are read from: the checkout in the cache for a git source, the folder itself for a path source. Read files through {@link resolveInside}.
 * @property {FetchedSource} source What the manifest records. A git address has no credentials.
 * @property {string | null} github
 * @property {DocsGuide[]} guides
 */

/**
 * What the manifest lists for a project's docs.
 *
 * @typedef {object} ManifestDocs
 * @property {{ type: 'git', git: string, ref: string, sha: string } | { type: 'path', path: string, sha: string | null, dirty: boolean | null }} source A git source: the address (without credentials), the branch or tag, and the commit the cache holds. A path source: the folder as written in `project.yaml`, the commit of the repository it is in (null outside one) and whether the files differ from it (null when there is no commit).
 * @property {string | null} github
 * @property {DocsGuide[]} guides
 */

/**
 * @typedef {object} FetchOptions
 * @property {string} cacheDir Folder that holds the checkouts, one per project: `{cacheDir}/{slug}`.
 * @property {number} [timeoutMs] Time one git call can take (default {@link DEFAULT_GIT_TIMEOUT_MS}).
 * @property {(args: string[], call: GitCall) => Promise<GitResult>} [exec] Runs git (default {@link runGit}); replaced in tests.
 * @property {Record<string, string | undefined>} [env] The environment git's is made from (default the process's).
 */

/** A slug names a folder in the cache, so it must be one folder name. */
const CACHE_SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** A commit id: SHA-1, or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Last lines of git's output, made safe to print: no credentials, no control
 * characters, not too long.
 *
 * @param {string} text
 * @param {number} [lineCount] How many of the last lines are kept.
 * @param {number} [maxLength] The most characters kept (the end of the text).
 * @returns {string}
 */
export function tailOf(text, lineCount = 6, maxLength = 600) {
  const lines = redactUrl(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const joined = lines.slice(-lineCount).join(' | ');
  return joined.length > maxLength ? `...${joined.slice(-maxLength)}` : joined;
}

/**
 * The reason a git call failed, in words.
 *
 * @param {GitResult} result
 * @param {number} timeoutMs
 * @returns {string}
 */
function failureOf(result, timeoutMs) {
  if (result.spawnError !== undefined) {
    return /ENOENT/.test(result.spawnError)
      ? 'git was not found; install git and make sure it is on the PATH'
      : `git could not be started: ${tailOf(result.spawnError)}`;
  }
  if (result.timedOut) return `git did not finish within ${Number((timeoutMs / 1000).toFixed(1))} s and was stopped`;
  const output = tailOf(`${result.stderr}\n${result.stdout}`);
  const missingRef = /Remote branch .* not found|couldn't find remote ref|Could not find remote branch/i.test(result.stderr);
  const prefix = missingRef ? 'the branch or tag does not exist in the repository' : `git failed (exit code ${result.code})`;
  return output === '' ? prefix : `${prefix}: ${output}`;
}

/**
 * Prepares the files that make git's environment controlled.
 *
 * @param {string} reposDir
 * @returns {{ emptyConfig: string, hooksDir: string }}
 */
function prepareSandbox(reposDir) {
  const dir = join(reposDir, SANDBOX_DIR_NAME);
  const emptyConfig = join(dir, 'empty-config');
  const hooksDir = join(dir, 'no-hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(emptyConfig, '');
  return { emptyConfig, hooksDir };
}

/**
 * @param {string} path
 * @returns {boolean} Whether the path is a real folder (not a link to one).
 */
function isRealDirectory(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Fetches the documentation sources of some projects. A git source is cloned
 * (shallow, one branch or tag) into `{cacheDir}/{slug}`, or, when the cache
 * already holds a clone of the same address, fetched and reset to the ref;
 * a copy whose update fails is deleted and cloned again once, and is never
 * reused as it was. A path source is read in
 * place. Every guide folder has to exist in the source. All failures are
 * collected and raised together.
 *
 * @param {readonly { slug: string, docs: DocsConfig }[]} projects
 * @param {FetchOptions} options
 * @returns {Promise<Map<string, FetchedDocs>>} By project slug.
 * @throws {DocsSourceError} When any source cannot be fetched.
 */
export async function fetchDocsSources(projects, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const exec = options.exec ?? runGit;
  const reposDir = resolve(options.cacheDir);
  /** @type {Map<string, FetchedDocs>} */
  const fetched = new Map();
  /** @type {string[]} */
  const errors = [];
  if (projects.length === 0) return fetched;
  /** @type {{ emptyConfig: string, hooksDir: string }} */
  let sandbox;
  try {
    mkdirSync(reposDir, { recursive: true });
    sandbox = prepareSandbox(reposDir);
  } catch (error) {
    // Nothing can be fetched, and every project that needs it says so.
    throw new DocsSourceError(
      projects.map(({ slug, docs }) => `project "${slug}": cannot fetch the docs source ${describeSource(docs.source)}: cannot prepare the cache folder ${reposDir}: ${fsMessage(error)}`),
    );
  }
  for (const { slug, docs } of projects) {
    try {
      fetched.set(slug, await fetchOne(slug, docs, { reposDir, sandbox, timeoutMs, exec, base: options.env ?? process.env }));
    } catch (error) {
      errors.push(
        error instanceof SourceFailure
          ? error.message
          : `project "${slug}": cannot fetch the docs source ${describeSource(docs.source)}: ${fsMessage(error)}`,
      );
    }
  }
  if (errors.length > 0) throw new DocsSourceError(errors);
  return fetched;
}

/**
 * A failure to fetch one project's source; the message is complete.
 * `fatal` means that trying again cannot help: git is missing, or it ran out of time.
 */
class SourceFailure extends Error {
  /**
   * @param {string} message
   * @param {boolean} [fatal]
   */
  constructor(message, fatal = false) {
    super(message);
    this.fatal = fatal;
  }
}

/**
 * @param {DocsSource} source
 * @returns {string} The address (without credentials) or the folder, for messages.
 */
function describeSource(source) {
  return 'git' in source ? displayAddress(source.git) : redactUrl(source.path);
}

/**
 * An address for messages and the manifest. Only an address that is accepted
 * is shown (without credentials); any other text could hold a secret in a form
 * that cannot be told apart, so it is not echoed.
 *
 * @param {unknown} address
 * @returns {string}
 */
export function displayAddress(address) {
  return typeof address === 'string' && 'value' in checkGitUrl(address) ? redactUrl(address.trim()) : '(an address that is not usable)';
}

/**
 * @param {unknown} error
 * @returns {string} What went wrong, without credentials.
 */
function fsMessage(error) {
  return tailOf(error instanceof Error ? error.message : String(error));
}

/**
 * @typedef {object} FetchContext
 * @property {string} reposDir
 * @property {{ emptyConfig: string, hooksDir: string }} sandbox
 * @property {number} timeoutMs
 * @property {(args: string[], call: GitCall) => Promise<GitResult>} exec
 * @property {Record<string, string | undefined>} base
 */

/**
 * @param {string} slug
 * @param {DocsConfig} docs
 * @param {FetchContext} context
 * @returns {Promise<FetchedDocs>}
 */
async function fetchOne(slug, docs, context) {
  if (!CACHE_SLUG.test(slug)) throw new SourceFailure(`project "${slug}": docs: the slug is not usable as a cache folder name`);
  const { source } = docs;
  /** @type {string} */
  let where;
  /** @type {string} */
  let root;
  /** @type {FetchedSource} */
  let fetchedSource;
  if ('git' in source) {
    where = displayAddress(source.git);
    const sha = await fetchGit(slug, source, where, context);
    root = join(context.reposDir, slug);
    fetchedSource = { type: 'git', git: where, ref: source.ref, sha };
  } else {
    where = source.path;
    root = source.dir;
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a folder');
    } catch {
      throw new SourceFailure(`project "${slug}": docs source path "${redactUrl(source.path)}" is not a folder or does not exist`);
    }
    fetchedSource = { type: 'path', path: source.path, ...(await headOf(root, context)) };
  }
  for (const guide of docs.guides) {
    const found = resolveInside(root, guide.dir);
    /** @type {string | null} */
    let problem = null;
    if (!found.ok) {
      problem = found.reason === 'missing' ? 'does not exist in the source' : `cannot be used: ${found.message}`;
    } else if (!statSync(found.path).isDirectory()) {
      problem = 'is not a folder';
    }
    if (problem !== null) {
      const ref = 'ref' in source ? ` (ref ${source.ref})` : '';
      throw new SourceFailure(`project "${slug}": docs source ${where}${ref}: the guide folder "${guide.dir}" ${problem}`);
    }
  }
  return { slug, root, source: fetchedSource, github: docs.github, guides: docs.guides };
}

/**
 * The commit of the repository a folder is in, and whether the folder differs
 * from it. Nothing is reported for a folder outside a repository or when git
 * is not installed: a path source does not need git.
 *
 * @param {string} dir
 * @param {FetchContext} context
 * @returns {Promise<{ sha: string | null, dirty: boolean | null }>}
 */
async function headOf(dir, context) {
  // git runs in a folder of ours and is pointed at the source with -C: the source may be someone else's repository, and a program in the
  // folder git runs in must never be what is started (Windows looks there first).
  const call = {
    cwd: context.reposDir,
    env: gitEnvironment(context.sandbox, null, context.base),
    timeoutMs: Math.min(context.timeoutMs, 30_000),
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
  };
  const head = await context.exec([...gitConfigArguments(context.sandbox), '-C', dir, 'rev-parse', '--verify', '--quiet', 'HEAD'], call);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !COMMIT_ID.test(sha)) return { sha: null, dirty: null };
  const status = await context.exec(
    [...gitConfigArguments(context.sandbox), '-C', dir, 'status', '--porcelain=v1', '--untracked-files=normal', '--', '.'],
    call,
  );
  return { sha, dirty: status.code === 0 ? status.stdout.trim() !== '' : null };
}

/**
 * Clones or updates a project's checkout.
 *
 * @param {string} slug
 * @param {{ git: string, ref: string }} source
 * @param {string} where The address without credentials.
 * @param {FetchContext} context
 * @returns {Promise<string>} The commit the checkout is at.
 */
async function fetchGit(slug, source, where, context) {
  const checked = checkGitUrl(source.git);
  if ('problem' in checked) throw new SourceFailure(`project "${slug}": docs source ${where}: source.git ${checked.problem}`);
  const checkedRef = checkRef(source.ref);
  if ('problem' in checkedRef) throw new SourceFailure(`project "${slug}": docs source ${where}: source.ref ${checkedRef.problem}`);
  const target = join(context.reposDir, slug);
  if (!isInside(relative(context.reposDir, target)) || relative(context.reposDir, target) !== slug) {
    throw new SourceFailure(`project "${slug}": docs source ${where}: the cache folder is outside the cache`);
  }
  const gitDir = join(target, '.git');
  const env = gitEnvironment(context.sandbox, checked.transport, context.base);
  const fail = (/** @type {string} */ reason, fatal = false) =>
    new SourceFailure(`project "${slug}": cannot fetch the docs source ${where} (ref ${source.ref}): ${reason}`, fatal);
  /**
   * Git runs in the cache folder, never in a folder of the repository it works on.
   *
   * @param {string[]} args
   */
  const git = (args) =>
    context.exec([...gitConfigArguments(context.sandbox), ...args], {
      cwd: context.reposDir,
      env,
      timeoutMs: context.timeoutMs,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    });
  /**
   * @param {string} step
   * @param {string[]} args
   */
  const must = async (step, args) => {
    const result = await git(args);
    if (result.code !== 0) {
      throw fail(`${step}: ${failureOf(result, context.timeoutMs)}`, result.spawnError !== undefined || result.timedOut);
    }
    return result;
  };
  const removeCopy = () => {
    try {
      // Windows can hold the files of a process that was just stopped for a moment.
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      throw fail(`cannot remove the cached copy in ${target}: ${fsMessage(error)}`);
    }
  };
  // Every call below names the repository, so that git never looks for one in a parent folder.
  const own = [`--git-dir=${gitDir}`, `--work-tree=${target}`];
  const headOfCopy = async () => {
    const head = await must('rev-parse', [...own, 'rev-parse', '--verify', 'HEAD^{commit}']);
    const sha = head.stdout.trim();
    if (!COMMIT_ID.test(sha)) throw fail(`git reported "${tailOf(sha)}" instead of a commit id`);
    return sha;
  };

  let reuse = false;
  if (isRealDirectory(target) && isRealDirectory(gitDir)) {
    const origin = await git([...own, 'config', '--get', 'remote.origin.url']);
    if (origin.spawnError !== undefined) throw fail(failureOf(origin, context.timeoutMs), true);
    if (origin.timedOut) {
      removeCopy();
      throw fail(failureOf(origin, context.timeoutMs), true);
    }
    reuse = origin.code === 0 && origin.stdout.trim() === source.git;
  }
  if (reuse) {
    try {
      await must('fetch', [...own, 'fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', 'origin', source.ref]);
      await must('reset', [...own, 'reset', '--quiet', '--hard', 'FETCH_HEAD']);
      await must('clean', [...own, 'clean', '--quiet', '-f', '-f', '-d', '-x']);
      return await headOfCopy();
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      // A failed or killed update can leave lock files and half-written objects that would make every later update fail, and the stale
      // checkout is never used. The copy is removed and, unless git is missing or ran out of time, cloned again.
      removeCopy();
      if (error.fatal) throw error;
    }
  } else {
    removeCopy();
  }
  try {
    await must('clone', [
      'clone', '--quiet', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
      `--branch=${source.ref}`, '--', source.git, target,
    ]);
    return await headOfCopy();
  } catch (error) {
    try {
      removeCopy();
    } catch {
      // The failure to fetch is what is reported.
    }
    throw error;
  }
}

/**
 * The commit a branch or tag of a remote repository is at, from `git ls-remote`
 * output. A branch wins over a tag of the same name (as it does for `git clone
 * --branch`), and an annotated tag is peeled to the commit it points at, which
 * is the commit a clone of it is at.
 *
 * @param {string} output
 * @param {string} ref A branch or tag name.
 * @returns {string | null} The commit id; null when the repository has no such branch or tag.
 */
export function commitFromLsRemote(output, ref) {
  /** @type {Map<string, string>} */
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(line);
    if (match !== null) found.set(match[2], match[1]);
  }
  return found.get(`refs/heads/${ref}`) ?? found.get(`refs/tags/${ref}^{}`) ?? found.get(`refs/tags/${ref}`) ?? null;
}

/**
 * Asks the remote repositories of some projects which commit their configured
 * branch or tag is at now, with `git ls-remote`: nothing is cloned, and no
 * token is needed for a public repository. It goes through the same safety
 * layer as {@link fetchDocsSources}: git by its absolute path, an argument list,
 * the address after `--`, a controlled environment, only the transport of the
 * address, no hooks or credential helpers, a time limit, and no credentials
 * in any message.
 *
 * @param {readonly { slug: string, source: { git: string, ref: string } }[]} projects
 * @param {Pick<FetchOptions, 'timeoutMs' | 'exec' | 'env'>} [options]
 * @returns {Promise<Map<string, string>>} The commit by project slug.
 * @throws {DocsSourceError} When any cannot be read; every failure is listed.
 */
export async function readRemoteCommits(projects, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const exec = options.exec ?? runGit;
  /** @type {Map<string, string>} */
  const commits = new Map();
  /** @type {string[]} */
  const errors = [];
  if (projects.length === 0) return commits;
  // git needs a folder to run in and files for its controlled configuration; both are made new for the call and removed after it.
  let work;
  /** @type {{ emptyConfig: string, hooksDir: string }} */
  let sandbox;
  try {
    work = mkdtempSync(join(tmpdir(), 'coffer-remote-'));
    sandbox = prepareSandbox(work);
  } catch (error) {
    throw new DocsSourceError(
      projects.map(({ slug, source }) => `project "${slug}": cannot read the commit of ${displayAddress(source.git)} (ref ${displayRef(source.ref)}): cannot prepare a work folder: ${fsMessage(error)}`),
    );
  }
  try {
    for (const { slug, source } of projects) {
      const where = displayAddress(source.git);
      const fail = (/** @type {string} */ reason) =>
        errors.push(`project "${slug}": cannot read the commit of ${where} (ref ${displayRef(source.ref)}): ${reason}`);
      const checked = checkGitUrl(source.git);
      if ('problem' in checked) {
        fail(`source.git ${checked.problem}`);
        continue;
      }
      const checkedRef = checkRef(source.ref);
      if ('problem' in checkedRef) {
        fail(`source.ref ${checkedRef.problem}`);
        continue;
      }
      const ref = checkedRef.value;
      const result = await exec(
        [
          ...gitConfigArguments(sandbox),
          'ls-remote',
          '--',
          checked.value,
          `refs/heads/${ref}`,
          `refs/tags/${ref}`,
          `refs/tags/${ref}^{}`,
        ],
        {
          cwd: work,
          env: gitEnvironment(sandbox, checked.transport, options.env ?? process.env),
          timeoutMs,
          maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
        },
      );
      if (result.code !== 0 || result.spawnError !== undefined || result.timedOut) {
        fail(`ls-remote: ${failureOf(result, timeoutMs)}`);
        continue;
      }
      const sha = commitFromLsRemote(result.stdout, ref);
      if (sha === null) fail('the branch or tag does not exist in the repository');
      else commits.set(slug, sha);
    }
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover in the temporary folder is not worth failing for.
    }
  }
  if (errors.length > 0) throw new DocsSourceError(errors);
  return commits;
}

/**
 * A project that has a `docs` block, as `coffer docs fetch` reads it.
 *
 * @typedef {object} DocsEntry
 * @property {string} site Id of the site the project belongs to.
 * @property {string} slug The project's folder name.
 * @property {DocsConfig} docs
 */

/**
 * Plans what `coffer docs fetch` fetches when several sites have projects.
 *
 * A project folder name is one cache folder (`{cacheDir}/{slug}`) for the git
 * sources that use it, so two git sources with the same folder name must be
 * the same repository at the same ref; when the address or the ref differ, that
 * is a conflict. Nothing else is: the guides are not part of the source (the
 * same repository is fetched once and every guide folder of every site is
 * checked), and a folder source never uses the cache. Entries that differ only
 * in the folder they read share a slug, which one run can report only once, so
 * they go in separate runs.
 *
 * @param {readonly DocsEntry[]} entries
 * @returns {{ runs: { slug: string, docs: DocsConfig }[][], conflicts: string[] }}
 */
export function planDocsFetch(entries) {
  /** @type {string[]} */
  const conflicts = [];
  /** @type {Map<string, { site: string, source: { git: string, ref: string } }>} */
  const gitBySlug = new Map();
  /** @type {Map<string, { slug: string, docs: DocsConfig }>} */
  const distinct = new Map();
  for (const { site, slug, docs } of entries) {
    const { source } = docs;
    let key;
    if ('git' in source) {
      const earlier = gitBySlug.get(slug);
      if (earlier === undefined) {
        gitBySlug.set(slug, { site, source });
      } else if (earlier.source.git !== source.git || earlier.source.ref !== source.ref) {
        conflicts.push(
          `project "${slug}": site "${site}" configures the docs source ${displayAddress(source.git)} (ref ${displayRef(source.ref)}), but site "${earlier.site}" has ${displayAddress(earlier.source.git)} (ref ${displayRef(earlier.source.ref)}) for a project with the same folder name; both use the cache folder .cache/repos/${slug}, so give the projects different folder names or the same source`,
        );
        continue;
      }
      key = `git\0${slug}`;
    } else {
      key = `path\0${slug}\0${source.dir}`;
    }
    const same = distinct.get(key);
    if (same === undefined) {
      distinct.set(key, { slug, docs });
    } else {
      const known = new Set(same.docs.guides.map((guide) => guide.dir));
      same.docs = { ...same.docs, guides: [...same.docs.guides, ...docs.guides.filter((guide) => !known.has(guide.dir))] };
    }
  }
  /** @type {{ slug: string, docs: DocsConfig }[][]} */
  const runs = [];
  for (const entry of distinct.values()) {
    const run = runs.find((candidate) => !candidate.some((other) => other.slug === entry.slug));
    if (run === undefined) runs.push([entry]);
    else run.push(entry);
  }
  return { runs, conflicts };
}

/**
 * @param {unknown} ref
 * @returns {string} The ref for a message: shown only when it is a usable one.
 */
function displayRef(ref) {
  return 'value' in checkRef(ref) ? String(ref) : '(a ref that is not usable)';
}

/**
 * The manifest entry of a fetched source.
 *
 * @param {FetchedDocs} fetched
 * @param {string} configDir Absolute path of the folder with the configuration file; a path source is listed relative to it when it is inside.
 * @returns {ManifestDocs}
 */
export function manifestDocs(fetched, configDir) {
  /** @type {ManifestDocs['source']} */
  let source = fetched.source;
  if (source.type === 'path') {
    const inside = relative(configDir, fetched.root);
    source = { ...source, path: isInside(inside) && inside !== '' ? inside.split(sep).join('/') : source.path };
  }
  return { source, github: fetched.github, guides: fetched.guides };
}

/**
 * One line that says what was fetched, for `coffer docs fetch`.
 *
 * @param {FetchedDocs} fetched
 * @returns {string} `slug: sha (address or path)`.
 */
export function describeFetched(fetched) {
  const { source } = fetched;
  if (source.type === 'git') return `${fetched.slug}: ${source.sha} (${source.git}, ref ${source.ref})`;
  const state = source.sha === null ? 'not in a git repository' : source.sha;
  return `${fetched.slug}: ${state} (${source.path}${source.dirty ? ', uncommitted changes' : ''})`;
}
