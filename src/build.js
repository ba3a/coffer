import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_INFO_FILE_NAME, createBuildInfo, renderBuildInfo } from './build-info.js';
import { CARDS_CACHE_DIR, createCardMaker } from './cards.js';
import { DEFAULT_LATEST_POSTS, loadHome } from './content/home.js';
import { discoverPosts, isPublished, resolveNow } from './content/posts.js';
import { FONT_FILE_FORMATS, getProjectKind } from './content/project-kinds.js';
import { PROJECT_BLOCK_POSTS, newestFirst, projectsOfPost, unknownProjectMessage } from './content/project-posts.js';
import { projectStyle } from './content/project-style.js';
import { loadProjects, projectUrl, showcaseOf } from './content/projects.js';
import { finishGuidePage, githubRefOf, githubUrl, locateGuideImage, planGuides, resolveGuideLinks } from './docs/guides.js';
import { fillReadmeSections, readSection } from './docs/readme.js';
import { SymbolIndexError, indexOfHtmlReference, indexOfView } from './docs/symbols.js';
import { ReferenceFailure, backBarHtml, generateReference, publishReferenceFolder, viewOfReference } from './docs/reference.js';
import { fetchDocsSources, manifestDocs } from './docs/sources.js';
import {
  FEED_FILE_NAME,
  absoluteUri,
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
import { inspectSvg } from './images/svg.js';
import { buildMeta } from './meta.js';
import { MarkdownError, renderMarkdown } from './markdown/render.js';
import {
  REDIRECTS_FILE_NAME,
  checkRedirects,
  collectRedirects,
  renderRedirectPage,
  renderRedirectsFile,
} from './redirects.js';
import { createTemplates, siteUrl } from './render/templates.js';
import { REPORT_DIR_NAME, REPORT_FILE_NAME, Report, ReportError, writeReport } from './report.js';
import { PAGE_URL_NAME, firstPageAliases, pageUrl, paginate } from './pagination.js';
import { BLOG_FILTER, SEARCH_DIR_NAME, SEARCH_URL_NAME, buildSearchIndex, searchPageUrl } from './search.js';
import { SHARE_FILE_NAME, SHARE_SCRIPT, hashtagsFor, renderShareText, shareUrlFor } from './share.js';
import { ROBOTS_FILE_NAME, SITEMAP_FILE_NAME, renderRobots, renderSitemap } from './sitemap.js';
import { readVersion } from './version.js';
import { VIEWER_SCRIPTS, VIEWER_STYLES, viewerJson } from './viewer.js';

/** Directory holding the static assets of the default theme. */
export const ENGINE_ASSETS_DIR = fileURLToPath(new URL('../theme/assets/', import.meta.url));

/** Folder of the cache that holds the checkouts of documentation sources, `{cache}/repos/{slug}`. */
export const DOCS_REPOS_CACHE_DIR = 'repos';

/** Name of the folder, inside the cache, that holds the generated references of projects. */
export const DOCS_REFERENCE_CACHE_DIR = 'reference';

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
 * @property {() => Date} [clock] The clock that gives `builtAt` in `build-info.json` (default the system clock). It is not the "now" that decides which posts are published.
 * @property {string} [nowFlag] Value of `--now`; a date or a date and time, read in the site's time zone when it has no offset.
 * @property {Record<string, string | undefined>} [env] Environment for `COFFER_NOW` (default `process.env`).
 * @property {string} [cwd] Directory that a relative `out` resolves against (default the working directory).
 * @property {string[]} [siteIds] Build only these sites (default all).
 * @property {string} [cacheDir] Directory for work that is worth keeping between builds, such as title cards (default `.cache` beside the configuration file; an absolute path, or relative to the working directory).
 * @property {{ timeoutMs?: number, exec?: import('./docs/sources.js').FetchOptions['exec'], env?: Record<string, string | undefined> }} [docsFetch] How the documentation sources of tool projects are fetched: the time one git call can take, a replacement for running git, and the environment git's is made from. Used by tests.
 * @property {{ timeoutMs?: number, env?: Record<string, string | undefined> }} [reference] How the reference commands of tool projects are run: the time one command can take, and the environment it gets (default the process's). Used by tests.
 * @property {string} [reportDir] Directory that receives `report.json`, the errors, warnings and notes of the build (default `.coffer` beside the configuration file; an absolute path, or relative to the working directory). It is never inside the output.
 */

/**
 * One page written by the build, as listed in the manifest.
 *
 * @typedef {object} ManifestPage
 * @property {string} url Site-relative URL, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {'home' | 'not-found' | 'blog-index' | 'post' | 'tag-index' | 'tag' | 'search' | 'series' | 'project-index' | 'project' | 'docs'} type
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
 * @property {'summary' | 'full'} index How list pages show the post: its own `index` front matter, else the blog's `index.type`.
 * @property {{ url: string, file: string } | null} share The post's share summary text file (`share.txt`: address and path), or null when the blog has no share summary. It is an output file of the build, not a page: it is in neither the sitemap, the feeds nor the search index.
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
 * @property {'blog' | 'tag' | 'series' | 'project'} type What the feed lists.
 * @property {string | null} blog Id of the blog; null for a project feed, which lists the posts of every blog.
 * @property {string} url Site-relative URL of the feed.
 * @property {string} selfUrl Absolute URL of the feed, as its self link says.
 * @property {string} file Path of the feed file, relative to the site's output directory.
 * @property {string} page Site-relative URL of the page the feed belongs to.
 * @property {string} title
 * @property {number} entries Number of entries in the feed.
 * @property {string | null} tag Tag path of a tag feed.
 * @property {string | null} series Series slug of a series feed.
 * @property {string | null} project Slug of the project of a project feed.
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
 * @property {'body' | 'cover' | 'card' | 'press-kit'} use A Markdown image in the text, the cover of the post, a picture of a project (its card, logo or key art), or the thumbnail of a press kit's logo or screenshot.
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
 * @property {import('./build-info.js').BuildInfo} buildInfo What `build-info.json` says (see `docs/scheduling.md`).
 * @property {ManifestPage[]} pages
 * @property {ManifestPost[]} posts
 * @property {ManifestTag[]} tags Every tag page, with the posts it lists.
 * @property {ManifestSeries[]} series Every series page, with its parts in order.
 * @property {ManifestProject[]} projects Every project, in showcase order; empty when the site has no projects.
 * @property {ManifestRedirect[]} redirects Permanent redirects from old post addresses.
 * @property {ManifestFeed[]} feeds Every Atom feed, with the page it belongs to.
 * @property {string[]} sitemap Site-relative URLs listed in `sitemap.xml`, sorted.
 * @property {ManifestImage[]} images Every image used by a page, with the files made from it; sorted by page, then original.
 * @property {ManifestRootFile[]} files The files the build copies to the root of the site from the `favicon` and `appleTouchIcon` settings (`/favicon.ico`, `/apple-touch-icon.png`); empty without those settings. They are files, not pages, so they are not in `pages` or the sitemap.
 */

/**
 * A file the build copies to the root of the site.
 *
 * @typedef {object} ManifestRootFile
 * @property {'favicon' | 'appleTouchIcon'} setting The site setting that names it.
 * @property {string} source Value of the setting: the path of the original in the output (a theme asset), relative to the root of the site.
 * @property {string} url Site-relative address of the copy.
 * @property {string} file Path of the copy, relative to the site's output directory.
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
 * @property {string[]} posts Site-relative URLs of the published posts about the project (by its tag or by `projects:`), newest first, from every blog.
 * @property {string | null} feed Site-relative URL of the project's feed; null when the site has no blog.
 * @property {string} card Path of the card picture, relative to the configuration file.
 * @property {ManifestProjectFile[]} files The files copied unchanged to the output for the project, such as a trailer video or a font; empty when it has none. Pictures are listed under `images`.
 * @property {ManifestProjectDocs | null} docs The documentation of a tool: where it comes from (for a git repository the address without credentials, the ref and the commit that was built; for a folder its path and the commit of the repository it is in), the GitHub repository, the guides, and the pages built from them. Null when the project has no `docs`.
 * @property {ManifestDownload[]} downloads The full-resolution logos and screenshots of the project's press kit; empty when it has none. `coffer check` reads each one back against its policy.
 */

/**
 * The documentation of a project in the manifest: the source and guides as
 * configured (see `ManifestDocs`), the pages built from them, and the
 * generated reference.
 *
 * @typedef {import('./docs/sources.js').ManifestDocs & { pages: ManifestDocsPage[], reference: ManifestReference | null }} ManifestProjectDocs
 */

/**
 * The generated reference of a project. Its pages are not in the manifest's
 * `pages` or in the sitemap: they are generated content, outside the theme.
 *
 * @typedef {object} ManifestReference
 * @property {string} url Site-relative URL of the reference, ending in a slash.
 * @property {string} file Path of its index page, relative to the site's output directory.
 * @property {'html' | 'json'} format
 * @property {string} title The configured title.
 * @property {number} files The number of files published; 1 for a json reference.
 * @property {number | null} items The number of elements of a json reference; null for html.
 * @property {string[]} undocumented The names of the elements without documentation, in the order found.
 * @property {boolean} cached Whether the result came from the cache of this build (the command did not run).
 */

/**
 * A page of a project's documentation.
 *
 * @typedef {object} ManifestDocsPage
 * @property {string} url Site-relative URL, ending in a slash.
 * @property {string} file Path of the HTML file, relative to the site's output directory.
 * @property {string | null} source Path of the guide file inside the documentation source, with `/`; null for the docs index that the build generates when no file is one.
 * @property {string} title
 */

/**
 * A file of a press kit that people download. A picture is re-encoded at the
 * size of the original, so its metadata follows the policy; an SVG logo is
 * published as it is, and is checked for anything that could run script.
 *
 * @typedef {object} ManifestDownload
 * @property {'logos' | 'screenshots'} field The list of `pressKit` in `project.yaml` that names it.
 * @property {string} source Path of the original, relative to the configuration file.
 * @property {string} sha256 Hash of the original.
 * @property {string} url Site-relative address of the published file.
 * @property {string} file Path of the published file, relative to the site's output directory.
 * @property {string} fileName The descriptive file name that the `download` attribute suggests.
 * @property {string} type Media type of the published file.
 * @property {number | null} width Width in pixels of the published file (the upright original's, never reduced); null for an SVG that declares none.
 * @property {number | null} height Height in pixels, likewise.
 * @property {number} bytes Size of the published file.
 * @property {ManifestImagePolicy | null} policy The metadata policy the file was published under; null for an SVG, which is published as it is.
 * @property {import('./images/metadata.js').PublishedPosition | null} gps The position the file carries, never more precise than the policy allows.
 * @property {import('./images/metadata.js').CameraFields | null} camera The camera fields the file carries.
 */

/**
 * A file of a project that is published as it is.
 *
 * @typedef {object} ManifestProjectFile
 * @property {string} field The field of `project.yaml` that names it.
 * @property {string} source Path of the original, relative to the configuration file.
 * @property {string} url Site-relative address of the published file.
 * @property {string} file Path of the published file, relative to the site's output directory.
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
 * @property {{ pages: number }} search Pages put in the full-text search index.
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
 * @param {'summary' | 'full'} [blogIndex] The `index.type` of the post's blog, used when the post has no `index` of its own.
 *     The view has an empty `html`; a list page fills it for a post whose effective `index` is `full`.
 */
function postView(post, url, readingMinutes, unpublished, tagLinks = [], series = null, blogIndex = 'summary') {
  return {
    slug: post.slug,
    url,
    title: post.title,
    date: post.date,
    tags: post.tags,
    tagLinks,
    summary: post.summary,
    index: post.index ?? blogIndex,
    html: '',
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
 * Reads the file a site setting names from the output.
 *
 * @param {SiteConfig} site
 * @param {string} outDir
 * @param {string} setting
 * @param {string} path Value of the setting: a path relative to the root of the site.
 * @returns {Buffer}
 * @throws {BuildError} When there is no such file; the message names the setting and the site.
 */
function readSiteFile(site, outDir, setting, path) {
  const file = join(outDir, ...path.split('/'));
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new BuildError(`site "${site.id}": ${setting}: "${path}" is not in the output; put the file in the "assets" folder of the theme`);
  }
  return readFileSync(file);
}

/**
 * @param {Buffer} bytes
 * @returns {boolean} Whether `bytes` start like a PNG file (signature and header chunk).
 */
function isPng(bytes) {
  return bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR';
}

/** The first bytes of an `.ico` file: reserved 0, type 1 (icon). */
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);

/** The root files the `favicon` and `appleTouchIcon` settings make: where each is served. */
const ROOT_ICON_FILES = /** @type {const} */ ({ favicon: 'favicon.ico', appleTouchIcon: 'apple-touch-icon.png' });

/**
 * Reads and checks the file of the `favicon` or `appleTouchIcon` setting: it
 * exists in the output, and is an `.ico` or PNG file (`favicon`) or a PNG file
 * (`appleTouchIcon`).
 *
 * @param {SiteConfig} site
 * @param {string} outDir
 * @param {'favicon' | 'appleTouchIcon'} setting
 * @param {string} path Value of the setting.
 * @returns {Buffer}
 * @throws {BuildError} When the file does not qualify; the message names the setting and the site.
 */
function checkRootIcon(site, outDir, setting, path) {
  const bytes = readSiteFile(site, outDir, setting, path);
  const png = isPng(bytes);
  const ico = bytes.length >= 6 && bytes.subarray(0, 4).equals(ICO_SIGNATURE);
  if (setting === 'appleTouchIcon' ? !png : !png && !ico) {
    throw new BuildError(`site "${site.id}": ${setting}: "${path}" is not ${setting === 'appleTouchIcon' ? 'a PNG file' : 'an ICO or PNG file'}`);
  }
  return bytes;
}

/** The smallest side in pixels of a site's `icon`: feed readers show it at up to 128 px. */
const MIN_ICON_SIZE = 128;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Checks a picture a site setting names (`icon`, `logo`) in the output: the
 * file exists and is a PNG; with `square`, it is also square and at least
 * `MIN_ICON_SIZE` pixels on a side.
 *
 * @param {SiteConfig} site
 * @param {string} outDir
 * @param {'icon' | 'logo'} setting
 * @param {string} path Value of the setting: a path relative to the root of the site.
 * @param {boolean} square Whether the picture must be a square of at least `MIN_ICON_SIZE`.
 * @returns {string} Absolute address of the picture, percent-encoded as for any URL in a feed.
 * @throws {BuildError} When the picture does not qualify; the message names the setting and the site.
 */
function checkSitePicture(site, outDir, setting, path, square) {
  const fail = (/** @type {string} */ problem) => {
    throw new BuildError(`site "${site.id}": ${setting}: "${path}" ${problem}`);
  };
  const bytes = readSiteFile(site, outDir, setting, path);
  if (!isPng(bytes)) return fail('is not a PNG file');
  if (square) {
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== height) return fail(`must be square, but it is ${width} x ${height} px`);
    if (width < MIN_ICON_SIZE) return fail(`must be at least ${MIN_ICON_SIZE} x ${MIN_ICON_SIZE} px, but it is ${width} x ${height} px`);
  }
  return absoluteUri(site.baseUrl, `/${path}`);
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
    // The snippet is for the published site only; a preview build (`coffer dev`,
    // `--drafts`) must not count the author's own visits.
    analytics: drafts ? null : site.analytics,
    onMissing: (message) => warnings.push(message),
  });

  const projectsIndexUrl = site.projects ? `/${site.urls.projects}/` : null;
  const nav = [
    { key: 'nav.home', url: '/' },
    ...(projectsIndexUrl ? [{ key: 'nav.projects', url: projectsIndexUrl }] : []),
    ...site.blogs.map((blog) => ({ label: blog.title, url: blogUrl(blog) })),
    ...site.blogs.map((blog) => ({
      label:
        site.blogs.length > 1
          ? templates.translator.t('nav.search_blog', { title: blog.title })
          : templates.translator.t('nav.search'),
      url: searchPageUrl(blogUrl(blog)),
    })),
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
   * The part of a rendered text that decides what its page loads.
   *
   * @typedef {{ carousels: number, viewerImages: import('./markdown/render.js').ViewerImage[] }} PageText
   */
  /**
   * What a page needs besides its HTML, as template variables: the carousel
   * script when the page has a carousel and, when it has images the viewer can
   * open, the viewer (PhotoSwipe, its styles, the engine's script and styles)
   * and the list of those images as JSON for it. Pages without such images load
   * nothing of it.
   *
   * A page that shows several texts (a list page of full posts) passes them all,
   * in the order they appear: the images are listed in that order, and each
   * script and style is included once however many texts use it.
   *
   * @param {PageText | PageText[] | null} rendered
   * @param {boolean} [withMap] Whether the page has a map, which needs Leaflet and the engine's map script (after the viewer's, so that a marker finds the viewer ready).
   * @returns {{ scripts: string[], styles: string[], viewerData: string }}
   */
  const pageAssetsFor = (rendered, withMap = false) => {
    const texts = rendered === null ? [] : Array.isArray(rendered) ? rendered : [rendered];
    const viewerImages = texts.flatMap((text) => text.viewerImages);
    const scripts = texts.some((text) => text.carousels > 0) ? ['/assets/carousel.js'] : [];
    const styles = [];
    let viewerData = '';
    if (viewerImages.length > 0) {
      styles.push(...VIEWER_STYLES);
      scripts.push(...VIEWER_SCRIPTS);
      viewerData = viewerJson({ labels: viewerLabels, images: viewerImages });
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
   * @param {'body' | 'cover' | 'card' | 'press-kit'} use
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
   * @param {{ shown: string, locate: (src: string) => { file: string } | { error: string } | null }} [own] For a text that does not live in the content directory (a guide of a project's documentation): how findings name the file, and how an image address is turned into a file. `locate` returns null for an image that is left as it is (a remote one) and `{ error }` for one that fails the build.
   * @returns {import('./markdown/render.js').ImageOptions}
   */
  const imageOptionsFor = (sourceFile, pageUrl, page, own) => {
    const shown = own ? own.shown : posix(relative(config.dir, sourceFile));
    return {
      sizes: site.images.sizes,
      carouselSizes: site.images.carouselSizes,
      resolve: async ({ src, alt, line, column }) => {
        if (alt.trim() === '') warnings.push(`${shown}:${line}:${column}: the image "${src}" has no alt text`);
        /** @type {string | null} */
        let file;
        if (own) {
          const located = own.locate(src);
          if (located !== null && 'error' in located) {
            report.addError({ site: site.id, file: shown, line, column, message: located.error });
            return null;
          }
          file = located === null ? null : located.file;
        } else {
          file = localImageFile(sourceFile, src);
        }
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
  /** @type {Map<string, { selected: Post[], rendered: Map<Post, RenderedPost>, listRendered: Map<Post, RenderedPost>, tagMeta: ReturnType<typeof loadTagMeta> }>} */
  const prepared = new Map();
  /**
   * The GPX tracks of each selected post, read and analyzed.
   * @type {Map<Post, import('./geo/gpx.js').LoadedTrack[]>}
   */
  const postTracks = new Map();
  /** @type {import('./check/source-links.js').SourcePost[]} */
  const sourcePosts = [];
  /**
   * Every post of the site, whatever its state, for `build-info.json`.
   * @type {Post[]}
   */
  const everyPost = [];
  for (const blog of site.blogs) {
    const found = discoverPosts(blog.dir, { timezone: site.timezone });
    everyPost.push(...found);
    const selected = found.filter((post) => isPublished(post, { now, drafts }));
    // The tags decide the metadata policy of the images, so they are read
    // before the first image is processed.
    const tagMeta = loadTagMeta(blog.dir);
    const resolver = createResolver(tagMeta.meta, tagMeta.file);
    /** @type {Map<Post, RenderedPost>} */
    const rendered = new Map();
    /**
     * The body of each post whose effective `index` is `full`, rendered for a
     * list page: headings one level lower, ids prefixed with the slug.
     * @type {Map<Post, RenderedPost>}
     */
    const listRendered = new Map();
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
      const imageOptions = imageOptionsFor(post.file, postUrl(blog, post.slug), page);
      if ((post.index ?? blog.index.type) !== 'full') {
        rendered.set(
          post,
          await renderMarkdown(post.body, {
            file: post.file,
            startLine: post.bodyLine,
            images: imageOptions,
            carousel: carouselLabels,
          }),
        );
        continue;
      }
      // A full post is rendered twice, as a page and for list pages. The second
      // pass takes the images from the first, so each image is processed,
      // published and reported once.
      /** @type {Map<string, Promise<import('./markdown/render.js').ResponsiveImage | null>>} */
      const resolvedImages = new Map();
      /** @param {import('./markdown/render.js').ImageRequest} request */
      const imageKey = (request) => `${request.line}:${request.column}:${request.src}`;
      rendered.set(
        post,
        await renderMarkdown(post.body, {
          file: post.file,
          startLine: post.bodyLine,
          images: {
            ...imageOptions,
            resolve: (request) => {
              const resolving = imageOptions.resolve(request);
              resolvedImages.set(imageKey(request), resolving);
              return resolving;
            },
          },
          carousel: carouselLabels,
        }),
      );
      listRendered.set(
        post,
        await renderMarkdown(post.body, {
          file: post.file,
          startLine: post.bodyLine,
          images: {
            ...imageOptions,
            resolve: (request) => resolvedImages.get(imageKey(request)) ?? imageOptions.resolve(request),
          },
          carousel: carouselLabels,
          headingShift: 1,
          idPrefix: `${post.slug}-`,
        }),
      );
    }
    prepared.set(blog.id, { selected, rendered, listRendered, tagMeta });
    for (const post of found) {
      sourcePosts.push({ post, url: postUrl(blog, post.slug), rendered: rendered.get(post) ?? null });
    }
  }

  /**
   * Makes one picture of a project (its card, logo or key art) through the
   * image pipeline, under the policy of the project's page.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {string} field The field that names the picture; used in messages.
   * @param {string} file Absolute path of the picture.
   * @param {string} alt
   * @param {string} url Site-relative URL of the project's page.
   * @param {PageImages} page
   * @param {'card' | 'press-kit'} [use] What the manifest says the picture is used for (default `card`).
   * @returns {Promise<ProjectPicture | null>} Null when the picture cannot be made; the problem is reported.
   */
  const makeProjectPicture = async (project, field, file, alt, url, page, use = 'card') => {
    try {
      const policy = page.policyFor(posix(relative(project.dir, file)));
      const processed = await images.process(file, {
        location: policy.location.value,
        camera: policy.camera.value,
      });
      const standIn = publishImage(processed, url, use, page, policy);
      return {
        src: imageFileUrl(processed, standIn),
        width: standIn.width,
        height: standIn.height,
        srcset: processed.variants.map((entry) => ({ url: imageFileUrl(processed, entry), width: entry.width })),
        alt,
      };
    } catch (error) {
      if (!(error instanceof ImageError)) throw error;
      report.addError({
        site: site.id,
        file: posix(relative(config.dir, project.file)),
        message: `${field}: image '${posix(relative(project.dir, file))}': ${error.message}`,
      });
      return null;
    }
  };

  /**
   * Copies a file of a project (a trailer video, a font) to the output
   * unchanged. It is published beside the project's page under a fixed name
   * made from the field name and the extension, so nothing the author typed
   * becomes part of a path.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {string} url Site-relative URL of the project's page.
   * @param {string} field
   * @param {string} file Path of the file relative to the project folder, with `/`.
   * @param {ManifestProjectFile[]} files Receives the manifest entry.
   * @returns {string} Site-relative address of the published file.
   */
  const publishProjectFile = (project, url, field, file, files) => {
    const name = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`) + extname(file).toLowerCase();
    const address = `${url}${name}`;
    const source = join(project.dir, ...file.split('/'));
    const target = join(outDir, ...address.split('/').filter(Boolean));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    files.push({ field, source: posix(relative(config.dir, source)), url: address, file: address.slice(1) });
    return address;
  };

  /** Folder, below a game's page, in which the files of its press kit are published. */
  const PRESS_KIT_DIR = 'press-kit';
  /** Pseudo-addresses of the descriptions of a press kit for the link check; nothing links to them. */
  const PRESS_KIT_DESCRIPTION_URL = '~press-kit-';

  /**
   * The size of a file in words a person can compare: whole kilobytes, or
   * megabytes with one decimal.
   *
   * @param {number} bytes
   * @returns {{ value: string, unit: 'kb' | 'mb' }}
   */
  const fileSizeOf = (bytes) => {
    /** @type {Intl.NumberFormat} */
    let format;
    try {
      format = new Intl.NumberFormat(site.lang, { maximumFractionDigits: 1 });
    } catch {
      format = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
    }
    return bytes < 1024 * 1024
      ? { value: format.format(Math.max(1, Math.round(bytes / 1024))), unit: 'kb' }
      : { value: format.format(Math.round((bytes / (1024 * 1024)) * 10) / 10), unit: 'mb' };
  };

  /**
   * One logo or screenshot of a press kit as the template shows it: a
   * thumbnail and the facts about the file to download.
   *
   * @typedef {object} PressKitAssetView
   * @property {number} number Place in its list, from 1.
   * @property {string} alt
   * @property {{ src: string, width: number | null, height: number | null, srcset: { url: string, width: number }[], alt: string }} thumbnail For an SVG the thumbnail is the file itself and has no `srcset`.
   * @property {string} url Address of the file to download.
   * @property {string} fileName
   * @property {string} format `PNG`, `JPEG` or `SVG`.
   * @property {number | null} width
   * @property {number | null} height
   * @property {{ value: string, unit: 'kb' | 'mb' }} size
   */

  /**
   * A description of a press kit, rendered. The link check sees it as a page
   * of its own, so a broken link in it is reported with the line of `project.yaml`.
   *
   * @typedef {object} PressKitDescription
   * @property {RenderedPost} rendered
   * @property {import('./check/source-links.js').SourceFile} source
   * @property {string} url Pseudo-address for the link check.
   * @property {string} html The HTML to show; link rewrites are applied to it once the links are checked.
   */

  /**
   * @typedef {object} PreparedPressKit
   * @property {import('./content/project-kinds.js').PressKit} kit
   * @property {PressKitDescription | null} shortDescription
   * @property {PressKitDescription | null} longDescription
   * @property {PressKitAssetView[]} logos
   * @property {PressKitAssetView[]} screenshots
   * @property {ManifestDownload[]} downloads
   */

  /**
   * Prepares the press kit of a game: renders its descriptions, makes a
   * thumbnail of every logo and screenshot, and publishes the files to
   * download under `{page}/press-kit/{slug}-{logo|screenshot}-{nn}.{ext}`.
   * A picture is re-encoded at the size of the original under the policy of
   * the project's page; an SVG logo, which the schema already checked, is
   * copied as it is.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {string} url Site-relative URL of the project's page.
   * @param {import('./content/project-kinds.js').PressKit} kit
   * @param {PageImages} page
   * @returns {Promise<PreparedPressKit>}
   */
  const preparePressKit = async (project, url, kit, page) => {
    const shown = posix(relative(config.dir, project.file));

    /**
     * @param {'shortDescription' | 'longDescription'} name
     * @returns {Promise<PressKitDescription | null>}
     */
    const describe = async (name) => {
      const description = kit[name];
      if (description === null) return null;
      const rendered = await renderMarkdown(description.text, {
        file: project.file,
        startLine: description.line,
        carousel: carouselLabels,
      });
      for (const directive of rendered.maps) {
        warnings.push(`${shown}:${directive.line ?? description.line}: pressKit.${name}: the ::map directive is only for posts and is left out`);
      }
      if (rendered.carousels > 0) {
        warnings.push(`${shown}:${description.line}: pressKit.${name}: a carousel needs pictures of the page; it is shown as plain pictures (list screenshots under "screenshots")`);
      }
      for (const image of rendered.images) {
        if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(image.src)) {
          warnings.push(`${shown}:${description.line}: pressKit.${name}: the picture "${image.src}" is not published from a description; list it under "screenshots" or "logos"`);
        }
      }
      return {
        rendered,
        source: {
          slug: `${PRESS_KIT_DESCRIPTION_URL}${name}`,
          kind: 'file',
          file: project.file,
          dir: project.dir,
          draft: false,
        },
        url: `${url}${PRESS_KIT_DESCRIPTION_URL}${name}/`,
        html: withoutMapPlaceholders(rendered.html),
      };
    };

    /** @type {ManifestDownload[]} */
    const downloads = [];
    /**
     * @param {'logos' | 'screenshots'} group
     * @param {'logo' | 'screenshot'} label Part of the published file names.
     * @returns {Promise<PressKitAssetView[]>}
     */
    const assetsOf = async (group, label) => {
      /** @type {PressKitAssetView[]} */
      const views = [];
      for (const [index, asset] of kit[group].entries()) {
        const number = index + 1;
        const stem = `${project.slug}-${label}-${String(number).padStart(2, '0')}`;
        const absolute = join(project.dir, ...asset.file.split('/'));
        const source = posix(relative(config.dir, absolute));
        const field = `pressKit.${group}: item ${number}`;

        if (asset.kind === 'svg') {
          const bytes = readFileSync(absolute);
          const svg = inspectSvg(bytes);
          const fileName = `${stem}.svg`;
          const address = `${url}${PRESS_KIT_DIR}/${fileName}`;
          const target = join(outDir, ...address.split('/').filter(Boolean));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes);
          downloads.push({
            field: group,
            source,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            url: address,
            file: address.slice(1),
            fileName,
            type: 'image/svg+xml',
            width: svg.width,
            height: svg.height,
            bytes: bytes.length,
            policy: null,
            gps: null,
            camera: null,
          });
          views.push({
            number,
            alt: asset.alt,
            thumbnail: { src: address, width: svg.width, height: svg.height, srcset: [], alt: asset.alt },
            url: address,
            fileName,
            format: 'SVG',
            width: svg.width,
            height: svg.height,
            size: fileSizeOf(bytes.length),
          });
          continue;
        }

        const thumbnail = await makeProjectPicture(project, field, absolute, asset.alt, url, page, 'press-kit');
        if (thumbnail === null) continue;
        try {
          const policy = page.policyFor(asset.file);
          const download = await images.download(absolute, {
            location: policy.location.value,
            camera: policy.camera.value,
          });
          const fileName = `${stem}${download.extension}`;
          const address = `${url}${PRESS_KIT_DIR}/${fileName}`;
          images.publishDownload(download, outDir, address);
          if (download.gps?.precision === 'exact') page.exact.add(download.source);
          downloads.push({
            field: group,
            source,
            sha256: download.sha256,
            url: address,
            file: address.slice(1),
            fileName,
            type: download.mime,
            width: download.width,
            height: download.height,
            bytes: download.bytes,
            policy: { location: policy.location, camera: policy.camera },
            gps: download.gps,
            camera: download.camera,
          });
          views.push({
            number,
            alt: asset.alt,
            thumbnail,
            url: address,
            fileName,
            format: download.format === 'png' ? 'PNG' : 'JPEG',
            width: download.width,
            height: download.height,
            size: fileSizeOf(download.bytes),
          });
        } catch (error) {
          if (!(error instanceof ImageError)) throw error;
          report.addError({ site: site.id, file: shown, message: `${field}: image '${asset.file}': ${error.message}` });
        }
      }
      return views;
    };

    const shortDescription = await describe('shortDescription');
    const longDescription = await describe('longDescription');
    const logos = await assetsOf('logos', 'logo');
    const screenshots = await assetsOf('screenshots', 'screenshot');
    return { kit, shortDescription, longDescription, logos, screenshots, downloads };
  };

  // The projects: each one's page text is rendered, and its card picture goes
  // through the image pipeline, before the links are checked.
  /**
   * @typedef {object} PreparedProject
   * @property {import('./content/projects.js').Project} project
   * @property {string} url Site-relative URL of the project's page.
   * @property {RenderedPost} rendered
   * @property {PageImages} page
   * @property {ProjectPicture | null} picture The card picture, or null when it could not be made (reported).
   * @property {Record<string, ProjectMedium | null>} media What the kind's `image`, `trailer` and `font-file` fields publish, by field name; null for a picture that could not be made (reported). A field that is not set has no entry.
   * @property {ManifestProjectFile[]} files The video and font files copied to the output for the project.
   * @property {PreparedPressKit | null} pressKit The press kit of a game that has one.
   * @property {import('./check/source-links.js').SourceFile} source The page as the link check sees it.
   * @property {Map<number, PreparedReadmeSection>} readmes The sections of the project's repository that the page's `::readme` directives show, by the number of the directive; a directive whose section could not be read has no entry (the problem is reported).
   */
  /**
   * A section of the README of a project, rendered for the project's page.
   *
   * @typedef {object} PreparedReadmeSection
   * @property {string} html The section, links rewritten, no map placeholders.
   * @property {number} carousels Number of carousels in it.
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
  /**
   * What a media field of a project publishes: a picture, a local video or an
   * embedded one for a `trailer`, or a font file.
   *
   * @typedef {(ProjectPicture & { type: 'image' }) | { type: 'video', url: string, mime: string } | { type: 'embed', provider: string, url: string } | { type: 'font', url: string, format: string }} ProjectMedium
   */
  /** @type {PreparedProject[]} */
  const preparedProjects = [];
  /** @type {Map<string, import('./docs/sources.js').FetchedDocs>} */
  let docsFetched = new Map();

  /**
   * A page of a project's documentation, rendered and ready to be written.
   *
   * @typedef {object} PreparedDocsPage
   * @property {string} url Site-relative address, ending in a slash.
   * @property {string} file Path of the HTML file, relative to the output directory.
   * @property {string} title
   * @property {string | null} titleId The `id` of the heading the title came from.
   * @property {string} html The body, without the title.
   * @property {string} description
   * @property {RenderedPost | null} rendered What the Markdown renderer found (headings, images); null for a generated index.
   * @property {import('./docs/guides.js').GuidePage | null} page The guide file; null for an index the build generates.
   */
  /**
   * The documentation of one project.
   *
   * @typedef {object} PreparedDocs
   * @property {string} indexUrl Site-relative address of the docs index.
   * @property {PreparedDocsPage[]} pages In sidebar order, the index first.
   * @property {string | null} github
   * @property {string} ref
   * @property {{ title: string, url: string } | null} reference The generated reference, which the sidebar and the generated index list after the guides.
   */
  /** @type {Map<string, PreparedDocs>} */
  const docsPrepared = new Map();

  /**
   * The generated reference of a project, ready to be written.
   *
   * @typedef {object} PreparedReference
   * @property {import('./docs/reference.js').ReferenceResult} result
   * @property {string} url Site-relative address, ending in a slash.
   * @property {string} title The configured title.
   * @property {ReturnType<typeof viewOfReference> | null} view What the template shows of a json reference; null for html.
   * @property {string[]} undocumented The names of the elements without documentation.
   * @property {import('./docs/symbols.js').SymbolIndex | null} symbols The symbols that guides can link to; null for an html reference that configures no index.
   * @property {boolean} autoLink Whether guides link inline code that names a symbol.
   */
  /** @type {Map<string, PreparedReference>} */
  const referencePrepared = new Map();

  /**
   * Splits the location off a Markdown error, which carries it in its message.
   *
   * @param {MarkdownError} error
   * @returns {string}
   */
  const markdownMessageOf = (error) => {
    const place = [error.file, error.line, error.line === undefined ? undefined : error.column].filter((part) => part !== undefined).join(':');
    return place !== '' && error.message.startsWith(`${place}: `) ? error.message.slice(place.length + 2) : error.message;
  };

  /**
   * Reads, renders and checks the guides of a project: selects the files,
   * renders them with the site's Markdown pipeline (images go through the image
   * pipeline), decides where every link leads, and takes the title from the first
   * heading. Findings are reported with `{repo}:{path}:{line}`.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {string} projectPageUrl
   * @param {import('./docs/sources.js').FetchedDocs} fetched
   * @param {ReturnType<typeof createResolver>} resolver
   * @param {PreparedReference | undefined} reference The generated reference of the project, if it has one.
   * @param {readonly import('./markdown/directives/readme.js').ReadmeDirective[]} directives The `::readme` directives of the project's page; their sections are rendered with the guides' link rewriting and put into `sections`.
   * @param {Map<number, PreparedReadmeSection>} sections Filled with the sections that could be read, by the number of the directive.
   * @returns {Promise<PreparedDocs | null>} Null when the project publishes no guide page and has no reference.
   */
  const prepareDocs = async (project, projectPageUrl, fetched, resolver, reference, directives, sections) => {
    const plan = planGuides(fetched);
    for (const issue of plan.issues) report.addError({ site: site.id, ...issue });
    for (const warning of plan.warnings) warnings.push(warning);
    const indexUrl = `${projectPageUrl}${site.urls.docs}/`;
    /** @param {import('./docs/guides.js').GuidePage} page */
    const urlOf = (page) => (page.slug === '' ? indexUrl : `${indexUrl}${page.slug}/`);
    /** @type {Map<import('./docs/guides.js').GuidePage, RenderedPost>} */
    const renderedPages = new Map();
    for (const guide of plan.pages) {
      const url = urlOf(guide);
      const sourceFile = join(fetched.root, ...guide.rel.split('/'));
      const images = pageImagesOf(sourceFile, null, resolver);
      images.shown = guide.label;
      pageImages.set(`docs:${project.slug}:${guide.rel}`, images);
      try {
        renderedPages.set(
          guide,
          await renderMarkdown(guide.text, {
            file: guide.label,
            images: imageOptionsFor(sourceFile, url, images, {
              shown: guide.label,
              locate: (src) => locateGuideImage(fetched.root, guide.rel, src),
            }),
            carousel: carouselLabels,
          }),
        );
      } catch (error) {
        if (!(error instanceof MarkdownError)) throw error;
        report.addError({ site: site.id, file: guide.label, line: error.line, column: error.column, message: markdownMessageOf(error) });
      }
    }
    // The sections of the README that the project's page shows are texts of the repository too: they are rendered like guides and their links are resolved from their own file.
    const pageFile = posix(relative(config.dir, project.pageFile));
    /** @type {{ directive: import('./markdown/directives/readme.js').ReadmeDirective, page: import('./docs/guides.js').GuidePage }[]} */
    const sectionPages = [];
    for (const directive of directives) {
      const read = readSection(fetched, directive);
      if (!read.ok) {
        report.addError({ site: site.id, file: pageFile, line: directive.line, column: directive.column, message: `::readme: ${read.message}` });
        continue;
      }
      const { page } = read.found;
      const sourceFile = join(fetched.root, ...page.rel.split('/'));
      const images = pageImagesOf(sourceFile, null, resolver);
      images.shown = page.label;
      pageImages.set(`docs:${project.slug}:${page.rel}:readme:${directive.index}`, images);
      const own = imageOptionsFor(sourceFile, projectPageUrl, images, {
        shown: page.label,
        locate: (src) => locateGuideImage(fetched.root, page.rel, src),
      });
      try {
        renderedPages.set(
          page,
          await renderMarkdown(page.text, {
            file: page.label,
            startLine: read.found.line,
            // The pictures of the section are plain pictures: the viewer of the page lists the images of the page's own text, and the project page's first picture is not among these.
            images: { ...own, leadingImage: true, resolve: async (request) => {
                const image = await own.resolve(request);
                return image === null ? null : { ...image, viewer: undefined };
              },
            },
            carousel: carouselLabels,
          }),
        );
        sectionPages.push({ directive, page });
      } catch (error) {
        if (!(error instanceof MarkdownError)) throw error;
        report.addError({ site: site.id, file: page.label, line: error.line, column: error.column, message: markdownMessageOf(error) });
      }
    }
    const ref = githubRefOf(fetched);
    const links = resolveGuideLinks(plan.pages, {
      sections: sectionPages.map((entry) => entry.page),
      root: fetched.root,
      repo: plan.repo,
      github: fetched.github,
      ref,
      urlOf,
      indexUrl,
      rendered: renderedPages,
      symbols: reference?.symbols ?? null,
    });
    for (const issue of links.issues) report.addError({ site: site.id, ...issue });
    for (const { directive, page } of sectionPages) {
      const rendered = /** @type {RenderedPost} */ (renderedPages.get(page));
      for (const map of rendered.maps) {
        warnings.push(`${page.label}:${map.line ?? 1}: the ::map directive is only for posts and is left out`);
      }
      const finished = finishGuidePage({
        page,
        html: rendered.html,
        rewrites: links.rewrites.get(page),
        refused: links.refused.get(page),
        indexTitle: '',
        symbols: reference?.symbols ?? null,
        autoLink: reference?.autoLink ?? true,
      });
      for (const issue of finished.issues) report.addError({ site: site.id, ...issue });
      sections.set(directive.index, { html: finished.html, carousels: rendered.carousels });
    }
    /** @type {PreparedDocsPage[]} */
    const pagesOut = [];
    for (const guide of plan.pages) {
      const rendered = renderedPages.get(guide);
      if (!rendered) continue;
      for (const directive of rendered.maps) {
        warnings.push(`${guide.label}:${directive.line ?? 1}: the ::map directive is only for posts and is left out`);
      }
      const finished = finishGuidePage({
        page: guide,
        html: rendered.html,
        rewrites: links.rewrites.get(guide),
        refused: links.refused.get(guide),
        indexTitle: t('docs.title'),
        symbols: reference?.symbols ?? null,
        autoLink: reference?.autoLink ?? true,
      });
      for (const issue of finished.issues) report.addError({ site: site.id, ...issue });
      const url = urlOf(guide);
      pagesOut.push({
        url,
        file: fileForUrl(url),
        title: finished.title,
        titleId: finished.titleId,
        html: finished.html,
        description: finished.description,
        rendered,
        page: guide,
      });
    }
    if (pagesOut.length === 0 && (plan.pages.length > 0 || !reference)) return null;
    // Without a README or an index file the docs index lists the pages.
    if (!pagesOut.some((entry) => entry.page?.isIndex)) {
      pagesOut.unshift({
        url: indexUrl,
        file: fileForUrl(indexUrl),
        title: t('docs.title'),
        titleId: null,
        html: '',
        description: project.pitch,
        rendered: null,
        page: null,
      });
    }
    return { indexUrl, pages: pagesOut, github: fetched.github, ref, reference: reference ? { title: reference.title, url: reference.url } : null };
  };

  /**
   * Generates the references of the projects that configure one (running the
   * commands that are not answered by the cache), and lists the elements without
   * documentation in the report. A reference that cannot be generated is an
   * error of the project's file.
   *
   * @param {readonly import('./content/projects.js').Project[]} loaded
   */
  const prepareReferences = async (loaded) => {
    for (const project of loaded) {
      const docs = /** @type {import('./docs/sources.js').DocsConfig | null | undefined} */ (project.fields.docs);
      const fetched = docsFetched.get(project.slug);
      if (!docs?.reference || !fetched) continue;
      const shown = posix(relative(config.dir, project.file));
      /** @type {import('./docs/reference.js').ReferenceResult} */
      let result;
      try {
        result = await generateReference({
          slug: project.slug,
          reference: docs.reference,
          fetched,
          siteDir: config.dir,
          cacheDir: join(cacheRoot, DOCS_REFERENCE_CACHE_DIR),
          timeoutMs: options.reference?.timeoutMs,
          env: options.reference?.env,
        });
      } catch (error) {
        if (!(error instanceof ReferenceFailure)) throw error;
        report.addError({ site: site.id, file: shown, message: `docs.reference: ${error.message}` });
        continue;
      }
      const view = result.model ? viewOfReference(result.model, result.undocumentedNames) : null;
      const undocumented = [...new Set([...(view?.undocumented.map((entry) => entry.name) ?? []), ...result.undocumentedNames])];
      for (const entry of view?.undocumented ?? []) {
        warnings.push(`${shown}: docs.reference: "${entry.name}" (${entry.section}) has no documentation`);
      }
      for (const name of result.undocumentedNames) {
        if (!view?.undocumented.some((entry) => entry.name === name)) warnings.push(`${shown}: docs.reference: "${name}" has no documentation`);
      }
      for (const name of result.skipped) warnings.push(`${shown}: docs.reference: the link "${name}" in the generated folder is not published`);
      const referenceUrl = `${projectUrl(site.urls.projects, project.slug)}${site.urls.docs}/reference/`;
      /** @type {import('./docs/symbols.js').SymbolIndex | null} */
      let symbols = null;
      try {
        if (view) symbols = indexOfView(view, referenceUrl);
        else if (docs.reference.index) symbols = indexOfHtmlReference(docs.reference.index, result.dataDir, referenceUrl);
      } catch (error) {
        if (!(error instanceof SymbolIndexError)) throw error;
        report.addError({ site: site.id, file: shown, message: `docs.reference.index: ${error.message}` });
        continue;
      }
      referencePrepared.set(project.slug, {
        result,
        url: referenceUrl,
        title: docs.reference.title,
        view,
        undocumented,
        symbols,
        autoLink: docs.reference.autoLink,
      });
    }
  };

  if (site.projects) {
    const projectResolver = createResolver(new Map(), null);
    const loadedProjects = loadProjects(site.projects.dir);
    // The documentation sources are fetched before anything is rendered, and a source that cannot be fetched fails the build: there is no fallback to empty documentation.
    docsFetched = await fetchDocsSources(
      loadedProjects.flatMap((project) =>
        project.fields.docs ? [{ slug: project.slug, docs: /** @type {import('./docs/sources.js').DocsConfig} */ (project.fields.docs) }] : [],
      ),
      { cacheDir: join(cacheRoot, DOCS_REPOS_CACHE_DIR), ...options.docsFetch },
    );
    await prepareReferences(loadedProjects);
    for (const project of loadedProjects) {
      const url = projectUrl(site.urls.projects, project.slug);
      const page = pageImagesOf(project.pageFile, null, projectResolver);
      pageImages.set(project.pageFile, page);
      const rendered = await renderMarkdown(project.body, {
        file: project.pageFile,
        startLine: project.bodyLine,
        // A game page starts with its logo or key art, which is the eager image; the pictures of the text then are all lazy.
        images: { ...imageOptionsFor(project.pageFile, url, page), leadingImage: Boolean(project.fields.logo || project.fields.keyArt) },
        carousel: carouselLabels,
        // Only the page of a project with a docs source can show a section of its README.
        readme: docsFetched.has(project.slug),
      });
      const makePicture = (/** @type {string} */ field, /** @type {string} */ file, /** @type {string} */ alt) =>
        makeProjectPicture(project, field, file, alt, url, page);
      const picture = await makePicture('card', project.card, project.cardAlt);
      /** @type {Record<string, ProjectMedium | null>} */
      const media = {};
      /** @type {ManifestProjectFile[]} */
      const files = [];
      /** @type {Map<number, PreparedReadmeSection>} */
      const readmes = new Map();
      const kind = /** @type {import('./content/project-kinds.js').ProjectKind} */ (getProjectKind(project.kind));
      for (const [field, spec] of Object.entries(kind.fields)) {
        const value = project.fields[field];
        if (value === null || value === undefined) continue;
        if (spec.type === 'image') {
          const alt = project.fields[`${field}Alt`];
          const made = await makePicture(field, join(project.dir, ...String(value).split('/')), typeof alt === 'string' ? alt : '');
          media[field] = made === null ? null : { type: 'image', ...made };
        } else if (spec.type === 'trailer') {
          const trailer = /** @type {{ type: 'file', file: string, mime: string } | { type: 'embed', provider: string, url: string }} */ (value);
          media[field] =
            trailer.type === 'embed'
              ? trailer
              : { type: 'video', url: publishProjectFile(project, url, field, trailer.file, files), mime: trailer.mime };
        } else if (spec.type === 'font-file') {
          const file = String(value);
          const format = FONT_FILE_FORMATS[/** @type {keyof typeof FONT_FILE_FORMATS} */ (extname(file).toLowerCase())];
          media[field] = { type: 'font', url: publishProjectFile(project, url, field, file, files), format };
        }
      }
      const kit = /** @type {import('./content/project-kinds.js').PressKit | null | undefined} */ (project.fields.pressKit);
      const pressKit = kit ? await preparePressKit(project, url, kit, page) : null;
      preparedProjects.push({
        project,
        url,
        rendered,
        page,
        picture,
        media,
        files,
        pressKit,
        source: { slug: project.slug, kind: 'folder', file: project.pageFile, dir: project.dir, draft: false },
        readmes,
      });
      const fetchedDocs = docsFetched.get(project.slug);
      if (fetchedDocs) {
        const prepared = await prepareDocs(project, url, fetchedDocs, projectResolver, referencePrepared.get(project.slug), rendered.readmes, readmes);
        if (prepared) docsPrepared.set(project.slug, prepared);
      }
    }
  }
  for (const entry of preparedProjects) {
    // The press kit section has the anchor "press-kit", which links may point at.
    sourcePosts.push({
      post: entry.source,
      url: entry.url,
      rendered: entry.pressKit ? { ...entry.rendered, ids: [...entry.rendered.ids, 'press-kit'] } : entry.rendered,
    });
    for (const description of [entry.pressKit?.shortDescription, entry.pressKit?.longDescription]) {
      // The descriptions are shown inside the press kit section, so `#press-kit` is a valid anchor for them too.
      if (description) {
        sourcePosts.push({
          post: description.source,
          url: description.url,
          rendered: { ...description.rendered, ids: [...description.rendered.ids, 'press-kit'] },
        });
      }
    }
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
    if (entry.rendered.readmes.length > 0) {
      // The sections come after the link rewrites of the page: their links were resolved from the file they come from.
      entry.rendered = {
        ...entry.rendered,
        html: fillReadmeSections(entry.rendered.html, new Map([...entry.readmes].map(([index, section]) => [index, section.html]))),
        carousels: entry.rendered.carousels + [...entry.readmes.values()].reduce((sum, section) => sum + section.carousels, 0),
      };
    }
    for (const description of [entry.pressKit?.shortDescription, entry.pressKit?.longDescription]) {
      if (description) description.html = applyLinkRewrites(description.html, linkCheck.rewrites.get(description.source));
    }
  }

  // Which posts are about which project. A post is about a project when one of
  // its tags is the project's tag or lies below it, or when its front matter
  // lists the project (see `content/project-posts.js`). This is decided before
  // any page is written: a post ends with the blocks of its projects, and a
  // project's page and feed list its posts, from every blog of the site.
  const projectRefs = preparedProjects.map(({ project }) => ({ slug: project.slug, tag: project.tag }));
  const projectSlugs = projectRefs.map((entry) => entry.slug);
  /**
   * The slugs of the projects each built post is about, in the order of the projects page.
   * @type {Map<Post, string[]>}
   */
  const aboutPost = new Map();
  /**
   * The published posts about each project, newest first. A draft, or a post
   * dated after `now` that a preview build renders, is never listed.
   * @type {Map<string, import('./content/project-posts.js').ProjectPostRef[]>}
   */
  const publishedAbout = new Map(projectSlugs.map((slug) => [slug, []]));
  for (const blog of site.blogs) {
    const { selected, rendered } = /** @type {{ selected: Post[], rendered: Map<Post, RenderedPost> }} */ (
      prepared.get(blog.id)
    );
    for (const post of selected) {
      const about = projectsOfPost(post, projectRefs);
      for (const slug of about.unknown) {
        report.addError({
          site: site.id,
          file: posix(relative(config.dir, post.file)),
          message: unknownProjectMessage(slug, projectSlugs),
        });
      }
      aboutPost.set(post, about.slugs);
      if (!isPublished(post, { now })) continue;
      for (const slug of about.slugs) {
        publishedAbout.get(slug)?.push({
          url: postUrl(blog, post.slug),
          title: post.title,
          date: post.date,
          summary: post.summary,
          readingMinutes: rendered.get(post)?.readingMinutes ?? 0,
        });
      }
    }
  }
  for (const [slug, list] of publishedAbout) publishedAbout.set(slug, newestFirst(list));

  /** @type {ManifestProject[]} */
  const manifestProjects = [];
  /** @param {string} kind */
  const kindLabelOf = (kind) => (templates.translator.has(`projects.kind.${kind}`) ? t(`projects.kind.${kind}`) : kind);
  /**
   * The accent colour and display font of a project's page, as safe CSS.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {Record<string, ProjectMedium | null>} media
   */
  const projectStyleOf = (project, media) => {
    const accent = project.fields.accent;
    const displayFont = project.fields.displayFont;
    const font = media.displayFontFile;
    return projectStyle({
      accent: typeof accent === 'string' ? accent : null,
      displayFont: typeof displayFont === 'string' ? displayFont : null,
      font: font?.type === 'font' ? { url: font.url, format: font.format } : null,
    });
  };
  /**
   * What the template of a game shows as its press kit: the factsheet (the
   * fields that are known, the game's own platforms and price standing in for
   * ones the press kit does not give), the rendered descriptions and the
   * assets to download.
   *
   * @param {import('./content/projects.js').Project} project
   * @param {PreparedPressKit | null} prepared
   */
  const pressKitViewOf = (project, prepared) => {
    if (prepared === null) return null;
    const { kit } = prepared;
    const platforms = kit.platforms ?? /** @type {string[]} */ (project.fields.platforms ?? []);
    const price = kit.price ?? /** @type {string | null | undefined} */ (project.fields.price) ?? null;
    return {
      developer: kit.developer,
      releaseStatus: kit.releaseStatus ?? t(`projects.status.${project.status}`),
      platforms: platforms.length > 0 ? platforms : null,
      price,
      shortDescription: prepared.shortDescription?.html ?? null,
      longDescription: prepared.longDescription?.html ?? null,
      logos: prepared.logos,
      screenshots: prepared.screenshots,
    };
  };
  /**
   * The store buttons of a project: the links of `stores` that are set, itch
   * first. Other store names are not shown.
   *
   * @param {import('./content/projects.js').Project} project
   * @returns {{ name: string, label: string, url: string }[]}
   */
  const storeLinksOf = (project) => {
    const stores = /** @type {Record<string, unknown> | null | undefined} */ (project.fields.stores);
    if (typeof stores !== 'object' || stores === null) return [];
    return ['itch', 'steam'].flatMap((name) => {
      const url = stores[name];
      return typeof url === 'string' && url !== '' ? [{ name, label: t(`projects.game.${name}`), url }] : [];
    });
  };
  /** A project has a feed when the site has a blog, which holds the posts the feed lists. */
  const hasProjectFeeds = site.blogs.length > 0;
  const latestProjectPosts = site.projects?.latestPosts ?? 0;
  const projectViews = preparedProjects.map(({ project, url, picture, media, pressKit }) => {
    const feed = hasProjectFeeds ? { url: feedUrlFor(url), title: t('feeds.project', { title: project.name }) } : null;
    return {
      pressKit: pressKitViewOf(project, pressKit),
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
      // The link is written only when the documentation pages are built, so that it never leads to a page that does not exist.
      docsUrl: docsPrepared.get(project.slug)?.indexUrl ?? null,
      storeLinks: storeLinksOf(project),
      picture,
      media,
      style: projectStyleOf(project, media),
      feed,
      devlogUrl: feed?.url ?? null,
      posts: (publishedAbout.get(project.slug) ?? []).slice(0, latestProjectPosts),
    };
  });
  const projectViewBySlug = new Map(projectViews.map((view) => [view.slug, view]));
  /**
   * The block at the end of a post about a project, and the badge near its
   * title: the project, its links and up to three other recent posts about it.
   *
   * @param {string} slug
   * @param {string} pageUrl Site-relative URL of the post, which the block's list leaves out.
   */
  const projectBlockOf = (slug, pageUrl) => {
    const view = /** @type {(typeof projectViews)[number]} */ (projectViewBySlug.get(slug));
    return {
      slug,
      name: view.name,
      pitch: view.pitch,
      url: view.url,
      kind: view.kind,
      docsUrl: view.docsUrl,
      storeLinks: view.storeLinks,
      feed: view.feed,
      posts: (publishedAbout.get(slug) ?? [])
        .filter((other) => other.url !== pageUrl)
        .slice(0, PROJECT_BLOCK_POSTS)
        .map(({ url, title, date }) => ({ url, title, date })),
    };
  };
  /**
   * The feed entries of the published posts about each project, from every
   * blog; the project feeds are written after the blogs.
   * @type {Map<string, import('./feeds.js').FeedEntry[]>}
   */
  const projectFeedEntries = new Map(projectSlugs.map((slug) => [slug, []]));

  /** @type {((searchable: boolean) => void)[]} */
  const searchPageWriters = [];

  // The pictures of the site settings `icon` and `logo` are checked once the
  // theme assets are in the output and before any feed is written.
  if (site.icon !== null) site.iconUrl = checkSitePicture(site, outDir, 'icon', site.icon, true);
  if (site.logo !== null) site.logoUrl = checkSitePicture(site, outDir, 'logo', site.logo, false);
  // The files for the root of the site are read now, so that a wrong setting fails early, and written once every page is.
  /** @type {{ setting: 'favicon' | 'appleTouchIcon', source: string, file: string, bytes: Buffer }[]} */
  const rootIcons = [];
  for (const setting of /** @type {const} */ (['favicon', 'appleTouchIcon'])) {
    const source = site[setting];
    if (source !== null) rootIcons.push({ setting, source, file: ROOT_ICON_FILES[setting], bytes: checkRootIcon(site, outDir, setting, source) });
  }

  for (const blog of site.blogs) {
    const { selected, rendered: renderedPosts, listRendered, tagMeta } = /** @type {{ selected: Post[], rendered: Map<Post, RenderedPost>, listRendered: Map<Post, RenderedPost>, tagMeta: ReturnType<typeof loadTagMeta> }} */ (
      prepared.get(blog.id)
    );

    const blogBase = blogUrl(blog);
    const clash = selected.find((post) => post.slug === site.urls.tags);
    if (clash) {
      throw new BuildError(
        `${clash.file}: slug: "${clash.slug}" is the address of the tag pages of the blog "${blog.id}" (${tagUrl(blogBase, site.urls.tags)}); rename the post or change "urls.tags"`,
      );
    }
    if (selected.some((post) => post.slug === SEARCH_URL_NAME)) {
      throw new BuildError(
        `a post with the slug "${SEARCH_URL_NAME}" in the blog "${blog.id}" would collide with the blog's search page (${searchPageUrl(blogBase)}); rename the post`,
      );
    }
    if (site.urls.tags === SEARCH_URL_NAME || site.urls.series === SEARCH_URL_NAME) {
      throw new BuildError(
        `"urls.${site.urls.tags === SEARCH_URL_NAME ? 'tags' : 'series'}" is "${SEARCH_URL_NAME}", the address of the search page of the blog "${blog.id}" (${searchPageUrl(blogBase)}); choose another name`,
      );
    }
    if (selected.some((post) => post.slug === FEED_FILE_NAME)) {
      throw new BuildError(
        `a post with the slug "${FEED_FILE_NAME}" in the blog "${blog.id}" would collide with the blog's feed (${feedUrlFor(blogBase)}); rename the post`,
      );
    }
    if (blog.index.pageSize !== null) {
      const pageClash = selected.find((post) => post.slug === PAGE_URL_NAME);
      if (pageClash) {
        throw new BuildError(
          `${pageClash.file}: slug: "${pageClash.slug}" is the address of the pages of the paginated index of the blog "${blog.id}" (${blogBase}${PAGE_URL_NAME}/2/); rename the post`,
        );
      }
      if (site.urls.tags === PAGE_URL_NAME || site.urls.series === PAGE_URL_NAME) {
        throw new BuildError(
          `"urls.${site.urls.tags === PAGE_URL_NAME ? 'tags' : 'series'}" is "${PAGE_URL_NAME}", the address of the pages of the paginated index of the blog "${blog.id}" (${blogBase}${PAGE_URL_NAME}/2/); choose another name`,
        );
      }
    }
    const tagTree = buildTagTree(selected);
    const clashingTag = tagTree.all.find((node) => node.path.includes('/') && node.path.split('/').pop() === FEED_FILE_NAME);
    if (clashingTag) {
      throw new BuildError(
        `the tag "${clashingTag.path}" of the blog "${blog.id}" would collide with the feed of its parent; rename the tag`,
      );
    }
    if (blog.index.pageSize !== null) {
      // The pages after the first of a tag page are at `{tag}/page/n/`, which a tag of that path would share.
      const taken = new Set(tagTree.all.map((node) => node.path));
      for (const node of tagTree.all) {
        const pageCount = Math.ceil(node.posts.length / blog.index.pageSize);
        if (pageCount < 2) continue;
        for (let n = 1; n <= pageCount; n += 1) {
          const path = `${node.path}/${PAGE_URL_NAME}/${n}`;
          if (taken.has(path)) {
            throw new BuildError(
              `the tag "${path}" of the blog "${blog.id}" would collide with page ${n} of the tag "${node.path}" (${pageUrl(tagUrl(blogBase, site.urls.tags, node.path), n)}); rename the tag`,
            );
          }
        }
      }
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
    /**
     * The post bodies that list pages show in full (`post.html`), by the address
     * of the post. Neither the table of contents, the series box, the project
     * blocks nor the share summary are part of them.
     * @type {Map<string, { post: Post, url: string, rendered: RenderedPost, hasMap: boolean }>}
     */
    const listBodies = new Map();
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
      const forLists = listRendered.get(post);
      // The maps are the same as on the post page; their problems were reported there.
      if (forLists) listBodies.set(url, { post, url, rendered: forLists, hasMap: mapped.maps.length > 0 });

      const aboutProjects = aboutPost.get(post) ?? [];
      if (!unpublished) {
        const feedEntry = createFeedEntry({
          baseUrl: site.baseUrl,
          url,
          title: post.title,
          date: post.date,
          summary: post.summary,
          html: mapped.feedHtml,
          tags: post.tags.map((path) => ({ path, name: nameOf(path) })),
          tagsIndexUrl,
        });
        feedEntries.set(post, feedEntry);
        for (const slug of aboutProjects) projectFeedEntries.get(slug)?.push(feedEntry);
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
        blog.index.type,
      );
      const projectBlocks = aboutProjects.map((slug) => projectBlockOf(slug, url));
      const previewImage = await previewImageOf(post, url);
      warnUnusedImageEntries(/** @type {PageImages} */ (pageImages.get(post.file)));
      const file = fileForUrl(url);
      const assets = pageAssetsFor(rendered, mapped.maps.length > 0);
      /**
       * The share summary of the post: its text, shown in the post and written to `share.txt`.
       * @type {{ text: string, url: string, file: string } | null}
       */
      let share = null;
      if (blog.shareSummary) {
        if (post.kind === 'folder' && readdirSync(post.dir).some((name) => name.toLowerCase() === SHARE_FILE_NAME)) {
          throw new BuildError(
            `${shownFile}: the file "${SHARE_FILE_NAME}" in the folder of the post would collide with the share summary the blog "${blog.id}" writes at ${shareUrlFor(url)} ("shareSummary: true"); rename the file or switch the share summary off`,
          );
        }
        share = {
          text: renderShareText({
            baseUrl: site.baseUrl,
            url,
            title: post.title,
            summary: post.summary || excerptOf(mapped.feedHtml),
            hashtags: blog.shareHashtags ? hashtagsFor(post.tags.map(nameOf)) : [],
          }),
          url: shareUrlFor(url),
          file: `${posix(dirname(file))}/${SHARE_FILE_NAME}`,
        };
        if (existsSync(join(outDir, ...share.file.split('/')))) {
          throw new BuildError(
            `${shownFile}: the share summary of the post (${share.url}) would overwrite a file the build has already written there`,
          );
        }
      }
      const html = templates.render('post.njk', {
        site,
        nav,
        blog,
        feedLinks: feedLinksFor(blog, [
          ...post.tags.map(tagFeedLink),
          ...(view.series ? [seriesFeedLink(view.series.slug)] : []),
          ...projectBlocks.flatMap((block) => (block.feed ? [block.feed] : [])),
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
        projectBlocks,
        series: view.series,
        toc: rendered.toc,
        ...assets,
        scripts: share ? [...assets.scripts, SHARE_SCRIPT] : assets.scripts,
        share,
        page: {
          title: post.title,
          description: post.summary ?? '',
          content: mapped.html,
        },
      });
      writeOutput(outDir, file, html);
      if (share) writeOutput(outDir, share.file, share.text);
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
        index: view.index,
        share: share ? { url: share.url, file: share.file } : null,
        series: view.series
          ? { slug: view.series.slug, number: view.series.number, count: view.series.count }
          : null,
        tracks: manifestTracks,
        maps: mapped.maps.map((map) => map.summary),
      });
    }

    const views = entries.map(({ post, url, readingMinutes, unpublished }) =>
      postView(
        post,
        url,
        readingMinutes,
        unpublished,
        post.tags.map((path) => ({ path, name: nameOf(path), url: urlOf(path) })),
        null,
        blog.index.type,
      ),
    );
    if (blog === site.blogs[0]) firstBlogPosts = views;

    /** The maps of a post body on a list page, by post address and number of images before it (a map is drawn once per place). */
    const listMaps = new Map();
    /**
     * Puts the body into each post of a list page that shows its post in full
     * and returns what the page needs for those bodies. The page has one viewer:
     * the images of the bodies are listed in the order of the page, and the
     * links and map markers of each body count on from the images before it.
     * The result goes into the page's template variables.
     *
     * @template {{ url: string }} V
     * @param {V[]} listed The posts of the page, in order.
     * @returns {{ posts: (V & { html: string })[], scripts: string[], styles: string[], viewerData: string }}
     */
    const withBodies = (listed) => {
      /** @type {PageText[]} */
      const texts = [];
      let offset = 0;
      let withMap = false;
      const posts = listed.map((view) => {
        const body = listBodies.get(view.url);
        if (!body) return { ...view, html: '' };
        const key = `${view.url}@${offset}`;
        let html = listMaps.get(key);
        if (html === undefined) {
          html = renderPostMaps({
            lang: site.lang,
            basePath: templates.basePath,
            tiles: site.map,
            templates,
            rendered: body.rendered,
            tracks: postTracks.get(body.post) ?? [],
            url: body.url,
            enabled: body.post.map !== false,
            viewerOffset: offset,
          }).html;
          listMaps.set(key, html);
        }
        texts.push(body.rendered);
        offset += body.rendered.viewerImages.length;
        withMap ||= body.hasMap;
        return { ...view, html };
      });
      return { posts, ...pageAssetsFor(texts, withMap) };
    };

    const indexUrl = blogBase;
    const blogFeedLink = /** @type {FeedLink} */ (blogFeeds.get(blog.id));
    // A blog with a page size splits its lists (the index, every tag page and
    // every series page) into pages when they have more posts than fit on one.
    // The first page stays at the address of the list and the non-canonical
    // spelling of it redirects there. Feeds are never paginated.
    /**
     * @template T
     * @param {object} list
     * @param {string} list.url Address of the list, ending in a slash.
     * @param {T[]} list.items
     * @param {string} list.title Title of the list; pages after the first add "(Page n of m)" to the one in the meta tags.
     * @param {'blog-index' | 'tag' | 'series'} list.type
     * @param {string} list.source What the redirect of the first page is for, in messages.
     * @param {(listPage: import('./pagination.js').ListPage<T>, metaTitle: string) => string} list.render
     */
    const writeListPages = ({ url, items, title, type, source, render }) => {
      const listPages = paginate(items, blog.index.pageSize, url);
      const firstAliases = firstPageAliases(url, listPages);
      if (firstAliases.length > 0) aliasing.push({ url, aliasUrls: firstAliases, source });
      for (const listPage of listPages) {
        const { pagination } = listPage;
        const metaTitle =
          pagination && pagination.page > 1
            ? `${title} (${templates.translator.t('pagination.page', { page: pagination.page, pages: pagination.pages })})`
            : title;
        const file = fileForUrl(listPage.url);
        writeOutput(outDir, file, render(listPage, metaTitle));
        pages.push({ url: listPage.url, file, type, title });
      }
    };

    writeListPages({
      url: indexUrl,
      items: views,
      title: blog.title,
      type: 'blog-index',
      source: `blog "${blog.id}"`,
      render: (listPage, metaTitle) =>
        templates.render('blog-index.njk', {
          site,
          nav,
          blog,
          feedLinks: feedLinksFor(blog),
          meta: metaFor({ title: metaTitle, description: site.description, url: listPage.url, image: cardFor(blog.title) }),
          pageFeed: blogFeedLink,
          ...withBodies(listPage.items),
          pagination: listPage.pagination,
          tagsUrl: tagUrl(blogBase, site.urls.tags),
          page: { title: blog.title, description: site.description, content: '' },
        }),
    });

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

    // The search page is written once every page that goes into the index is known: an index
    // with nothing in it cannot be searched, so then the page says there is nothing yet.
    searchPageWriters.push((searchable) => {
      const searchUrl = searchPageUrl(blogBase);
      const searchTitle = t('search.title');
      const searchHtml = templates.render('search.njk', {
        site,
        nav,
        blog,
        feedLinks: feedLinksFor(blog),
        meta: metaFor({
          title: `${searchTitle}: ${blog.title}`,
          description: site.description,
          url: searchUrl,
          image: cardFor(`${searchTitle}: ${blog.title}`),
        }),
        tagsUrl: tagsIndexUrl,
        searchUrl,
        searchable,
        searchData: {
          bundle: `${templates.basePath}/${SEARCH_DIR_NAME}/`,
          filters: { [BLOG_FILTER]: blog.id },
          text: {
            searching: t('search.searching'),
            found: t('search.found'),
            none: t('search.none'),
            error: t('search.error'),
          },
        },
        scripts: searchable ? [`/${SEARCH_DIR_NAME}/pagefind-modular-ui.js`, '/assets/search.js'] : [],
        page: { title: searchTitle, description: '', content: '' },
      });
      const searchFile = fileForUrl(searchUrl);
      writeOutput(outDir, searchFile, searchHtml);
      pages.push({ url: searchUrl, file: searchFile, type: 'search', title: searchTitle });
    });

    for (const node of tagTree.all) {
      const view = treeView(node);
      const tagPostUrls = node.posts.map((post) => postUrl(blog, post.slug));
      const tagFeed = tagFeedLink(node.path);
      const tagViews = tagPostUrls.flatMap((address) => viewByUrl.get(address) ?? []);
      writeListPages({
        url: view.url,
        items: tagViews,
        title: view.name,
        type: 'tag',
        source: `tag "${node.path}" of blog "${blog.id}"`,
        render: (listPage, metaTitle) =>
          templates.render('tag.njk', {
            site,
            nav,
            blog,
            feedLinks: feedLinksFor(blog, [tagFeed]),
            meta: metaFor({ title: metaTitle, description: view.description, url: listPage.url, image: cardFor(view.name) }),
            pageFeed: tagFeed,
            tagsUrl: tagsIndexUrl,
            tag: view,
            ancestors: tagPaths(node.path)
              .slice(0, -1)
              .map((path) => ({ path, name: nameOf(path), url: urlOf(path) })),
            children: view.children,
            ...withBodies(listPage.items),
            pagination: listPage.pagination,
            page: { title: view.name, description: view.description, content: '' },
          }),
      });
      const file = fileForUrl(view.url);
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
      writeListPages({
        url,
        items: parts,
        title: entry.name,
        type: 'series',
        source: `series "${entry.slug}" of blog "${blog.id}"`,
        render: (listPage, metaTitle) =>
          templates.render('series.njk', {
            site,
            nav,
            blog,
            feedLinks: feedLinksFor(blog, [seriesFeed]),
            meta: metaFor({ title: metaTitle, description: entry.description ?? '', url: listPage.url, image: cardFor(entry.name) }),
            pageFeed: seriesFeed,
            ...withBodies(listPage.items),
            pagination: listPage.pagination,
            series: {
              slug: entry.slug,
              name: entry.name,
              description: entry.description ?? '',
              url,
              count: entry.count,
            },
            page: { title: entry.name, description: entry.description ?? '', content: '' },
          }),
      });
      const file = fileForUrl(url);
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
      const selfUrl = absoluteUri(site.baseUrl, url);
      writeOutput(
        outDir,
        url.slice(1),
        renderFeed({
          lang: site.lang,
          selfUrl,
          alternateUrl: absoluteUri(site.baseUrl, page),
          title,
          subtitle,
          author: site.author,
          updated: chosen[0]?.updated ?? now,
          generator: { name: 'coffer', version },
          icon: site.iconUrl ?? null,
          logo: site.logoUrl ?? null,
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
        project: null,
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

  // The feed of each project: the published posts about it from every blog,
  // newest first, the latest `feeds.limit` of them. A project that no post is
  // about still has a feed, with no entries, so the address a page links to
  // always exists. The feed has the address `{projects}/{slug}/feed.xml`, which
  // no file the build publishes for a project can have (those have names the
  // build chooses); a kind that publishes such a file is reported.
  if (hasProjectFeeds) {
    const siteTitle = site.title;
    for (const { project, url, files, pressKit } of preparedProjects) {
      const feedUrl = feedUrlFor(url);
      const taken = new Set([...files.map((file) => file.url), ...(pressKit?.downloads ?? []).map((file) => file.url)]);
      // A blog whose prefix is the project's address has the same feed, but it has the project page's file too, and that clash is reported below.
      if (taken.has(feedUrl) || manifestFeeds.some((feed) => feed.type !== 'blog' && feed.url === feedUrl)) {
        report.addError({
          site: site.id,
          file: posix(relative(config.dir, project.file)),
          message: `the feed of the project (${feedUrl}) would be written over another file or feed of the site; rename the project folder`,
        });
        continue;
      }
      const chosen = selectEntries(projectFeedEntries.get(project.slug) ?? [], site.feeds.limit);
      const selfUrl = absoluteUri(site.baseUrl, feedUrl);
      const title = `${project.name} | ${siteTitle}`;
      writeOutput(
        outDir,
        feedUrl.slice(1),
        renderFeed({
          lang: site.lang,
          selfUrl,
          alternateUrl: absoluteUri(site.baseUrl, url),
          title,
          subtitle: project.pitch,
          author: site.author,
          updated: chosen[0]?.updated ?? now,
          generator: { name: 'coffer', version },
          icon: site.iconUrl ?? null,
          logo: site.logoUrl ?? null,
          entries: chosen,
        }),
      );
      manifestFeeds.push({
        type: 'project',
        blog: null,
        url: feedUrl,
        selfUrl,
        file: feedUrl.slice(1),
        page: url,
        title,
        entries: chosen.length,
        tag: null,
        series: null,
        project: project.slug,
      });
    }
  }

  // The projects page and one page per project; the views of the projects were made before the posts.
  if (projectsIndexUrl) {
    for (const entry of preparedProjects) {
      const { project, url, rendered, page, picture, files } = entry;
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
        feedLinks: feedLinksFor(null, view.feed ? [view.feed] : []),
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

      // The pages of the project's documentation.
      const docs = docsPrepared.get(project.slug);
      /** @type {ManifestDocsPage[]} */
      const docsManifestPages = [];
      /** @type {ManifestReference | null} */
      let referenceManifest = null;
      if (docs) {
        const sidebar = docs.pages.map((entry) => ({ title: entry.title, url: entry.url }));
        if (docs.reference) sidebar.push({ title: docs.reference.title, url: docs.reference.url });
        for (const [position, entry] of docs.pages.entries()) {
          const previous = docs.pages[position - 1];
          const next = docs.pages[position + 1];
          const isIndex = entry.url === docs.indexUrl;
          const sourceUrl =
            entry.page && docs.github
              ? githubUrl({ github: docs.github, ref: docs.ref, kind: 'blob', path: entry.page.rel })
              : null;
          const docsHtml = templates.render('docs.njk', {
            site,
            nav,
            feedLinks: feedLinksFor(null, view.feed ? [view.feed] : []),
            meta: metaFor({
              title: isIndex ? `${t('docs.title')}: ${project.name}` : `${entry.title}: ${project.name}`,
              description: entry.description || project.pitch,
              url: entry.url,
              image: picture ? picture.src : cardFor(project.name),
            }),
            project: view,
            projectsUrl: projectsIndexUrl,
            toc: entry.rendered?.toc ?? [],
            docs: {
              isIndex,
              generated: entry.page === null,
              indexUrl: docs.indexUrl,
              url: entry.url,
              titleId: entry.titleId,
              sidebar: sidebar.map((item) => ({ ...item, current: item.url === entry.url })),
              previous: previous ? { title: previous.title, url: previous.url } : null,
              next: next ? { title: next.title, url: next.url } : null,
              sourceUrl,
            },
            ...pageAssetsFor(entry.rendered),
            page: { title: entry.title, description: entry.description, content: entry.html },
          });
          writeOutput(outDir, entry.file, docsHtml);
          pages.push({ url: entry.url, file: entry.file, type: 'docs', title: entry.title });
          docsManifestPages.push({
            url: entry.url,
            file: entry.file,
            source: entry.page ? entry.page.rel : null,
            title: entry.title,
          });
        }

        // The generated reference: a folder of HTML copied as it is, or the page made of a json file. Both lead back to the site.
        const generated = referencePrepared.get(project.slug);
        if (generated) {
          const bar = backBarHtml(
            siteUrl(url, templates.basePath),
            t('reference.back', { project: project.name, site: site.title }),
          );
          const referenceFile = fileForUrl(generated.url);
          if (generated.result.format === 'html') {
            const published = publishReferenceFolder(generated.result.dataDir, join(outDir, ...dirname(referenceFile).split('/')), bar);
            referenceManifest = { url: generated.url, file: referenceFile, format: 'html', title: generated.title, files: published.files, items: null, undocumented: generated.undocumented, cached: generated.result.cached };
          } else {
            const view = /** @type {NonNullable<typeof generated.view>} */ (generated.view);
            writeOutput(
              outDir,
              referenceFile,
              templates.render('reference.njk', {
                lang: site.lang,
                heading: view.title ?? generated.title,
                project: { name: project.name, url },
                bar,
                sections: view.sections,
                itemCount: view.itemCount,
                undocumentedCount: view.undocumented.length,
              }),
            );
            referenceManifest = { url: generated.url, file: referenceFile, format: 'json', title: generated.title, files: 1, items: view.itemCount, undocumented: generated.undocumented, cached: generated.result.cached };
          }
        }
      }
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
        posts: (publishedAbout.get(project.slug) ?? []).map((post) => post.url),
        feed: view.feed ? view.feed.url : null,
        card: posix(relative(config.dir, project.card)),
        files,
        docs: docsFetched.has(project.slug)
          ? { ...manifestDocs(/** @type {import('./docs/sources.js').FetchedDocs} */ (docsFetched.get(project.slug)), config.dir), pages: docsManifestPages, reference: referenceManifest }
          : null,
        downloads: entry.pressKit?.downloads ?? [],
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

  // What the full-text index covers: the published posts and the guides.
  const searchPages = [
    ...manifestPosts.filter((entry) => entry.published).map((entry) => ({ url: entry.url, file: entry.file })),
    ...pages.filter((entry) => entry.type === 'docs').map((entry) => ({ url: entry.url, file: entry.file })),
  ];
  for (const write of searchPageWriters) write(searchPages.length > 0);

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
        if (entry.type !== 'project' && entry.type !== 'project-index' && entry.type !== 'docs') continue;
        const owner = preparedProjects.find((candidate) =>
          entry.type === 'docs' ? entry.url.startsWith(candidate.url) : candidate.url === entry.url,
        );
        const source = owner
          ? posix(relative(config.dir, owner.project.file))
          : posix(relative(config.dir, /** @type {{ dir: string }} */ (site.projects).dir));
        const others = entries.filter((other) => other !== entry).map((other) => `${other.type} ${other.url}`);
        const what = entry.type === 'project' ? 'the project page' : entry.type === 'docs' ? 'the documentation page' : 'the projects index';
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

  // The icons for the root of the site. Anything already there (a page, a
  // redirect, a file of a project) would be overwritten or hidden, so it is an error.
  /** @type {ManifestRootFile[]} */
  const manifestFiles = [];
  for (const icon of rootIcons) {
    if (existsSync(join(outDir, icon.file))) {
      const url = `/${icon.file}`;
      const page = pages.find((entry) => entry.file === icon.file || entry.file.startsWith(`${icon.file}/`));
      const redirect = redirects.find((entry) => entry.from === url || entry.from.startsWith(`${url}/`));
      const what = page ? `the ${page.type} page ${page.url}` : redirect ? `the redirect from ${redirect.from}` : 'a file of the content';
      throw new BuildError(
        `site "${site.id}": ${icon.setting}: "${icon.source}" would be copied to ${url}, where ${what} is already; move or rename it, or remove the setting`,
      );
    }
    writeOutput(outDir, icon.file, icon.bytes);
    manifestFiles.push({ setting: icon.setting, source: icon.source, url: `/${icon.file}`, file: icon.file });
  }

  // The sitemap lists the canonical pages a visitor can reach. The 404 page, the
  // redirect stubs and, in a preview build, posts that are not published yet
  // (and tag or series pages with nothing else on them) stay out.
  const publishedUrls = new Set(manifestPosts.filter((entry) => entry.published).map((entry) => entry.url));
  const hasPublished = (/** @type {string[]} */ urls) => urls.some((url) => publishedUrls.has(url));
  const hiddenUrls = new Set([
    NOT_FOUND_URL,
    ...pages.filter((entry) => entry.type === 'search').map((entry) => entry.url),
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

  // The full-text index covers the published posts and the guides, once the HTML is final.
  const search = await buildSearchIndex({
    outDir,
    lang: site.lang,
    basePath: templates.basePath,
    pages: searchPages,
  });

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

  // What the deployed site says about itself, for the scheduled job that decides whether to rebuild (see docs/scheduling.md). The posts waiting
  // for their date are judged against the same "now" that decided which posts this build published.
  const buildInfo = createBuildInfo({
    builtAt: (options.clock ?? (() => new Date()))(),
    engineVersion: version,
    docs: docsFetched,
    posts: everyPost,
    now,
  });
  writeOutput(outDir, BUILD_INFO_FILE_NAME, renderBuildInfo(buildInfo));

  /** @type {Manifest} */
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    generator: { name: 'coffer', version },
    site: { id: site.id, baseUrl: site.baseUrl, lang: site.lang, timezone: site.timezone },
    now: now.toISOString(),
    drafts,
    buildInfo,
    pages,
    posts: manifestPosts,
    tags: manifestTags,
    series: manifestSeries,
    projects: manifestProjects,
    redirects: redirects.map(({ from, to, status }) => ({ from, to, status })),
    feeds: manifestFeeds,
    sitemap: sitemapEntries.map((entry) => entry.url).sort(),
    images: manifestImages,
    files: manifestFiles,
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
    search,
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
 * - for the blog, every tag, every series and every project, a full-content Atom feed named
 *   `feed.xml` under the page's address, newest first (see `docs/feeds.md`);
 * - on every post about a project (by its tag or by `projects:`), a badge near the title and
 *   a project block at the end; on every project page the latest posts about it (see `docs/projects.md`);
 * - `sitemap.xml` (published canonical pages only) and `robots.txt` (see `docs/seo.md`),
 *   and `title`, description, canonical, Open Graph and Twitter card tags on every page;
 * - for every post, tag, series and blog index without a picture of its own, a 1200 by 630 title card in `cards/{hash}.png`, cached in `.cache/cards/`
 *   (see `docs/seo.md`); a post's `cover` is the preview image of a post that has one;
 * - for every blog, a search page at `{blogPrefix}/search/` and, in `pagefind/`, the full-text index of the published posts
 *   and guides (Pagefind, built for the site's language; see `docs/full-text-search.md`);
 * - the assets of the default theme, then of the site's theme, in `assets/`;
 * - `build-info.json`, the build time, the commits of the documentation sources and the time of the next scheduled post (see `docs/scheduling.md`);
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
