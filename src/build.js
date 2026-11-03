import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LATEST_POSTS, loadHome } from './content/home.js';
import { discoverPosts, isPublished, resolveNow } from './content/posts.js';
import {
  FEED_FILE_NAME,
  absoluteUrl,
  createFeedEntry,
  excerptOf,
  feedUrlFor,
  renderFeed,
  selectEntries,
} from './feeds.js';
import {
  buildTagTree,
  loadTagMeta,
  tagName,
  tagPaths,
  tagUrl,
  unusedTagWarnings,
} from './content/tags.js';
import {
  buildSeries,
  duplicatePositionWarnings,
  loadSeriesMeta,
  seriesUrl,
  unusedSeriesWarnings,
} from './content/series.js';
import { buildMeta } from './meta.js';
import { renderMarkdown } from './markdown/render.js';
import {
  REDIRECTS_FILE_NAME,
  checkRedirects,
  collectRedirects,
  renderRedirectPage,
  renderRedirectsFile,
} from './redirects.js';
import { createTemplates } from './render/templates.js';
import { ROBOTS_FILE_NAME, SITEMAP_FILE_NAME, renderRobots, renderSitemap } from './sitemap.js';
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
 * @property {'home' | 'not-found' | 'blog-index' | 'post' | 'tag-index' | 'tag' | 'series'} type
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
 * @property {{ slug: string, number: number, count: number } | null} series The series the post belongs to, with its place in it ("part number of count"), or null.
 */

/**
 * One tag page listed in the manifest.
 *
 * @typedef {object} ManifestTag
 * @property {string} blog Id of the blog.
 * @property {string} path Tag path such as `workshop/boxes`.
 * @property {string} url Site-relative URL of the tag page, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {string} name Name shown for the tag.
 * @property {number} count Number of distinct posts in the tag's subtree.
 * @property {string[]} posts Site-relative URLs of those posts, newest first.
 */

/**
 * One series page listed in the manifest.
 *
 * @typedef {object} ManifestSeries
 * @property {string} blog Id of the blog.
 * @property {string} slug Series slug.
 * @property {string} url Site-relative URL of the series page, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {string} name Name shown for the series.
 * @property {number} count Number of parts.
 * @property {string[]} posts Site-relative URLs of the parts, in reading order.
 */

/**
 * One Atom feed listed in the manifest.
 *
 * @typedef {object} ManifestFeed
 * @property {'blog' | 'tag' | 'series'} type What the feed lists.
 * @property {string} blog Id of the blog.
 * @property {string} url Site-relative URL of the feed.
 * @property {string} selfUrl Absolute URL of the feed, as its self link says.
 * @property {string} file Path of the feed file, relative to the site's output directory.
 * @property {string} page Site-relative URL of the page the feed belongs to.
 * @property {string} title
 * @property {number} entries Number of entries in the feed.
 * @property {string | null} tag Tag path of a tag feed.
 * @property {string | null} series Series slug of a series feed.
 */

/**
 * The build manifest of one site. `images` is filled by a later feature;
 * checks read this file instead of guessing what the build wrote.
 *
 * @typedef {object} Manifest
 * @property {number} manifestVersion
 * @property {{ name: string, version: string }} generator
 * @property {{ id: string, baseUrl: string, lang: string, timezone: string }} site
 * @property {string} now ISO 8601 moment used to decide which posts are published.
 * @property {boolean} drafts True for a preview build.
 * @property {ManifestPage[]} pages
 * @property {ManifestPost[]} posts
 * @property {ManifestTag[]} tags Every tag page, with the posts it lists.
 * @property {ManifestSeries[]} series Every series page, with its parts in order.
 * @property {ManifestRedirect[]} redirects Permanent redirects from old post addresses.
 * @property {ManifestFeed[]} feeds Every Atom feed, with the page it belongs to.
 * @property {string[]} sitemap Site-relative URLs listed in `sitemap.xml`, sorted.
 * @property {unknown[]} images
 */

/**
 * One redirect listed in the manifest.
 *
 * @typedef {object} ManifestRedirect
 * @property {string} from Site-relative URL of the old address, ending in a slash.
 * @property {string} to Site-relative URL of the live page, ending in a slash.
 * @property {number} status
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
 * The place of a post in its series, as templates see it.
 *
 * @typedef {object} SeriesView
 * @property {string} slug
 * @property {string} name
 * @property {string} url Address of the series page.
 * @property {number} number The "n" of "part n of m".
 * @property {number} count The "m" of "part n of m".
 * @property {{ title: string, url: string } | null} previous
 * @property {{ title: string, url: string } | null} next
 */

