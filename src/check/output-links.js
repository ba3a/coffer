import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { listHtmlUrls } from '../html-urls.js';
import { parseRedirects, resolveRequest } from '../serve.js';
import { decodeEntities } from '../xml.js';

/** Redirect hops followed before a link is called a loop. */
const MAX_HOPS = 5;

/** Fragments that always work: the top of the page. */
const ALWAYS_PRESENT = new Set(['', 'top']);

/**
 * The files a host that serves an output directory the way Cloudflare Pages
 * does would answer with, including `_redirects` rules.
 *
 * @typedef {object} OutputResolver
 * @property {(pathname: string) => { file: string } | { external: string } | null} resolve Follows redirects; null when the path leads to nothing.
 * @property {(file: string) => Set<string>} anchors The `id` and `name` values in an HTML file.
 */

/**
 * Whether a path is a regular file.
 *
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
 * Reads the `id` and `name` attributes of an HTML document.
 *
 * @param {string} html
 * @returns {Set<string>}
 */
function collectAnchors(html) {
  /** @type {Set<string>} */
  const found = new Set();
  const pattern = /\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    found.add(decodeEntities(value, { html: true }));
  }
  return found;
}

/**
 * Creates a resolver for a built site directory. Files are read when asked
 * for, and what is read is remembered, so build the resolver after the build.
 *
 * @param {string} outDir Output directory of one site.
 * @returns {OutputResolver}
 */
export function createOutputResolver(outDir) {
  const redirectsFile = join(outDir, '_redirects');
  const rules = existsSync(redirectsFile) ? parseRedirects(readFileSync(redirectsFile, 'utf8')) : [];
  /** @type {Map<string, Set<string>>} */
  const anchorCache = new Map();

  /** @type {OutputResolver['resolve']} */
  const resolve = (pathname) => {
    let current = pathname;
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const answer = resolveRequest(outDir, rules, current, '');
      if (answer.kind === 'file') return { file: answer.file };
      if (answer.kind === 'missing') {
        // Pages serves `/about` from `about.html` as well.
        if (!current.endsWith('/')) {
          const sibling = join(outDir, ...`${current}.html`.split('/').filter(Boolean));
          if (isFile(sibling)) return { file: sibling };
        }
        return null;
      }
      if (!answer.location.startsWith('/') || answer.location.startsWith('//')) {
        return { external: answer.location };
      }
      current = answer.location.replace(/[?#].*$/, '');
    }
    return null;
  };

  return {
    resolve,
    anchors(file) {
      let anchors = anchorCache.get(file);
      if (anchors === undefined) {
        anchors = collectAnchors(readFileSync(file, 'utf8'));
        anchorCache.set(file, anchors);
      }
      return anchors;
    },
  };
}

/**
 * @typedef {object} LinkContext
 * @property {string} baseUrl Absolute URL of the site.
 * @property {string} pageUrl Site-relative URL of the document that holds the links.
 * @property {OutputResolver} resolver
 */

/**
 * Checks one URL found in a document. External URLs are not checked.
 *
 * @param {string} url The URL as written.
 * @param {LinkContext} context
 * @returns {string | null} A description of the problem, or null when the URL is fine.
 */
export function checkLinkTarget(url, context) {
  const trimmed = url.trim();
  let base;
  let target;
  try {
    base = new URL(context.baseUrl);
    target = new URL(trimmed, new URL(context.pageUrl, base));
  } catch {
    return `malformed URL "${url}"`;
  }
  if (target.origin !== base.origin) return null;

  const found = context.resolver.resolve(target.pathname);
  if (found === null) return `broken link "${url}" (nothing is served at ${target.pathname})`;
  if ('external' in found) return null;

  let fragment = target.hash.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Keep the fragment as written.
  }
  if (ALWAYS_PRESENT.has(fragment) || fragment.startsWith(':~:') || !found.file.endsWith('.html')) return null;
  if (!context.resolver.anchors(found.file).has(fragment)) {
    return `missing anchor "#${fragment}" in ${target.pathname}`;
  }
  return null;
}

/**
 * Checks every `href`, `src`, `srcset` and `poster` URL of an HTML document.
 *
 * @param {string} html
 * @param {LinkContext} context
 * @returns {string[]} One message per distinct problem.
 */
export function checkHtmlLinks(html, context) {
  /** @type {Set<string>} */
  const problems = new Set();
  for (const { url, tag, attribute } of listHtmlUrls(html)) {
    if (url.trim() === '') continue;
    const problem = checkLinkTarget(url, context);
    if (problem !== null) problems.add(`${problem} in <${tag} ${attribute}>`);
  }
  return [...problems];
}

/**
 * Site-relative URL a built HTML file is served at.
 *
 * @param {string} file Path relative to the site directory, with forward slashes.
 * @returns {string}
 */
export function urlForHtmlFile(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return `/${file.slice(0, -'index.html'.length)}`;
  return `/${file}`;
}
