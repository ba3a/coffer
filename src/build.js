import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARDS_CACHE_DIR, createCardMaker } from './cards.js';
import { DEFAULT_LATEST_POSTS, loadHome } from './content/home.js';
import { discoverPosts, isPublished, resolveNow } from './content/posts.js';
import { getProjectKind } from './content/project-kinds.js';
import { loadProjects, projectUrl, showcaseOf } from './content/projects.js';
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
import { loadTracks } from './geo/gpx.js';
import { MAP_SCRIPTS, MAP_STYLES } from './geo/map.js';
import { renderPostMaps, withoutMapPlaceholders } from './geo/post-maps.js';
import { applyLinkRewrites, checkSourceLinks } from './check/source-links.js';
import { IMAGE_EXTENSIONS } from './images/defaults.js';
import { IMAGES_CACHE_DIR, ImageError, createImagePipeline, imageFileUrl, pickVariant } from './images/pipeline.js';
import { PolicyError, createPolicyResolver, findImageOverride } from './images/policy.js';
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
import { REPORT_DIR_NAME, REPORT_FILE_NAME, Report, ReportError, writeReport } from './report.js';
import { ROBOTS_FILE_NAME, SITEMAP_FILE_NAME, renderRobots, renderSitemap } from './sitemap.js';
import { readVersion } from './version.js';
import { VIEWER_SCRIPTS, VIEWER_STYLES, viewerJson } from './viewer.js';

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
 * @property {string} [cacheDir] Directory for work that is worth keeping between builds, such as title cards (default `.cache` beside the configuration file; an absolute path, or relative to the working directory).
 * @property {string} [reportDir] Directory that receives `report.json`, the errors, warnings and notes of the build (default `.coffer` beside the configuration file; an absolute path, or relative to the working directory). It is never inside the output.
 */

/**
 * One page written by the build, as listed in the manifest.
 *
 * @typedef {object} ManifestPage
 * @property {string} url Site-relative URL, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {'home' | 'not-found' | 'blog-index' | 'post' | 'tag-index' | 'tag' | 'series' | 'project-index' | 'project'} type
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
 * @property {ManifestTrack[]} tracks The GPX tracks published with the post, in the order they are shown; empty when it has none.
 * @property {import('./geo/post-maps.js').ManifestMap[]} maps The maps of the post in the order they appear; empty when the post has none.
 */

/**
 * One GPX track published with a post, as listed in the manifest. The GPX file
 * is published unchanged, so it carries the exact positions of the track.
 *
 * @typedef {object} ManifestTrack
 * @property {string} title Title given in front matter, else the name inside the file, else the file name.
 * @property {string} source Path of the GPX file, relative to the configuration file.
 * @property {string} gpx Site-relative address of the published GPX file, for download.
 * @property {string} geojson Site-relative address of the simplified geometry as GeoJSON, for the map.
 * @property {number} distanceMeters Length along the recorded points, rounded to a metre.
 * @property {number | null} elevationGainMeters Total climb with small ups and downs smoothed away, rounded to a metre; null when the file has no elevations.
 * @property {{ elevationMeters: number, latitude: number, longitude: number } | null} highest The highest point (elevation rounded to a metre), or null when the file has no elevations.
 * @property {number} points Number of recorded points.
 * @property {number} simplifiedPoints Number of points of the simplified geometry.
 * @property {[number, number, number, number]} bounds West, south, east and north in degrees.
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
 * One file made from an image.
 *
 * @typedef {object} ManifestImageOutput
 * @property {'variant' | 'viewer'} role A WebP variant for `srcset`, or the full-size JPEG for the viewer.
 * @property {string} url Site-relative address.
 * @property {string} file Path of the file, relative to the site's output directory.
 * @property {string} type Media type.
 * @property {number} width
 * @property {number} height
 */

/**
 * One image used by a page, as listed in the manifest. The original is never
 * published; `outputs` are the files made from it.
 *
 * @typedef {object} ManifestImage
 * @property {string} source Path of the original, relative to the configuration file.
 * @property {string} post Site-relative URL of the page that uses the image (`/` for the home page).
 * @property {'body' | 'cover' | 'card'} use A Markdown image in the text, the cover of the post, or the card picture of a project.
 * @property {string} sha256 Hash of the original.
 * @property {number} width Upright width of the original.
 * @property {number} height Upright height of the original.
 * @property {ManifestImagePolicy} policy The metadata policy the image was published under, and where each setting came from.
 * @property {import('./images/metadata.js').PublishedPosition | null} gps The position the viewer JPEG carries, which is what a map may show: the exact one (`precision: "exact"`), a rounded one (`"coarse"`) or none. It is never more precise than the policy allows, and no other file carries a position.
 * @property {import('./images/metadata.js').CameraFields | null} camera The camera fields the viewer JPEG carries, or null.
 * @property {ManifestImageOutput[]} outputs The variants, narrowest first, then the viewer image.
 */

