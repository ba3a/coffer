import { existsSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ConfigError, findConfigFile, loadConfig } from './config.js';
import { runGit, tailOf } from './docs/sources.js';
import { MissingCredentialsError } from './media/credentials.js';
import { writeFileAtomic } from './media/fsutil.js';
import { LockError } from './media/lock.js';
import { MediaStoreError } from './media/store.js';
import { createStore } from './media/stores.js';
import { formatLock, formatPull, formatPush, lockMedia, MediaError, mediaContext, pullMedia, pushMedia } from './media/sync.js';

/**
 * `coffer hooks`: git hooks that keep the media originals in step with git.
 *
 * `coffer hooks install` writes five small POSIX shell scripts to
 * `.coffer-hooks/` and points the `core.hooksPath` of this repository (the local
 * configuration only, never `--global` or `--system`) at them. The scripts do
 * nothing but find coffer and call `coffer hooks run <hook>`; what a hook does
 * is code in this file, which is tested without a shell:
 *
 * - `pre-commit` refreshes `media.lock.json` and stages it;
 * - `pre-push` uploads the objects of the lock that the store lacks and stops
 *   the push when that fails;
 * - `post-checkout` (branch checkouts only), `post-merge` and `post-rewrite`
 *   fetch the originals the lock lists. They never fail the git operation they
 *   follow, and skip with a notice when there are no credentials.
 *
 * Nothing here can delete data on its own account: `pull` is the media pull of
 * `coffer media pull`, which refuses to delete files that were not synced, and
 * no hook passes `--force`.
 */

/** The folder of the generated scripts, in the root of the repository. */
export const HOOKS_DIR_NAME = '.coffer-hooks';

/** The hooks coffer generates. */
export const HOOK_NAMES = Object.freeze(['pre-commit', 'pre-push', 'post-checkout', 'post-merge', 'post-rewrite']);

/** The version of the generated scripts; a script of an older version is replaced by `install`. */
export const HOOK_VERSION = 1;

/** The start of the second line of every generated script; it says that coffer wrote the file. */
const MARKER = '# coffer-hook:';

/** The exit code of a command that was called wrongly. */
const EXIT_USAGE = 2;

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Raised for a problem the person running a command can act on.
 */
export class HooksError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'HooksError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// The scripts

/**
 * What each hook does, for the comment at the top of its script and the
 * message when it fails.
 *
 * @type {Record<string, { blocking: boolean, summary: string, failure: string }>}
 */
const HOOK_DETAILS = {
  'pre-commit': {
    blocking: true,
    summary: 'Refreshes media.lock.json from the originals in the working copy and stages it.',
    failure: 'the commit was stopped. Fix the problem above, or commit without this hook (git commit --no-verify); the lock file is then not refreshed.',
  },
  'pre-push': {
    blocking: true,
    summary: 'Uploads the originals the lock file lists to the media store; stops the push if that fails. Does nothing when the push only deletes branches or tags, or when the lock lists nothing.',
    failure: 'the push was stopped because the originals could not be uploaded. Fix the problem above, or push without this hook (git push --no-verify); the originals are then missing for everybody who pulls.',
  },
  'post-checkout': {
    blocking: false,
    summary: 'After a branch checkout, fetches the originals the lock file lists (never fails the checkout).',
    failure: 'the originals were not fetched; run "coffer media pull" to see why.',
  },
  'post-merge': {
    blocking: false,
    summary: 'After a merge, fetches the originals the lock file lists (never fails the merge).',
    failure: 'the originals were not fetched; run "coffer media pull" to see why.',
  },
  'post-rewrite': {
    blocking: false,
    summary: 'After an amend or a rebase, fetches the originals the lock file lists (never fails it).',
    failure: 'the originals were not fetched; run "coffer media pull" to see why.',
  },
};

/**
 * @param {string} text
 * @returns {string} The text in single quotes for a POSIX shell.
 */
function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The text of a hook script: POSIX `sh`, LF line ends, no bashisms.
 *
 * @param {string} name One of {@link HOOK_NAMES}.
 * @param {{ config?: string }} [options] `config` is the configuration file, relative to the root of the repository, with `/`.
 * @returns {string}
 */
