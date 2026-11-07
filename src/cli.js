import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { BuildError, buildSites, DEFAULT_OUT_DIR, DOCS_REPOS_CACHE_DIR } from './build.js';
import { CardError } from './cards.js';
import { checkOutput } from './check/index.js';
import { ConfigError, loadConfig } from './config.js';
import { DEFAULT_DEV_PORT, startDev } from './dev.js';
import { HomeError } from './content/home.js';
import { PostError } from './content/posts.js';
import { loadProjects, ProjectError } from './content/projects.js';
import { describeFetched, DocsSourceError, fetchDocsSources, planDocsFetch, redactUrl } from './docs/sources.js';
import { SeriesError } from './content/series.js';
import { TagsError } from './content/tags.js';
import { FontError } from './font-metrics.js';
import { runHooks } from './hooks.js';
import { MarkdownError } from './markdown/render.js';
import { runMedia } from './media/command.js';
import { createPost, NewPostError, splitTags } from './new-post.js';
import { formatRebuildAnswer, rebuildNeeded, RebuildUsageError } from './rebuild-needed.js';
import { I18nError } from './render/i18n.js';
import { ReportError, formatExactLocations } from './report.js';
import { SearchError } from './search.js';
import { DEFAULT_PORT, startServer } from './serve.js';
import { readVersion } from './version.js';

export { readVersion };

export const USAGE = `Usage: coffer <command> [options]

Commands:
  build           Build the sites into an output directory
                  (--config <path>, --out <dir> [default: ${DEFAULT_OUT_DIR}],
                  --drafts to include drafts and future posts, --now <date>)
  serve [dir]     Serve one built site directory the way Cloudflare Pages does
                  (--port <number> [default: ${DEFAULT_PORT}], --host <address>;
                  dir defaults to the working directory)
  dev             Preview every site with live reload, drafts and scheduled posts
                  included, each site on its own port, built into .cache/dev
                  (--config <path>, --port <number> for the first site
                  [default: ${DEFAULT_DEV_PORT}], --host <address>)
  new <blog> "Title"
                  Create {blogDir}/{slug}/index.md as a draft, with the front
                  matter filled in and a slug made from the title
                  (--date <date>, --tags <a,b/c>, --slug <slug>,
                  --config <path>; <blog> may be written site/blog)
  check           Check a finished build: links, anchors, preview metadata,
                  feeds and the sitemap; exits 1 on any failure
                  (--config <path>, --out <dir> [default: ${DEFAULT_OUT_DIR}],
                  --w3c to also validate feeds at validator.w3.org)
  docs fetch      Fetch the documentation sources of the tool projects
                  (git repositories into the cache, folders in place) and
                  print the commit of each; exits 1 if any cannot be fetched
                  (--config <path>, --project <slug> for one project)
  media           Keep original photos and videos outside git, in a media store:
                  status, lock, push, pull, gitignore (see docs/media.md)
                  (--config <path>; status: --remote;
                  pull: --force, --restore, --dry-run)
  hooks           Git hooks that keep the originals in step with git: install
                  (--force, --config <path>), uninstall, status (see docs/media.md)
  rebuild-needed  Say whether a deployed site is out of date: fetch its
                  build-info.json, ask each git docs source for its current
                  commit (git ls-remote, no token for public repositories)
                  and check for a scheduled post that is due; prints yes or
                  no and the reasons, and exits 0 either way (1 when a
                  source cannot be asked, 2 for a usage error)
                  (--url <build-info.json address>, --config <path>,
                  --site <id> [needed when there are several sites], --json)
  config          Check coffer.yaml and list the configured sites
                  (--config <path> selects another file)
  help            Show this help text
  --version, -v   Print the coffer version

Run "coffer help" to see this message again.
`;

/**
 * @typedef {object} Io
 * @property {(text: string) => void} out Writes to standard output.
 * @property {(text: string) => void} err Writes to standard error.
 */

