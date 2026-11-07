import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AwsClient } from 'aws4fetch';

import {
  isUsableCredential,
  lookUpVariables,
  MAX_PLACEHOLDER_LENGTH,
  MissingCredentialsError,
  missingCredentialsMessage,
} from './credentials.js';
import { removeQuietly } from './fsutil.js';
import { assertKey, MediaStoreError, OBJECT_PREFIX } from './store.js';
import { readVersion } from '../version.js';

/**
 * A store that keeps the objects in an S3-compatible bucket (Cloudflare R2,
 * Backblaze B2, MinIO, AWS S3) as `{endpoint}/{bucket}/{prefix}originals/{sha256}`.
 *
 * Design decisions:
 *
 * - **Path-style addresses.** R2 and nearly every S3-compatible server accept
 *   them, and they need no wildcard certificate or DNS entry per bucket.
 * - **Requests are signed with aws4fetch** (AWS Signature Version 4) and sent
 *   with `node:http(s)`, so the body of an upload is a stream read from disk
 *   with an explicit `Content-Length`, a download is a stream written to disk,
 *   and a video never sits in memory. Redirects are never followed: a
 *   redirect is an error, so a signed request cannot be sent on to another
 *   host.
 * - **The payload hash is the key.** An object is named by the SHA-256 of its
 *   content, and the file is hashed before the upload, so the request is
 *   signed with `x-amz-content-sha256: {key}`; the server verifies the body
 *   against it (S3 and R2 refuse a body that does not match). That works on
 *   any server, with or without TLS, and is stronger than `UNSIGNED-PAYLOAD`.
 *   The upload is hashed again while it is sent and fails with `mismatch` when
 *   the file turns out not to be the content of the key (the server refuses such
 *   a body as well, so nothing is kept under the wrong name). Downloads
 *   are hashed while they are written; a file that is not the key's content is
 *   removed and reported as corrupt.
 * - **Retries** with exponential backoff and jitter, only for network errors,
 *   timeouts, HTTP 408, 429 and 5xx; `Retry-After` is honoured (up to a
 *   limit); the number of attempts and the total time are bounded; 400, 403
 *   and 404 are final. The sleep, the clock and the random source can be
 *   replaced, so tests are fast.
 * - **Nothing secret in a message.** Credentials live in a closure and are
 *   removed from every text that is shown; the body of an error response is
 *   cut short and stripped of anything that looks like a key.
 * - **https only.** The configuration accepts nothing else. The one exception
 *   is the option `allowInsecureLoopback` of {@link createS3Store}, which lets
 *   tests talk to an in-process server on `localhost`; the configuration has
 *   no way to switch it on.
 */

/** The SHA-256 of nothing: the payload hash of a request without a body. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Chunk size when reading an original to upload. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * The limits of a store. All can be replaced by tests.
 *
 * @typedef {object} S3Limits
 * @property {number} maxAttempts How many times one operation is tried (the first try included).
 * @property {number} baseDelayMs The wait before the second try; it doubles with every try.
 * @property {number} maxDelayMs The longest wait that backoff alone makes.
 * @property {number} maxRetryAfterMs The longest wait a `Retry-After` header is obeyed for.
 * @property {number} totalTimeoutMs How long one operation may spend, retries and waits together, before it gives up (an attempt that has started is not cut off by it, only limited by the idle timeout).
 * @property {number} idleTimeoutMs How long a connection may be silent before the attempt fails.
 * @property {number} maxErrorBodyBytes How much of an error response is read.
 */

/** @type {S3Limits} */
export const DEFAULT_S3_LIMITS = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  maxRetryAfterMs: 60_000,
  totalTimeoutMs: 10 * 60_000,
  idleTimeoutMs: 30_000,
  maxErrorBodyBytes: 4096,
});

