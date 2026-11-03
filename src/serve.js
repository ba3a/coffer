import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

/**
 * A static file server for one site directory that behaves like Cloudflare
 * Pages, so that URLs can be checked locally the way a visitor meets them:
 *
 * - `/a` redirects with 308 to `/a/` when `a/index.html` exists;
 * - `/a/index.html` redirects with 308 to `/a/`;
 * - the rules of `_redirects` apply, with their own status, before any file is
 *   looked up;
 * - an unknown path answers 404 with the content of `404.html`.
 *
 * It has no dependencies and is meant for local use and tests, not production.
 */

/** Default port of `coffer serve`. */
export const DEFAULT_PORT = 8080;

/** Status of the redirects that normalise a path. */
const NORMALISE_STATUS = 308;

/** Statuses a `_redirects` rule may use for a redirect. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atom': 'application/atom+xml; charset=utf-8',
  '.rss': 'application/rss+xml; charset=utf-8',
  '.gpx': 'application/gpx+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Content type of a file that has no known extension. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Content type for a file name.
 *
 * @param {string} file
 * @returns {string}
 */
export function contentTypeFor(file) {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * One rule of a `_redirects` file.
 *
 * @typedef {object} RedirectRule
 * @property {string} from Path to match; a trailing `*` matches any rest, which `:splat` in `to` repeats.
 * @property {string} to Destination path or absolute URL.
 * @property {number} status
 */

/**
 * Reads the text of a `_redirects` file. Blank lines and lines starting with
 * `#` are skipped, as are rules that are not redirects (status 200 rewrites)
 * and lines that are not `from to [status]`. The status defaults to 301.
 *
 * @param {string} text
 * @returns {RedirectRule[]}
 */
export function parseRedirects(text) {
  /** @type {RedirectRule[]} */
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2 || parts.length > 3) continue;
    const [from, to, code] = parts;
    const status = code === undefined ? 301 : Number.parseInt(code, 10);
    if (!from.startsWith('/') || !REDIRECT_STATUSES.has(status)) continue;
    rules.push({ from, to, status });
  }
  return rules;
}

/**
 * Finds the first rule that matches a path and returns where it sends the
 * visitor.
 *
 * @param {RedirectRule[]} rules
 * @param {string} pathname Decoded request path starting with a slash.
 * @returns {{ location: string, status: number } | null}
 */
export function matchRedirect(rules, pathname) {
  for (const rule of rules) {
    if (rule.from.endsWith('*')) {
      const prefix = rule.from.slice(0, -1);
      if (pathname.startsWith(prefix)) {
        return {
          location: rule.to.replaceAll(':splat', pathname.slice(prefix.length)),
          status: rule.status,
        };
      }
    } else if (rule.from === pathname) {
      return { location: rule.to, status: rule.status };
    }
  }
  return null;
}

/**
 * @param {string} file
 * @returns {boolean}
 */
function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Path of a file inside `root` for a decoded URL path, or null when the path
 * leaves the directory.
 *
 * @param {string} root Absolute directory.
 * @param {string} pathname Decoded request path starting with a slash.
 * @returns {string | null}
 */
function insideRoot(root, pathname) {
  const target = resolve(root, `.${pathname}`);
  return target === root || target.startsWith(root + sep) ? target : null;
}

/**
 * What the server does for a request.
 *
 * @typedef {{ kind: 'redirect', status: number, location: string }
 *   | { kind: 'file', status: number, file: string }
 *   | { kind: 'missing' }} Resolution
 */

/**
 * Decides what to answer for a request path, without sending anything.
 *
 * @param {string} root Absolute site directory.
 * @param {RedirectRule[]} rules
 * @param {string} rawPath Request path as received, without the query.
 * @param {string} search The query string with its `?`, or the empty string.
 * @returns {Resolution}
 */
export function resolveRequest(root, rules, rawPath, search) {
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return { kind: 'missing' };
  }
  if (!pathname.startsWith('/') || pathname.includes('\0')) return { kind: 'missing' };

  const rule = matchRedirect(rules, pathname);
  if (rule) return { kind: 'redirect', status: rule.status, location: rule.location };

  if (pathname.endsWith('/index.html')) {
    const base = pathname.slice(0, -'index.html'.length);
    if (isFile(join(root, ...base.split('/'), 'index.html'))) {
      return { kind: 'redirect', status: NORMALISE_STATUS, location: `${base}${search}` };
    }
  }

  const target = insideRoot(root, pathname);
  if (target === null) return { kind: 'missing' };

  if (pathname.endsWith('/')) {
    const index = join(target, 'index.html');
    return isFile(index) ? { kind: 'file', status: 200, file: index } : { kind: 'missing' };
  }
  if (isFile(target)) return { kind: 'file', status: 200, file: target };
  if (isFile(join(target, 'index.html'))) {
    return { kind: 'redirect', status: NORMALISE_STATUS, location: `${pathname}/${search}` };
  }
  return { kind: 'missing' };
}

/**
 * Reads the `_redirects` file of a site directory; no file means no rules.
 *
 * @param {string} root
 * @returns {RedirectRule[]}
 */
function readRules(root) {
  const file = join(root, '_redirects');
  return existsSync(file) ? parseRedirects(readFileSync(file, 'utf8')) : [];
}

/**
 * @typedef {object} ServeOptions
 * @property {string} dir The site directory to serve.
 * @property {number} [port] Port to listen on; 0 picks a free one (default 8080).
 * @property {string} [host] Address to listen on (default `localhost`).
 */

/**
 * @typedef {object} RunningServer
 * @property {import('node:http').Server} server
 * @property {number} port The port actually listening.
 * @property {string} url Base URL, such as `http://localhost:8080`.
 * @property {() => Promise<void>} close Stops the server and drops open connections.
 */

/**
 * Starts the server. Files and `_redirects` are read on every request, so a
 * rebuild of the directory shows at once.
 *
 * @param {ServeOptions} options
 * @returns {Promise<RunningServer>}
 */
export function startServer(options) {
  const root = resolve(options.dir);
  const host = options.host ?? 'localhost';

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method Not Allowed\n');
      return;
    }

    /**
     * @param {number} status
     * @param {string} type
     * @param {Buffer | string} body
     * @param {Record<string, string>} [headers]
     */
    const send = (status, type, body, headers = {}) => {
      const buffer = typeof body === 'string' ? Buffer.from(body) : body;
      response.writeHead(status, {
        'Content-Type': type,
        'Content-Length': String(buffer.length),
        ...headers,
      });
      response.end(method === 'HEAD' ? undefined : buffer);
    };

    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const resolution = resolveRequest(root, readRules(root), url.pathname, url.search);
      if (resolution.kind === 'redirect') {
        send(resolution.status, 'text/plain; charset=utf-8', `${resolution.location}\n`, {
          Location: resolution.location,
        });
      } else if (resolution.kind === 'file') {
        send(resolution.status, contentTypeFor(resolution.file), readFileSync(resolution.file));
      } else {
        const notFound = join(root, '404.html');
        if (isFile(notFound)) {
          send(404, contentTypeFor(notFound), readFileSync(notFound));
        } else {
          send(404, 'text/plain; charset=utf-8', 'Not Found\n');
        }
      }
    } catch (error) {
      send(500, 'text/plain; charset=utf-8', `${error instanceof Error ? error.message : error}\n`);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolvePromise({
        server,
        port,
        url: `http://${host}:${port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
