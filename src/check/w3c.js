import { readFileSync } from 'node:fs';

import { decodeEntities } from '../xml.js';

/** The W3C feed validation service. */
export const W3C_VALIDATOR_URL = 'https://validator.w3.org/feed/check.cgi';

/** Pause between two requests, in milliseconds: the service asks for at most one per second. */
export const W3C_REQUEST_INTERVAL_MS = 1000;

/** How long a request may take before the service counts as unreachable, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * One feed to validate online.
 *
 * @typedef {object} OnlineFeed
 * @property {string} label Name used in messages, such as the path of the feed file.
 * @property {string} path Path of the feed file on disk.
 */

/**
 * @typedef {object} W3cOptions
 * @property {typeof fetch} [fetch] Replaces the global `fetch`, for tests.
 * @property {(ms: number) => Promise<void>} [sleep] Replaces the real pause between requests, for tests.
 * @property {string} [url] Replaces the service address, for tests.
 * @property {number} [intervalMs] Pause between requests (default one second).
 */

/**
 * @typedef {object} W3cResult
 * @property {{ label: string, message: string }[]} errors Feeds the service found invalid, one message per problem.
 * @property {{ label: string, message: string }[]} warnings Warnings of the service, and a note when it could not be reached.
 * @property {number} checked Number of feeds the service answered for.
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * Text of the first element with a local name inside a block of XML.
 *
 * @param {string} block
 * @param {string} name
 * @returns {string | null}
 */
function childText(block, name) {
  const match = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`).exec(block);
  return match ? decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'), { html: true }).trim() : null;
}

/**
 * Problems or warnings listed in a SOAP 1.2 answer of the validator.
 *
 * @param {string} body
 * @param {'error' | 'warning'} kind
 * @returns {string[]}
 */
function listProblems(body, kind) {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${kind}>([\\s\\S]*?)</(?:[\\w.-]+:)?${kind}>`, 'g');
  /** @type {string[]} */
  const messages = [];
  for (const match of body.matchAll(pattern)) {
    const text = childText(match[1], 'text') ?? 'no description';
    const line = childText(match[1], 'line');
    messages.push(line ? `line ${line}: ${text}` : text);
  }
  return messages;
}

/**
 * Reads the answer of the validator.
 *
 * @param {string} body The SOAP 1.2 document.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] } | null} Null when the document is not an answer of the validator.
 */
export function parseW3cResponse(body) {
  const validity = childText(body, 'validity');
  if (validity !== 'true' && validity !== 'false') return null;
  const errors = listProblems(body, 'error');
  if (validity === 'false' && errors.length === 0) errors.push('the W3C validator rejected the feed');
  return { valid: validity === 'true', errors, warnings: listProblems(body, 'warning') };
}

/**
 * Posts feeds to the W3C feed validator, one request per second. A feed the
 * service finds invalid is an error. If the service cannot be reached (no
 * network, an error status, an answer that is not the validator's), the rest
 * is skipped and a single warning says so: a missing network must not fail a
 * check.
 *
 * @param {OnlineFeed[]} feeds
 * @param {W3cOptions} [options]
 * @returns {Promise<W3cResult>}
 */
export async function validateFeedsOnline(feeds, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const url = options.url ?? W3C_VALIDATOR_URL;
  const interval = options.intervalMs ?? W3C_REQUEST_INTERVAL_MS;

  /** @type {W3cResult} */
  const result = { errors: [], warnings: [], checked: 0 };
  for (const [index, feed] of feeds.entries()) {
    if (index > 0) await sleep(interval);
    let outcome;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'coffer-check' },
        body: new URLSearchParams({ rawdata: readFileSync(feed.path, 'utf8'), output: 'soap12' }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      outcome = parseW3cResponse(await response.text());
      if (outcome === null) throw new Error('the answer is not a feed validator response');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
      result.warnings.push({
        label: feed.label,
        message: `the W3C feed validator could not be reached (${reason}${cause}); feeds were not validated online`,
      });
      return result;
    }
    result.checked += 1;
    for (const message of outcome.errors) result.errors.push({ label: feed.label, message: `W3C validator: ${message}` });
    for (const message of outcome.warnings) {
      result.warnings.push({ label: feed.label, message: `W3C validator: ${message}` });
    }
  }
  return result;
}
