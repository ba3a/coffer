import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { compileGlob } from '../docs/glob.js';
import { hashFile, removeQuietly, renameReplacing, temporaryNameFor, writeFileAtomic } from './fsutil.js';
import { LockError, MAX_LOCK_BYTES, MAX_LOCK_ENTRIES, parseLock, renderLock } from './lock.js';
import { checkMediaPath, collisionKey, compareBytes, matchesAny, resolveMediaFile, scanOriginals } from './paths.js';
import { HashCache, SyncState } from './state.js';
import { MediaStoreError } from './store.js';

/**
 * The media commands: what `coffer media status`, `lock`, `push` and `pull`
 * do. The working copy is the media root (the folder of the configuration
 * file); the lock file says which originals belong in it; a store keeps their
 * content.
 *
 * What makes this safe to run from a git hook on a folder full of someone's
 * photos:
 *
 * - A file is *synced* when it is known to be in the store with exactly the
 *   content it has here; `push` and `pull` record that in `.coffer/media-state.json`.
 *   `pull` deletes a file only when it is synced, is no longer in the lock and
 *   still has exactly the recorded content. A file that was never synced, or
 *   was changed afterwards, is never deleted. Locking alone does not make a
 *   file synced: the lock can be undone by a checkout, the store is what keeps
 *   the photo.
 * - `pull` never replaces a local file that differs from the lock unless the
 *   file is synced and unchanged (the lock moved on) or `force` is given;
 *   otherwise it reports a conflict.
 * - Every path comes from the lock file or the state, which are untrusted: it
 *   must be a plain path that matches `media.include` and is reached without
 *   passing through a link (see `paths.js`).
 * - A download goes to a temporary file next to its target, is hashed, and is
 *   renamed into place only when the hash is right, so a failed or interrupted
 *   pull leaves no partial original behind, and running it again finishes the
 *   work.
 */

/**
 * Raised for a problem the person running the command can act on; every
 * message is in `errors`.
 */
