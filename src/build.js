import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LATEST_POSTS, loadHome } from './content/home.js';
import { discoverPosts, isPublished, resolveNow } from './content/posts.js';
import { renderMarkdown } from './markdown/render.js';
import { createTemplates } from './render/templates.js';
import { readVersion } from './version.js';

/** Directory holding the static assets of the default theme. */
export const ENGINE_ASSETS_DIR = fileURLToPath(new URL('../theme/assets/', import.meta.url));

/** Output root used when none is given. */
export const DEFAULT_OUT_DIR = 'dist';

/**
 * Name of the build manifest, written to the root of every site's output. It
 * is for checks, not for visitors: deployments must leave it out.
 */
export const MANIFEST_FILE_NAME = '.coffer-manifest.json';

/** File names that must not be deployed. */
export const DEPLOY_EXCLUDES = Object.freeze([MANIFEST_FILE_NAME]);

/** Version of the manifest format. */
export const MANIFEST_VERSION = 1;

/**
 * Raised when a build cannot continue for a reason that is not a problem in
 * the configuration, a post or a Markdown text.
 */
export class BuildError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

/**
 * @typedef {import('./config.js').CofferConfig} CofferConfig
 * @typedef {import('./config.js').SiteConfig} SiteConfig
 * @typedef {import('./config.js').BlogConfig} BlogConfig
 * @typedef {import('./content/posts.js').Post} Post
 */

/**
 * @typedef {object} BuildOptions
 * @property {string} [out] Output root, absolute or relative to `cwd` (default `dist`). Each site is written to `{out}/{siteId}`.
 * @property {boolean} [drafts] Preview mode: build drafts and future-dated posts too.
 * @property {Date} [now] The moment that decides which posts are already published. Wins over `nowFlag` and the environment.
 * @property {string} [nowFlag] Value of `--now`; a date or a date and time, read in the site's time zone when it has no offset.
 * @property {Record<string, string | undefined>} [env] Environment for `COFFER_NOW` (default `process.env`).
 * @property {string} [cwd] Directory that a relative `out` resolves against (default the working directory).
 * @property {string[]} [siteIds] Build only these sites (default all).
 */

/**
 * One page written by the build, as listed in the manifest.
 *
 * @typedef {object} ManifestPage
 * @property {string} url Site-relative URL, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {'home' | 'not-found' | 'blog-index' | 'post'} type
 * @property {string} title
 */

/**
 * One post listed in the manifest.
 *
 * @typedef {object} ManifestPost
 * @property {string} blog Id of the blog.
 * @property {string} slug
 * @property {string} url Site-relative URL, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {string} source Path of the Markdown file, relative to the configuration file.
 * @property {string} title
 * @property {string} date ISO 8601 moment of publication.
 * @property {string[]} tags
 * @property {boolean} draft True when the post is a draft.
 * @property {boolean} published False for a post that is only built because of preview mode.
 * @property {number} readingMinutes
 */

/**
 * The build manifest of one site. `feeds` and `images` are filled by later
 * features; checks read this file instead of guessing what the build wrote.
 *
 * @typedef {object} Manifest
 * @property {number} manifestVersion
 * @property {{ name: string, version: string }} generator
 * @property {{ id: string, baseUrl: string, lang: string, timezone: string }} site
 * @property {string} now ISO 8601 moment used to decide which posts are published.
 * @property {boolean} drafts True for a preview build.
 * @property {ManifestPage[]} pages
 * @property {ManifestPost[]} posts
 * @property {unknown[]} feeds
 * @property {unknown[]} images
 */

/**
 * The outcome of building one site.
 *
 * @typedef {object} SiteResult
 * @property {string} id
 * @property {string} outDir Absolute path of the site's output directory.
 * @property {Manifest} manifest
 * @property {string[]} warnings
 */

/**
 * @param {string} value
 * @returns {string}
 */
function posix(value) {
  return sep === '/' ? value : value.split(sep).join('/');
}

/**
 * Site-relative URL of a blog: `/journal/`, or `/` for a blog at the root.
 *
 * @param {BlogConfig} blog
 * @returns {string}
 */
function blogUrl(blog) {
  return blog.prefix === '' ? '/' : `/${blog.prefix}/`;
}

/**
 * Site-relative URL of a post. It depends on the blog prefix and the slug
 * only, never on the date or the tags.
 *
 * @param {BlogConfig} blog
 * @param {string} slug
 * @returns {string}
 */
export function postUrl(blog, slug) {
  return `${blogUrl(blog)}${slug}/`;
}