/**
 * The effective metadata policy of an image, one decision per setting.
 *
 * @typedef {object} ManifestImagePolicy
 * @property {import('./images/policy.js').PolicyDecision<'strip' | 'coarse' | 'keep'>} location
 * @property {import('./images/policy.js').PolicyDecision<'strip' | 'keep'>} camera
 */

/**
 * The build manifest of one site. Checks read this file instead of guessing
 * what the build wrote.
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
 * @property {ManifestProject[]} projects Every project, in showcase order; empty when the site has no projects.
 * @property {ManifestRedirect[]} redirects Permanent redirects from old post addresses.
 * @property {ManifestFeed[]} feeds Every Atom feed, with the page it belongs to.
 * @property {string[]} sitemap Site-relative URLs listed in `sitemap.xml`, sorted.
 * @property {ManifestImage[]} images Every image used by a page, with the files made from it; sorted by page, then original.
 */

/**
 * One project listed in the manifest.
 *
 * @typedef {object} ManifestProject
 * @property {string} slug
 * @property {string} url Site-relative URL of the project's page, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {string} source Path of `project.yaml`, relative to the configuration file.
 * @property {string} name
 * @property {string} pitch
 * @property {string} kind
 * @property {string} status
 * @property {boolean} featured
 * @property {number | null} order
 * @property {string | null} tag The devlog tag that marks posts about the project.
 * @property {string} card Path of the card picture, relative to the configuration file.
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
 * @property {{ generated: number, reused: number }} cards Title cards drawn by this build, and cards found in the cache.
 * @property {{ generated: number, reused: number }} images Images processed by this build, and images found in the cache.
 * @property {import('./report.js').ExactLocation[]} exactLocations The posts (and other pages) whose published images carry exact positions, by file.
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
 * A post as rendered from Markdown.
 *
 * @typedef {Awaited<ReturnType<typeof renderMarkdown>>} RenderedPost
 */

/**
 * Whether a host that serves the output directory the way Cloudflare Pages
 * does would answer a site path with a page or a file: `/a/b/` with
 * `a/b/index.html`, and `/a/b` with `a/b`, `a/b.html` or `a/b/index.html`.
 *
 * @param {string} outDir
 * @param {string} path Normalized site path starting with `/`.
 * @returns {boolean}
 */
function outputServes(outDir, path) {
  const base = join(outDir, ...path.split('/').filter(Boolean));
  /** @param {string} file */
  const isFile = (file) => existsSync(file) && statSync(file).isFile();
  if (path.endsWith('/')) return isFile(join(base, 'index.html'));
  return isFile(base) || isFile(`${base}.html`) || isFile(join(base, 'index.html'));
}

/**
 * @param {string} outDir
 * @param {string} file Path relative to `outDir`, with forward slashes.
 * @param {string | Uint8Array} content
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
 * @param {Report} report Receives the errors found in the sources.
 * @returns {Promise<SiteResult>}
 */
