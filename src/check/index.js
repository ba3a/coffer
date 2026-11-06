import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_OUT_DIR, MANIFEST_FILE_NAME } from '../build.js';
import { absoluteUrl } from '../feeds.js';
import { listHtmlUrls } from '../html-urls.js';
import { XmlError, parseXml } from '../xml.js';
import { validateFeed } from './feed-validator.js';
import { checkImages } from './output-images.js';
import { checkHtmlLinks, checkLinkTarget, createOutputResolver, urlForHtmlFile } from './output-links.js';
import { pagePreviewProblems, readPageHead } from './output-meta.js';
import { validateFeedsOnline } from './w3c.js';

/**
 * @typedef {import('../build.js').Manifest} Manifest
 * @typedef {import('../xml.js').XmlElement} XmlElement
 * @typedef {import('./output-links.js').OutputResolver} OutputResolver
 */

/**
 * One problem found in a build.
 *
 * @typedef {object} Finding
 * @property {string} site Id of the site.
 * @property {string} file Path of the file with the problem, relative to the site's output directory, with forward slashes.
 * @property {string} message
 */

/**
 * @typedef {object} SiteCheck
 * @property {string} site
 * @property {string} outDir
 * @property {Finding[]} failures
 * @property {{ pages: number, feeds: number, images: number }} checked
 * @property {string[]} feedFiles Feed files the manifest lists, relative to `outDir`; empty when the manifest could not be used.
 */

/**
 * @typedef {object} CheckOptions
 * @property {string} [out] Output root (default `dist`); each site is read from `{out}/{siteId}`.
 * @property {string} [cwd] Directory a relative `out` resolves against (default the working directory).
 * @property {string} [rootDir] Directory the manifest's `source` paths are relative to; `checkOutput` takes it from the configuration.
 * @property {boolean} [w3c] Also post every feed to the W3C feed validator.
 * @property {import('./w3c.js').W3cOptions} [w3cOptions] Overrides for the online validation, for tests.
 */

/**
 * @typedef {object} CheckResult
 * @property {SiteCheck[]} sites
 * @property {Finding[]} failures Every failure of every site.
 * @property {Finding[]} warnings Things worth knowing that do not fail the check.
 */

/**
 * Lists the files under a directory with a given extension.
 *
 * @param {string} dir
 * @param {string} extension
 * @param {string} [prefix] Path of `dir` inside the root, for recursion.
 * @returns {string[]} Paths relative to the root, with forward slashes, sorted.
 */
function listFiles(dir, extension, prefix = '') {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...listFiles(join(dir, entry.name), extension, relative));
    } else if (entry.name.toLowerCase().endsWith(extension)) {
      found.push(relative);
    }
  }
  return found.sort();
}

/**
 * Site-relative path of an absolute URL on the site, or null for another site.
 *
 * @param {string} baseUrl
 * @param {string} url
 * @returns {string | null}
 */
function sitePath(baseUrl, url) {
  try {
    const target = new URL(url);
    return target.origin === new URL(baseUrl).origin ? target.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Walks an element and its descendants.
 *
 * @param {XmlElement} element
 * @param {(element: XmlElement) => void} visit
 */
function walk(element, visit) {
  visit(element);
  for (const child of element.children) walk(child, visit);
}

/**
 * Checks the URLs in a feed: link targets, a content `src`, and the links and
 * images inside HTML content and summaries.
 *
 * @param {string} xml
 * @param {import('./output-links.js').LinkContext} context
 * @returns {string[]}
 */
function checkFeedLinks(xml, context) {
  let root;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlError) return [];
    throw error;
  }
  /** @type {Set<string>} */
  const problems = new Set();
  /**
   * @param {string} url
   * @param {string} where
   */
  const check = (url, where) => {
    const problem = checkLinkTarget(url, context);
    if (problem !== null) problems.add(`${problem} in ${where}`);
  };
  walk(root, (element) => {
    if (element.local === 'link' && element.attributes.href !== undefined) {
      check(element.attributes.href, '<link href>');
    } else if (element.local === 'content' && element.attributes.src !== undefined) {
      check(element.attributes.src, '<content src>');
    } else if ((element.local === 'logo' || element.local === 'icon') && element.text.trim() !== '') {
      check(element.text.trim(), `<${element.local}>`);
    } else if (
      (element.local === 'content' || element.local === 'summary') &&
      element.attributes.type === 'html'
    ) {
      for (const { url, tag, attribute } of listHtmlUrls(element.text)) {
        if (url.trim() !== '') check(url, `<${element.local}> <${tag} ${attribute}>`);
      }
    }
  });
  return [...problems];
}