export function renderHook(name, options = {}) {
  const details = HOOK_DETAILS[name];
  if (details === undefined) throw new HooksError([`there is no hook "${name}"`]);
  const lines = [
    '#!/bin/sh',
    `${MARKER} ${name} version ${HOOK_VERSION}`,
    '# Generated by "coffer hooks install"; do not edit this file, run the command again to update it.',
    `# ${details.summary}`,
    '# The program that is run: $COFFER if it is set, else node_modules/.bin/coffer of the repository, else "coffer" on the PATH.',
    '# Set COFFER_SKIP_HOOKS=1 to skip all coffer hooks (for example in a CI job that commits). See docs/media.md.',
    'set -eu',
    '',
    `hook=${shellQuote(name)}`,
    `blocking=${details.blocking ? 1 : 0}`,
    `config=${shellQuote(options.config ?? '')}`,
    '',
  ];
  if (name === 'post-checkout') {
    lines.push(
      '# Only a checkout of a branch (the third argument is 1) changes the working copy in a way that matters;',
      '# checking out single files (0) does not.',
      `[ "\${3:-}" = '1' ] || exit 0`,
      '',
    );
  }
  lines.push(
    'if [ -n "${COFFER_SKIP_HOOKS:-}" ]; then',
    '  exit 0',
    'fi',
    '',
    'say() {',
    `  printf 'coffer (%s hook): %s\\n' "$hook" "$1" >&2`,
    '}',
    '',
    '# A hook that guards an operation (pre-*) fails when it cannot do its work, so that nothing slips through;',
    '# a hook that follows an operation (post-*) only says so, because it cannot undo or stop it.',
    'stop() {',
    '  say "$1"',
    '  if [ "$blocking" = 1 ]; then',
    '    exit 1',
    '  fi',
    '  exit 0',
    '}',
    '',
    '# Git runs hooks in the root of the working tree; make sure of it.',
    `root=$(git rev-parse --show-toplevel 2>/dev/null) || stop 'cannot find the root of the repository'`,
    'cd "$root" || stop "cannot enter $root"',
    '',
    'if [ -n "${COFFER:-}" ]; then',
    '  program=$COFFER',
    'elif [ -f "$root/node_modules/.bin/coffer" ]; then',
    '  program="$root/node_modules/.bin/coffer"',
    'elif command -v coffer >/dev/null 2>&1; then',
    '  program=coffer',
    'else',
    `  stop 'the coffer program was not found: run "npm install" in the repository, or set COFFER to its path'`,
    'fi',
    'if [ -z "${COFFER:-}" ] && ! command -v node >/dev/null 2>&1; then',
    `  stop 'node was not found on the PATH of this program (a graphical git client may not have it): start git from a terminal, or set COFFER'`,
    'fi',
    '',
    'status=0',
    'if [ -n "$config" ]; then',
    '  "$program" hooks run "$hook" --config "$config" -- "$@" || status=$?',
    'else',
    '  "$program" hooks run "$hook" -- "$@" || status=$?',
    'fi',
    '',
    'if [ "$status" -ne 0 ]; then',
    `  say ${shellQuote(details.failure)}`,
    'fi',
    details.blocking ? 'exit "$status"' : 'exit 0',
    '',
  );
  return lines.join('\n');
}

/**
 * Whether the text of a hook file was generated by coffer.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isGeneratedHook(text) {
  const lines = text.split(/\r?\n/, 3);
  return lines[0] === '#!/bin/sh' && (lines[1] ?? '').startsWith(MARKER);
}

// ---------------------------------------------------------------------------
// Git

/**
 * The environment for the git calls of `install`, `uninstall` and `status`:
 * the process's without any `GIT_*` variable, which could point git at
 * another repository or configuration. The user's own git configuration is
 * kept (it can hold `safe.directory`); only the repository's local one is
 * written.
 *
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string>}
 */
function sanitizedGitEnv(base) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || key.toUpperCase().startsWith('GIT_')) continue;
    env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * The environment of the git call a hook makes: exactly the one git gave the
 * hook, because `GIT_INDEX_FILE` and friends say which index the commit uses.
 *
 * @param {Record<string, string | undefined>} base
 * @returns {Record<string, string>}
 */
function inheritedGitEnv(base) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * @typedef {object} GitCaller
 * @property {string} cwd
 * @property {Record<string, string>} env
 */

/**
 * Runs git (by its absolute path, found on the PATH; no shell).
 *
 * @param {GitCaller} caller
 * @param {string[]} args
 * @returns {Promise<import('./docs/sources.js').GitResult>}
 */
function git(caller, args) {
  return runGit(args, { cwd: caller.cwd, env: caller.env, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 256 * 1024 });
}