async function buildSite(config, site, options, outRoot, version, report) {
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

  const projectsIndexUrl = site.projects ? `/${site.urls.projects}/` : null;
  const nav = [
    { key: 'nav.home', url: '/' },
    ...(projectsIndexUrl ? [{ key: 'nav.projects', url: projectsIndexUrl }] : []),
    ...site.blogs.map((blog) => ({ label: blog.title, url: blogUrl(blog) })),
  ];

  const t = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params = {}) =>
    templates.translator.t(key, params);
  /** The words of carousels, in the language of the site. */
  const carouselLabels = {
    label: templates.translator.t('carousel.label'),
    previous: templates.translator.t('carousel.previous'),
    next: templates.translator.t('carousel.next'),
  };
  /** The words of the image viewer, in the language of the site. */
  const viewerLabels = {
    close: templates.translator.t('viewer.close'),
    zoom: templates.translator.t('viewer.zoom'),
    previous: templates.translator.t('viewer.previous'),
    next: templates.translator.t('viewer.next'),
    error: templates.translator.t('viewer.error'),
    showOnMap: templates.translator.t('viewer.show_on_map'),
  };
  /**
   * What a page needs besides its HTML, as template variables: the carousel
   * script when the page has a carousel and, when it has images the viewer can
   * open, the viewer (PhotoSwipe, its styles, the engine's script and styles)
   * and the list of those images as JSON for it. Pages without such images load
   * nothing of it.
   *
   * @param {{ carousels: number, viewerImages: import('./markdown/render.js').ViewerImage[] } | null} rendered
   * @param {boolean} [withMap] Whether the page has a map, which needs Leaflet and the engine's map script (after the viewer's, so that a marker finds the viewer ready).
   * @returns {{ scripts: string[], styles: string[], viewerData: string }}
   */
  const pageAssetsFor = (rendered, withMap = false) => {
    const scripts = rendered && rendered.carousels > 0 ? ['/assets/carousel.js'] : [];
    const styles = [];
    let viewerData = '';
    if (rendered && rendered.viewerImages.length > 0) {
      styles.push(...VIEWER_STYLES);
      scripts.push(...VIEWER_SCRIPTS);
      viewerData = viewerJson({ labels: viewerLabels, images: rendered.viewerImages });
    }
    if (withMap) {
      styles.push(...MAP_STYLES);
      scripts.push(...MAP_SCRIPTS);
    }
    return { scripts, styles, viewerData };
  };
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

  // Pages that have no picture of their own are shown in link previews with a
  // card that carries the site title and the page title.
  const cacheRoot = resolve(options.cacheDir ?? join(config.dir, '.cache'));
  const cards = createCardMaker({
    themeDir: site.theme,
    cacheDir: join(cacheRoot, CARDS_CACHE_DIR),
    siteTitle: site.title,
  });
  /** @param {string} title */
  const cardFor = (title) => cards.makeAndPublish(title, outDir);

  // Every image a page uses is resized once, kept in the cache by the hash of the
  // original and the options, and published as WebP variants plus a full-size
  // JPEG. The original itself never reaches the output.
  const images = createImagePipeline({
    cacheDir: join(cacheRoot, IMAGES_CACHE_DIR),
    widths: site.images.widths,
    viewerMaxEdge: site.images.viewerMaxEdge,
    webpQuality: site.images.webpQuality,
    jpegQuality: site.images.jpegQuality,
  });
  /** @type {ManifestImage[]} */
  const manifestImages = [];
  /** @type {Set<string>} */
  const recordedImages = new Set();

  /**
   * What decides the metadata policy of the images of one page source: a post,
   * or the home page. Created by `pageImagesOf`.
   *
   * @typedef {object} PageImages
   * @property {string} shown Path of the source file, relative to the configuration file.
   * @property {(reference: string) => import('./images/policy.js').ImagePolicy} policyFor The metadata policy of an image, given as the page refers to it (a Markdown address, or the cover).
   * @property {ReadonlyMap<string, import('./images/policy.js').ImageOverride>} overrides The page's `images:` map.
   * @property {Set<string>} used Keys of `overrides` that matched an image.
   * @property {Set<string>} exact Originals of the page whose published file carries the exact position.
   * @property {number} tracks Number of GPX files the page publishes; each carries the exact positions of its track.
   */

  /**
   * The stand-in for a policy that cannot be resolved because of a mistake that
   * has been reported: nothing is published.
   *
   * @type {import('./images/policy.js').ImagePolicy}
   */
  const strictestPolicy = {
    location: { value: 'strip', source: { level: 'site', origin: null } },
    camera: { value: 'strip', source: { level: 'site', origin: null } },
  };

  /**
   * Adds the errors of a policy problem to the report. Each message starts with
   * the file and names the setting.
   *
   * @param {PolicyError} error
   */
  const reportPolicyError = (error) => {
    for (const message of error.errors) report.addError({ site: site.id, message });
  };

  /**
   * Creates the function that resolves the metadata policy of the images of a
   * blog, from the site settings and the blog's `tags.yaml`. A wrong value is
   * reported once; the images of the blog are then published without any
   * metadata so that the other problems of the build are still found.
   *
   * @param {ReadonlyMap<string, import('./content/tags.js').TagMeta>} tags
   * @param {string | null} tagsFile Absolute path of `tags.yaml`, or null when the blog has none.
   * @returns {((post: import('./images/policy.js').PolicyPost, image?: string) => import('./images/policy.js').ImagePolicy) | null} Null when the settings are wrong.
   */
  const createResolver = (tags, tagsFile) => {
    try {
      return createPolicyResolver({
        site: site.location,
        tags,
        tagsFile: tagsFile === null ? 'tags.yaml' : posix(relative(config.dir, tagsFile)),
      });
    } catch (error) {
      if (!(error instanceof PolicyError)) throw error;
      reportPolicyError(error);
      return null;
    }
  };

  /**
   * Prepares the policy of the images of one page source.
   *
   * @param {string} sourceFile Absolute path of the Markdown file.
   * @param {Post | null} post The post, or null for a page that has no front matter for the policy (the home page).
   * @param {ReturnType<typeof createResolver>} resolver
   * @returns {PageImages}
   */
  const pageImagesOf = (sourceFile, post, resolver) => {
    const shown = posix(relative(config.dir, sourceFile));
    /** @type {import('./images/policy.js').PolicyPost} */
    const policyPost = {
      file: shown,
      tags: post?.tags ?? [],
      location: post?.location ?? null,
      camera: post?.camera ?? null,
      images: post?.images ?? new Map(),
    };
    let usable = resolver !== null;
    if (resolver !== null) {
      // Everything the post says about the policy is checked now, whether or
      // not an image uses it, so that a typo in the front matter fails the build.
      try {
        resolver(policyPost);
      } catch (error) {
        if (!(error instanceof PolicyError)) throw error;
        reportPolicyError(error);
        usable = false;
      }
    }
    /** @type {Set<string>} */
    const used = new Set();
    return {
      shown,
      overrides: policyPost.images,
      used,
      exact: new Set(),
      tracks: 0,
      policyFor: (reference) => {
        const found = findImageOverride(policyPost.images, reference);
        if (found !== null) used.add(found.key);
        return usable && resolver !== null ? resolver(policyPost, reference) : strictestPolicy;
      },
    };
  };

  /**
   * The page sources of the site, by absolute path of the Markdown file.
   *
   * @type {Map<string, PageImages>}
   */
  const pageImages = new Map();

  /**
   * Warns about entries of a page's `images:` map that no image of the page uses.
   *
   * @param {PageImages} page
   */
  const warnUnusedImageEntries = (page) => {
    for (const key of page.overrides.keys()) {
      if (!page.used.has(key)) {
        warnings.push(`${page.shown}: images: "${key}" matches no image of the post`);
      }
    }
  };

  /**
   * The path in an image address, without a query or a fragment.
   *
   * @param {string} address
   * @returns {string}
   */
  const addressPath = (address) => {
    const cut = address.search(/[?#]/);
    return cut < 0 ? address : address.slice(0, cut);
  };

  /**
   * Publishes a processed image and lists it in the manifest.
   *
   * @param {import('./images/pipeline.js').ProcessedImage} processed
   * @param {string} pageUrl Site-relative URL of the page that uses the image.
   * @param {'body' | 'cover' | 'card'} use
   * @param {PageImages} page The page source that uses the image.
   * @param {import('./images/policy.js').ImagePolicy} policy The decision the image was processed under.
   * @returns {import('./images/pipeline.js').ImageFile} The variant that stands in for the picture where no `srcset` is understood.
   */
  const publishImage = (processed, pageUrl, use, page, policy) => {
    images.publish(processed, outDir);
    if (processed.gps?.precision === 'exact') page.exact.add(processed.source);
    const id = `${processed.source}\n${pageUrl}\n${use}\n${processed.key}`;
    if (!recordedImages.has(id)) {
      recordedImages.add(id);
      /**
       * @param {import('./images/pipeline.js').ImageFile} entry
       * @param {'variant' | 'viewer'} role
       * @param {string} type
       * @returns {ManifestImageOutput}
       */
      const output = (entry, role, type) => {
        const url = imageFileUrl(processed, entry);
        return { role, url, file: url.slice(1), type, width: entry.width, height: entry.height };
      };
      manifestImages.push({
        source: posix(relative(config.dir, processed.source)),
        post: pageUrl,
        use,
        sha256: processed.sha256,
        width: processed.width,
        height: processed.height,
        policy: { location: policy.location, camera: policy.camera },
        gps: processed.gps,
        camera: processed.camera,
        outputs: [
          ...processed.variants.map((entry) => output(entry, 'variant', 'image/webp')),
          output(processed.viewer, 'viewer', 'image/jpeg'),
        ],
      });
    }
    return pickVariant(processed.variants);
  };

  /**
   * The file an image address names, when it is a file inside the content
   * directory. Remote addresses and addresses that start with "/" are not
   * source files; a name that matches nothing is for the link check to report.
   *
   * @param {string} sourceFile Markdown file that holds the address.
   * @param {string} address
   * @returns {string | null}
   */
  const localImageFile = (sourceFile, address) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(address) || address.startsWith('/')) return null;
    const raw = addressPath(address);
    let path = raw;
    try {
      path = decodeURIComponent(raw);
    } catch {
      // Keep the address as written.
    }
    if (path === '') return null;
    const target = resolve(dirname(sourceFile), path);
    const inside = relative(site.contentDir, target);
    if (inside.startsWith('..') || isAbsolute(inside)) return null;
    return existsSync(target) && statSync(target).isFile() ? target : null;
  };

  /**
   * How the Markdown renderer turns the images of a text into responsive
   * pictures. Problems are reported with the file, line and column of the image.
   *
   * @param {string} sourceFile Markdown file of the text.
   * @param {string} pageUrl Site-relative URL of the page the text appears on.
   * @param {PageImages} page Decides the metadata policy of the images.
   * @returns {import('./markdown/render.js').ImageOptions}
   */
  const imageOptionsFor = (sourceFile, pageUrl, page) => {
    const shown = posix(relative(config.dir, sourceFile));
    return {
      sizes: site.images.sizes,
      carouselSizes: site.images.carouselSizes,
      resolve: async ({ src, alt, line, column }) => {
        if (alt.trim() === '') warnings.push(`${shown}:${line}:${column}: the image "${src}" has no alt text`);
        const file = localImageFile(sourceFile, src);
        if (file === null) return null;
        if (!IMAGE_EXTENSIONS.includes(extname(file).toLowerCase())) {
          report.addError({
            site: site.id,
            file: shown,
            line,
            column,
            message: `unsupported image format '${src}' (use JPEG, PNG, WebP or HEIC)`,
          });
          return null;
        }
        try {
          const policy = page.policyFor(addressPath(src));
          const processed = await images.process(file, { location: policy.location.value, camera: policy.camera.value });
          const standIn = publishImage(processed, pageUrl, 'body', page, policy);
          return {
            src: imageFileUrl(processed, standIn),
            width: standIn.width,
            height: standIn.height,
            srcset: processed.variants.map((entry) => ({ url: imageFileUrl(processed, entry), width: entry.width })),
            viewer: {
              src: imageFileUrl(processed, processed.viewer),
              width: processed.viewer.width,
              height: processed.viewer.height,
            },
            location: processed.gps,
          };
        } catch (error) {
          if (!(error instanceof ImageError)) throw error;
          report.addError({ site: site.id, file: shown, line, column, message: `image '${src}': ${error.message}` });
          return null;
        }
      },
    };
  };

  /**
   * The preview image of a post: its cover, else a card with its title. A cover
   * that is a URL is used as it is; a cover that is a file beside the post is
   * resized like any other image and the 1200 pixel variant is used.
   *
   * @param {Post} post
   * @param {string} url Site-relative URL of the post.
   * @returns {Promise<string>}
   */
  const previewImageOf = async (post, url) => {
    const shown = posix(relative(config.dir, post.file));
    const cover = post.cover;
    if (cover === null) return cardFor(post.title);
    if (/^https?:\/\//i.test(cover)) return cover;
    const source = resolve(dirname(post.file), cover);
    const inside = relative(site.contentDir, source);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      warnings.push(`${shown}: cover: "${cover}" is outside the content directory; using a generated card`);
    } else if (!IMAGE_EXTENSIONS.includes(extname(source).toLowerCase())) {
      warnings.push(`${shown}: cover: "${cover}" must be one of ${IMAGE_EXTENSIONS.join(', ')}; using a generated card`);
    } else if (!existsSync(source) || !statSync(source).isFile()) {
      warnings.push(`${shown}: cover: "${cover}" does not exist; using a generated card`);
    } else {
      try {
        const page = /** @type {PageImages} */ (pageImages.get(post.file));
        const policy = page.policyFor(addressPath(cover));
        const processed = await images.process(source, { location: policy.location.value, camera: policy.camera.value });
        return imageFileUrl(processed, publishImage(processed, url, 'cover', page, policy));
      } catch (error) {
        if (!(error instanceof ImageError)) throw error;
        warnings.push(`${shown}: cover: "${cover}": ${error.message}; using a generated card`);
      }
    }
    return cardFor(post.title);
  };

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

  // Every post of every blog is read and rendered first, so that links between posts
  // can be resolved before any page is written.
  /** @type {Map<string, { selected: Post[], rendered: Map<Post, RenderedPost>, tagMeta: ReturnType<typeof loadTagMeta> }>} */
  const prepared = new Map();
  /**
   * The GPX tracks of each selected post, read and analyzed.
   * @type {Map<Post, import('./geo/gpx.js').LoadedTrack[]>}
   */
  const postTracks = new Map();
  /** @type {import('./check/source-links.js').SourcePost[]} */
  const sourcePosts = [];
  for (const blog of site.blogs) {
    const found = discoverPosts(blog.dir, { timezone: site.timezone });
    const selected = found.filter((post) => isPublished(post, { now, drafts }));
    // The tags decide the metadata policy of the images, so they are read
    // before the first image is processed.
    const tagMeta = loadTagMeta(blog.dir);
    const resolver = createResolver(tagMeta.meta, tagMeta.file);
    /** @type {Map<Post, RenderedPost>} */
    const rendered = new Map();
    for (const post of selected) {
      const page = pageImagesOf(post.file, post, resolver);
      pageImages.set(post.file, page);
      // A single-file post has no folder of its own, so only the files it lists are its tracks.
      const { tracks, errors } = loadTracks({
        dir: post.dir,
        listed: post.kind === 'file' ? (post.tracks ?? []) : post.tracks,
        show: (path) => posix(relative(config.dir, path)),
        tolerance: site.tracks.tolerance,
        elevationThreshold: site.tracks.elevationThreshold,
      });
      for (const error of errors) report.addError({ site: site.id, file: error.file, message: error.reason });
      postTracks.set(post, tracks);
      page.tracks = tracks.length;
      rendered.set(
        post,
        await renderMarkdown(post.body, {
          file: post.file,
          startLine: post.bodyLine,
          images: imageOptionsFor(post.file, postUrl(blog, post.slug), page),
          carousel: carouselLabels,
        }),
      );
    }
    prepared.set(blog.id, { selected, rendered, tagMeta });
    for (const post of found) {
      sourcePosts.push({ post, url: postUrl(blog, post.slug), rendered: rendered.get(post) ?? null });
    }
  }

  // The projects: each one's page text is rendered, and its card picture goes
  // through the image pipeline, before the links are checked.
  /**
   * @typedef {object} PreparedProject
   * @property {import('./content/projects.js').Project} project
   * @property {string} url Site-relative URL of the project's page.
   * @property {RenderedPost} rendered
   * @property {PageImages} page
   * @property {ProjectPicture | null} picture The card picture, or null when it could not be made (reported).
   * @property {import('./check/source-links.js').SourceFile} source The page as the link check sees it.
   */
  /**
   * A card picture, ready for a template's `<picture>`.
   *
   * @typedef {object} ProjectPicture
   * @property {string} src
   * @property {number} width
   * @property {number} height
   * @property {{ url: string, width: number }[]} srcset
   * @property {string} alt
   */
  /** @type {PreparedProject[]} */
  const preparedProjects = [];
  if (site.projects) {
    const projectResolver = createResolver(new Map(), null);
    for (const project of loadProjects(site.projects.dir)) {
      const url = projectUrl(site.urls.projects, project.slug);
      const page = pageImagesOf(project.pageFile, null, projectResolver);
      pageImages.set(project.pageFile, page);
      const rendered = await renderMarkdown(project.body, {
        file: project.pageFile,
        startLine: project.bodyLine,
        images: imageOptionsFor(project.pageFile, url, page),
        carousel: carouselLabels,
      });
      /** @type {ProjectPicture | null} */
      let picture = null;
      try {
        const policy = page.policyFor(posix(relative(project.dir, project.card)));
        const processed = await images.process(project.card, {
          location: policy.location.value,
          camera: policy.camera.value,
        });
        const standIn = publishImage(processed, url, 'card', page, policy);
        picture = {
          src: imageFileUrl(processed, standIn),
          width: standIn.width,
          height: standIn.height,
          srcset: processed.variants.map((entry) => ({ url: imageFileUrl(processed, entry), width: entry.width })),
          alt: project.cardAlt,
        };
      } catch (error) {
        if (!(error instanceof ImageError)) throw error;
        report.addError({
          site: site.id,
          file: posix(relative(config.dir, project.file)),
          message: `card: image '${posix(relative(project.dir, project.card))}': ${error.message}`,
        });
      }
      preparedProjects.push({
        project,
        url,
        rendered,
        page,
        picture,
        source: { slug: project.slug, kind: 'folder', file: project.pageFile, dir: project.dir, draft: false },
      });
    }
  }
  for (const entry of preparedProjects) {
    sourcePosts.push({ post: entry.source, url: entry.url, rendered: entry.rendered });
  }

  const linkCheck = checkSourceLinks({
    posts: sourcePosts,
    rootDir: config.dir,
    contentDir: site.contentDir,
    projects: new Map(preparedProjects.map((entry) => [entry.project.slug, entry.url])),
  });
  for (const issue of linkCheck.issues) report.addError({ site: site.id, ...issue });
  for (const [post, rewrites] of linkCheck.rewrites) {
    for (const { rendered } of prepared.values()) {
      const entry = rendered.get(/** @type {Post} */ (post));
      if (entry) rendered.set(/** @type {Post} */ (post), { ...entry, html: applyLinkRewrites(entry.html, rewrites) });
    }
  }
  for (const entry of preparedProjects) {
    entry.rendered = { ...entry.rendered, html: applyLinkRewrites(entry.rendered.html, linkCheck.rewrites.get(entry.source)) };
  }

  for (const blog of site.blogs) {
    const { selected, rendered: renderedPosts, tagMeta } = /** @type {{ selected: Post[], rendered: Map<Post, RenderedPost>, tagMeta: ReturnType<typeof loadTagMeta> }} */ (
      prepared.get(blog.id)
    );

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
      const rendered = /** @type {RenderedPost} */ (renderedPosts.get(post));
      const url = postUrl(blog, post.slug);
      const unpublished = !isPublished(post, { now });
      entries.push({ post, url, readingMinutes: rendered.readingMinutes, unpublished });
      const shownFile = posix(relative(config.dir, post.file));
      const mapped = renderPostMaps({
        lang: site.lang,
        basePath: templates.basePath,
        tiles: site.map,
        templates,
        rendered,
        tracks: postTracks.get(post) ?? [],
        url,
        enabled: post.map !== false,
      });
      for (const problem of mapped.problems) {
        report.addError({ site: site.id, file: shownFile, line: problem.line, column: problem.column, message: problem.message });
      }
      for (const warning of mapped.warnings) warnings.push(`${shownFile}: ${warning}`);

      if (!unpublished) {
        feedEntries.set(
          post,
          createFeedEntry({
            baseUrl: site.baseUrl,
            url,
            title: post.title,
            date: post.date,
            summary: post.summary,
            html: mapped.feedHtml,
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
      const previewImage = await previewImageOf(post, url);
      warnUnusedImageEntries(/** @type {PageImages} */ (pageImages.get(post.file)));
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
          description: post.summary || excerptOf(mapped.feedHtml),
          url,
          image: previewImage,
          type: 'article',
          published: post.date,
          tags: view.tagLinks.map((tag) => tag.name),
        }),
        post: view,
        series: view.series,
        toc: rendered.toc,
        ...pageAssetsFor(rendered, mapped.maps.length > 0),
        page: {
          title: post.title,
          description: post.summary ?? '',
          content: mapped.html,
        },
      });
      const file = fileForUrl(url);
      writeOutput(outDir, file, html);
      pages.push({ url, file, type: 'post', title: post.title });
      /** @type {ManifestTrack[]} */
      const manifestTracks = [];
      for (const track of postTracks.get(post) ?? []) {
        // The GPX file goes out exactly as it came; the map draws the simplified GeoJSON.
        const gpxFile = `${posix(dirname(file))}/${track.name}.gpx`;
        const geojsonFile = `${posix(dirname(file))}/${track.name}.geojson`;
        writeOutput(outDir, gpxFile, track.bytes);
        writeOutput(outDir, geojsonFile, `${JSON.stringify(track.summary.geojson)}
`);
        const { summary } = track;
        manifestTracks.push({
          title: summary.title,
          source: posix(relative(config.dir, track.path)),
          gpx: `${url}${encodeURIComponent(track.name)}.gpx`,
          geojson: `${url}${encodeURIComponent(track.name)}.geojson`,
          distanceMeters: Math.round(summary.distance),
          elevationGainMeters: summary.elevationGain === null ? null : Math.round(summary.elevationGain),
          highest:
            summary.highest === null
              ? null
              : {
                  elevationMeters: Math.round(summary.highest.elevation),
                  latitude: summary.highest.latitude,
                  longitude: summary.highest.longitude,
                },
          points: summary.points,
          simplifiedPoints: summary.simplifiedPoints,
          bounds: summary.bounds,
        });
      }
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
        tracks: manifestTracks,
        maps: mapped.maps.map((map) => map.summary),
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
      meta: metaFor({ title: blog.title, description: site.description, url: indexUrl, image: cardFor(blog.title) }),
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
      meta: metaFor({ title: tagsTitle, description: site.description, url: tagsIndexUrl, image: cardFor(tagsTitle) }),
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
        meta: metaFor({ title: view.name, description: view.description, url: view.url, image: cardFor(view.name) }),
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
        meta: metaFor({ title: entry.name, description: entry.description ?? '', url, image: cardFor(entry.name) }),
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

  // The projects page, one page per project, and the cards that the home page's showcase reuses.
  /** @type {ManifestProject[]} */
  const manifestProjects = [];
  /** @param {string} kind */
  const kindLabelOf = (kind) => (templates.translator.has(`projects.kind.${kind}`) ? t(`projects.kind.${kind}`) : kind);
  const projectViews = preparedProjects.map(({ project, url, picture }) => ({
    slug: project.slug,
    url,
    name: project.name,
    pitch: project.pitch,
    kind: project.kind,
    kindLabel: kindLabelOf(project.kind),
    status: project.status,
    statusLabel: t(`projects.status.${project.status}`),
    featured: project.featured,
    order: project.order,
    license: project.license,
    tag: project.tag,
    fields: project.fields,
    picture,
  }));
  if (projectsIndexUrl) {
    for (const entry of preparedProjects) {
      const { project, url, rendered, page, picture } = entry;
      const shown = posix(relative(config.dir, project.pageFile));
      for (const directive of rendered.maps) {
        warnings.push(`${shown}:${directive.line ?? 1}: the ::map directive is only for posts and is left out`);
      }
      warnUnusedImageEntries(page);
      const view = /** @type {(typeof projectViews)[number]} */ (projectViews.find((candidate) => candidate.slug === project.slug));
      const kind = /** @type {import('./content/project-kinds.js').ProjectKind} */ (getProjectKind(project.kind));
      const html = templates.render(kind.template, {
        site,
        nav,
        feedLinks: feedLinksFor(null),
        meta: metaFor({
          title: project.name,
          description: project.pitch,
          url,
          image: picture ? picture.src : cardFor(project.name),
        }),
        project: view,
        projectsUrl: projectsIndexUrl,
        ...pageAssetsFor(rendered),
        page: { title: project.name, description: project.pitch, content: withoutMapPlaceholders(rendered.html) },
      });
      const file = fileForUrl(url);
      writeOutput(outDir, file, html);
      pages.push({ url, file, type: 'project', title: project.name });
      manifestProjects.push({
        slug: project.slug,
        url,
        file,
        source: posix(relative(config.dir, project.file)),
        name: project.name,
        pitch: project.pitch,
        kind: project.kind,
        status: project.status,
        featured: project.featured,
        order: project.order,
        tag: project.tag,
        card: posix(relative(config.dir, project.card)),
      });
    }
    const projectsTitle = t('projects.title');
    const indexHtml = templates.render('project-index.njk', {
      site,
      nav,
      feedLinks: feedLinksFor(null),
      meta: metaFor({ title: projectsTitle, description: site.description, url: projectsIndexUrl, image: cardFor(projectsTitle) }),
      projects: projectViews,
      page: { title: projectsTitle, description: site.description, content: '' },
    });
    writeOutput(outDir, fileForUrl(projectsIndexUrl), indexHtml);
    pages.push({ url: projectsIndexUrl, file: fileForUrl(projectsIndexUrl), type: 'project-index', title: projectsTitle });
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
    // The home page has no front matter for the metadata policy: the site's
    // settings apply to its images.
    const homePage = home ? pageImagesOf(home.file, null, createResolver(new Map(), null)) : null;
    if (home && homePage) pageImages.set(home.file, homePage);
    const rendered =
      home && homePage
        ? await renderMarkdown(home.body, {
            file: home.file,
            startLine: home.bodyLine,
            images: imageOptionsFor(home.file, '/', homePage),
            carousel: carouselLabels,
          })
        : null;
    // Only a post has tracks and located photos, so a map has nothing to show here.
    if (home) {
      for (const directive of rendered?.maps ?? []) {
        warnings.push(`${posix(relative(config.dir, home.file))}:${directive.line ?? 1}: the ::map directive is only for posts and is left out`);
      }
    }
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
      showcase: showcaseOf(projectViews),
      projectsUrl: projectsIndexUrl,
      ...pageAssetsFor(rendered),
      page: {
        title,
        description: site.description,
        content: withoutMapPlaceholders(rendered?.html ?? ''),
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

  // Two pages written to the same file overwrite each other without a trace.
  // A project page is the one the author can move, so the error names its
  // project.yaml.
  {
    /** @type {Map<string, ManifestPage[]>} */
    const byFile = new Map();
    for (const entry of pages) byFile.set(entry.file, [...(byFile.get(entry.file) ?? []), entry]);
    for (const [file, entries] of byFile) {
      if (entries.length < 2) continue;
      for (const entry of entries) {
        if (entry.type !== 'project' && entry.type !== 'project-index') continue;
        const owner = preparedProjects.find((candidate) => candidate.url === entry.url);
        const source = owner
          ? posix(relative(config.dir, owner.project.file))
          : posix(relative(config.dir, /** @type {{ dir: string }} */ (site.projects).dir));
        const others = entries.filter((other) => other !== entry).map((other) => `${other.type} ${other.url}`);
        const what = entry.type === 'project' ? 'the project page' : 'the projects index';
        report.addError({
          site: site.id,
          file: source,
          message: `${what} ${entry.url} is written to ${file}, which ${others.join(' and ')} also use${others.length > 1 ? '' : 's'}; rename the project folder or change "urls.projects" or the blog prefix`,
        });
      }
    }
  }

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

  // Links that start with "/" can only be checked now that every page is written.
  for (const issue of linkCheck.verifyOutput((path) => outputServes(outDir, path))) {
    report.addError({ site: site.id, ...issue });
  }

  pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestPosts.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestTags.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestSeries.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestFeeds.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  manifestImages.sort(
    (a, b) =>
      (a.post < b.post ? -1 : a.post > b.post ? 1 : 0) ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.use < b.use ? -1 : a.use > b.use ? 1 : 0),
  );

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
    projects: manifestProjects,
    redirects: redirects.map(({ from, to, status }) => ({ from, to, status })),
    feeds: manifestFeeds,
    sitemap: sitemapEntries.map((entry) => entry.url).sort(),
    images: manifestImages,
  };
  writeFileSync(join(outDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  /** @type {import('./report.js').ExactLocation[]} */
  const exactLocations = [...pageImages.values()]
    .filter((page) => page.exact.size > 0 || page.tracks > 0)
    .map((page) => ({
      site: site.id,
      file: page.shown,
      images: page.exact.size,
      ...(page.tracks > 0 ? { tracks: page.tracks } : {}),
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    id: site.id,
    outDir,
    manifest,
    warnings,
    cards: { ...cards.stats },
    images: { ...images.stats },
    exactLocations,
  };
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
 * - for every post, tag, series and blog index without a picture of its own, a 1200 by 630 title card in `cards/{hash}.png`, cached in `.cache/cards/`
 *   (see `docs/seo.md`); a post's `cover` is the preview image of a post that has one;
 * - the assets of the default theme, then of the site's theme, in `assets/`;
 * - the build manifest `.coffer-manifest.json`.
 *
 * Before any page is written, every Markdown link and image of every post is resolved (see
 * `docs/links.md`): a broken link, a missing image or an unknown `project:` reference is an
 * error, and relative links to other posts become their canonical URLs. All errors are collected
 * and thrown together as a `ReportError`. The errors, warnings and notes of the build are also
 * written to `report.json` in `reportDir`, outside the output.
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
 * @throws {import('./report.js').ReportError} When the sources have broken links, missing images or unknown project references; it lists them all.
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

  const report = new Report();
  const reportFile = join(resolve(options.reportDir ?? join(config.dir, REPORT_DIR_NAME)), REPORT_FILE_NAME);

  /** @type {SiteResult[]} */
  const results = [];
  /** @type {unknown} */
  let failure;
  try {
    for (const site of sites) {
      const result = await buildSite(config, site, options, outRoot, version, report);
      for (const message of result.warnings) report.addWarning({ site: result.id, message });
      for (const entry of result.exactLocations) report.addExactLocation(entry);
      report.addInfo({
        site: result.id,
        message: `${result.manifest.posts.length} post(s), ${result.manifest.pages.length} page(s) built`,
      });
      results.push(result);
    }
    report.throwIfFailed();
  } catch (error) {
    failure = error;
    if (!(error instanceof ReportError)) {
      const lines =
        error instanceof Error && 'errors' in error && Array.isArray(error.errors)
          ? error.errors.map(String)
          : [error instanceof Error ? error.message : String(error)];
      for (const message of lines) report.addError(message);
    }
  }
  writeReport(report, reportFile);
  if (failure !== undefined) throw failure;
  return results;
}