/**
 * Compares `sitemap.xml` with the pages the manifest says belong in it.
 *
 * @param {string} outDir
 * @param {Manifest} manifest
 * @param {OutputResolver} resolver
 * @returns {string[]}
 */
function checkSitemap(outDir, manifest, resolver) {
  const file = join(outDir, 'sitemap.xml');
  if (!existsSync(file)) return ['sitemap.xml is missing'];
  let root;
  try {
    root = parseXml(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error instanceof XmlError) return [`sitemap.xml is not well-formed XML: ${error.message}`];
    throw error;
  }
  /** @type {string[]} */
  const listed = [];
  walk(root, (element) => {
    if (element.local === 'loc') listed.push(element.text.trim());
  });
  const expected = manifest.sitemap.map((url) => absoluteUrl(manifest.site.baseUrl, url));

  /** @type {string[]} */
  const problems = [];
  for (const url of expected) {
    if (!listed.includes(url)) problems.push(`sitemap.xml does not list ${url}, which the manifest expects`);
  }
  for (const url of listed) {
    if (!expected.includes(url)) problems.push(`sitemap.xml lists ${url}, which the manifest does not`);
    const path = sitePath(manifest.site.baseUrl, url);
    if (path === null) {
      problems.push(`sitemap.xml lists ${url}, which is not on ${manifest.site.baseUrl}`);
    } else if (resolver.resolve(path) === null) {
      problems.push(`sitemap.xml lists ${url}, but nothing is served at ${path}`);
    }
  }
  return problems;
}

/**
 * Says what is wrong with the shape of a parsed build manifest.
 *
 * @param {any} manifest
 * @returns {string | null} A description of the first problem, or null when the manifest has the expected shape.
 */
function manifestProblem(manifest) {
  if (typeof manifest !== 'object' || manifest === null) return 'it is not an object';
  if (typeof manifest.site?.baseUrl !== 'string') return 'it has no site.baseUrl';
  for (const key of ['pages', 'feeds', 'redirects', 'sitemap']) {
    if (!Array.isArray(manifest[key])) return `"${key}" is missing or is not a list`;
  }
  return null;
}

/**
 * Checks the finished build of one site: links, anchors, preview metadata,
 * feeds, the sitemap and the location and camera metadata of the published
 * images. The build manifest tells what to expect.
 *
 * @param {string} outDir Output directory of the site (`{out}/{siteId}`).
 * @param {string} siteId
 * @param {{ rootDir?: string }} [options] `rootDir`: where the originals are, so that published positions can be compared with them (see {@link CheckOptions}).
 * @returns {Promise<SiteCheck>}
 */