/** Site-relative URL and file of the page that hosts serve for an unknown address. */
export const NOT_FOUND_URL = '/404.html';
const NOT_FOUND_FILE = '404.html';

/**
 * Path of the HTML file for a site-relative URL, relative to the output directory.
 *
 * @param {string} url Site-relative URL ending in a slash.
 * @returns {string}
 */
function fileForUrl(url) {
  return `${url.slice(1)}index.html`;
}

/**
 * The part of a post that templates see.
 *
 * @param {Post} post
 * @param {string} url
 * @param {number} readingMinutes
 * @param {boolean} unpublished True when the post is only built because of preview mode.
 */
function postView(post, url, readingMinutes, unpublished) {
  return {
    slug: post.slug,
    url,
    title: post.title,
    date: post.date,
    tags: post.tags,
    summary: post.summary,
    draft: post.draft,
    unpublished,
    readingMinutes,
  };
}

/**
 * @param {string} outDir
 * @param {string} file Path relative to `outDir`, with forward slashes.
 * @param {string} content
 */
function writeOutput(outDir, file, content) {
  const target = join(outDir, ...file.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * Copies the assets of the default theme and then those of the site's theme,
 * so that a theme file replaces the engine file of the same name.
 *
 * @param {SiteConfig} site
 * @param {string} outDir
 */
function copyAssets(site, outDir) {
  const target = join(outDir, 'assets');
  mkdirSync(target, { recursive: true });
  /** @type {string[]} */
  const sources = [ENGINE_ASSETS_DIR];
  if (site.theme) sources.push(join(site.theme, 'assets'));
  for (const source of sources) {
    if (existsSync(source) && statSync(source).isDirectory()) {
      cpSync(source, target, { recursive: true });
    }
  }
}

/**
 * @param {import('./config.js').CofferConfig} config
 * @param {SiteConfig} site
 * @param {BuildOptions} options
 * @param {string} outRoot
 * @param {string} version
 * @returns {Promise<SiteResult>}
 */
async function buildSite(config, site, options, outRoot, version) {
  const outDir = join(outRoot, site.id);
  const drafts = options.drafts === true;

  /** @type {Date} */
  let now;
  if (options.now) {
    now = options.now;
  } else {
    try {
      now = resolveNow({ flag: options.nowFlag, env: options.env, timezone: site.timezone });
    } catch (error) {
      throw new BuildError(error instanceof Error ? error.message : String(error));
    }
  }

  /** @type {string[]} */
  const warnings = [];
  const templates = createTemplates({
    lang: site.lang,
    theme: site.theme,
    baseUrl: site.baseUrl,
    timezone: site.timezone,
    onMissing: (message) => warnings.push(message),
  });

  const nav = [
    { key: 'nav.home', url: '/' },
    ...site.blogs.map((blog) => ({ label: blog.title, url: blogUrl(blog) })),
  ];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyAssets(site, outDir);

  /** @type {ManifestPage[]} */
  const pages = [];
  /** @type {ManifestPost[]} */
  const manifestPosts = [];
  /**
   * The posts of the first blog, newest first, for the home page.
   * @type {ReturnType<typeof postView>[]}
   */
  let firstBlogPosts = [];

  for (const blog of site.blogs) {
    const found = discoverPosts(blog.dir, { timezone: site.timezone });
    const selected = found.filter((post) => isPublished(post, { now, drafts }));

    /** @type {{ post: Post, url: string, readingMinutes: number, unpublished: boolean }[]} */
    const entries = [];
    for (const post of selected) {
      const rendered = await renderMarkdown(post.body, {
        file: post.file,
        startLine: post.bodyLine,
      });
      const url = postUrl(blog, post.slug);
      const unpublished = !isPublished(post, { now });
      entries.push({ post, url, readingMinutes: rendered.readingMinutes, unpublished });

      const view = postView(post, url, rendered.readingMinutes, unpublished);
      const html = templates.render('post.njk', {
        site,
        nav,
        blog,
        post: view,
        toc: rendered.toc,
        page: {
          title: post.title,
          description: post.summary ?? '',
          content: rendered.html,
        },
      });
      const file = fileForUrl(url);
      writeOutput(outDir, file, html);
      pages.push({ url, file, type: 'post', title: post.title });
      manifestPosts.push({
        blog: blog.id,
        slug: post.slug,
        url,
        file,
        source: posix(relative(config.dir, post.file)),
        title: post.title,
        date: post.date.toISOString(),
        tags: post.tags,
        draft: post.draft,
        published: !unpublished,
        readingMinutes: rendered.readingMinutes,
      });
    }

    const views = entries.map(({ post, url, readingMinutes, unpublished }) =>
      postView(post, url, readingMinutes, unpublished),
    );
    if (blog === site.blogs[0]) firstBlogPosts = views;

    const indexUrl = blogUrl(blog);
    const indexHtml = templates.render('blog-index.njk', {
      site,
      nav,
      blog,
      posts: views,
      page: { title: blog.title, description: site.description, content: '' },
    });
    const indexFile = fileForUrl(indexUrl);
    writeOutput(outDir, indexFile, indexHtml);
    pages.push({ url: indexUrl, file: indexFile, type: 'blog-index', title: blog.title });
  }

  // The home page lives at "/". A blog at the site root has that address.
  const rootBlog = site.blogs.find((blog) => blog.prefix === '');
  const home = loadHome(site.contentDir);
  if (rootBlog) {
    if (home) {
      warnings.push(
        `${home.file}: not used, because the blog "${rootBlog.id}" has an empty prefix and its index is the home page of the site`,
      );
    }
  } else {
    const rendered = home
      ? await renderMarkdown(home.body, { file: home.file, startLine: home.bodyLine })
      : null;
    const firstBlog = site.blogs[0];
    const latest = firstBlogPosts.slice(0, home?.latestPosts ?? DEFAULT_LATEST_POSTS);
    const title = home?.title ?? site.title;
    const homeHtml = templates.render('home.njk', {
      site,
      nav,
      blog: firstBlog,
      blogUrl: firstBlog ? blogUrl(firstBlog) : null,
      posts: latest,
      secondaryLinks: home?.secondaryLinks ?? [],
      page: {
        title,
        description: site.description,
        content: rendered?.html ?? '',
      },
    });
    writeOutput(outDir, fileForUrl('/'), homeHtml);
    pages.push({ url: '/', file: fileForUrl('/'), type: 'home', title });
  }

  const notFoundTitle = templates.translator.t('not_found.title');
  writeOutput(
    outDir,
    NOT_FOUND_FILE,
    templates.render('404.njk', {
      site,
      nav,
      page: { title: notFoundTitle, description: '', content: '' },
    }),
  );
  pages.push({ url: NOT_FOUND_URL, file: NOT_FOUND_FILE, type: 'not-found', title: notFoundTitle });

  pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestPosts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  /** @type {Manifest} */
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: { name: 'coffer', version },
    site: { id: site.id, baseUrl: site.baseUrl, lang: site.lang, timezone: site.timezone },
    now: now.toISOString(),
    drafts,
    pages,
    posts: manifestPosts,
    feeds: [],
    images: [],
  };
  writeFileSync(join(outDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  return { id: site.id, outDir, manifest, warnings };
}

/**
 * Builds the sites of a configuration. Each site is written to
 * `{out}/{siteId}`, replacing what an earlier build left there:
 *
 * - every published post at `{blogPrefix}/{slug}/index.html`;
 * - the blog index at `{blogPrefix}/index.html`, newest post first;
 * - the home page at `index.html`, from `{contentDir}/home.md` (not written
 *   when a blog has an empty prefix: its index is the front page);
 * - `404.html`, the page hosts show for an unknown address;
 * - the assets of the default theme, then of the site's theme, in `assets/`;
 * - the build manifest `.coffer-manifest.json`.
 *
 * Drafts and posts dated after `now` are left out unless `drafts` is set.
 *
 * @param {CofferConfig} config
 * @param {BuildOptions} [options]
 * @returns {Promise<SiteResult[]>}
 * @throws {BuildError} For an unknown site id or an invalid `--now`.
 * @throws {import('./content/posts.js').PostError} When posts are invalid.
 * @throws {import('./content/home.js').HomeError} When the home page file is invalid.
 * @throws {import('./markdown/render.js').MarkdownError} When a post's Markdown is invalid.
 */
export async function buildSites(config, options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const outOption = options.out ?? DEFAULT_OUT_DIR;
  const outRoot = isAbsolute(outOption) ? outOption : resolve(cwd, outOption);

  let sites = config.sites;
  if (options.siteIds !== undefined) {
    const wanted = options.siteIds;
    for (const id of wanted) {
      if (!config.sites.some((site) => site.id === id)) {
        throw new BuildError(
          `unknown site "${id}" (configured: ${config.sites.map((site) => site.id).join(', ')})`,
        );
      }
    }
    sites = config.sites.filter((site) => wanted.includes(site.id));
  }

  const version = readVersion();

  /** @type {SiteResult[]} */
  const results = [];
  for (const site of sites) {
    results.push(await buildSite(config, site, options, outRoot, version));
  }
  return results;
}
