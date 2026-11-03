import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isValidLinkUrl } from '../config.js';
import { readFrontMatter } from './posts.js';

/** Name of the home page's content file, inside a site's content directory. */
export const HOME_FILE_NAME = 'home.md';

/** Number of latest posts shown on the home page when `latestPosts` is not set. */
export const DEFAULT_LATEST_POSTS = 5;

/** Largest accepted `latestPosts`. */
export const MAX_LATEST_POSTS = 50;

/**
 * A link as written in the front matter of the home page.
 *
 * @typedef {object} HomeLink
 * @property {string} label Text of the link.
 * @property {string} url Absolute `http(s)`/`mailto:` URL, or a site-relative path starting with `/`.
 */

/**
 * The home page as read from `{contentDir}/home.md`.
 *
 * @typedef {object} Home
 * @property {string} file Absolute path of the Markdown file.
 * @property {string} title Title of the page.
 * @property {number} latestPosts How many of the latest posts to list.
 * @property {HomeLink[]} secondaryLinks Links shown less prominently than the site's main links.
 * @property {string} body The Markdown text after the front matter: the about text.
 * @property {number} bodyLine 1-based line of the file on which `body` starts.
 */

/**
 * Raised when the home page file is invalid. Every problem is listed in
 * {@link HomeError#errors}; each entry starts with the file path and names the
 * field.
 */
export class HomeError extends Error {
  /**
   * @param {string[]} errors One entry per problem.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'HomeError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

const KEYS = ['title', 'latestPosts', 'secondaryLinks'];

/**
 * Parses the text of a home page file.
 *
 * @param {string} file Path shown in error messages.
 * @param {string} text Content of the file.
 * @returns {Home}
 * @throws {HomeError} When the front matter is missing or invalid.
 */
export function parseHomeSource(file, text) {
  /** @type {string[]} */
  const errors = [];
  const parts = readFrontMatter(file, text, errors);
  if (parts === undefined) throw new HomeError(errors);
  const fm = parts.data;
  /** @param {string} field @param {string} message */
  const fail = (field, message) => {
    errors.push(`${file}: ${field}: ${message}`);
  };

  for (const key of Object.keys(fm)) {
    if (!KEYS.includes(key)) {
      fail(key, `unknown key (expected one of: ${KEYS.join(', ')})`);
    }
  }

  const rawTitle = fm.title;
  let title = '';
  if (rawTitle === undefined || rawTitle === null) {
    fail('title', 'is required');
  } else if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    fail('title', 'must be a non-empty string');
  } else {
    title = rawTitle.trim();
  }

  let latestPosts = DEFAULT_LATEST_POSTS;
  const rawCount = fm.latestPosts;
  if (rawCount !== undefined && rawCount !== null) {
    if (
      typeof rawCount !== 'number' ||
      !Number.isInteger(rawCount) ||
      rawCount < 0 ||
      rawCount > MAX_LATEST_POSTS
    ) {
      fail('latestPosts', `must be a whole number from 0 to ${MAX_LATEST_POSTS}`);
    } else {
      latestPosts = rawCount;
    }
  }

  /** @type {HomeLink[]} */
  const secondaryLinks = [];
  const rawLinks = fm.secondaryLinks;
  if (rawLinks !== undefined && rawLinks !== null) {
    if (!Array.isArray(rawLinks)) {
      fail('secondaryLinks', 'must be a list');
    } else {
      rawLinks.forEach((entry, index) => {
        const here = `secondaryLinks[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          fail(here, 'must be a mapping with "label" and "url"');
          return;
        }
        const link = /** @type {Record<string, unknown>} */ (entry);
        for (const key of Object.keys(link)) {
          if (key !== 'label' && key !== 'url') {
            fail(`${here}.${key}`, 'unknown key (expected one of: label, url)');
          }
        }
        const { label, url } = link;
        let valid = true;
        if (typeof label !== 'string' || label.trim() === '') {
          fail(`${here}.label`, label === undefined ? 'is required' : 'must be a non-empty string');
          valid = false;
        }
        if (typeof url !== 'string' || url.trim() === '') {
          fail(`${here}.url`, url === undefined ? 'is required' : 'must be a non-empty string');
          valid = false;
        } else if (!isValidLinkUrl(url.trim())) {
          fail(`${here}.url`, 'must be an http(s) or mailto: URL, or a path starting with "/"');
          valid = false;
        }
        if (valid) {
          secondaryLinks.push({
            label: /** @type {string} */ (label).trim(),
            url: /** @type {string} */ (url).trim(),
          });
        }
      });
    }
  }

  if (errors.length > 0) throw new HomeError(errors);
  return { file, title, latestPosts, secondaryLinks, body: parts.body, bodyLine: parts.bodyLine };
}

/**
 * Reads `{contentDir}/home.md`.
 *
 * @param {string} contentDir Absolute path of a site's content directory.
 * @returns {Home | null} Null when the site has no `home.md`.
 * @throws {HomeError} When the file is invalid or cannot be read.
 */
export function loadHome(contentDir) {
  const file = join(contentDir, HOME_FILE_NAME);
  if (!existsSync(file)) return null;
  if (!statSync(file).isFile()) {
    throw new HomeError([`${file}: must be a file`]);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new HomeError([`${file}: cannot be read: ${reason}`]);
  }
  return parseHomeSource(file, text);
}