/**
 * Things a command reaches outside the process through; tests replace them.
 *
 * @typedef {object} Services
 * @property {import('./check/w3c.js').W3cOptions} [w3c] Replaces the network and the clock of `check --w3c`.
 * @property {Partial<Pick<import('./docs/sources.js').FetchOptions, 'exec' | 'timeoutMs' | 'env'>>} [docs] Replaces git, the time limit and the environment of `docs fetch`.
 * @property {{ signal?: AbortSignal, out?: string, watch?: boolean }} [dev] Lets a test stop `dev` (the signal), keep its build elsewhere (`out`) or not watch.
 * @property {Date} [now] Replaces the clock of `new` and `rebuild-needed`.
 * @property {import('./build-info.js').HttpOptions} [http] Replaces the limits (and `fetch`) of `rebuild-needed`.
 * @property {Record<string, string | undefined>} [env] Replaces the environment that `media` and `hooks` read store credentials from (and `hooks` runs git in).
 * @property {{ cwd?: string }} [hooks] Replaces the folder `hooks` starts from.
 * @property {NodeJS.ReadableStream & { isTTY?: boolean }} [stdin] Replaces the standard input that `hooks run pre-push` reads the refs of the push from.
 */

/**
 * A command receives its arguments (without the command name) and the output
 * channels, and resolves to a process exit code.
 *
 * @typedef {(args: string[], io: Io, services: Services) => number | Promise<number>} Command
 */

/**
 * Extracts the value of `--config <path>` or `--config=<path>`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string } | { error: string }}
 */
export function parseConfigArgs(args) {
  /** @type {string | undefined} */
  let configPath;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      const value = args[i + 1];
      if (value === undefined || value === '') {
        return { error: '--config needs a path' };
      }
      configPath = value;
      i += 1;
    } else if (arg.startsWith('--config=') && arg.length > '--config='.length) {
      configPath = arg.slice('--config='.length);
    } else {
      return { error: `unexpected argument "${arg}"` };
    }
  }
  return configPath === undefined ? {} : { configPath };
}

/**
 * Reads the options of `coffer build`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string, out?: string, drafts: boolean, now?: string } | { error: string }}
 */
export function parseBuildArgs(args) {
  /** @type {{ configPath?: string, out?: string, drafts: boolean, now?: string }} */
  const options = { drafts: false };
  /** @type {Record<string, 'configPath' | 'out' | 'now'>} */
  const valued = { '--config': 'configPath', '--out': 'out', '--now': 'now' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--drafts') {
      options.drafts = true;
      continue;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    options[valued[flag]] = value;
  }
  return options;
}

/**
 * Reads the options of `coffer check`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string, out?: string, w3c: boolean } | { error: string }}
 */
export function parseCheckArgs(args) {
  /** @type {{ configPath?: string, out?: string, w3c: boolean }} */
  const options = { w3c: false };
  /** @type {Record<string, 'configPath' | 'out'>} */
  const valued = { '--config': 'configPath', '--out': 'out' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--w3c') {
      options.w3c = true;
      continue;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    options[valued[flag]] = value;
  }
  return options;
}

/**
 * Reads the options of `coffer docs fetch`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string, project?: string } | { error: string }}
 */
export function parseDocsFetchArgs(args) {
  /** @type {{ configPath?: string, project?: string }} */
  const options = {};
  /** @type {Record<string, 'configPath' | 'project'>} */
  const valued = { '--config': 'configPath', '--project': 'project' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    options[valued[flag]] = value;
  }
  return options;
}

/**
 * Reads the options of `coffer rebuild-needed`.
 *
 * @param {string[]} args
 * @returns {{ url: string, configPath?: string, site?: string, json: boolean } | { error: string }}
 */
export function parseRebuildNeededArgs(args) {
  /** @type {{ url?: string, configPath?: string, site?: string, json: boolean }} */
  const options = { json: false };
  /** @type {Record<string, 'url' | 'configPath' | 'site'>} */
  const valued = { '--url': 'url', '--config': 'configPath', '--site': 'site' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    // A stray argument could be an address with a password in it.
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${redactUrl(arg)}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    options[valued[flag]] = value;
  }
  if (options.url === undefined) return { error: '--url is required: the address of the deployed build-info.json' };
  return { ...options, url: options.url };
}

/**
 * Reads the options of `coffer serve`.
 *
 * @param {string[]} args
 * @returns {{ dir: string, port: number, host?: string } | { error: string }}
 */