/**
 * Runs git and requires success.
 *
 * @param {GitCaller} caller
 * @param {string[]} args
 * @param {string} what What was being done, for the message.
 * @returns {Promise<string>} The standard output.
 * @throws {HooksError}
 */
async function gitOrFail(caller, args, what) {
  const result = await git(caller, args);
  if (result.spawnError !== undefined) throw new HooksError(['git could not be started (is it installed and on the PATH?)']);
  if (result.timedOut) throw new HooksError([`git took too long while ${what}`]);
  if (result.code !== 0) throw new HooksError([`git failed while ${what}: ${tailOf(result.stderr || result.stdout, 3, 300)}`]);
  return result.stdout;
}

/**
 * The root of the repository `cwd` is in.
 *
 * @param {GitCaller} caller
 * @returns {Promise<string>}
 * @throws {HooksError} Outside a repository.
 */
async function repositoryRoot(caller) {
  const result = await git(caller, ['rev-parse', '--show-toplevel']);
  if (result.spawnError !== undefined) throw new HooksError(['git could not be started (is it installed and on the PATH?)']);
  if (result.code !== 0 || result.stdout.trim() === '') throw new HooksError([`${caller.cwd} is not inside a git repository (or it has no working tree)`]);
  return resolve(result.stdout.trim());
}

/**
 * The value of `core.hooksPath` in the local configuration of the repository.
 *
 * @param {GitCaller} caller
 * @returns {Promise<string | null>} Null when it is not set.
 */
async function localHooksPath(caller) {
  const result = await git(caller, ['config', '--local', '--get', 'core.hooksPath']);
  if (result.spawnError !== undefined) throw new HooksError(['git could not be started (is it installed and on the PATH?)']);
  if (result.code === 1) return null;
  if (result.code !== 0) throw new HooksError([`git could not read core.hooksPath: ${tailOf(result.stderr, 3, 300)}`]);
  return result.stdout.replace(/\r?\n$/, '');
}

/**
 * @param {string} value A `core.hooksPath` value.
 * @returns {string} The value with `\` as `/`, without a leading `./` and a trailing `/`.
 */
function normalizedHooksPath(value) {
  return value.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// install, uninstall, status

/**
 * @typedef {object} HooksOptions
 * @property {string} [cwd] The folder to start from (default: the working directory).
 * @property {Record<string, string | undefined>} [env] The environment git runs in (default: the process's).
 */

/**
 * @param {HooksOptions} options
 * @returns {GitCaller}
 */
function callerOf(options) {
  return { cwd: resolve(options.cwd ?? process.cwd()), env: sanitizedGitEnv(options.env ?? process.env) };
}

/**
 * Reads a hook file.
 *
 * @param {string} file
 * @returns {Promise<{ text: string } | { missing: true } | { problem: string }>}
 */
async function readHookFile(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { missing: true };
    throw error;
  }
  if (!info.isFile()) return { problem: 'is not a regular file (a link or a folder)' };
  if (info.size > 64 * 1024) return { problem: 'is larger than a hook script of coffer can be' };
  return { text: await readFile(file, 'utf8') };
}

/**
 * Checks a `--config` value and turns it into the form the scripts hold.
 *
 * @param {string | undefined} configPath
 * @param {string} cwd
 * @param {string} repoRoot
 * @returns {string | undefined}
 * @throws {HooksError}
 */
function configForScripts(configPath, cwd, repoRoot) {
  if (configPath === undefined) return undefined;
  const file = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  if (!existsSync(file) || !statSync(file).isFile()) throw new HooksError([`${configPath}: file not found`]);
  const rel = relative(repoRoot, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HooksError([`${configPath}: the configuration file must be inside the repository (${repoRoot})`]);
  }
  const posixRel = rel.split(sep).join('/');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f']/.test(posixRel) || posixRel.startsWith('-')) {
    throw new HooksError([`${configPath}: the path has a character that cannot go into a hook script (control characters, an apostrophe, a leading "-")`]);
  }
  return posixRel;
}

/**
 * What `install` did.
 *
 * @typedef {object} InstallResult
 * @property {string} repoRoot
 * @property {{ name: string, action: 'written' | 'updated' | 'unchanged' }[]} files
 * @property {'set' | 'unchanged' | 'replaced'} hooksPath What happened to `core.hooksPath`.
 * @property {string | null} previousHooksPath The value that was replaced (with `force`).
 * @property {string[]} modeFixed Files whose mode in the git index was set to executable.
 * @property {string[]} warnings
 */

