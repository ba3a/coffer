import chokidar from 'chokidar';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from './build.js';
import { loadConfig } from './config.js';
import { ENGINE_I18N_DIR } from './render/i18n.js';
import { startServer } from './serve.js';

/**
 * The live preview behind `coffer dev`: every site is built in preview mode
 * into `.cache/dev/`, each site is served on its own port the way `coffer serve`
 * does, and a change to the content, a theme, the configuration or the engine's
 * theme rebuilds the sites and reloads the pages that are open.
 */

/** Default first port of `coffer dev`; the next site gets the next port. */
export const DEFAULT_DEV_PORT = 4000;

/** Directory of the preview build, inside the `.cache` beside the configuration. */
export const DEV_OUT_DIR = join('.cache', 'dev');

/** Path of the Server-Sent Events stream that tells open pages to reload. */
export const EVENTS_PATH = '/__coffer/events';

/** Path of the script that listens to the stream; it is added to HTML pages only in dev. */
export const RELOAD_SCRIPT_PATH = '/__coffer/reload.js';

/** The theme of the engine, whose templates and styles are watched too. */
const ENGINE_THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));

/** Quiet time after the last change before a rebuild starts. */
const DEFAULT_DEBOUNCE_MS = 150;

/** How often an open stream is sent a comment so that proxies and browsers keep it. */
const HEARTBEAT_MS = 20000;

/** Names of directories whose changes never matter to a build. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.cache', '.coffer']);

const RELOAD_SCRIPT = `(() => {
  const events = new EventSource('${EVENTS_PATH}');
  events.addEventListener('reload', () => location.reload());
})();
`;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A page of the dev server's own: the build is running, or it failed. It
 * listens to the stream, so it turns into the site by itself.
 *
 * @param {'building' | 'error'} kind
 * @param {string} message
 * @returns {string}
 */