export async function checkSite(outDir, siteId, options = {}) {
  /** @type {Finding[]} */
  const failures = [];
  /**
   * @param {string} file
   * @param {string} message
   */
  const fail = (file, message) => {
    failures.push({ site: siteId, file, message });
  };
  const result = () => ({ site: siteId, outDir, failures, checked: { pages: 0, feeds: 0, images: 0 }, feedFiles: [] });

  const manifestFile = join(outDir, MANIFEST_FILE_NAME);
  if (!existsSync(manifestFile)) {
    fail(MANIFEST_FILE_NAME, `no build found in ${outDir}: run "coffer build" first`);
    return result();
  }
  /** @type {Manifest} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    fail(MANIFEST_FILE_NAME, `cannot read the build manifest: ${error instanceof Error ? error.message : error}`);
    return result();
  }
  const shapeProblem = manifestProblem(manifest);
  if (shapeProblem !== null) {
    fail(MANIFEST_FILE_NAME, `the build manifest is not usable: ${shapeProblem}`);
    return result();
  }

  const baseUrl = manifest.site.baseUrl;
  const resolver = createOutputResolver(outDir);
  const checked = { pages: 0, feeds: 0, images: 0 };

  for (const page of manifest.pages) {
    if (!existsSync(join(outDir, ...page.file.split('/')))) {
      fail(page.file, `the manifest lists ${page.url}, but the file is missing`);
    }
  }
  const canonicalOf = new Map(
    manifest.pages.map((page) => [page.file, absoluteUrl(baseUrl, page.url)]),
  );
  const stubs = new Set(manifest.redirects.map((redirect) => `${redirect.from.replace(/^\//, '')}index.html`));

  // A generated reference is not made by the theme, so it has no preview metadata; its links are checked all the same.
  const referenceDirs = (manifest.projects ?? []).flatMap((project) => (project.docs?.reference ? [project.docs.reference.url.replace(/^\//, '')] : []));

  for (const file of listFiles(outDir, '.html')) {
    checked.pages += 1;
    const html = readFileSync(join(outDir, ...file.split('/')), 'utf8');
    const pageUrl = urlForHtmlFile(file);
    for (const message of checkHtmlLinks(html, { baseUrl, pageUrl, resolver })) {
      fail(file, message);
    }
    if (stubs.has(file) || referenceDirs.some((dir) => file.startsWith(dir))) continue;
    const head = readPageHead(html);
    for (const message of pagePreviewProblems(head, canonicalOf.get(file))) fail(file, message);
    for (const image of head.meta.get('og:image') ?? []) {
      const problem = checkLinkTarget(image, { baseUrl, pageUrl, resolver });
      if (problem !== null) fail(file, `og:image: ${problem}`);
    }
  }

  for (const feed of manifest.feeds) {
    checked.feeds += 1;
    const path = join(outDir, ...feed.file.split('/'));
    if (!existsSync(path)) {
      fail(feed.file, `the manifest lists the feed ${feed.url}, but the file is missing`);
      continue;
    }
    const xml = readFileSync(path, 'utf8');
    for (const message of validateFeed(xml, { selfUrl: feed.selfUrl }).errors) fail(feed.file, `invalid feed: ${message}`);
    for (const message of checkFeedLinks(xml, { baseUrl, pageUrl: feed.url, resolver })) fail(feed.file, message);
  }

  for (const message of checkSitemap(outDir, manifest, resolver)) fail('sitemap.xml', message);

  const imageCheck = await checkImages(outDir, manifest, { rootDir: options.rootDir });
  checked.images = imageCheck.checked;
  for (const finding of imageCheck.findings) fail(finding.file, finding.message);

  return { site: siteId, outDir, failures, checked, feedFiles: manifest.feeds.map((feed) => feed.file) };
}

/**
 * Checks the finished builds of every site of a configuration.
 *
 * @param {import('../config.js').CofferConfig} config
 * @param {CheckOptions} [options]
 * @returns {Promise<CheckResult>}
 */
export async function checkOutput(config, options = {}) {
  const outOption = options.out ?? DEFAULT_OUT_DIR;
  const root = isAbsolute(outOption) ? outOption : resolve(options.cwd ?? process.cwd(), outOption);

  /** @type {CheckResult} */
  const result = { sites: [], failures: [], warnings: [] };
  /** @type {{ label: string, path: string, site: string, file: string }[]} */
  const online = [];
  for (const site of config.sites) {
    const outDir = join(root, site.id);
    const check = await checkSite(outDir, site.id, { rootDir: options.rootDir ?? config.dir });
    result.sites.push(check);
    result.failures.push(...check.failures);
    if (options.w3c) {
      for (const file of check.feedFiles) {
        const path = join(outDir, ...file.split('/'));
        if (existsSync(path)) online.push({ label: `${site.id}/${file}`, path, site: site.id, file });
      }
    }
  }
  if (options.w3c && online.length > 0) {
    const outcome = await validateFeedsOnline(online, options.w3cOptions);
    for (const item of [...outcome.errors, ...outcome.warnings]) {
      const feed = online.find((entry) => entry.label === item.label);
      if (!feed) continue;
      const finding = { site: feed.site, file: feed.file, message: item.message };
      (outcome.errors.includes(item) ? result.failures : result.warnings).push(finding);
    }
  }
  return result;
}