/**
 * Writes the hook scripts and points `core.hooksPath` of the repository at
 * them. Nothing is written when anything stands in the way.
 *
 * @param {HooksOptions & { force?: boolean, config?: string }} [options] With `force`, a different `core.hooksPath` and hook files that coffer did not generate are replaced.
 * @returns {Promise<InstallResult>}
 * @throws {HooksError}
 */
export async function installHooks(options = {}) {
  const caller = callerOf(options);
  const repoRoot = await repositoryRoot(caller);
  const inRepo = { ...caller, cwd: repoRoot };
  const config = configForScripts(options.config, caller.cwd, repoRoot);
  const dir = join(repoRoot, HOOKS_DIR_NAME);

  // 1. Look at everything, change nothing.
  const current = await localHooksPath(inRepo);
  const problems = [];
  if (current !== null && normalizedHooksPath(current) !== HOOKS_DIR_NAME && options.force !== true) {
    problems.push(`core.hooksPath of this repository is already "${current}", so other hooks are in use; coffer leaves it alone. Run "coffer hooks install --force" to replace it with ${HOOKS_DIR_NAME} (those hooks will then no longer run), or call the hooks of coffer from yours: "coffer hooks run <hook>".`);
  }
  let dirInfo = null;
  try {
    dirInfo = await lstat(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  if (dirInfo !== null && !dirInfo.isDirectory()) problems.push(`${HOOKS_DIR_NAME} exists and is not a folder (a link or a file); move it away first`);
  /** @type {Map<string, 'new' | 'managed' | 'foreign'>} */
  const existing = new Map();
  /** @type {Map<string, string>} */
  const texts = new Map();
  if (dirInfo?.isDirectory()) {
    for (const name of HOOK_NAMES) {
      const found = await readHookFile(join(dir, name));
      if ('missing' in found) existing.set(name, 'new');
      else if ('problem' in found) {
        existing.set(name, 'foreign');
        if (options.force !== true) problems.push(`${HOOKS_DIR_NAME}/${name} ${found.problem}; "coffer hooks install --force" replaces it`);
      } else if (isGeneratedHook(found.text)) {
        existing.set(name, 'managed');
        texts.set(name, found.text);
      } else {
        existing.set(name, 'foreign');
        if (options.force !== true) problems.push(`${HOOKS_DIR_NAME}/${name} exists and was not generated by coffer, so it is not overwritten; "coffer hooks install --force" replaces it`);
      }
    }
  }
  if (problems.length > 0) throw new HooksError([...problems, 'Nothing was changed.']);

  // 2. Write.
  await mkdir(dir, { recursive: true });
  /** @type {InstallResult['files']} */
  const files = [];
  for (const name of HOOK_NAMES) {
    const text = renderHook(name, { config });
    const file = join(dir, name);
    const before = existing.get(name) ?? 'new';
    const same = texts.get(name) === text;
    if (!same) await writeFileAtomic(file, text);
    files.push({ name, action: same ? 'unchanged' : before === 'new' ? 'written' : 'updated' });
    await makeExecutable(file);
  }

  // 3. Tell git. A file that is already in the index gets the executable bit there too, where the file system cannot hold it.
  /** @type {string[]} */
  const modeFixed = [];
  for (const name of HOOK_NAMES) {
    const rel = `${HOOKS_DIR_NAME}/${name}`;
    const listed = await git(inRepo, ['ls-files', '-s', '--', rel]);
    if (listed.code === 0 && /^100644 /.test(listed.stdout)) {
      await gitOrFail(inRepo, ['update-index', '--chmod=+x', '--', rel], 'marking a hook executable in the index');
      modeFixed.push(rel);
    }
  }
  /** @type {InstallResult['hooksPath']} */
  let hooksPath = 'unchanged';
  if (current === null || normalizedHooksPath(current) !== HOOKS_DIR_NAME) {
    await gitOrFail(inRepo, ['config', '--local', 'core.hooksPath', HOOKS_DIR_NAME], 'setting core.hooksPath');
    hooksPath = current === null ? 'set' : 'replaced';
  }

  /** @type {string[]} */
  const warnings = [];
  if (config === undefined) {
    try {
      findConfigFile({ cwd: repoRoot });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      warnings.push('there is no coffer.yaml in the root of this repository (or above it), so the hooks will do nothing; if it is in a subfolder, run "coffer hooks install --config <path to coffer.yaml>"');
    }
  }
  if (hooksPath !== 'unchanged') {
    // The hooks of the default folder stop running once core.hooksPath points elsewhere.
    const common = await git(inRepo, ['rev-parse', '--git-common-dir']);
    if (common.code === 0) {
      try {
        const names = (await readdir(resolve(repoRoot, common.stdout.trim(), 'hooks'))).filter((name) => !name.endsWith('.sample'));
        if (names.length > 0) warnings.push(`the hooks in .git/hooks (${names.sort().join(', ')}) no longer run, because core.hooksPath points at ${HOOKS_DIR_NAME}`);
      } catch {
        // no such folder
      }
    }
  }
  return { repoRoot, files, hooksPath, previousHooksPath: hooksPath === 'replaced' ? current : null, modeFixed, warnings };
}

/**
 * Sets the executable bit where the file system has one.
 *
 * @param {string} file
 * @returns {Promise<void>}
 */
async function makeExecutable(file) {
  try {
    await chmod(file, 0o755);
  } catch {
    // A file system without modes (FAT, some network drives): git for Windows runs hooks regardless.
  }
}

/**
 * @param {InstallResult} result
 * @returns {string}
 */
export function formatInstall(result) {
  const lines = [`Hooks in ${HOOKS_DIR_NAME}/ (this repository only):`];
  for (const file of result.files) lines.push(`  ${file.name}: ${file.action}`);
  for (const rel of result.modeFixed) lines.push(`  ${rel}: marked executable in the git index`);
  lines.push(
    result.hooksPath === 'unchanged'
      ? `core.hooksPath is already ${HOOKS_DIR_NAME}.`
      : `core.hooksPath ${result.hooksPath === 'replaced' ? `replaced (it was "${result.previousHooksPath}")` : 'set'} to ${HOOKS_DIR_NAME} in the configuration of this repository.`,
  );
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Removes the scripts coffer generated and, when it points at them, the
 * `core.hooksPath` of the repository.
 *
 * @param {HooksOptions} [options]
 * @returns {Promise<{ removed: string[], kept: string[], hooksPath: 'unset' | 'unchanged' }>}
 */
export async function uninstallHooks(options = {}) {
  const caller = callerOf(options);
  const repoRoot = await repositoryRoot(caller);
  const inRepo = { ...caller, cwd: repoRoot };
  const dir = join(repoRoot, HOOKS_DIR_NAME);
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const kept = [];
  for (const name of HOOK_NAMES) {
    const found = await readHookFile(join(dir, name));
    if ('missing' in found) continue;
    if ('text' in found && isGeneratedHook(found.text)) {
      await rm(join(dir, name), { force: true });
      removed.push(name);
    } else {
      kept.push(name);
    }
  }
  try {
    await rmdir(dir); // only if it is empty
  } catch {
    // not empty, or not there
  }
  const current = await localHooksPath(inRepo);
  /** @type {'unset' | 'unchanged'} */
  let hooksPath = 'unchanged';
  if (current !== null && normalizedHooksPath(current) === HOOKS_DIR_NAME) {
    await gitOrFail(inRepo, ['config', '--local', '--unset', 'core.hooksPath'], 'unsetting core.hooksPath');
    hooksPath = 'unset';
  }
  return { removed, kept, hooksPath };
}

/**
 * Says whether the hooks are installed and current.
 *
 * @param {HooksOptions & { config?: string }} [options]
 * @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function hooksStatus(options = {}) {
  const caller = callerOf(options);
  const repoRoot = await repositoryRoot(caller);
  const inRepo = { ...caller, cwd: repoRoot };
  const dir = join(repoRoot, HOOKS_DIR_NAME);
  const current = await localHooksPath(inRepo);
  let ok = true;
  /** @type {string[]} */
  const lines = [];
  if (current === null) {
    ok = false;
    lines.push('core.hooksPath: not set in this repository (run "coffer hooks install")');
  } else if (normalizedHooksPath(current) !== HOOKS_DIR_NAME) {
    ok = false;
    lines.push(`core.hooksPath: "${current}", not ${HOOKS_DIR_NAME} (run "coffer hooks install --force" to use coffer's hooks)`);
  } else {
    lines.push(`core.hooksPath: ${HOOKS_DIR_NAME}`);
  }
  for (const name of HOOK_NAMES) {
    const found = await readHookFile(join(dir, name));
    let state;
    if ('missing' in found) state = 'missing';
    else if ('problem' in found || !isGeneratedHook(found.text)) state = 'not generated by coffer';
    else {
      const configLine = /^config='(.*)'$/m.exec(found.text)?.[1];
      const config = configLine === undefined || configLine === '' ? undefined : configLine.replace(/'\\''/g, "'");
      state = found.text === renderHook(name, { config }) ? 'installed' : 'outdated (run "coffer hooks install")';
    }
    if (state !== 'installed') ok = false;
    lines.push(`${name}: ${state}`);
  }
  return { ok, lines };
}

// ---------------------------------------------------------------------------
// run: what the scripts call

/**
 * One line git writes to the standard input of the `pre-push` hook:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * @typedef {object} PushRef
 * @property {string} localRef
 * @property {string} localSha
 * @property {string} remoteRef
 * @property {string} remoteSha
 */

/**
 * Reads the lines git sends to `pre-push`. Blank lines are ignored: git sends
 * no lines at all when there is nothing to send, so empty input means that
 * nothing is pushed. When any other line cannot be understood (it does not have
 * four fields, or its two shas are not hexadecimal of one length), nothing can
 * be said about the push and the result is `undefined`, like for input that
 * could not be read: the caller then checks the push instead of skipping it.
 *
 * @param {string} text
 * @returns {PushRef[] | undefined}
 */
export function parsePushRefs(text) {
  /** @type {PushRef[]} */
  const refs = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 4) return undefined;
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    if (!/^[0-9a-f]+$/i.test(localSha) || !/^[0-9a-f]+$/i.test(remoteSha) || localSha.length !== remoteSha.length) return undefined;
    refs.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return refs;
}

/**
 * Whether a push sends anything, which is the case when at least one ref is
 * created or updated (its local sha is not all zeros). Deleting a branch or a
 * tag (`git push --delete`, `git push origin :name`) sends no objects, so it
 * has nothing to upload and must work without credentials or a connection to
 * the store. A tag counts like a branch: it can point at commits whose lock
 * lists originals that are not uploaded yet, so a push that creates or moves a
 * tag is checked.
 *
 * @param {PushRef[]} refs
 * @returns {boolean}
 */
export function pushSendsRefs(refs) {
  return refs.some((ref) => /[^0]/.test(ref.localSha));
}

/**
 * The lines git writes to the standard input of `pre-push`, or `undefined`
 * when there are none to read (the standard input is a terminal, as when the
 * hook is run by hand).
 *
 * @param {NodeJS.ReadableStream & { isTTY?: boolean }} stream
 * @param {number} [timeoutMs] How long the stream may stay silent before it is given up on.
 * @returns {Promise<PushRef[] | undefined>} `undefined` when the lines are not known or cannot be understood.
 */
export async function readPushRefs(stream, timeoutMs = 30_000) {
  if (stream.isTTY === true) return undefined;
  const limit = 1024 * 1024;
  return new Promise((resolvePromise) => {
    let text = '';
    let done = false;
    /** @param {PushRef[] | undefined} value */
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      if (typeof stream.pause === 'function') stream.pause();
      resolvePromise(value);
    };
    const onData = (/** @type {string | Buffer} */ chunk) => {
      text += chunk.toString();
      if (text.length > limit) finish(undefined);
    };
    const onEnd = () => finish(parsePushRefs(text));
    const onError = () => finish(undefined);
    // A stream that never ends is treated like no information: the push is checked, as if it sent a branch.
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref();
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * @typedef {object} RunHookOptions
 * @property {string} [configPath] The configuration file (default: coffer.yaml in the working directory or above).
 * @property {string} [cwd]
 * @property {Record<string, string | undefined>} [env] The environment the store credentials are read from, and git runs in (default: the process's).
 * @property {PushRef[]} [pushRefs] For `pre-push`: the lines git sent on the standard input. When they are not known or cannot be understood (undefined), the push is treated as one that sends a branch.
 */

/**
 * @param {import('./cli.js').Io} io
 * @param {string} message
 */
function note(io, message) {
  io.err(`coffer: ${message}\n`);
}

/**
 * Runs the work of one hook. The scripts call this through `coffer hooks run`.
 *
 * @param {string} name One of {@link HOOK_NAMES}.
 * @param {import('./cli.js').Io} io
 * @param {RunHookOptions} [options]
 * @returns {Promise<number>} The exit code: 0, or 1 for a failure (which only a pre-* hook turns into a failed git operation).
 */
export async function runHook(name, io, options = {}) {
  const blocking = HOOK_DETAILS[name]?.blocking ?? true;
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  try {
    // A push that only deletes refs sends no objects: nothing to upload, no credentials needed.
    if (name === 'pre-push' && options.pushRefs !== undefined && !pushSendsRefs(options.pushRefs)) return 0;

    // No configuration at all means the hook has nothing to do. A configuration that was named and is not there is a mistake.
    if (options.configPath === undefined) {
      try {
        findConfigFile({ cwd });
      } catch (error) {
        if (error instanceof ConfigError) return 0;
        throw error;
      }
    }
    const config = loadConfig({ configPath: options.configPath, cwd });
    if (config.media === undefined) return 0;
    const context = mediaContext(config);

    if (name === 'pre-commit') {
      const result = await lockMedia(context);
      if (result.written || result.warnings.length > 0) io.out(formatLock(result, context.media.lock));
      await stageFile(cwd, context.media.lockFile, env);
      return 0;
    }

    /** @param {string} message */
    const warn = (message) => io.err(`coffer: warning: ${message}\n`);
    const makeStore = () => createStore(context.media.store, { env: options.env, configDir: config.dir, warn });
    if (name === 'pre-push') {
      // The store (and so the credentials) is only needed when the lock lists something.
      const result = await pushMedia(context, makeStore);
      if (result.errors.length > 0) {
        io.err(formatPush(result));
        return 1;
      }
      if (result.uploaded > 0) io.out(formatPush(result));
      return 0;
    }

    const result = await pullMedia(context, await makeStore(), {});
    const failed = result.conflicts.length > 0 || result.errors.length > 0;
    const changed = result.downloaded.length + result.replaced.length + result.deleted.length + result.kept.length + result.notInStore.length > 0;
    if (failed) io.err(formatPull(result));
    else if (changed) io.out(formatPull(result));
    return 0; // a post hook cannot stop the git operation; the printed text says what is left to do
  } catch (error) {
    if (error instanceof MissingCredentialsError && !blocking) {
      note(io, `the media originals were not fetched: no credentials for the media store (missing: ${error.missing.join(', ')}). Create .env.local as docs/media.md describes, then run "coffer media pull".`);
      return 0;
    }
    /** @type {string} */
    let text;
    if (error instanceof ConfigError || error instanceof MediaError || error instanceof LockError || error instanceof HooksError) text = `${error.errors.join('\n')}\n`;
    else if (error instanceof MissingCredentialsError) text = `${error.message}\n`;
    else if (error instanceof MediaStoreError) text = `coffer: ${error.message}\n`;
    else text = `coffer: the ${name} hook failed unexpectedly: ${error instanceof Error ? error.message : String(error)}\n`;
    io.err(text);
    return blocking ? 1 : 0;
  }
}

/**
 * Adds a file to the index of the commit in progress.
 *
 * @param {string} cwd
 * @param {string} file Absolute path.
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<void>}
 * @throws {HooksError}
 */
async function stageFile(cwd, file, env) {
  if (!existsSync(file)) return;
  const caller = { cwd, env: inheritedGitEnv(env) };
  const rel = relative(cwd, file).split(sep).join('/');
  const result = await git(caller, ['-c', 'core.fsmonitor=false', 'add', '--', rel]);
  if (result.spawnError !== undefined) throw new HooksError(['git could not be started to stage the lock file (is it on the PATH?)']);
  if (result.code !== 0) {
    throw new HooksError([`the lock file ${rel} could not be added to the commit: ${tailOf(result.stderr || result.stdout, 3, 300)} (is it ignored by .gitignore? the lock file must be committed)`]);
  }
}

// ---------------------------------------------------------------------------
// The command line

/** The subcommands of `coffer hooks`. */
export const HOOKS_SUBCOMMANDS = Object.freeze(['install', 'uninstall', 'status', 'run']);

/**
 * Reads the arguments of `coffer hooks`.
 *
 * @param {string[]} args The arguments after `hooks`.
 * @returns {{ subcommand: 'install', force: boolean, configPath?: string } | { subcommand: 'uninstall' | 'status' } | { subcommand: 'run', hook: string, configPath?: string } | { error: string }}
 */
export function parseHooksArgs(args) {
  const [subcommand, ...rest] = args;
  const known = HOOKS_SUBCOMMANDS.join(', ');
  if (subcommand === undefined || subcommand.startsWith('-')) return { error: `hooks needs a subcommand (${known})` };
  if (!HOOKS_SUBCOMMANDS.includes(subcommand)) return { error: `unknown hooks subcommand "${subcommand}" (known: ${known})` };

  /** @type {string | undefined} */
  let configPath;
  let force = false;
  /** @type {string | undefined} */
  let hook;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (subcommand === 'run' && arg === '--') break; // what follows is what git passed to the hook
    if (arg === '--config' || arg.startsWith('--config=')) {
      if (subcommand !== 'install' && subcommand !== 'run') return { error: `unexpected argument "${arg}" for "hooks ${subcommand}"` };
      const value = arg === '--config' ? rest[i + 1] : arg.slice('--config='.length);
      if (value === undefined || value === '') return { error: '--config needs a path' };
      if (arg === '--config') {
        if (value.startsWith('-')) return { error: `--config needs a path, but "${value}" looks like an option (write --config=${value} if that really is the path)` };
        i += 1;
      }
      configPath = value;
    } else if (arg === '--force' && subcommand === 'install') {
      force = true;
    } else if (subcommand === 'run' && hook === undefined && !arg.startsWith('-')) {
      hook = arg;
    } else {
      return { error: `unexpected argument "${arg}" for "hooks ${subcommand}"` };
    }
  }
  if (subcommand === 'run') {
    if (hook === undefined) return { error: `hooks run needs the name of a hook (${HOOK_NAMES.join(', ')})` };
    if (!HOOK_NAMES.includes(/** @type {never} */ (hook))) return { error: `unknown hook "${hook}" (known: ${HOOK_NAMES.join(', ')})` };
    return configPath === undefined ? { subcommand, hook } : { subcommand, hook, configPath };
  }
  if (subcommand === 'install') return configPath === undefined ? { subcommand, force } : { subcommand, force, configPath };
  return { subcommand: /** @type {'uninstall' | 'status'} */ (subcommand) };
}

/**
 * `coffer hooks <subcommand>`.
 *
 * @param {string[]} args The arguments after `hooks`.
 * @param {import('./cli.js').Io} io
 * @param {{ env?: Record<string, string | undefined>, hooks?: { cwd?: string }, stdin?: NodeJS.ReadableStream & { isTTY?: boolean } }} services
 * @returns {Promise<number>} The exit code: 0, 1 for a failure, 2 for a wrong call.
 */
export async function runHooks(args, io, services) {
  const parsed = parseHooksArgs(args);
  if ('error' in parsed) {
    io.err(`coffer: ${parsed.error}\n`);
    return EXIT_USAGE;
  }
  const options = { cwd: services.hooks?.cwd, env: services.env };
  if (parsed.subcommand === 'run') {
    // git sends the refs of a push on the standard input of pre-push; the script passes it on unread.
    const pushRefs = parsed.hook === 'pre-push' ? await readPushRefs(services.stdin ?? process.stdin) : undefined;
    return runHook(parsed.hook, io, { ...options, configPath: parsed.configPath, pushRefs });
  }
  try {
    switch (parsed.subcommand) {
      case 'install':
        io.out(formatInstall(await installHooks({ ...options, force: parsed.force, config: parsed.configPath })));
        return 0;
      case 'uninstall': {
        const result = await uninstallHooks(options);
        const lines = result.removed.map((name) => `removed ${HOOKS_DIR_NAME}/${name}`);
        for (const name of result.kept) lines.push(`kept ${HOOKS_DIR_NAME}/${name}: it was not generated by coffer`);
        lines.push(result.hooksPath === 'unset' ? 'core.hooksPath unset in the configuration of this repository.' : 'core.hooksPath was not pointing at coffer\'s hooks and is unchanged.');
        io.out(`${lines.join('\n')}\n`);
        return 0;
      }
      default: {
        const status = await hooksStatus(options);
        (status.ok ? io.out : io.err)(`${status.lines.join('\n')}\n`);
        return status.ok ? 0 : 1;
      }
    }
  } catch (error) {
    if (error instanceof HooksError) {
      io.err(`${error.errors.map((line) => (line.startsWith('coffer:') ? line : `coffer: ${line}`)).join('\n')}\n`);
      return 1;
    }
    throw error;
  }
}