export function overlayPage(kind, message) {
  const failed = kind === 'error';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${failed ? 'Build failed' : 'Building'} - coffer dev</title>
<style>
body { margin: 0; padding: 2rem 1rem; font: 16px/1.5 system-ui, sans-serif; background: ${failed ? '#2b0d0d' : '#14181f'}; color: #f2f2f2; }
main { max-width: 60rem; margin: 0 auto; }
h1 { margin: 0 0 1rem; font-size: 1.5rem; color: ${failed ? '#ff8a80' : '#9ecbff'}; }
pre { margin: 0; padding: 1rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; background: rgba(0, 0, 0, 0.35); border-radius: 4px; font: 14px/1.5 ui-monospace, Consolas, monospace; }
p { color: #c8c8c8; }
</style>
</head>
<body>
<main>
<h1>${failed ? 'The build failed' : 'Building the sites…'}</h1>
${failed ? `<pre id="coffer-dev-error">${escapeHtml(message)}</pre>\n<p>Fix the problem and save: this page reloads when the next build finishes.</p>` : '<p>This page reloads when the build finishes.</p>'}
</main>
<script src="${RELOAD_SCRIPT_PATH}"></script>
</body>
</html>
`;
}

/**
 * Adds the reload script to an HTML document, before the end of the body.
 *
 * @param {string} html
 * @returns {string}
 */
export function injectReloadScript(html) {
  const tag = `<script src="${RELOAD_SCRIPT_PATH}"></script>`;
  const end = html.lastIndexOf('</body>');
  return end === -1 ? `${html}${tag}\n` : `${html.slice(0, end)}${tag}\n${html.slice(end)}`;
}

/**
 * Describes a failed build for people: the problems the engine collected, or
 * the message, or for a bug in coffer the stack.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function describeBuildError(error) {
  if (error instanceof Error && 'errors' in error && Array.isArray(error.errors)) {
    return error.errors.map(String).join('\n');
  }
  if (
    error instanceof Error &&
    (error.constructor === Error ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError)
  ) {
    return error.stack ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a change to this path can affect a build.
 *
 * @param {string} path
 * @returns {boolean}
 */
function ignoredPath(path) {
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => IGNORED_DIRS.has(part))) return true;
  const name = parts[parts.length - 1] ?? '';
  return name.endsWith('~') || /\.(?:swp|swx|tmp)$/.test(name) || name === '4913' || name.startsWith('.#');
}

/**
 * The files and directories a rebuild depends on.
 *
 * @param {import('./config.js').CofferConfig} config
 * @returns {string[]}
 */
export function watchedPaths(config) {
  /** @type {Set<string>} */
  const paths = new Set([config.file, ENGINE_THEME_DIR, ENGINE_I18N_DIR]);
  for (const site of config.sites) {
    paths.add(site.contentDir);
    if (site.theme) paths.add(site.theme);
    if (site.projects) paths.add(site.projects.dir);
    for (const blog of site.blogs) paths.add(blog.dir);
  }
  return [...paths];
}

/**
 * @typedef {object} DevOptions
 * @property {string} [configPath] The `--config` value (default: `coffer.yaml` in the working directory or a parent).
 * @property {string} [cwd] Directory that `configPath` and `out` resolve against (default the working directory).
 * @property {number} [port] Port of the first site; the next site gets the next port. 0 lets the system pick every port (default 4000).
 * @property {string} [host] Address to listen on (default `localhost`).
 * @property {string} [out] Directory of the preview build (default `.cache/dev` beside the configuration).
 * @property {Date} [now] Replaces the clock of the build; used by tests.
 * @property {boolean} [watch] Watch for changes (default true); without it only `rebuild()` builds again.
 * @property {number} [debounceMs] Quiet time after the last change before a rebuild.
 * @property {import('./cli.js').Io} [io] Where progress and errors are written (default nowhere).
 */

/**
 * @typedef {object} DevSite
 * @property {string} id
 * @property {number} port
 * @property {string} url Base URL of the site, such as `http://localhost:4000`.
 * @property {string} dir Directory with the built files of the site.
 */

/**
 * @typedef {object} RunningDev
 * @property {DevSite[]} sites
 * @property {string} out Directory of the preview build.
 * @property {() => 'building' | 'ready' | 'error'} phase What the last build ended in, or `building` while one runs.
 * @property {() => string | null} lastError The problems of the last build, or null when it succeeded.
 * @property {() => Promise<void>} rebuild Builds again now and resolves when the build has finished and the pages were told.
 * @property {() => Promise<void>} idle Resolves when no build is running or waiting.
 * @property {() => Promise<void>} close Stops watching and serving.
 */

/**
 * Builds the sites in preview mode, serves them and watches for changes.
 * Returns once the first build has finished (or failed: a failure is shown in
 * the terminal and in the browser, and the server keeps running) and the
 * watcher is ready.
 *
 * @param {DevOptions} [options]
 * @returns {Promise<RunningDev>}
 * @throws {import('./config.js').ConfigError} When the configuration cannot be read at the start.
 * @throws {Error} When a port cannot be listened on.
 */
export async function startDev(options = {}) {
  const io = options.io ?? { out: () => {}, err: () => {} };
  const configOptions = { cwd: options.cwd, configPath: options.configPath };
  let config = loadConfig(configOptions);
  const out = resolve(options.cwd ?? process.cwd(), options.out ?? join(config.dir, DEV_OUT_DIR));
  const firstPort = options.port ?? DEFAULT_DEV_PORT;

  /** @type {'building' | 'ready' | 'error'} */
  let phase = 'building';
  /** @type {string | null} */
  let failure = null;
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  /** @param {import('node:http').ServerResponse} response */
  const openStream = (response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.write('retry: 500\n: connected\n\n');
    clients.add(response);
    response.once('close', () => clients.delete(response));
  };

  const notifyPages = () => {
    for (const client of clients) client.write(`event: reload\ndata: ${Date.now()}\n\n`);
  };
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /** @type {import('./serve.js').ServeOptions['intercept']} */
  const intercept = (request, response, url) => {
    if (url.pathname === EVENTS_PATH) {
      openStream(response);
      return true;
    }
    if (url.pathname === RELOAD_SCRIPT_PATH) {
      const body = Buffer.from(RELOAD_SCRIPT);
      response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    }
    if (phase === 'ready') return false;
    const body = Buffer.from(overlayPage(phase === 'error' ? 'error' : 'building', failure ?? ''));
    response.writeHead(phase === 'error' ? 500 : 503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'Retry-After': '1',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  };

  /** @type {import('./serve.js').ServeOptions['transform']} */
  const transform = (body, contentType) =>
    contentType.startsWith('text/html') ? Buffer.from(injectReloadScript(body.toString('utf8'))) : body;

  /** @type {Map<string, import('./serve.js').RunningServer>} */
  const servers = new Map();
  /** @type {DevSite[]} */
  const sites = [];
  const closeServers = async () => {
    await Promise.all([...servers.values()].map((server) => server.close()));
  };
  try {
    for (const [index, site] of config.sites.entries()) {
      const server = await startServer({
        dir: join(out, site.id),
        port: firstPort === 0 ? 0 : firstPort + index,
        host: options.host,
        intercept,
        transform,
        headers: { 'Cache-Control': 'no-store' },
      });
      servers.set(site.id, server);
      sites.push({ id: site.id, port: server.port, url: server.url, dir: join(out, site.id) });
    }
  } catch (error) {
    await closeServers();
    clearInterval(heartbeat);
    throw error;
  }
  for (const site of sites) {
    io.out(`${site.id}: ${site.url}/ (drafts and scheduled posts included)\n`);
  }

  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  /** @type {string[]} */
  let changed = [];
  let closed = false;

  /** @type {import('chokidar').FSWatcher | null} */
  let watcher = null;
  /** @type {Set<string>} */
  let watching = new Set();

  /**
   * Starts to watch the paths of a new configuration and stops watching those it dropped.
   *
   * @param {import('./config.js').CofferConfig} next
   */
  const syncWatched = (next) => {
    if (watcher === null) return;
    const wanted = new Set(watchedPaths(next));
    const added = [...wanted].filter((path) => !watching.has(path));
    const removed = [...watching].filter((path) => !wanted.has(path));
    if (added.length > 0) watcher.add(added);
    if (removed.length > 0) void watcher.unwatch(removed);
    watching = wanted;
  };

  const buildOnce = async () => {
    const started = Date.now();
    const reason = changed.length === 0 ? '' : ` (changed: ${[...new Set(changed)].slice(0, 3).join(', ')}${new Set(changed).size > 3 ? ', ...' : ''})`;
    changed = [];
    phase = 'building';
    failure = null;
    try {
      config = loadConfig(configOptions);
      const ids = config.sites.map((site) => site.id);
      if (ids.length !== sites.length || ids.some((id, index) => id !== sites[index]?.id)) {
        io.err(
          `warning: the list of sites changed; restart "coffer dev" to serve ${ids.join(', ')}\n`,
        );
      }
      const results = await buildSites(config, {
        out,
        drafts: true,
        now: options.now,
        siteIds: config.sites.map((site) => site.id).filter((id) => servers.has(id)),
      });
      for (const result of results) {
        for (const warning of result.warnings) io.err(`warning: ${result.id}: ${warning}\n`);
      }
      phase = 'ready';
      io.out(`Built in ${((Date.now() - started) / 1000).toFixed(1)} s${reason}\n`);
      syncWatched(config);
    } catch (error) {
      phase = 'error';
      failure = describeBuildError(error);
      io.err(`Build failed${reason}:\n${failure}\nThe server keeps running; fix the problem and save.\n`);
    }
    notifyPages();
  };

  /** @returns {Promise<void>} */
  const rebuild = () => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await buildOnce();
        } while (again && !closed);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  await rebuild();

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  if (options.watch !== false) {
    watching = new Set(watchedPaths(config));
    watcher = chokidar.watch([...watching], {
      ignoreInitial: true,
      ignored: ignoredPath,
    });
    watcher.on('all', (_event, path) => {
      if (closed) return;
      changed.push(relative(config.dir, path).split(sep).join('/') || path);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void rebuild();
      }, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      io.err(`watcher: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    const active = watcher;
    await new Promise((ready) => active.once('ready', () => ready(undefined)));
    io.out('Watching the content, themes and configuration for changes\n');
  }

  return {
    sites,
    out,
    phase: () => phase,
    lastError: () => failure,
    rebuild,
    idle: async () => {
      while (running !== null || timer !== null) {
        await (running ?? new Promise((done) => setTimeout(done, 20)));
      }
    },
    close: async () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      clearInterval(heartbeat);
      await watcher?.close();
      await running;
      for (const client of clients) client.end();
      clients.clear();
      await closeServers();
    },
  };
}