export class MediaError extends Error {
  /**
   * @param {string[]} errors
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'MediaError';
    this.errors = errors;
  }
}

/** How many lines of one kind a report lists before it says "and N more". */
const LIST_LIMIT = 20;

/**
 * What the commands work on.
 *
 * @typedef {object} MediaContext
 * @property {string} root The media root: the folder of the configuration file.
 * @property {import('./config.js').MediaConfig} media
 * @property {import('../docs/glob.js').CompiledGlob[]} globs The `include` patterns, compiled.
 */

/**
 * @param {import('../config.js').CofferConfig} config
 * @returns {MediaContext}
 * @throws {MediaError} When the configuration has no `media` block.
 */
export function mediaContext(config) {
  if (config.media === undefined) {
    throw new MediaError([
      `${config.file}: there is no "media" block, so there is nothing to track (add one, for example "media: { store: { type: fs, dir: ../originals } }"; see docs/media.md)`,
    ]);
  }
  return { root: config.dir, media: config.media, globs: config.media.include.map((pattern) => compileGlob(pattern)) };
}

/**
 * @param {string[]} lines
 * @returns {string[]} The lines, cut after the limit.
 */
function limited(lines) {
  return lines.length <= LIST_LIMIT ? lines : [...lines.slice(0, LIST_LIMIT), `... and ${lines.length - LIST_LIMIT} more`];
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The lock file and the working copy

/**
 * Reads the lock file.
 *
 * @param {MediaContext} context
 * @returns {Promise<Map<string, import('./lock.js').LockEntry> | null>} The entries by path, or null when there is no lock file.
 * @throws {LockError | MediaError} For a lock file that is not usable.
 */
export async function readLockFile(context) {
  const file = context.media.lockFile;
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  if (!info.isFile()) throw new MediaError([`${context.media.lock} is not a regular file`]);
  if (info.size > MAX_LOCK_BYTES) throw new MediaError([`${context.media.lock} is larger than ${MAX_LOCK_BYTES} bytes`]);
  const entries = parseLock(await readFile(file, 'utf8'), context.media.lock);
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/**
 * Refuses a lock whose paths do not match `media.include`: the patterns bound
 * what the lock may make `pull` write, so a lock from somewhere else cannot
 * name, say, the configuration file or a script.
 *
 * @param {MediaContext} context
 * @param {Iterable<string>} paths
 * @throws {MediaError}
 */
function requireIncluded(context, paths) {
  const outside = [...paths].filter((path) => !matchesAny(context.globs, path));
  if (outside.length > 0) {
    throw new MediaError([
      ...limited(outside.map((path) => `${context.media.lock}: "${path}" does not match any pattern of media.include, so it is not touched`)),
      'Nothing was changed. Widen "media.include", or remove these entries from the lock.',
    ]);
  }
}

/**
 * What the working copy holds.
 *
 * @typedef {object} LocalScan
 * @property {Map<string, import('./lock.js').LockEntry>} entries The originals found, by path, with their hashes.
 * @property {string[]} links Matching links that were left out.
 * @property {number} hashed How many files had to be read.
 * @property {number} cached How many hashes came from the cache.
 */

/**
 * Finds the originals in the working copy and hashes them (from the cache when
 * a file has not changed).
 *
 * @param {MediaContext} context
 * @param {HashCache} cache
 * @returns {Promise<LocalScan>}
 * @throws {MediaError} For a path that cannot be recorded, two files that collide, or a file that cannot be read.
 */
export async function scanWorkingCopy(context, cache) {
  const { files, links } = await scanOriginals(context.root, context.media.include, context.globs);
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, string>} */
  const collisions = new Map();
  /** @type {Map<string, import('./lock.js').LockEntry>} */
  const entries = new Map();
  let hashed = 0;
  let cached = 0;
  if (files.length > MAX_LOCK_ENTRIES) throw new MediaError([`more than ${MAX_LOCK_ENTRIES} originals match media.include`]);
  files.sort((a, b) => compareBytes(a.path, b.path));
  for (const file of files) {
    const checked = checkMediaPath(file.path);
    if ('problem' in checked) {
      problems.push(`${file.path}: the path ${checked.problem}; rename it or leave it out of media.include`);
      continue;
    }
    const key = collisionKey(file.path);
    const other = collisions.get(key);
    if (other !== undefined) {
      problems.push(`${file.path}: the same file as ${other} on a case-insensitive file system; rename one of them`);
      continue;
    }
    collisions.set(key, file.path);
    const location = await resolveMediaFile(context.root, file.path);
    if (!location.ok || !location.exists) {
      problems.push(`${file.path}: ${location.ok ? 'disappeared while scanning' : location.message}`);
      continue;
    }
    try {
      const result = await cache.hash(file.path, location.path, file);
      if (result.cached) cached += 1;
      else hashed += 1;
      entries.set(file.path, { path: file.path, sha256: result.sha256, size: result.size });
    } catch (error) {
      problems.push(`${file.path}: ${describe(error)}`);
    }
  }
  if (problems.length > 0) throw new MediaError(limited(problems));
  return { entries, links, hashed, cached };
}

// ---------------------------------------------------------------------------
// status

/**
 * How the working copy compares with the lock.
 *
 * @typedef {object} MediaStatus
 * @property {string[]} added In the working copy, not in the lock (`lock` will add them).
 * @property {string[]} changed In both, with different content here than in the lock (`lock` will update the entry).
 * @property {string[]} deleted In the lock, removed here after a sync (`lock` will drop the entry).
 * @property {string[]} missing In the lock, not here, never synced here (`pull` will fetch them).
 * @property {string[]} outdated In both; the lock has moved on and this copy is the one that was synced (`pull` will replace it).
 * @property {string[]} removed Not in the lock any more but still here, as it was synced (`pull` will delete it).
 * @property {number} unchanged How many are the same here and in the lock.
 * @property {string[]} notInStore Paths whose content the store lacks (only with `remote`).
 * @property {boolean} hasLock Whether there is a lock file.
 * @property {string[]} warnings
 */

/**
 * Compares the working copy with the lock.
 *
 * @param {MediaContext} context
 * @param {{ store?: import('./store.js').MediaStore }} [options] With a store, also asks it which objects of the lock it lacks.
 * @returns {Promise<MediaStatus>}
 */
export async function mediaStatus(context, options = {}) {
  const lock = await readLockFile(context);
  if (lock !== null) requireIncluded(context, lock.keys());
  const cache = await HashCache.load(context.root);
  const state = await SyncState.load(context.root);
  const local = await scanWorkingCopy(context, cache);
  await cache.save();

  /** @type {MediaStatus} */
  const status = { added: [], changed: [], deleted: [], missing: [], outdated: [], removed: [], unchanged: 0, notInStore: [], hasLock: lock !== null, warnings: linkWarnings(local.links) };
  const entries = lock ?? new Map();
  for (const entry of entries.values()) {
    const here = local.entries.get(entry.path);
    const synced = state.entries.get(entry.path);
    if (here === undefined) (synced !== undefined ? status.deleted : status.missing).push(entry.path);
    else if (here.sha256 === entry.sha256) status.unchanged += 1;
    else (synced?.sha256 === here.sha256 ? status.outdated : status.changed).push(entry.path);
  }
  for (const here of local.entries.values()) {
    if (entries.has(here.path)) continue;
    (state.entries.get(here.path)?.sha256 === here.sha256 ? status.removed : status.added).push(here.path);
  }
  for (const list of [status.added, status.changed, status.deleted, status.missing, status.outdated, status.removed]) list.sort(compareBytes);

  if (options.store !== undefined) {
    /** @type {Map<string, boolean>} */
    const known = new Map();
    for (const entry of [...entries.values()].sort((a, b) => compareBytes(a.path, b.path))) {
      let present = known.get(entry.sha256);
      if (present === undefined) {
        present = await options.store.has(entry.sha256);
        known.set(entry.sha256, present);
      }
      if (!present) status.notInStore.push(entry.path);
    }
  }
  return status;
}

/**
 * @param {string[]} links
 * @returns {string[]}
 */
function linkWarnings(links) {
  return limited(links.sort(compareBytes).map((path) => `${path} is a symbolic link or junction and is left out; originals must be regular files`));
}

/**
 * @param {MediaStatus} status
 * @returns {string} A report for the terminal.
 */
export function formatStatus(status) {
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} label
   * @param {string[]} paths
   * @param {string} [note]
   */
  const section = (label, paths, note) => {
    if (paths.length === 0) return;
    lines.push(`${label} (${paths.length})${note === undefined ? '' : `: ${note}`}`);
    for (const line of limited(paths)) lines.push(`  ${line}`);
  };
  if (!status.hasLock) lines.push('There is no lock file yet; run "coffer media lock" to create it.');
  section('new', status.added, 'in this working copy, not in the lock; "coffer media lock" adds them');
  section('changed', status.changed, 'differ from the lock; "coffer media lock" records the new content');
  section('deleted', status.deleted, 'removed here; "coffer media lock" drops them from the lock');
  section('missing', status.missing, 'in the lock, not here; "coffer media pull" fetches them');
  section('outdated', status.outdated, 'the lock has newer content; "coffer media pull" replaces them');
  section('removed', status.removed, 'no longer in the lock; "coffer media pull" deletes them');
  section('not in the store', status.notInStore, 'the store lacks their content; "coffer media push" uploads it');
  for (const warning of status.warnings) lines.push(`warning: ${warning}`);
  const changes = status.added.length + status.changed.length + status.deleted.length + status.missing.length + status.outdated.length + status.removed.length;
  lines.push(changes === 0 && status.notInStore.length === 0 ? `${status.unchanged} original(s), all in step with the lock.` : `${status.unchanged} original(s) unchanged.`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// lock

/**
 * What `lock` did.
 *
 * @typedef {object} LockResult
 * @property {number} count How many originals the lock lists.
 * @property {string[]} added
 * @property {string[]} changed
 * @property {string[]} removed Entries dropped: the file was synced here and has been deleted here, or the entry no longer matches `media.include`.
 * @property {string[]} kept Entries of the old lock that were kept although the file is not here: it was never fetched on this working copy.
 * @property {boolean} written Whether the lock file changed on disk.
 * @property {number} hashed How many files were read.
 * @property {number} cached How many hashes came from the cache.
 * @property {string[]} warnings
 */

/**
 * Writes the lock file from the originals in the working copy.
 *
 * A file that is absent here is dropped from the lock only when this working
 * copy had it in sync (fetched or pushed it) and it has since been deleted: a
 * deliberate delete. An entry for a file that was never here (a fresh clone
 * that has not pulled yet, a pull that failed half way, a photo of a
 * collaborator that arrived with a merge) is kept as it is, because dropping
 * it would make the next `pull` on every other working copy delete that photo.
 * A kept entry that `media.include` no longer covers is dropped, with a
 * warning, because `status`, `push` and `pull` refuse a lock with such entries.
 *
 * @param {MediaContext} context
 * @returns {Promise<LockResult>}
 */
export async function lockMedia(context) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, import('./lock.js').LockEntry>} */
  let previous = new Map();
  try {
    previous = (await readLockFile(context)) ?? new Map();
  } catch (error) {
    if (!(error instanceof LockError || error instanceof MediaError)) throw error;
    warnings.push(`the existing ${context.media.lock} could not be read and is replaced (${error.errors[0]})`);
  }
  const cache = await HashCache.load(context.root);
  const state = await SyncState.load(context.root);
  const local = await scanWorkingCopy(context, cache);
  cache.retain(new Set(local.entries.keys()));
  await cache.save();
  warnings.push(...linkWarnings(local.links));

  const added = [];
  const changed = [];
  for (const entry of local.entries.values()) {
    const before = previous.get(entry.path);
    if (before === undefined) added.push(entry.path);
    else if (before.sha256 !== entry.sha256) changed.push(entry.path);
  }
  /** @type {Map<string, import('./lock.js').LockEntry>} */
  const merged = new Map(local.entries);
  const removed = [];
  const kept = [];
  const localKeys = new Map([...local.entries.keys()].map((path) => [collisionKey(path), path]));
  for (const entry of [...previous.values()].sort((a, b) => compareBytes(a.path, b.path))) {
    if (local.entries.has(entry.path)) continue;
    if (state.entries.has(entry.path)) {
      removed.push(entry.path); // synced here, deleted here
      continue;
    }
    if (!matchesAny(context.globs, entry.path)) {
      removed.push(entry.path);
      warnings.push(`${entry.path} is in the old ${context.media.lock} but not fetched here, and does not match media.include any more, so it is dropped from the lock`);
      continue;
    }
    const clash = localKeys.get(collisionKey(entry.path));
    if (clash !== undefined) {
      throw new MediaError([
        `${clash}: the same file as ${entry.path}, which the ${context.media.lock} lists and this working copy has not fetched yet, on a case-insensitive file system; run "coffer media pull" first, or rename one of them`,
      ]);
    }
    merged.set(entry.path, entry);
    kept.push(entry.path);
  }
  const text = renderLock(merged.values());

  let current = null;
  try {
    current = (await readFile(context.media.lockFile, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    current = null;
  }
  const written = current !== text;
  if (written) {
    await mkdir(dirname(context.media.lockFile), { recursive: true });
    await writeFileAtomic(context.media.lockFile, text);
  }
  return {
    count: merged.size,
    added: added.sort(compareBytes),
    changed: changed.sort(compareBytes),
    removed: removed.sort(compareBytes),
    kept: kept.sort(compareBytes),
    written,
    hashed: local.hashed,
    cached: local.cached,
    warnings,
  };
}

/**
 * @param {LockResult} result
 * @param {string} lockPath How the lock file is named.
 * @returns {string}
 */
export function formatLock(result, lockPath) {
  const lines = [];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  for (const [label, paths] of /** @type {[string, string[]][]} */ ([['added', result.added], ['changed', result.changed], ['removed', result.removed], ['kept', result.kept]])) {
    for (const path of limited(paths)) lines.push(`${label} ${path}`);
  }
  lines.push(
    `${lockPath}: ${result.count} original(s)` +
      (result.written ? `, ${result.added.length} added, ${result.changed.length} changed, ${result.removed.length} removed` : ', unchanged') +
      (result.kept.length > 0 ? `, ${result.kept.length} kept: not fetched on this working copy yet; run "coffer media pull"` : '') +
      ` (${result.hashed} read, ${result.cached} from the cache)`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// push

/**
 * What `push` did.
 *
 * @typedef {object} PushResult
 * @property {number} uploaded Objects uploaded.
 * @property {number} present Objects the store already had (including those recorded as synced earlier).
 * @property {string[]} errors Entries that could not be pushed.
 * @property {boolean} noLock Whether there was no lock file.
 */

/**
 * Uploads the objects of the lock that the store lacks.
 *
 * @param {MediaContext} context
 * @param {import('./store.js').MediaStore} store
 * @returns {Promise<PushResult>}
 */
export async function pushMedia(context, store) {
  const lock = await readLockFile(context);
  /** @type {PushResult} */
  const result = { uploaded: 0, present: 0, errors: [], noLock: lock === null };
  if (lock === null) return result;
  requireIncluded(context, lock.keys());
  const cache = await HashCache.load(context.root);
  const state = await SyncState.load(context.root);
  /** @type {Set<string>} */
  const ensured = new Set();
  try {
    for (const entry of [...lock.values()].sort((a, b) => compareBytes(a.path, b.path))) {
      try {
        const synced = state.entries.get(entry.path);
        const location = await resolveMediaFile(context.root, entry.path);
        if (!location.ok) {
          result.errors.push(`${entry.path}: ${location.message}`);
          continue;
        }
        /** @type {{ sha256: string, size: number } | null} */
        let local = null;
        if (location.exists) {
          const info = await lstat(location.path);
          local = await cache.hash(entry.path, location.path, info);
        }
        if (local !== null && local.sha256 === entry.sha256 && synced?.sha256 === entry.sha256) {
          result.present += 1;
          continue;
        }
        if (!ensured.has(entry.sha256)) {
          if (await store.has(entry.sha256)) {
            result.present += 1;
          } else if (local !== null && local.sha256 === entry.sha256) {
            await store.put(entry.sha256, location.path);
            result.uploaded += 1;
          } else {
            result.errors.push(`${entry.path}: the store lacks its content and the file here ${local === null ? 'is missing' : 'is different from the lock'}; run "coffer media lock", or fetch the right file`);
            continue;
          }
          ensured.add(entry.sha256);
        } else {
          result.present += 1;
        }
        if (local !== null && local.sha256 === entry.sha256) state.entries.set(entry.path, { sha256: entry.sha256, size: entry.size });
      } catch (error) {
        result.errors.push(`${entry.path}: ${describe(error)}`);
      }
    }
  } finally {
    await state.save();
    await cache.save();
  }
  return result;
}

/**
 * @param {PushResult} result
 * @returns {string}
 */
export function formatPush(result) {
  if (result.noLock) return 'There is no lock file; run "coffer media lock" first.\n';
  const lines = limited(result.errors).map((error) => `error: ${error}`);
  lines.push(`${result.uploaded} object(s) uploaded, ${result.present} already in the store${result.errors.length > 0 ? `, ${result.errors.length} failed` : ''}.`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// pull

/**
 * @typedef {object} PullOptions
 * @property {boolean} [force] Replace local files that differ from the lock even when they were not synced (their content is lost).
 * @property {boolean} [restore] Fetch files again that were synced and have since been deleted here.
 * @property {boolean} [dryRun] Say what would happen and change nothing.
 */

/**
 * What `pull` did (or, with `dryRun`, would do).
 *
 * @typedef {object} PullResult
 * @property {string[]} downloaded Files that were not here and were fetched.
 * @property {string[]} replaced Files that were replaced by the lock's content.
 * @property {string[]} deleted Files that were deleted because they were removed from the lock.
 * @property {number} inSync Files that already had the lock's content.
 * @property {string[]} kept Files not deleted although they left the lock, with the reason.
 * @property {string[]} skipped Files deleted here after a sync and left deleted.
 * @property {string[]} conflicts Files that differ from the lock and were not synced; nothing was changed for them.
 * @property {string[]} notInStore Files here that the lock lists and the store lacks (run push).
 * @property {string[]} errors Files that could not be fetched, replaced or deleted.
 * @property {boolean} noLock Whether there was no lock file.
 * @property {boolean} dryRun
 */

/**
 * Brings the working copy in line with the lock: fetches the files that are
 * missing or outdated and deletes the ones that were removed from the lock.
 * See the notes at the top of this file for what is never touched.
 *
 * @param {MediaContext} context
 * @param {import('./store.js').MediaStore} store
 * @param {PullOptions} [options]
 * @returns {Promise<PullResult>}
 */
export async function pullMedia(context, store, options = {}) {
  /** @type {PullResult} */
  const result = { downloaded: [], replaced: [], deleted: [], inSync: 0, kept: [], skipped: [], conflicts: [], notInStore: [], errors: [], noLock: false, dryRun: options.dryRun === true };
  const lock = await readLockFile(context);
  if (lock === null) {
    // A missing lock must not read as "everything was removed".
    result.noLock = true;
    return result;
  }
  requireIncluded(context, lock.keys());
  const cache = await HashCache.load(context.root);
  const state = await SyncState.load(context.root);

  /** @typedef {{ entry: import('./lock.js').LockEntry, replacing: { size: number, mtimeMs: number } | null }} Download */
  /** @type {Download[]} */
  const downloads = [];
  /** @type {{ path: string, size: number, mtimeMs: number }[]} */
  const deletions = [];
  /** @type {import('./lock.js').LockEntry[]} */
  const adoptions = [];

  // 1. Plan: look at every file once, change nothing.
  for (const entry of [...lock.values()].sort((a, b) => compareBytes(a.path, b.path))) {
    const location = await resolveMediaFile(context.root, entry.path);
    if (!location.ok) {
      result.errors.push(`${entry.path}: ${location.message}; not touched`);
      continue;
    }
    const synced = state.entries.get(entry.path);
    if (!location.exists) {
      if (synced?.sha256 === entry.sha256 && options.restore !== true) result.skipped.push(entry.path);
      else downloads.push({ entry, replacing: null });
      continue;
    }
    try {
      const info = await lstat(location.path);
      /** @type {{ sha256: string, size: number }} */
      let local = await cache.hash(entry.path, location.path, info);
      if (local.sha256 !== entry.sha256 && synced?.sha256 === local.sha256 && options.force !== true) {
        // The file is about to be replaced because it is "exactly what was synced". The cache goes by size and
        // modification time, which an edit can leave alone, so look at the content itself.
        local = await hashFresh(cache, entry.path, location.path, info);
      }
      if (local.sha256 === entry.sha256) {
        result.inSync += 1;
        if (synced?.sha256 !== entry.sha256) adoptions.push(entry);
      } else if (synced?.sha256 === local.sha256 || options.force === true) {
        downloads.push({ entry, replacing: { size: info.size, mtimeMs: info.mtimeMs } });
      } else {
        result.conflicts.push(entry.path);
      }
    } catch (error) {
      result.errors.push(`${entry.path}: ${describe(error)}`);
    }
  }
  const lockKeys = new Set([...lock.keys()].map(collisionKey));
  for (const [path, synced] of [...state.entries].sort((a, b) => compareBytes(a[0], b[0]))) {
    if (lock.has(path)) continue;
    if (lockKeys.has(collisionKey(path))) {
      result.kept.push(`${path} (the lock has it under another spelling of the name)`);
      state.entries.delete(path);
      continue;
    }
    if (!matchesAny(context.globs, path)) {
      state.entries.delete(path);
      continue;
    }
    const location = await resolveMediaFile(context.root, path);
    if (!location.ok) {
      result.kept.push(`${path} (${location.message})`);
      state.entries.delete(path);
      continue;
    }
    if (!location.exists) {
      state.entries.delete(path);
      continue;
    }
    try {
      const info = await lstat(location.path);
      // About to be deleted: read the file, do not trust the cache (see above).
      const local = await hashFresh(cache, path, location.path, info);
      if (local.sha256 === synced.sha256) {
        deletions.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } else {
        result.kept.push(`${path} (changed since it was synced)`);
        state.entries.delete(path);
      }
    } catch (error) {
      result.errors.push(`${path}: ${describe(error)}`);
    }
  }

  if (lock.size === 0 && deletions.length > 0 && options.force !== true) {
    // A valid but empty lock says that nothing belongs in the repository; it can also come from a bad merge or a
    // wrong branch. Deleting every synced file on that word needs a deliberate --force.
    result.errors.push(
      `the lock lists no originals, so pull would delete all ${deletions.length} synced file(s) here; nothing was deleted. If the lock is right, run "coffer media pull --force" (add --dry-run to see the list first)`,
    );
    deletions.length = 0;
  }

  if (options.dryRun === true) {
    result.deleted = deletions.map((item) => item.path);
    for (const { entry, replacing } of downloads) (replacing === null ? result.downloaded : result.replaced).push(entry.path);
    return result;
  }

  // 2. Act. Deletions first, so that a rename of only the case of a name cannot lose the new file.
  try {
    for (const item of deletions) {
      try {
        const location = await resolveMediaFile(context.root, item.path);
        if (!location.ok || !location.exists) throw new Error(location.ok ? 'is already gone' : location.message);
        const info = await lstat(location.path);
        if (info.size !== item.size || info.mtimeMs !== item.mtimeMs) {
          result.kept.push(`${item.path} (changed while pulling)`);
          state.entries.delete(item.path);
          continue;
        }
        await rm(location.path, { force: true });
        state.entries.delete(item.path);
        result.deleted.push(item.path);
      } catch (error) {
        result.errors.push(`${item.path}: ${describe(error)}`);
      }
    }

    for (const { entry, replacing } of downloads) {
      try {
        await fetchOriginal(context, store, entry, replacing, options.force === true, cache);
        state.entries.set(entry.path, { sha256: entry.sha256, size: entry.size });
        (replacing === null ? result.downloaded : result.replaced).push(entry.path);
      } catch (error) {
        if (error instanceof ConflictError) result.conflicts.push(entry.path);
        else result.errors.push(`${entry.path}: ${describe(error)}`);
      }
    }

    for (const entry of adoptions) {
      try {
        if (await store.has(entry.sha256)) state.entries.set(entry.path, { sha256: entry.sha256, size: entry.size });
        else result.notInStore.push(entry.path);
      } catch (error) {
        result.errors.push(`${entry.path}: ${describe(error)}`);
      }
    }
  } finally {
    await state.save();
    await cache.save();
  }
  return result;
}

/**
 * Hashes a file by reading it, whatever the cache says, and corrects the cache
 * when it was wrong. The status of the file is compared before and after, so a
 * file that changes while it is read is an error rather than a wrong hash.
 *
 * @param {HashCache} cache
 * @param {string} rel
 * @param {string} file Absolute path.
 * @param {{ size: number, mtimeMs: number }} info The file's status as the caller saw it.
 * @returns {Promise<{ sha256: string, size: number }>}
 */
async function hashFresh(cache, rel, file, info) {
  const hashedAt = Date.now();
  const result = await hashFile(file);
  const after = await lstat(file);
  if (result.size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new Error(`changed while it was being read; try again when nothing is writing to it`);
  }
  cache.entries.set(rel, { size: info.size, mtimeMs: info.mtimeMs, hashedAt, sha256: result.sha256 });
  return result;
}

/** A local file changed between looking at it and replacing it. */
class ConflictError extends Error {}

/**
 * Fetches one original: into a temporary file beside its place, hashed, then
 * renamed over whatever is there.
 *
 * @param {MediaContext} context
 * @param {import('./store.js').MediaStore} store
 * @param {import('./lock.js').LockEntry} entry
 * @param {{ size: number, mtimeMs: number } | null} replacing What the file looked like when it was judged replaceable; null if it was absent.
 * @param {boolean} force
 * @param {HashCache} cache
 * @returns {Promise<void>}
 */
async function fetchOriginal(context, store, entry, replacing, force, cache) {
  const location = await resolveMediaFile(context.root, entry.path, { createFolders: true });
  if (!location.ok) throw new Error(location.message);
  if (replacing === null && location.exists) throw new ConflictError('appeared while pulling');
  const temporary = temporaryNameFor(location.path);
  try {
    try {
      await store.get(entry.sha256, temporary);
    } catch (error) {
      if (error instanceof MediaStoreError && error.code === 'missing') {
        throw new Error(`the store has no object for it (${entry.sha256.slice(0, 12)}...); run "coffer media push" where the file is`);
      }
      throw error;
    }
    const received = await hashFile(temporary);
    if (received.sha256 !== entry.sha256 || received.size !== entry.size) {
      throw new Error(`the downloaded content does not match the lock (expected ${entry.sha256.slice(0, 12)}... and ${entry.size} bytes); the store may be damaged`);
    }
    if (replacing !== null && !force) {
      const now = await lstat(location.path);
      if (now.size !== replacing.size || now.mtimeMs !== replacing.mtimeMs) throw new ConflictError('changed while pulling');
    }
    await renameReplacing(temporary, location.path);
    const info = await lstat(location.path);
    cache.entries.set(entry.path, { size: info.size, mtimeMs: info.mtimeMs, hashedAt: Date.now(), sha256: entry.sha256 });
  } finally {
    await removeQuietly(temporary);
  }
}

/**
 * @param {PullResult} result
 * @returns {string}
 */
export function formatPull(result) {
  if (result.noLock) return 'There is no lock file; nothing to pull and nothing deleted.\n';
  const verb = result.dryRun ? 'would be ' : '';
  /** @type {string[]} */
  const lines = [];
  /**
   * @param {string} label
   * @param {string[]} paths
   */
  const section = (label, paths) => {
    for (const path of limited(paths)) lines.push(`${label} ${path}`);
  };
  section(`${verb}downloaded`, result.downloaded);
  section(`${verb}replaced`, result.replaced);
  section(`${verb}deleted`, result.deleted);
  section('kept', result.kept);
  section('left deleted', result.skipped);
  section('not in the store', result.notInStore);
  for (const path of limited(result.conflicts)) {
    lines.push(`conflict ${path}: differs from the lock and is not a copy that was synced, so it was not overwritten (keep it and run "coffer media lock", or run "coffer media pull --force" to replace it)`);
  }
  for (const error of limited(result.errors)) lines.push(`error: ${error}`);
  lines.push(
    `${result.downloaded.length} ${verb}downloaded, ${result.replaced.length} ${verb}replaced, ${result.deleted.length} ${verb}deleted, ${result.inSync} already in step` +
      (result.skipped.length > 0 ? `, ${result.skipped.length} left deleted (use --restore to fetch them again)` : '') +
      (result.conflicts.length > 0 ? `, ${result.conflicts.length} conflict(s)` : '') +
      (result.errors.length > 0 ? `, ${result.errors.length} error(s)` : '') +
      '.',
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// gitignore

/**
 * The lines the content repository should ignore: the originals themselves
 * (they live in the store, the lock records them) and the working files of the
 * media commands.
 *
 * @param {MediaContext} context
 * @returns {string}
 */
export function gitignoreText(context) {
  const lines = [
    '# Originals are kept in the media store and listed in the lock file (coffer media).',
    '# Generated by "coffer media gitignore" from media.include; do not ignore the lock file.',
    ...context.media.include,
    '',
    '# Working files of the media commands.',
    '.coffer/',
  ];
  return `${lines.join('\n')}\n`;
}