/**
 * @typedef {object} S3StoreOptions
 * @property {Record<string, string | undefined>} [env] The environment the settings are read from (default: the process's).
 * @property {string} [configDir] The folder of the configuration file, where `.env.local` is looked for.
 * @property {(message: string) => void} [warn] Called with a warning (never an error), for example when `.env.local` is tracked by git or not ignored.
 * @property {boolean} [allowInsecureLoopback] For tests: also accept `http://` addresses of `localhost`, `127.0.0.1` and `[::1]`. A configuration cannot set this.
 * @property {Partial<S3Limits>} [limits]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep] Replaces the wait between tries.
 * @property {() => number} [now] Replaces the clock (milliseconds).
 * @property {() => number} [random] Replaces the random source (0 up to 1) of the jitter.
 * @property {AbortSignal} [signal] Cancels everything the store is doing.
 */

/**
 * Raised inside the store for a failure that is worth another try.
 */
class RetryableError extends Error {
  /**
   * @param {string} message
   * @param {number} [retryAfterMs]
   */
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RetryableError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Codes of errors of the connection that are worth another try. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
]);

// ---------------------------------------------------------------------------
// Settings

/**
 * @param {string} template An endpoint with `${NAME}` placeholders.
 * @returns {string[]} The names, without duplicates.
 */
export function placeholdersOf(template) {
  return [...new Set([...template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))];
}

/**
 * Checks and normalizes the endpoint after the placeholders were replaced.
 *
 * @param {string} template
 * @param {Map<string, string>} values
 * @param {boolean} allowInsecureLoopback
 * @returns {string} The endpoint without a trailing slash.
 * @throws {MediaStoreError}
 */
