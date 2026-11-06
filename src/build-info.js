import { redactUrl, tailOf } from './docs/sources.js';

/**
 * `build-info.json`: what a deployed site says about how it was built, so that
 * a scheduled job can tell whether the live site is out of date without
 * building anything (see `docs/scheduling.md`).
 *
 * This module writes the file ({@link createBuildInfo}), reads and checks one
 * that came from outside ({@link checkBuildInfo}), fetches the deployed copy
 * ({@link fetchBuildInfo}) and decides whether a new build is needed
 * ({@link compareBuildInfo}). Reading the commits of the remote repositories
 * is done by `docs/sources.js`, which has the git safety layer.
 */

/** Name of the file at the root of a site's output. */
export const BUILD_INFO_FILE_NAME = 'build-info.json';

/** The largest build-info file that is read, in bytes. A real one is a few hundred bytes. */
export const MAX_BUILD_INFO_BYTES = 256 * 1024;

/** The most sources a build-info file can list. */
export const MAX_BUILD_INFO_SOURCES = 500;

/** How long fetching the deployed file can take, in milliseconds (the whole exchange, redirects and body included). */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/** The most redirects that are followed. */
export const MAX_REDIRECTS = 3;

/**
 * Where a documentation source of a project was fetched from.
 *
 * @typedef {object} BuildInfoSource
 * @property {string} url The address of the repository, without credentials.
 * @property {string} ref The branch or tag.
 * @property {string} sha The commit the build used.
 */

/**
 * The content of `build-info.json`.
 *
 * @typedef {object} BuildInfo
 * @property {string} builtAt ISO 8601 moment (UTC) the build was made.
 * @property {string} engineVersion Version of coffer that made it.
 * @property {Record<string, BuildInfoSource>} sources Git documentation sources by project slug, sorted by slug.
 * @property {string | null} nextScheduledAt ISO 8601 date of the earliest post that is not a draft and is dated after the build's "now"; null when there is none.
 */