/**
 * The part of a post that templates see.
 *
 * @param {Post} post
 * @param {string} url
 * @param {number} readingMinutes
 * @param {boolean} unpublished True when the post is only built because of preview mode.
 * @param {{ path: string, name: string, url: string }[]} [tagLinks] The post's tags with their names and page addresses.
 * @param {SeriesView | null} [series] The post's place in its series.
 */
function postView(post, url, readingMinutes, unpublished, tagLinks = [], series = null) {
  return {
    slug: post.slug,
    url,
    title: post.title,
    date: post.date,
    tags: post.tags,
    tagLinks,
    summary: post.summary,
    draft: post.draft,
    unpublished,
    readingMinutes,
    series,
  };
}

/**
 * A feed as templates see it: the address and a text for people and readers.
 *
 * @typedef {object} FeedLink
 * @property {string} url Site-relative address of the feed.
 * @property {string} title
 */

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

  const t = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params) =>
    templates.translator.t(key, params);
  /** @type {Map<string, FeedLink>} */
  const blogFeeds = new Map(
    site.blogs.map((blog) => [
      blog.id,
      { url: feedUrlFor(blogUrl(blog)), title: t('feeds.blog', { title: blog.title }) },
    ]),
  );
  /**
   * The feeds a page advertises in its head: those of its own blog first, then
   * the ones that belong to the page itself, then those of the other blogs.
   *
   * @param {BlogConfig | null} blog
   * @param {FeedLink[]} [specific]
   * @returns {FeedLink[]}
   */
  const feedLinksFor = (blog, specific = []) => {
    const own = blog ? (blogFeeds.get(blog.id) ?? null) : null;
    const others = [...blogFeeds].filter(([id]) => id !== blog?.id).map(([, link]) => link);
    return [...(own ? [own] : []), ...specific, ...others];
  };

  /**
   * The `meta` object of a page (see `meta.js`).
   *
   * @param {import('./meta.js').MetaPage} page
   */
  const metaFor = (page) => buildMeta(site, page);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyAssets(site, outDir);
  if (site.defaultImage.startsWith('/') && !existsSync(join(outDir, ...site.defaultImage.split('/').filter(Boolean)))) {
    warnings.push(
      `defaultImage: "${site.defaultImage}" is not in the output; put the file in the "assets" folder of the theme`,
    );
  }

  /** @type {ManifestPage[]} */
  const pages = [];
  /** @type {ManifestPost[]} */
  const manifestPosts = [];
  /** @type {ManifestTag[]} */
  const manifestTags = [];
  /** @type {ManifestSeries[]} */
  const manifestSeries = [];
  /** @type {ManifestFeed[]} */
  const manifestFeeds = [];
  /** @type {{ url: string, aliasUrls: string[], source: string }[]} */
  const aliasing = [];
  /**
   * The posts of the first blog, newest first, for the home page.
   * @type {ReturnType<typeof postView>[]}
   */
  let firstBlogPosts = [];

  for (const blog of site.blogs) {
    const found = discoverPosts(blog.dir, { timezone: site.timezone });
    const selected = found.filter((post) => isPublished(post, { now, drafts }));

    const blogBase = blogUrl(blog);
    const clash = selected.find((post) => post.slug === site.urls.tags);
    if (clash) {
      throw new BuildError(
        `${clash.file}: slug: "${clash.slug}" is the address of the tag pages of the blog "${blog.id}" (${tagUrl(blogBase, site.urls.tags)}); rename the post or change "urls.tags"`,
      );
    }
    if (selected.some((post) => post.slug === FEED_FILE_NAME)) {
      throw new BuildError(
        `a post with the slug "${FEED_FILE_NAME}" in the blog "${blog.id}" would collide with the blog's feed (${feedUrlFor(blogBase)}); rename the post`,
      );
    }
    const tagMeta = loadTagMeta(blog.dir);
    const tagTree = buildTagTree(selected);
    const clashingTag = tagTree.all.find((node) => node.path.includes('/') && node.path.split('/').pop() === FEED_FILE_NAME);
    if (clashingTag) {
      throw new BuildError(
        `the tag "${clashingTag.path}" of the blog "${blog.id}" would collide with the feed of its parent; rename the tag`,
      );
    }
    if (tagMeta.file !== null) {
      const shown = posix(relative(config.dir, tagMeta.file));
      for (const warning of [
        ...tagMeta.warnings,
        ...unusedTagWarnings(tagMeta.file, tagMeta.meta, tagTree),
      ]) {
        warnings.push(warning.replace(tagMeta.file, shown));
      }
    }
    /** @param {string} path */
    const nameOf = (path) => tagName(path, tagMeta.meta);
    /** @param {string} path */
    const urlOf = (path) => tagUrl(blogBase, site.urls.tags, path);

    const seriesMeta = loadSeriesMeta(blog.dir);
    const seriesList = buildSeries(selected, seriesMeta.meta);
    if (seriesMeta.file !== null) {
      const shown = posix(relative(config.dir, seriesMeta.file));
      for (const warning of [
        ...seriesMeta.warnings,
        ...unusedSeriesWarnings(seriesMeta.file, seriesMeta.meta, seriesList),
      ]) {
        warnings.push(warning.replace(seriesMeta.file, shown));
      }
    }
    warnings.push(
      ...duplicatePositionWarnings(seriesList, (file) => posix(relative(config.dir, file))),
    );
    /** @param {string} slug */
    const seriesPageUrl = (slug) => seriesUrl(blogBase, site.urls.series, slug);
    /** @param {string} slug */
    const seriesNameOf = (slug) => seriesList.find((entry) => entry.slug === slug)?.name ?? slug;
    /** @type {Map<Post, SeriesView>} */
    const seriesOf = new Map();
    for (const entry of seriesList) {
      for (const part of entry.parts) {
        seriesOf.set(part.post, {
          slug: entry.slug,
          name: entry.name,
          url: seriesPageUrl(entry.slug),
          number: part.number,
          count: entry.count,
          previous: part.previous
            ? { title: part.previous.title, url: postUrl(blog, part.previous.slug) }
            : null,
          next: part.next ? { title: part.next.title, url: postUrl(blog, part.next.slug) } : null,
        });
      }
    }

    /** @type {{ post: Post, url: string, readingMinutes: number, unpublished: boolean }[]} */
    const entries = [];
    /**
     * The feed entries of the published posts. A draft, or a post dated after
     * `now` that is only built for a preview, never gets one.
     * @type {Map<Post, import('./feeds.js').FeedEntry>}
     */
    const feedEntries = new Map();
    /** @param {string} path */
    const tagFeedLink = (path) => ({
      url: feedUrlFor(urlOf(path)),
      title: t('feeds.tag', { tag: nameOf(path) }),
    });
    /** @param {string} slug */
    const seriesFeedLink = (slug) => ({
      url: feedUrlFor(seriesPageUrl(slug)),
      title: t('feeds.series', { title: seriesNameOf(slug) }),
    });
    const tagsIndexUrl = tagUrl(blogBase, site.urls.tags);
    for (const post of selected) {
      const rendered = await renderMarkdown(post.body, {
        file: post.file,
        startLine: post.bodyLine,
      });
      const url = postUrl(blog, post.slug);
      const unpublished = !isPublished(post, { now });
      entries.push({ post, url, readingMinutes: rendered.readingMinutes, unpublished });
      if (!unpublished) {
        feedEntries.set(
          post,
          createFeedEntry({
            baseUrl: site.baseUrl,
            url,
            title: post.title,
            date: post.date,
            summary: post.summary,
            html: rendered.html,
            tags: post.tags.map((path) => ({ path, name: nameOf(path) })),
            tagsIndexUrl,
          }),
        );
      }
      if (!unpublished && post.aliases.length > 0) {
        aliasing.push({
          url,
          aliasUrls: post.aliases.map((alias) => postUrl(blog, alias)),
          source: posix(relative(config.dir, post.file)),
        });
      }

      const view = postView(
        post,
        url,
        rendered.readingMinutes,
        unpublished,
        post.tags.map((path) => ({ path, name: nameOf(path), url: urlOf(path) })),
        seriesOf.get(post) ?? null,
      );
      const html = templates.render('post.njk', {
        site,
        nav,
        blog,
        feedLinks: feedLinksFor(blog, [
          ...post.tags.map(tagFeedLink),
          ...(view.series ? [seriesFeedLink(view.series.slug)] : []),
        ]),
        meta: metaFor({
          title: post.title,
          description: post.summary || excerptOf(rendered.html),
          url,
          type: 'article',
          published: post.date,
          tags: view.tagLinks.map((tag) => tag.name),
        }),
        post: view,
        series: view.series,
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
        series: view.series
          ? { slug: view.series.slug, number: view.series.number, count: view.series.count }
          : null,
      });
    }

    const views = entries.map(({ post, url, readingMinutes, unpublished }) =>
      postView(post, url, readingMinutes, unpublished),
    );
    if (blog === site.blogs[0]) firstBlogPosts = views;

    const indexUrl = blogBase;
    const blogFeedLink = /** @type {FeedLink} */ (blogFeeds.get(blog.id));
    const indexHtml = templates.render('blog-index.njk', {
      site,
      nav,
      blog,
      feedLinks: feedLinksFor(blog),
      meta: metaFor({ title: blog.title, description: site.description, url: indexUrl }),
      pageFeed: blogFeedLink,
      posts: views,
      tagsUrl: tagUrl(blogBase, site.urls.tags),
      page: { title: blog.title, description: site.description, content: '' },
    });
    const indexFile = fileForUrl(indexUrl);
    writeOutput(outDir, indexFile, indexHtml);
    pages.push({ url: indexUrl, file: indexFile, type: 'blog-index', title: blog.title });

    // The posts of a tag page are the same objects as on the blog index, found
    // by their address.
    const viewByUrl = new Map(views.map((view) => [view.url, view]));
    const tagsTitle = templates.translator.t('tags.title');

    /**
     * @typedef {object} TagView
     * @property {string} path
     * @property {string} name
     * @property {string} description
     * @property {string} url
     * @property {number} count
     * @property {TagView[]} children
     */

    /**
     * @param {import('./content/tags.js').TagNode} node
     * @returns {TagView}
     */
    const treeView = (node) => ({
      path: node.path,
      name: nameOf(node.path),
      description: tagMeta.meta.get(node.path)?.description ?? '',
      url: urlOf(node.path),
      count: node.count,
      children: node.children.map(treeView),
    });

    const tagsIndexHtml = templates.render('tag-index.njk', {
      site,
      nav,
      blog,
      feedLinks: feedLinksFor(blog),
      meta: metaFor({ title: tagsTitle, description: site.description, url: tagsIndexUrl }),
      tagsUrl: tagsIndexUrl,
      tree: tagTree.roots.map(treeView),
      page: { title: tagsTitle, description: '', content: '' },
    });
    const tagsIndexFile = fileForUrl(tagsIndexUrl);
    writeOutput(outDir, tagsIndexFile, tagsIndexHtml);
    pages.push({ url: tagsIndexUrl, file: tagsIndexFile, type: 'tag-index', title: tagsTitle });

    for (const node of tagTree.all) {
      const view = treeView(node);
      const tagPostUrls = node.posts.map((post) => postUrl(blog, post.slug));
      const tagFeed = tagFeedLink(node.path);
      const html = templates.render('tag.njk', {
        site,
        nav,
        blog,
        feedLinks: feedLinksFor(blog, [tagFeed]),
        meta: metaFor({ title: view.name, description: view.description, url: view.url }),
        pageFeed: tagFeed,
        tagsUrl: tagsIndexUrl,
        tag: view,
        ancestors: tagPaths(node.path)
          .slice(0, -1)
          .map((path) => ({ path, name: nameOf(path), url: urlOf(path) })),
        children: view.children,
        posts: tagPostUrls.flatMap((address) => viewByUrl.get(address) ?? []),
        page: { title: view.name, description: view.description, content: '' },
      });
      const file = fileForUrl(view.url);
      writeOutput(outDir, file, html);
      pages.push({ url: view.url, file, type: 'tag', title: view.name });
      manifestTags.push({
        blog: blog.id,
        path: node.path,
        url: view.url,
        file,
        name: view.name,
        count: node.count,
        posts: tagPostUrls,
      });
    }

    for (const entry of seriesList) {
      const url = seriesPageUrl(entry.slug);
      const parts = entry.parts.flatMap((part) => {
        const view = viewByUrl.get(postUrl(blog, part.post.slug));
        return view ? [{ ...view, part: part.number }] : [];
      });
      const seriesFeed = seriesFeedLink(entry.slug);
      const html = templates.render('series.njk', {
        site,
        nav,
        blog,
        feedLinks: feedLinksFor(blog, [seriesFeed]),
        meta: metaFor({ title: entry.name, description: entry.description ?? '', url }),
        pageFeed: seriesFeed,
        posts: parts,
        series: {
          slug: entry.slug,
          name: entry.name,
          description: entry.description ?? '',
          url,
          count: entry.count,
        },
        page: { title: entry.name, description: entry.description ?? '', content: '' },
      });
      const file = fileForUrl(url);
      writeOutput(outDir, file, html);
      pages.push({ url, file, type: 'series', title: entry.name });
      manifestSeries.push({
        blog: blog.id,
        slug: entry.slug,
        url,
        file,
        name: entry.name,
        count: entry.count,
        posts: entry.parts.map((part) => postUrl(blog, part.post.slug)),
      });
    }

    // Feeds. They list published posts only, so a draft or a future-dated post
    // that a preview build renders never reaches them.
    const blogTitle =
      blog.title === site.title ? site.title : `${blog.title} | ${site.title}`;
    const subscribed = [...feedEntries.values()];
    /**
     * @param {object} feed
     * @param {'blog' | 'tag' | 'series'} feed.type
     * @param {string} feed.page Site-relative URL of the page the feed belongs to.
     * @param {string} feed.title
     * @param {string} feed.subtitle
     * @param {import('./feeds.js').FeedEntry[]} feed.entries
     * @param {number | null} feed.limit
     * @param {string | null} [feed.tag]
     * @param {string | null} [feed.series]
     */
    const writeFeed = ({ type, page, title, subtitle, entries: candidates, limit, tag = null, series = null }) => {
      const chosen = selectEntries(candidates, limit);
      const url = feedUrlFor(page);
      const selfUrl = absoluteUrl(site.baseUrl, url);
      writeOutput(
        outDir,
        url.slice(1),
        renderFeed({
          lang: site.lang,
          selfUrl,
          alternateUrl: absoluteUrl(site.baseUrl, page),
          title,
          subtitle,
          author: site.author,
          updated: chosen[0]?.updated ?? now,
          generator: { name: 'coffer', version },
          entries: chosen,
        }),
      );
      manifestFeeds.push({
        type,
        blog: blog.id,
        url,
        selfUrl,
        file: url.slice(1),
        page,
        title,
        entries: chosen.length,
        tag,
        series,
      });
    };
    writeFeed({
      type: 'blog',
      page: blogBase,
      title: blogTitle,
      subtitle: site.description,
      entries: subscribed,
      limit: site.feeds.limit,
    });
    for (const node of tagTree.all) {
      writeFeed({
        type: 'tag',
        page: urlOf(node.path),
        title: `${nameOf(node.path)} | ${blogTitle}`,
        subtitle: tagMeta.meta.get(node.path)?.description ?? '',
        entries: node.posts.flatMap((post) => feedEntries.get(post) ?? []),
        limit: site.feeds.limit,
        tag: node.path,
      });
    }
    for (const entry of seriesList) {
      writeFeed({
        type: 'series',
        page: seriesPageUrl(entry.slug),
        title: `${entry.name} | ${blogTitle}`,
        subtitle: entry.description ?? '',
        entries: entry.parts.flatMap((part) => feedEntries.get(part.post) ?? []),
        limit: null,
        series: entry.slug,
      });
    }
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
      feedLinks: feedLinksFor(null),
      meta: metaFor({ title, description: site.description, url: '/' }),
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
      feedLinks: feedLinksFor(null),
      meta: metaFor({ title: notFoundTitle, description: site.description, url: NOT_FOUND_URL }),
      page: { title: notFoundTitle, description: '', content: '' },
    }),
  );
  pages.push({ url: NOT_FOUND_URL, file: NOT_FOUND_FILE, type: 'not-found', title: notFoundTitle });

  const redirects = collectRedirects(aliasing);
  const problems = checkRedirects(
    redirects,
    new Set(pages.map((entry) => entry.url)),
    new Set(manifestPosts.map((entry) => entry.url)),
  );
  if (problems.length > 0) throw new BuildError(problems.join('\n'));
  const baseUrl = site.baseUrl.replace(/\/+$/, '');
  for (const redirect of redirects) {
    writeOutput(
      outDir,
      fileForUrl(redirect.from),
      renderRedirectPage({
        lang: site.lang,
        target: redirect.to,
        canonical: `${baseUrl}${redirect.to}`,
      }),
    );
  }
  const redirectRules = renderRedirectsFile(redirects);
  if (redirectRules !== '') writeOutput(outDir, REDIRECTS_FILE_NAME, redirectRules);

  // The sitemap lists the canonical pages a visitor can reach. The 404 page, the
  // redirect stubs and, in a preview build, posts that are not published yet
  // (and tag or series pages with nothing else on them) stay out.
  const publishedUrls = new Set(manifestPosts.filter((entry) => entry.published).map((entry) => entry.url));
  const hasPublished = (/** @type {string[]} */ urls) => urls.some((url) => publishedUrls.has(url));
  const hiddenUrls = new Set([
    NOT_FOUND_URL,
    ...manifestPosts.filter((entry) => !entry.published).map((entry) => entry.url),
    ...manifestTags.filter((entry) => !hasPublished(entry.posts)).map((entry) => entry.url),
    ...manifestSeries.filter((entry) => !hasPublished(entry.posts)).map((entry) => entry.url),
  ]);
  const postDates = new Map(manifestPosts.map((entry) => [entry.url, new Date(entry.date)]));
  const sitemapEntries = pages
    .filter((entry) => !hiddenUrls.has(entry.url))
    .map((entry) => ({ url: entry.url, lastModified: postDates.get(entry.url) ?? null }));
  writeOutput(outDir, SITEMAP_FILE_NAME, renderSitemap(site.baseUrl, sitemapEntries));
  writeOutput(outDir, ROBOTS_FILE_NAME, renderRobots(site.baseUrl));

  pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestPosts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestTags.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestSeries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestFeeds.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  /** @type {Manifest} */
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: { name: 'coffer', version },
    site: { id: site.id, baseUrl: site.baseUrl, lang: site.lang, timezone: site.timezone },
    now: now.toISOString(),
    drafts,
    pages,
    posts: manifestPosts,
    tags: manifestTags,
    series: manifestSeries,
    redirects: redirects.map(({ from, to, status }) => ({ from, to, status })),
    feeds: manifestFeeds,
    sitemap: sitemapEntries.map((entry) => entry.url).sort(),
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
 * - for every blog, the tag tree at `{blogPrefix}/{tags}/index.html` and a page
 *   per tag at `{blogPrefix}/{tags}/{path}/index.html`, listing the posts with
 *   the tag or any tag below it, newest first;
 * - for every `aliases` entry of a published post, a redirect page at the old
 *   address and a rule in `_redirects`;
 * - for every series, a page at `{blogPrefix}/{series}/{slug}/` listing its
 *   parts in order, and on every part a navigation block (series name, "part
 *   n of m", previous and next) at the top and at the end;
 * - for the blog, every tag and every series, a full-content Atom feed named
 *   `feed.xml` under the page's address, newest first (see `docs/feeds.md`);
 * - `sitemap.xml` (published canonical pages only) and `robots.txt` (see `docs/seo.md`),
 *   and `title`, description, canonical, Open Graph and Twitter card tags on every page;
 * - the assets of the default theme, then of the site's theme, in `assets/`;
 * - the build manifest `.coffer-manifest.json`.
 *
 * Drafts and posts dated after `now` are left out unless `drafts` is set.
 *
 * @param {CofferConfig} config
 * @param {BuildOptions} [options]
 * @returns {Promise<SiteResult[]>}
 * @throws {BuildError} For an unknown site id, an invalid `--now`, an alias that collides with a live address or a post whose slug is the address of the tag pages.
 * @throws {import('./content/posts.js').PostError} When posts are invalid.
 * @throws {import('./content/home.js').HomeError} When the home page file is invalid.
 * @throws {import('./content/tags.js').TagsError} When a blog's `tags.yaml` is invalid.
 * @throws {import('./content/series.js').SeriesError} When a blog's `series.yaml` is invalid.
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