export function parseServeArgs(args) {
  /** @type {{ dir: string, port: number, host?: string }} */
  const options = { dir: '.', port: DEFAULT_PORT };
  let sawDir = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (sawDir) return { error: `unexpected argument "${arg}"` };
      options.dir = arg;
      sawDir = true;
      continue;
    }
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (flag !== '--port' && flag !== '--host') return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    if (flag === '--host') {
      options.host = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        return { error: '--port must be a number from 0 to 65535' };
      }
      options.port = Number(value);
    }
  }
  return options;
}

/**
 * Reads the options of `coffer dev`.
 *
 * @param {string[]} args
 * @returns {{ configPath?: string, port: number, host?: string } | { error: string }}
 */
export function parseDevArgs(args) {
  /** @type {{ configPath?: string, port: number, host?: string }} */
  const options = { port: DEFAULT_DEV_PORT };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (flag !== '--config' && flag !== '--port' && flag !== '--host') {
      return { error: `unexpected argument "${arg}"` };
    }
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    if (flag === '--config') {
      options.configPath = value;
    } else if (flag === '--host') {
      options.host = value;
    } else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        return { error: '--port must be a number from 0 to 65535' };
      }
      options.port = Number(value);
    }
  }
  return options;
}

/**
 * Reads the options of `coffer new`.
 *
 * @param {string[]} args
 * @returns {{ blog: string, title: string, configPath?: string, date?: string, tags: string[], slug?: string } | { error: string }}
 */
export function parseNewArgs(args) {
  /** @type {string[]} */
  const positional = [];
  /** @type {{ configPath?: string, date?: string, tags: string[], slug?: string }} */
  const options = { tags: [] };
  /** @type {Record<string, 'configPath' | 'date' | 'tags' | 'slug'>} */
  const valued = { '--config': 'configPath', '--date': 'date', '--tags': 'tags', '--slug': 'slug' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [flag, inline] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (!Object.hasOwn(valued, flag)) return { error: `unexpected argument "${arg}"` };
    const value = inline ?? args[i + 1];
    if (value === undefined || value === '') return { error: `${flag} needs a value` };
    if (inline === undefined) i += 1;
    const key = valued[flag];
    if (key === 'tags') options.tags.push(...splitTags(value));
    else options[key] = value;
  }
  if (positional.length === 0) return { error: 'new needs a blog and a title: coffer new <blog> "Title"' };
  if (positional.length === 1) return { error: 'new needs a title: coffer new <blog> "Title"' };
  if (positional.length > 2) {
    return { error: `unexpected argument "${positional[2]}" (put a title with spaces in quotes)` };
  }
  return { blog: positional[0], title: positional[1], ...options };
}