/** A project slug, as a key of `sources` (the name of a folder in the cache of repositories). */
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** A commit id: SHA-1, or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** An ISO 8601 date and time with an offset, as `Date#toISOString` writes it (and its relatives). */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isMoment(value) {
  return typeof value === 'string' && ISO_MOMENT.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The moment of the first post that is waiting for its date.
 *
 * It applies the rule the build uses to decide what is published (a post is
 * published when it is not a draft and its date is not after "now"), so a post
 * counts here exactly when the build left it out only because of its date.
 *
 * @param {readonly { draft: boolean, date: Date }[]} posts Every post of the site, whatever its state.
 * @param {Date} now The build's "now" (not the clock: `--now` and `COFFER_NOW` apply).
 * @returns {string | null} ISO 8601 moment, or null when no post is waiting.
 */
export function nextScheduledAt(posts, now) {
  /** @type {number | null} */
  let earliest = null;
  for (const post of posts) {
    if (post.draft) continue;
    const time = post.date.getTime();
    if (Number.isNaN(time) || time <= now.getTime()) continue;
    if (earliest === null || time < earliest) earliest = time;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/**
 * Makes the content of `build-info.json`.
 *
 * @param {object} input
 * @param {Date} input.builtAt The moment of the build, from the clock.
 * @param {string} input.engineVersion
 * @param {ReadonlyMap<string, import('./docs/sources.js').FetchedDocs>} input.docs The documentation sources the build used, by project slug; folders are left out.
 * @param {readonly { draft: boolean, date: Date }[]} input.posts Every post of the site.
 * @param {Date} input.now The build's "now".
 * @returns {BuildInfo}
 */
export function createBuildInfo({ builtAt, engineVersion, docs, posts, now }) {
  /** @type {[string, BuildInfoSource][]} */
  const sources = [];
  for (const [slug, fetched] of docs) {
    if (fetched.source.type !== 'git') continue;
    sources.push([slug, { url: fetched.source.git, ref: fetched.source.ref, sha: fetched.source.sha }]);
  }
  sources.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    builtAt: builtAt.toISOString(),
    engineVersion,
    sources: Object.fromEntries(sources),
    nextScheduledAt: nextScheduledAt(posts, now),
  };
}

/**
 * The text of `build-info.json`.
 *
 * @param {BuildInfo} info
 * @returns {string}
 */
export function renderBuildInfo(info) {
  return `${JSON.stringify(info, null, 2)}\n`;
}

/**
 * A build-info file that has been checked.
 *
 * @typedef {object} ReadBuildInfo
 * @property {string} builtAt
 * @property {string} engineVersion
 * @property {Map<string, BuildInfoSource>} sources
 * @property {string | null} nextScheduledAt
 */

/**
 * Checks the shape of a parsed `build-info.json`. The file came from a web
 * server, so nothing in it is trusted: every field has to have the type and
 * form described in `docs/scheduling.md`. Unknown fields are ignored.
 *
 * @param {unknown} value
 * @returns {{ value: ReadBuildInfo } | { problem: string }}
 */
export function checkBuildInfo(value) {
  if (!isMapping(value)) return { problem: 'it is not a JSON object' };
  if (!isMoment(value.builtAt)) return { problem: '"builtAt" is missing or is not an ISO 8601 date and time' };
  if (typeof value.engineVersion !== 'string' || value.engineVersion === '' || value.engineVersion.length > 100) {
    return { problem: '"engineVersion" is missing or is not a version string' };
  }
  if (!isMapping(value.sources)) return { problem: '"sources" is missing or is not an object' };
  const entries = Object.entries(value.sources);
  if (entries.length > MAX_BUILD_INFO_SOURCES) return { problem: `"sources" lists more than ${MAX_BUILD_INFO_SOURCES} projects` };
  /** @type {Map<string, BuildInfoSource>} */
  const sources = new Map();
  for (const [slug, entry] of entries) {
    // The name is not echoed: it came from the file.
    if (!SLUG.test(slug)) return { problem: '"sources" has a key that is not a project slug' };
    if (!isMapping(entry)) return { problem: `"sources.${slug}" is not an object` };
    const { url, ref, sha } = entry;
    if (typeof url !== 'string' || url === '' || url.length > 600) return { problem: `"sources.${slug}.url" is missing or is not an address` };
    if (typeof ref !== 'string' || ref === '' || ref.length > 200) return { problem: `"sources.${slug}.ref" is missing or is not a branch or tag name` };
    if (typeof sha !== 'string' || !COMMIT_ID.test(sha)) return { problem: `"sources.${slug}.sha" is missing or is not a commit id` };
    sources.set(slug, { url, ref, sha });
  }
  const next = value.nextScheduledAt;
  if (next !== null && !isMoment(next)) return { problem: '"nextScheduledAt" is missing or is neither null nor an ISO 8601 date and time' };
  return { value: { builtAt: value.builtAt, engineVersion: value.engineVersion, sources, nextScheduledAt: next } };
}

// ---------------------------------------------------------------------------
// Fetching the deployed file

/**
 * @typedef {object} HttpOptions
 * @property {typeof fetch} [fetch] Replaces `fetch` (tests).
 * @property {number} [timeoutMs] Time the whole exchange can take (default {@link DEFAULT_FETCH_TIMEOUT_MS}).
 * @property {number} [maxBytes] The most bytes of the body that are read (default {@link MAX_BUILD_INFO_BYTES}).
 * @property {number} [maxRedirects] The most redirects that are followed (default {@link MAX_REDIRECTS}).
 */

/**
 * Checks an address that the deployed file is fetched from.
 *
 * @param {string} text
 * @returns {{ url: URL } | { problem: string }}
 */
export function checkBuildInfoUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    // The text is not echoed: it may hold a password.
    return { problem: 'is not a valid URL (use http:// or https://)' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'must be an http:// or https:// URL' };
  if (url.username !== '' || url.password !== '') {
    return { problem: 'must not contain a user name or password; the file is public, so none is needed' };
  }
  if (url.hostname === '') return { problem: 'must have a host name' };
  return { url };
}

/**
 * What went wrong when a body could not be read, in words that hold no credentials.
 *
 * @param {unknown} error
 * @param {number} timeoutMs
 * @returns {string}
 */
function describeFetchError(error, timeoutMs) {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `no answer within ${Number((timeoutMs / 1000).toFixed(1))} s`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return tailOf(code === '' ? message : `${code} (${message})`, 1, 200);
}

/**
 * Reads at most `maxBytes` of a response body.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array | null>} The bytes; null when the body is larger.
 */
async function readBounded(response, maxBytes) {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Fetches the deployed `build-info.json`. Only http and https addresses are
 * fetched, at most {@link MAX_REDIRECTS} redirects are followed (each to an
 * http or https address without credentials, and never from https down to
 * http), the body is bounded in size and the whole exchange in time. Any
 * answer that is not a usable file is a reason, never an exception.
 *
 * @param {string} address
 * @param {HttpOptions} [options]
 * @returns {Promise<{ ok: true, info: ReadBuildInfo } | { ok: false, reason: string }>}
 */
export async function fetchBuildInfo(address, options = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BUILD_INFO_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const checked = checkBuildInfoUrl(address);
  if ('problem' in checked) return { ok: false, reason: `the address ${checked.problem}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /** @param {string} text */
  const unavailable = (text) => ({ ok: /** @type {const} */ (false), reason: redactUrl(text) });
  try {
    let url = checked.url;
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'coffer' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel().catch(() => {});
        if (redirects >= maxRedirects) return unavailable(`more than ${maxRedirects} redirects`);
        /** @type {URL} */
        let next;
        try {
          next = new URL(/** @type {string} */ (response.headers.get('location')), url);
        } catch {
          return unavailable('it redirects to an address that is not valid');
        }
        const target = checkBuildInfoUrl(next.href);
        if ('problem' in target) return unavailable(`it redirects to an address that ${target.problem}`);
        if (url.protocol === 'https:' && target.url.protocol === 'http:') return unavailable('it redirects from https to http');
        url = target.url;
        continue;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return unavailable(`the server answered ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        return unavailable(`the file is larger than ${maxBytes} bytes`);
      }
      const bytes = await readBounded(response, maxBytes);
      if (bytes === null) return unavailable(`the file is larger than ${maxBytes} bytes`);
      let parsed;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
        parsed = JSON.parse(text);
      } catch {
        return unavailable('the file is not valid JSON');
      }
      const result = checkBuildInfo(parsed);
      if ('problem' in result) return unavailable(`the file is not a build-info file: ${result.problem}`);
      return { ok: true, info: result.value };
    }
  } catch (error) {
    return unavailable(describeFetchError(error, timeoutMs));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Deciding

/**
 * One reason a new build is needed.
 *
 * @typedef {object} Reason
 * @property {'deployed-unavailable' | 'source-added' | 'source-removed' | 'source-url-changed' | 'source-ref-changed' | 'source-sha-changed' | 'scheduled-time-passed'} code
 * @property {string} message
 * @property {string} [source] The project slug, for the reasons that are about a source.
 */

/**
 * Compares what is deployed with what is current, source by source.
 *
 * @param {ReadBuildInfo} deployed
 * @param {ReadonlyMap<string, BuildInfoSource>} current The sources as configured, with the commit each one is at now.
 * @param {Date} now
 * @returns {Reason[]} Empty when the deployed site is up to date.
 */
export function compareBuildInfo(deployed, current, now) {
  /** @type {Reason[]} */
  const reasons = [];
  const slugs = [...new Set([...deployed.sources.keys(), ...current.keys()])].sort();
  for (const slug of slugs) {
    const was = deployed.sources.get(slug);
    const is = current.get(slug);
    if (was === undefined && is !== undefined) {
      reasons.push({ code: 'source-added', source: slug, message: `${slug}: the docs source ${redactUrl(is.url)} (ref ${is.ref}) is not in the deployed build` });
    } else if (was !== undefined && is === undefined) {
      reasons.push({ code: 'source-removed', source: slug, message: `${slug}: the deployed build used a docs source that is no longer configured` });
    } else if (was !== undefined && is !== undefined) {
      if (was.url !== is.url) {
        reasons.push({ code: 'source-url-changed', source: slug, message: `${slug}: the repository changed from ${redactUrl(was.url)} to ${redactUrl(is.url)}` });
      } else if (was.ref !== is.ref) {
        reasons.push({ code: 'source-ref-changed', source: slug, message: `${slug}: the ref changed from ${was.ref} to ${is.ref}` });
      } else if (was.sha !== is.sha) {
        reasons.push({ code: 'source-sha-changed', source: slug, message: `${slug}: ${is.ref} moved from ${was.sha} to ${is.sha}` });
      }
    }
  }
  if (deployed.nextScheduledAt !== null && Date.parse(deployed.nextScheduledAt) <= now.getTime()) {
    reasons.push({
      code: 'scheduled-time-passed',
      message: `a post scheduled for ${deployed.nextScheduledAt} is due (it is ${now.toISOString()})`,
    });
  }
  return reasons;
}