export function resolveEndpoint(template, values, allowInsecureLoopback) {
  const text = template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name) => {
    const value = values.get(name) ?? '';
    if (value.length > MAX_PLACEHOLDER_LENGTH || !/^[A-Za-z0-9._-]+$/.test(value) || /^\.+$/.test(value)) {
      throw new MediaStoreError('failed', `the variable ${name} is used in the store endpoint, so it may only contain letters, digits, ".", "_" and "-", and not only dots (its value is not shown)`);
    }
    return value;
  });
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new MediaStoreError('failed', 'the store endpoint is not a valid address after its ${NAME} placeholders are replaced');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (allowInsecureLoopback && url.protocol === 'http:' && loopback))) {
    throw new MediaStoreError('failed', 'the store endpoint must be an https address');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') {
    throw new MediaStoreError('failed', 'the store endpoint must not contain credentials, a query or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Cuts a text for a message: control characters out, the credentials in use and
 * anything that looks like a key removed, and at most `limit` characters.
 *
 * @param {string} text
 * @param {string[]} secrets Values that must not appear.
 * @param {number} [limit]
 * @returns {string}
 */
export function scrub(text, secrets, limit = 300) {
  let result = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join('[removed]');
  }
  result = result
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[removed]')
    .replace(/\bAWS4-HMAC-SHA256\b[^\n]*/gi, '[removed]')
    .replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim();
  return result.length > limit ? `${result.slice(0, limit)}...` : result;
}

/**
 * @param {unknown} error
 * @returns {string | undefined}
 */
function codeOf(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The abort error of a signal.
 *
 * @returns {MediaStoreError}
 */
function cancelled() {
  return new MediaStoreError('failed', 'the operation was cancelled');
}

/**
 * Waits, and stops waiting when the signal aborts.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Reads a `Retry-After` header: seconds, or a date.
 *
 * @param {string | string[] | undefined} header
 * @param {number} nowMs
 * @param {number} maxMs
 * @returns {number | undefined} Milliseconds, at most `maxMs`.
 */
export function parseRetryAfter(header, nowMs, maxMs) {
  const text = Array.isArray(header) ? header[0] : header;
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  let ms;
  if (/^\d{1,9}$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    ms = date - nowMs;
  }
  return Math.min(Math.max(ms, 0), maxMs);
}

// ---------------------------------------------------------------------------
// The store

/**
 * @typedef {object} Upload
 * @property {string} file
 * @property {number} size
 * @property {string} key
 */

/**
 * Makes the store a configuration describes.
 *
 * @param {Extract<import('./config.js').MediaStoreConfig, { type: 's3' }>} config
 * @param {S3StoreOptions} [options]
 * @returns {Promise<import('./store.js').MediaStore>}
 * @throws {MissingCredentialsError} When the credentials (or a variable of the endpoint) are not set: one message with everything to do.
 * @throws {MediaStoreError} For other unusable settings.
 */
export async function createS3Store(config, options = {}) {
  const env = options.env ?? process.env;
  const limits = { ...DEFAULT_S3_LIMITS, ...options.limits };
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const signal = options.signal;

  const placeholders = placeholdersOf(config.endpoint);
  const names = [...new Set([...placeholders, config.accessKeyIdEnv, config.secretAccessKeyEnv])];
  const found = await lookUpVariables(names, { env, configDir: options.configDir, warn: options.warn });
  if (found.missing.length > 0) {
    throw new MissingCredentialsError(
      missingCredentialsMessage(found.missing, {
        configDir: options.configDir,
        bucket: config.bucket,
        accessKeyIdEnv: config.accessKeyIdEnv,
        secretAccessKeyEnv: config.secretAccessKeyEnv,
      }),
      found.missing,
    );
  }
  const accessKeyId = /** @type {string} */ (found.values.get(config.accessKeyIdEnv));
  const secretAccessKey = /** @type {string} */ (found.values.get(config.secretAccessKeyEnv));
  for (const [name, value] of [[config.accessKeyIdEnv, accessKeyId], [config.secretAccessKeyEnv, secretAccessKey]]) {
    if (!isUsableCredential(value)) {
      throw new MediaStoreError('failed', `the variable ${name} does not hold a usable credential (printable characters without spaces, at most 512; its value is not shown)`);
    }
  }
  const secrets = [accessKeyId, secretAccessKey];
  const endpoint = resolveEndpoint(config.endpoint, found.values, options.allowInsecureLoopback === true);
  const folder = config.prefix.replace(/^\/+|\/+$/g, '');
  const objectBase = `${endpoint}/${config.bucket}/${folder === '' ? '' : `${folder}/`}${OBJECT_PREFIX}`;
  const target = new URL(endpoint);
  const description = `bucket ${config.bucket} at ${target.origin}${folder === '' ? '' : ` (prefix ${folder}/)`}`;
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: config.region, retries: 0 });
  const userAgent = `coffer/${readVersion()} (media store)`;
  const agent = target.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: 4 }) : new http.Agent({ keepAlive: true, maxSockets: 4 });

  /** @param {string} text */
  const safe = (text) => scrub(text, secrets);

  const throwIfCancelled = () => {
    if (signal?.aborted) throw cancelled();
  };

  /**
   * Sends one signed request and resolves with the response as soon as its
   * headers are there; the caller reads or drops the body.
   *
   * @param {'HEAD' | 'GET' | 'PUT'} method
   * @param {string} key
   * @param {Upload} [upload]
   * @returns {Promise<http.IncomingMessage>}
   */
  async function send(method, key, upload) {
    throwIfCancelled();
    const url = `${objectBase}${key}`;
    const datetime = new Date(now()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    const signed = await client.sign(url, {
      method,
      headers: { 'x-amz-content-sha256': upload === undefined ? EMPTY_SHA256 : upload.key },
      aws: { datetime },
    });
    /** @type {Record<string, string>} */
    const headers = Object.fromEntries(signed.headers);
    headers['user-agent'] = userAgent;
    if (upload !== undefined) headers['content-length'] = String(upload.size);
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, { method, headers, agent, signal }, resolve);
      /**
       * The reason the upload itself failed (a file that cannot be read, a file that is not its key), which is more telling than the closed connection it causes.
       *
       * @type {Error | undefined}
       */
      let uploadError;
      request.on('error', (error) => reject(uploadError ?? error));
      request.setTimeout(limits.idleTimeoutMs, () => {
        request.destroy(Object.assign(new Error(`no data for ${Math.round(limits.idleTimeoutMs / 1000)} seconds`), { code: 'ETIMEDOUT' }));
      });
      if (upload === undefined) {
        request.end();
        return;
      }
      const hash = createHash('sha256');
      let sent = 0;
      const verify = new Transform({
        transform(chunk, _encoding, done) {
          sent += chunk.length;
          if (sent > upload.size) {
            done(new MediaStoreError('mismatch', 'the file is longer than it was when it was hashed; it changed (run "coffer media lock" again)'));
            return;
          }
          hash.update(chunk);
          done(null, chunk);
        },
        flush(done) {
          if (sent !== upload.size || hash.digest('hex') !== upload.key) {
            done(new MediaStoreError('mismatch', `the file does not have the SHA-256 ${upload.key}; it changed after it was hashed (run "coffer media lock" again)`));
            return;
          }
          done();
        },
      });
      const source = createReadStream(upload.file, { highWaterMark: CHUNK_BYTES });
      source.on('error', (error) => (uploadError ??= error));
      verify.on('error', (error) => (uploadError ??= error));
      // A failure of the pipeline destroys the request, which rejects the promise above.
      pipeline(source, verify, request).catch(() => {});
    });
  }

  /**
   * Reads the start of an error response and shapes it for a message.
   *
   * @param {http.IncomingMessage} response
   * @returns {Promise<string>}
   */
  async function describeBody(response) {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= limits.maxErrorBodyBytes) break;
      }
    } catch {
      // The body is only extra detail.
    }
    response.destroy();
    const text = Buffer.concat(chunks).subarray(0, limits.maxErrorBodyBytes).toString('utf8');
    const code = /<Code>([^<]{1,100})<\/Code>/.exec(text)?.[1];
    const message = /<Message>([^<]{1,300})<\/Message>/.exec(text)?.[1];
    if (code !== undefined || message !== undefined) return safe([code, message].filter((part) => part !== undefined).join(': '));
    return safe(text.replace(/<[^>]*>/g, ' '));
  }

  /**
   * The error for a response that is not a success.
   *
   * @param {string} operation For the message.
   * @param {http.IncomingMessage} response
   * @returns {Promise<RetryableError | MediaStoreError>}
   */
  async function failureOf(operation, response) {
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers.location;
      let where = 'another address';
      try {
        if (location !== undefined) where = new URL(location, objectBase).host;
      } catch {
        // keep the generic wording
      }
      response.destroy();
      return new MediaStoreError('failed', `${operation}: the server answered HTTP ${status}, a redirect to ${safe(where)}; redirects are not followed. Check "endpoint" and "region" of the media store`);
    }
    const retryAfter = parseRetryAfter(response.headers['retry-after'], now(), limits.maxRetryAfterMs);
    const detail = await describeBody(response);
    const text = `${operation}: HTTP ${status}${detail === '' ? '' : ` (${detail})`}`;
    if (status === 408 || status === 429 || status >= 500) return new RetryableError(text, retryAfter);
    const hints = {
      400: 'the request was refused; check "bucket", "region" and "prefix"',
      401: 'the credentials were not accepted',
      403: 'access denied: check that the credentials are right and that the token may read and write this bucket (some servers also answer 403 for an object that does not exist when the token may not list the bucket)',
      404: 'the bucket or the object was not found: check "bucket" and "endpoint"',
    };
    const hint = hints[/** @type {400 | 401 | 403 | 404} */ (status)];
    return new MediaStoreError('failed', hint === undefined ? text : `${text}; ${hint}`);
  }

  /**
   * Turns whatever an attempt threw into a retryable or a final error.
   *
   * @param {string} operation
   * @param {unknown} error
   * @returns {RetryableError | MediaStoreError}
   */
  function classify(operation, error) {
    if (error instanceof RetryableError || error instanceof MediaStoreError) return error;
    if (signal?.aborted || /** @type {Error} */ (error)?.name === 'AbortError') return cancelled();
    const code = codeOf(error);
    const message = safe(error instanceof Error ? error.message : String(error));
    if (code !== undefined && RETRYABLE_CODES.has(code)) return new RetryableError(`${operation}: ${message}`);
    return new MediaStoreError('failed', `${operation}: ${message}${code === undefined ? '' : ` [${code}]`}`);
  }

  /**
   * Runs an attempt until it succeeds, fails for good or runs out of tries or time.
   *
   * @template T
   * @param {string} operation
   * @param {() => Promise<T>} attempt
   * @returns {Promise<T>}
   */
  async function retrying(operation, attempt) {
    const started = now();
    for (let tries = 1; ; tries += 1) {
      throwIfCancelled();
      try {
        return await attempt();
      } catch (raw) {
        const error = classify(operation, raw);
        if (!(error instanceof RetryableError)) throw error;
        const backoff = Math.min(limits.maxDelayMs, limits.baseDelayMs * 2 ** (tries - 1));
        const delay = error.retryAfterMs ?? Math.round(backoff / 2 + (random() * backoff) / 2);
        if (tries >= limits.maxAttempts || now() - started + delay > limits.totalTimeoutMs) {
          throw new MediaStoreError('failed', `${error.message} (gave up after ${tries} attempt${tries === 1 ? '' : 's'})`);
        }
        await sleep(delay, signal);
      }
    }
  }

  return {
    description,

    async has(key) {
      const name = `HEAD ${OBJECT_PREFIX}${assertKey(key).slice(0, 12)}...`;
      return retrying(name, async () => {
        const response = await send('HEAD', key);
        const status = response.statusCode;
        if (status === 200) {
          response.resume();
          return true;
        }
        if (status === 404) {
          response.resume();
          return false;
        }
        throw await failureOf(name, response);
      });
    },

    async put(key, file) {
      const name = `PUT ${OBJECT_PREFIX}${assertKey(key).slice(0, 12)}...`;
      const info = await lstat(file);
      if (!info.isFile()) throw new MediaStoreError('failed', `${file} is not a regular file`);
      await retrying(name, async () => {
        const response = await send('PUT', key, { file, size: info.size, key });
        const status = response.statusCode;
        if (status === 200 || status === 201 || status === 204) {
          response.resume();
          return;
        }
        throw await failureOf(name, response);
      });
    },

    async get(key, file) {
      const name = `GET ${OBJECT_PREFIX}${assertKey(key).slice(0, 12)}...`;
      await retrying(name, async () => {
        const response = await send('GET', key);
        const status = response.statusCode;
        if (status === 404) {
          response.resume();
          throw new MediaStoreError('missing', `the store has no object ${key}`);
        }
        if (status !== 200) throw await failureOf(name, response);
        const expected = response.headers['content-length'];
        const hash = createHash('sha256');
        let received = 0;
        const count = new Transform({
          transform(chunk, _encoding, done) {
            received += chunk.length;
            hash.update(chunk);
            done(null, chunk);
          },
        });
        const output = createWriteStream(file, { flags: 'wx', flush: true });
        try {
          await pipeline(response, count, output);
        } catch (error) {
          await removeQuietly(file);
          // An error of the file (disk full, no permission) is final; one of the connection is not.
          throw error;
        }
        if (expected !== undefined && received !== Number(expected)) {
          await removeQuietly(file);
          throw new RetryableError(`${name}: the download stopped after ${received} of ${expected} bytes`);
        }
        if (hash.digest('hex') !== key) {
          await removeQuietly(file);
          throw new MediaStoreError('corrupt', `the stored object ${key} is corrupt: its content does not hash to its key`);
        }
      });
    },
  };
}