/** @type {Record<string, Command>} */
const commands = {
  dev: async (args, io, services) => {
    const parsed = parseDevArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    /** @type {import('./dev.js').RunningDev} */
    let running;
    try {
      running = await startDev({
        configPath: parsed.configPath,
        port: parsed.port,
        host: parsed.host,
        out: services.dev?.out,
        watch: services.dev?.watch,
        io,
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      io.err(`coffer: cannot start the preview: ${error instanceof Error ? error.message : error}\n`);
      return 1;
    }
    io.out('Press Ctrl+C to stop.\n');
    const signal = services.dev?.signal;
    await new Promise((done) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        signal?.removeEventListener('abort', stop);
        done(undefined);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      if (signal?.aborted) stop();
      signal?.addEventListener('abort', stop, { once: true });
    });
    await running.close();
    return 0;
  },
  new: (args, io, services) => {
    const parsed = parseNewArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      const [siteId, blogId] = parsed.blog.includes('/') ? parsed.blog.split('/', 2) : [undefined, parsed.blog];
      const matches = config.sites.flatMap((site) =>
        site.id === (siteId ?? site.id)
          ? site.blogs.filter((blog) => blog.id === blogId).map((blog) => ({ site, blog }))
          : [],
      );
      if (matches.length !== 1) {
        const known = config.sites.flatMap((site) => site.blogs.map((blog) => `${site.id}/${blog.id}`));
        io.err(
          `coffer: ${matches.length === 0 ? `no blog "${parsed.blog}"` : `"${parsed.blog}" names several blogs; write site/blog`} (known: ${known.join(', ') || 'none'})\n`,
        );
        return 1;
      }
      const { site, blog } = matches[0];
      const post = createPost({
        blog,
        timezone: site.timezone,
        title: parsed.title,
        date: parsed.date,
        tags: parsed.tags,
        slug: parsed.slug,
        now: services.now,
      });
      const shown = relative(process.cwd(), post.file).split(sep).join('/');
      io.out(`Created ${shown.startsWith('..') ? post.file : shown} (a draft; remove "draft: true" to publish)\n`);
      return 0;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof NewPostError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  serve: async (args, io) => {
    const parsed = parseServeArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}
`);
      return 1;
    }
    const dir = resolve(parsed.dir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      io.err(`coffer: ${parsed.dir} is not a directory
`);
      return 1;
    }
    let running;
    try {
      running = await startServer({ dir, port: parsed.port, host: parsed.host });
    } catch (error) {
      io.err(`coffer: cannot start the server: ${error instanceof Error ? error.message : error}
`);
      return 1;
    }
    io.out(`Serving ${dir} at ${running.url}/ (Ctrl+C to stop)
`);
    const { server } = running;
    process.once('SIGINT', () => void running.close());
    process.once('SIGTERM', () => void running.close());
    await new Promise((done) => server.once('close', done));
    return 0;
  },
  build: async (args, io) => {
    const parsed = parseBuildArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      const results = await buildSites(config, {
        out: parsed.out,
        drafts: parsed.drafts,
        nowFlag: parsed.now,
      });
      for (const result of results) {
        for (const warning of result.warnings) {
          io.err(`warning: ${result.id}: ${warning}\n`);
        }
        const { posts, pages } = result.manifest;
        io.out(
          `${result.id}: ${posts.length} post(s), ${pages.length} page(s) -> ${result.outDir}\n`,
        );
      }
      // Every build says which posts publish exact locations, so that a mistake
      // in a policy is seen before the site is pushed.
      io.out(formatExactLocations(results.flatMap((result) => result.exactLocations)));
      return 0;
    } catch (error) {
      if (
        error instanceof ConfigError ||
        error instanceof PostError ||
        error instanceof ProjectError ||
        error instanceof SeriesError ||
        error instanceof TagsError ||
        error instanceof HomeError ||
        error instanceof ReportError ||
        error instanceof DocsSourceError
      ) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      if (
        error instanceof BuildError ||
        error instanceof CardError ||
        error instanceof FontError ||
        error instanceof MarkdownError ||
        error instanceof I18nError ||
        error instanceof SearchError
      ) {
        io.err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  },
  check: async (args, io, services) => {
    const parsed = parseCheckArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      const out = parsed.out ?? DEFAULT_OUT_DIR;
      const result = await checkOutput(config, { out, w3c: parsed.w3c, w3cOptions: services.w3c });
      const label = out.replace(/[\\/]+$/, '');
      for (const warning of result.warnings) {
        io.err(`warning: ${label}/${warning.site}/${warning.file}: ${warning.message}\n`);
      }
      for (const failure of result.failures) {
        io.err(`${label}/${failure.site}/${failure.file}: ${failure.message}\n`);
      }
      for (const site of result.sites) {
        const problems = site.failures.length;
        io.out(
          `${site.site}: ${site.checked.pages} page(s), ${site.checked.feeds} feed(s), ${site.checked.images} image(s) checked, ` +
            `${problems === 0 ? 'no failures' : `${problems} failure(s)`}\n`,
        );
      }
      if (result.failures.length > 0) {
        io.err(`coffer check: ${result.failures.length} failure(s)\n`);
        return 1;
      }
      return 0;
    } catch (error) {
      if (error instanceof ConfigError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  docs: async (args, io, services) => {
    const [subcommand, ...rest] = args;
    if (subcommand !== 'fetch') {
      io.err(`coffer: ${subcommand === undefined ? 'docs needs a subcommand' : `unknown docs subcommand "${subcommand}"`} (known: fetch)\n`);
      return 1;
    }
    const parsed = parseDocsFetchArgs(rest);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      /** @type {import('./docs/sources.js').DocsEntry[]} */
      const entries = [];
      let projectCount = 0;
      for (const site of config.sites) {
        if (!site.projects) continue;
        for (const project of loadProjects(site.projects.dir)) {
          projectCount += 1;
          if (parsed.project !== undefined && project.slug !== parsed.project) continue;
          if (!project.fields.docs) continue;
          entries.push({
            site: site.id,
            slug: project.slug,
            docs: /** @type {import('./docs/sources.js').DocsConfig} */ (project.fields.docs),
          });
        }
      }
      const plan = planDocsFetch(entries);
      if (plan.conflicts.length > 0) {
        io.err(`${plan.conflicts.join('\n')}\n`);
        return 1;
      }
      if (parsed.project !== undefined && entries.length === 0) {
        io.err(`coffer: no project "${parsed.project}" with a docs source (${projectCount} project(s) read)\n`);
        return 1;
      }
      /** @type {import('./docs/sources.js').FetchedDocs[]} */
      const fetched = [];
      /** @type {string[]} */
      const failures = [];
      for (const run of plan.runs) {
        try {
          const result = await fetchDocsSources(run, {
            cacheDir: join(config.dir, '.cache', DOCS_REPOS_CACHE_DIR),
            ...services.docs,
          });
          fetched.push(...result.values());
        } catch (error) {
          if (!(error instanceof DocsSourceError)) throw error;
          failures.push(...error.errors);
        }
      }
      if (failures.length > 0) throw new DocsSourceError(failures);
      for (const entry of fetched) io.out(`${describeFetched(entry)}\n`);
      if (fetched.length === 0) io.out('no project has a docs source\n');
      return 0;
    } catch (error) {
      if (error instanceof ConfigError || error instanceof ProjectError || error instanceof DocsSourceError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  'rebuild-needed': async (args, io, services) => {
    const parsed = parseRebuildNeededArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}
`);
      return 2;
    }
    try {
      const config = loadConfig({ configPath: parsed.configPath });
      const answer = await rebuildNeeded({
        config,
        url: parsed.url,
        site: parsed.site,
        now: services.now,
        http: services.http,
        git: services.docs,
      });
      io.out(parsed.json ? `${JSON.stringify(answer, null, 2)}\n` : formatRebuildAnswer(answer));
      return 0;
    } catch (error) {
      if (error instanceof RebuildUsageError) {
        io.err(`coffer: ${error.message}\n`);
        return 2;
      }
      if (error instanceof ConfigError || error instanceof ProjectError || error instanceof DocsSourceError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  media: (args, io, services) => runMedia(args, io, services),
  hooks: (args, io, services) => runHooks(args, io, services),
  config: (args, io) => {
    const parsed = parseConfigArgs(args);
    if ('error' in parsed) {
      io.err(`coffer: ${parsed.error}\n`);
      return 1;
    }
    try {
      const config = loadConfig(parsed);
      const names = config.sites.map((site) => site.id).join(', ');
      io.out(`${config.sites.length} site(s) configured: ${names}\n`);
      return 0;
    } catch (error) {
      if (error instanceof ConfigError) {
        io.err(`${error.errors.join('\n')}\n`);
        return 1;
      }
      throw error;
    }
  },
  help: (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '--help': (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '-h': (_args, io) => {
    io.out(USAGE);
    return 0;
  },
  '--version': (_args, io) => {
    io.out(`${readVersion()}\n`);
    return 0;
  },
  '-v': (_args, io) => {
    io.out(`${readVersion()}\n`);
    return 0;
  },
};

/**
 * Dispatches a command line to the matching command.
 *
 * @param {string[]} argv Arguments after the program name.
 * @param {Io} io Output channels.
 * @param {Services} [services] Outside services, replaced in tests.
 * @returns {Promise<number>} Process exit code.
 */
export async function run(argv, io, services = {}) {
  const [name, ...args] = argv;
  if (name === undefined) {
    io.err(USAGE);
    return 1;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (command === undefined) {
    io.err(`coffer: unknown command "${name}"\n\n${USAGE}`);
    return 1;
  }
  return command(args, io, services);
}
