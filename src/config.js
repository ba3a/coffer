import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';

import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SIZES,
  DEFAULT_VIEWER_MAX_EDGE,
  DEFAULT_WEBP_QUALITY,
  DEFAULT_WIDTHS as DEFAULT_IMAGE_WIDTHS,
} from './images/defaults.js';

/**
 * The file name coffer looks for when no `--config` path is given.
 */
export const CONFIG_FILE_NAME = 'coffer.yaml';

/**
 * A link shown on a site, for example in the header or the home page.
 *
 * @typedef {object} LinkConfig
 * @property {string} label Text of the link.
 * @property {string} url Absolute `http(s)`/`mailto:` URL, or a site-relative path starting with `/`.
 */

/**
 * One blog of a site.
 *
 * @typedef {object} BlogConfig
 * @property {string} id Identifier, unique within the site.
 * @property {string} dir Absolute path of the directory holding the posts.
 * @property {string} prefix URL prefix without slashes at either end; the empty string for a blog at the site root.
 * @property {string} title Display title of the blog.
 */

/**
 * URL prefixes of the generated sections of a site.
 *
 * @typedef {object} UrlsConfig
 * @property {string} projects Prefix of the projects index and project pages.
 * @property {string} docs Segment under a project page that holds its documentation.
 * @property {string} tags Segment under a blog that holds the tag pages.
 * @property {string} series Segment under a blog that holds the series pages.
 */

/**
 * What happens to the location and the camera metadata of published images.
 *
 * @typedef {object} LocationConfig
 * @property {'strip' | 'coarse' | 'keep'} default Site-wide location policy.
 * @property {'strip' | 'keep'} camera Site-wide camera metadata policy.
 */

/**
 * How published images are made.
 *
 * @typedef {object} ImagesConfig
 * @property {number[]} widths Widths in pixels of the WebP variants, ascending. A variant is never wider than the original.
 * @property {number} viewerMaxEdge Longest edge in pixels of the full-size JPEG kept for the viewer and for downloads.
 * @property {number} webpQuality WebP quality, 1 to 100.
 * @property {number} jpegQuality JPEG quality of the full-size image, 1 to 100.
 * @property {string} sizes The `sizes` attribute of the pictures: how wide the image is shown at each screen width.
 */

/**
 * Where a site keeps its projects.
 *
 * @typedef {object} ProjectsConfig
 * @property {string} dir Absolute path of the directory holding one folder per project.
 */

/**
 * The author named in the site's feeds.
 *
 * @typedef {object} AuthorConfig
 * @property {string} name Name of the author; the site title when the configuration gives none.
 * @property {string | null} email Email address, or null.
 * @property {string | null} url Absolute `http(s)` URL of the author's home page, or null.
 */

/**
 * Settings of the Atom feeds.
 *
 * @typedef {object} FeedsConfig
 * @property {number} limit Number of entries in the feed of a blog or a tag; series feeds always list every part.
 */

/**
 * A site as configured, with defaults applied and paths made absolute.
 *
 * @typedef {object} SiteConfig
 * @property {string} id Identifier, unique within the configuration; also the output directory name.
 * @property {string} baseUrl Absolute https URL of the site, without a trailing slash.
 * @property {string} lang Canonical BCP 47 language tag.
 * @property {string} timezone IANA time zone used to interpret dates without a time.
 * @property {string} title Title of the site.
 * @property {string} description Short description of the site; may be empty.
 * @property {string} contentDir Absolute path of the content directory.
 * @property {string | null} theme Absolute path of the theme directory, or null for the default theme.
 * @property {string} contentLicense Content license text shown in the footer; may be empty.
 * @property {string} defaultImage Preview image of pages that have none: a site-relative path starting with `/` or an absolute http(s) URL.
 * @property {AuthorConfig} author Author named in feeds.
 * @property {FeedsConfig} feeds Settings of the Atom feeds.
 * @property {LinkConfig[]} links Links of the site.
 * @property {BlogConfig[]} blogs Blogs of the site.
 * @property {UrlsConfig} urls URL prefixes of the generated sections.
 * @property {LocationConfig} location Image metadata policy.
 * @property {ImagesConfig} images How published images are made.
 * @property {ProjectsConfig | null} projects Projects location, or null when the site has no projects.
 */

/**
 * The normalized configuration returned by {@link loadConfig} and
 * {@link normalizeConfig}.
 *
 * @typedef {object} CofferConfig
 * @property {string} file Absolute path of the configuration file.
 * @property {string} dir Absolute path of the directory holding the configuration file.
 * @property {SiteConfig[]} sites The configured sites, in file order.
 */

/**
 * Raised when the configuration cannot be found, parsed or validated. Every
 * problem is listed in {@link ConfigError#errors}; the message joins them.
 */
export class ConfigError extends Error {
  /**
   * @param {string[]} errors One entry per problem, each starting with the file name.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ConfigError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

/** @type {Readonly<UrlsConfig>} */
export const DEFAULT_URLS = Object.freeze({
  projects: 'made',
  docs: 'docs',
  tags: 'tags',
  series: 'series',
});

/** Preview image used by pages without one, unless the site says otherwise. It ships with the default theme. */
export const DEFAULT_IMAGE = '/assets/social-default.png';

/** Number of entries in a blog or tag feed unless the site says otherwise. */
export const DEFAULT_FEED_LIMIT = 20;

const IMAGE_KEYS = ['widths', 'viewerMaxEdge', 'webpQuality', 'jpegQuality', 'sizes'];
const LOCATION_POLICIES = ['strip', 'coarse', 'keep'];
const CAMERA_POLICIES = ['strip', 'keep'];
const SITE_KEYS = [
  'id',
  'baseUrl',
  'lang',
  'timezone',
  'title',
  'description',
  'contentDir',
  'theme',
  'contentLicense',
  'defaultImage',
  'author',
  'feeds',
  'links',
  'blogs',
  'urls',
  'location',
  'images',
  'projects',
];
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} value
 * @returns {string}
 */
function posix(value) {
  return sep === '/' ? value : value.split(sep).join('/');
}

/**
 * Collects validation problems for one configuration file.
 */
class Problems {
  /**
   * @param {string} fileLabel Name of the file as shown to the user.
   */
  constructor(fileLabel) {
    this.fileLabel = fileLabel;
    /** @type {string[]} */
    this.list = [];
  }

  /**
   * @param {string} path Key path such as `sites[1].baseUrl`; empty for the whole file.
   * @param {string} message
   */
  add(path, message) {
    this.list.push(
      path === ''
        ? `${this.fileLabel}: ${message}`
        : `${this.fileLabel}: ${path}: ${message}`,
    );
  }
}

/**
 * Reports keys of `mapping` that are not in `allowed`.
 *
 * @param {Record<string, unknown>} mapping
 * @param {readonly string[]} allowed
 * @param {string} path
 * @param {Problems} problems
 */
function rejectUnknownKeys(mapping, allowed, path, problems) {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) {
      problems.add(
        path === '' ? key : `${path}.${key}`,
        `unknown key (expected one of: ${allowed.join(', ')})`,
      );
    }
  }
}

/**
 * Reads a non-empty string. Returns `undefined` after reporting a problem, and
 * `fallback` when the key is absent and not required.
 *
 * @param {Record<string, unknown>} mapping
 * @param {string} key
 * @param {string} path Path of `mapping`.
 * @param {Problems} problems
 * @param {{ required?: boolean, fallback?: string }} [options]
 * @returns {string | undefined}
 */
function readString(mapping, key, path, problems, options = {}) {
  const here = path === '' ? key : `${path}.${key}`;
  const value = mapping[key];
  if (value === undefined || value === null) {
    if (options.required) {
      problems.add(here, 'is required');
      return undefined;
    }
    return options.fallback;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(here, 'must be a non-empty string');
    return undefined;
  }
  return value.trim();
}

/**
 * Reads a string that may be empty (descriptions, license text).
 *
 * @param {Record<string, unknown>} mapping
 * @param {string} key
 * @param {string} path
 * @param {Problems} problems
 * @returns {string}
 */
function readText(mapping, key, path, problems) {
  const value = mapping[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    problems.add(path === '' ? key : `${path}.${key}`, 'must be a string');
    return '';
  }
  return value.trim();
}

/**
 * Reads a mapping, or `undefined` when the key is absent.
 *
 * @param {Record<string, unknown>} mapping
 * @param {string} key
 * @param {string} path
 * @param {Problems} problems
 * @returns {Record<string, unknown> | undefined}
 */
function readMapping(mapping, key, path, problems) {
  const value = mapping[key];
  if (value === undefined || value === null) return undefined;
  if (!isMapping(value)) {
    problems.add(`${path}.${key}`, 'must be a mapping');
    return undefined;
  }
  return value;
}

/**
 * Reads a list, or an empty list when the key is absent.
 *
 * @param {Record<string, unknown>} mapping
 * @param {string} key
 * @param {string} path
 * @param {Problems} problems
 * @returns {unknown[]}
 */
function readList(mapping, key, path, problems) {
  const value = mapping[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.add(`${path}.${key}`, 'must be a list');
    return [];
  }
  return value;
}

/**
 * Checks and normalizes an absolute https URL: no credentials, query or
 * fragment, no trailing slash.
 *
 * @param {string} value
 * @returns {{ url: string } | { error: string }}
 */
function parseBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'must be an absolute https URL' };
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    return { error: 'must be an absolute https URL' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { error: 'must not contain credentials' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { error: 'must not contain a query or a fragment' };
  }
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') };
}

/**
 * Checks a URL path made of segments such as `made` or `notes/2024`.
 *
 * @param {string} value
 * @param {boolean} allowEmpty
 * @returns {string | undefined} A problem description, or undefined when valid.
 */
function checkUrlPath(value, allowEmpty) {
  if (value === '') {
    return allowEmpty ? undefined : 'must not be empty';
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    return 'must not start or end with a slash';
  }
  if (!value.split('/').every((segment) => SEGMENT_RE.test(segment))) {
    return 'must be made of letters, digits, ".", "_" and "-", separated by single slashes';
  }
  return undefined;
}

/**
 * Checks an IANA time zone name.
 *
 * @param {string} value
 * @returns {string | undefined} The canonical name, or undefined when invalid.
 */
function canonicalTimeZone(value) {
  if (/^[+-]/.test(value)) return undefined;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Checks a language tag.
 *
 * @param {string} value
 * @returns {string | undefined} The canonical tag, or undefined when invalid.
 */
function canonicalLang(value) {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/**
 * @param {Record<string, unknown>} mapping
 * @param {string} key
 * @param {string} path
 * @param {string} baseDir
 * @param {Problems} problems
 * @param {{ required?: boolean, fallback?: string | null }} [options]
 * @returns {string | null | undefined} Absolute path.
 */
function readPath(mapping, key, path, baseDir, problems, options = {}) {
  const value = readString(mapping, key, path, problems, {
    required: options.required,
  });
  if (value !== undefined) return resolve(baseDir, value);
  // Absent, or invalid (already reported): the fallback keeps later checks quiet.
  const { fallback } = options;
  return fallback === undefined || fallback === null
    ? fallback
    : resolve(baseDir, fallback);
}

/**
 * @param {unknown} raw
 * @param {string} path
 * @param {Problems} problems
 * @returns {LinkConfig[]}
 */
function normalizeLinks(raw, path, problems) {
  /** @type {LinkConfig[]} */
  const links = [];
  const list = Array.isArray(raw) ? raw : [];
  list.forEach((entry, index) => {
    const here = `${path}[${index}]`;
    if (!isMapping(entry)) {
      problems.add(here, 'must be a mapping with "label" and "url"');
      return;
    }
    rejectUnknownKeys(entry, ['label', 'url'], here, problems);
    const label = readString(entry, 'label', here, problems, { required: true });
    const url = readString(entry, 'url', here, problems, { required: true });
    if (url !== undefined && !isValidLinkUrl(url)) {
      problems.add(
        `${here}.url`,
        'must be an http(s) or mailto: URL, or a path starting with "/"',
      );
      return;
    }
    if (label !== undefined && url !== undefined) links.push({ label, url });
  });
  return links;
}

/**
 * Whether a link target is an http(s) or `mailto:` URL, or a site-relative
 * path starting with a single `/`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isValidLinkUrl(value) {
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'mailto:') return parsed.pathname !== '';
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname !== ''
    );
  } catch {
    return false;
  }
}

/**
 * @param {unknown[]} list
 * @param {string} path
 * @param {string} baseDir
 * @param {string} siteTitle
 * @param {Problems} problems
 * @returns {BlogConfig[]}
 */
function normalizeBlogs(list, path, baseDir, siteTitle, problems) {
  /** @type {BlogConfig[]} */
  const blogs = [];
  /** @type {Map<string, number>} */
  const ids = new Map();
  /** @type {Map<string, number>} */
  const prefixes = new Map();
  list.forEach((entry, index) => {
    const here = `${path}[${index}]`;
    if (!isMapping(entry)) {
      problems.add(here, 'must be a mapping');
      return;
    }
    rejectUnknownKeys(entry, ['id', 'dir', 'prefix', 'title'], here, problems);
    const id = readString(entry, 'id', here, problems, { required: true });
    if (id !== undefined) {
      if (!ID_RE.test(id)) {
        problems.add(
          `${here}.id`,
          'must be made of letters, digits, ".", "_" and "-"',
        );
      } else if (ids.has(id)) {
        problems.add(`${here}.id`, `duplicates ${path}[${ids.get(id)}].id`);
      } else {
        ids.set(id, index);
      }
    }
    const dirValue = readString(entry, 'dir', here, problems, {
      fallback: id,
    });
    const dir = dirValue === undefined ? undefined : resolve(baseDir, dirValue);

    /** @type {string | undefined} */
    let prefix;
    const rawPrefix = entry.prefix;
    if (rawPrefix === undefined || rawPrefix === null) {
      prefix = id;
    } else if (typeof rawPrefix !== 'string') {
      problems.add(`${here}.prefix`, 'must be a string');
    } else {
      const trimmed = rawPrefix.trim();
      const problem = checkUrlPath(trimmed, true);
      if (problem === undefined) {
        prefix = trimmed;
      } else {
        problems.add(`${here}.prefix`, problem);
      }
    }
    if (prefix !== undefined) {
      if (prefixes.has(prefix)) {
        problems.add(
          `${here}.prefix`,
          `duplicates ${path}[${prefixes.get(prefix)}].prefix`,
        );
      } else {
        prefixes.set(prefix, index);
      }
    }
    const title = readString(entry, 'title', here, problems, {
      fallback: siteTitle,
    });
    if (
      id !== undefined &&
      dir !== undefined &&
      prefix !== undefined &&
      title !== undefined
    ) {
      blogs.push({ id, dir, prefix, title });
    }
  });
  return blogs;
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @param {string} path
 * @param {Problems} problems
 * @returns {UrlsConfig}
 */
function normalizeUrls(raw, path, problems) {
  const urls = { ...DEFAULT_URLS };
  if (raw === undefined) return urls;
  rejectUnknownKeys(raw, Object.keys(DEFAULT_URLS), path, problems);
  for (const key of /** @type {(keyof UrlsConfig)[]} */ (
    Object.keys(DEFAULT_URLS)
  )) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      problems.add(`${path}.${key}`, 'must be a string');
      continue;
    }
    const trimmed = value.trim();
    const problem = checkUrlPath(trimmed, false);
    if (problem !== undefined) {
      problems.add(`${path}.${key}`, problem);
    } else {
      urls[key] = trimmed;
    }
  }
  if (urls.tags === urls.series) {
    problems.add(`${path}.series`, `must differ from ${path}.tags`);
  }
  return urls;
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @param {string} path
 * @param {Problems} problems
 * @returns {LocationConfig}
 */
function normalizeLocation(raw, path, problems) {
  /** @type {LocationConfig} */
  const location = { default: 'strip', camera: 'strip' };
  if (raw === undefined) return location;
  rejectUnknownKeys(raw, ['default', 'camera'], path, problems);
  const policy = raw.default;
  if (policy !== undefined && policy !== null) {
    if (typeof policy === 'string' && LOCATION_POLICIES.includes(policy)) {
      location.default = /** @type {LocationConfig['default']} */ (policy);
    } else {
      problems.add(
        `${path}.default`,
        `must be one of: ${LOCATION_POLICIES.join(', ')}`,
      );
    }
  }
  const camera = raw.camera;
  if (camera !== undefined && camera !== null) {
    if (typeof camera === 'string' && CAMERA_POLICIES.includes(camera)) {
      location.camera = /** @type {LocationConfig['camera']} */ (camera);
    } else {
      problems.add(
        `${path}.camera`,
        `must be one of: ${CAMERA_POLICIES.join(', ')}`,
      );
    }
  }
  return location;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} key
 * @param {string} path
 * @param {Problems} problems
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function readBoundedInteger(raw, key, path, problems, min, max, fallback) {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  problems.add(`${path}.${key}`, `must be an integer from ${min} to ${max}`);
  return fallback;
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @param {string} path
 * @param {Problems} problems
 * @returns {ImagesConfig}
 */
function normalizeImages(raw, path, problems) {
  /** @type {ImagesConfig} */
  const images = {
    widths: [...DEFAULT_IMAGE_WIDTHS],
    viewerMaxEdge: DEFAULT_VIEWER_MAX_EDGE,
    webpQuality: DEFAULT_WEBP_QUALITY,
    jpegQuality: DEFAULT_JPEG_QUALITY,
    sizes: DEFAULT_SIZES,
  };
  if (raw === undefined) return images;
  rejectUnknownKeys(raw, IMAGE_KEYS, path, problems);
  const widths = raw.widths;
  if (widths !== undefined && widths !== null) {
    if (
      Array.isArray(widths) &&
      widths.length > 0 &&
      widths.every((width) => typeof width === 'number' && Number.isInteger(width) && width >= 16 && width <= 20000)
    ) {
      images.widths = [...new Set(/** @type {number[]} */ (widths))].sort((a, b) => a - b);
    } else {
      problems.add(`${path}.widths`, 'must be a non-empty list of integers from 16 to 20000');
    }
  }
  images.viewerMaxEdge = readBoundedInteger(raw, 'viewerMaxEdge', path, problems, 64, 30000, images.viewerMaxEdge);
  images.webpQuality = readBoundedInteger(raw, 'webpQuality', path, problems, 1, 100, images.webpQuality);
  images.jpegQuality = readBoundedInteger(raw, 'jpegQuality', path, problems, 1, 100, images.jpegQuality);
  const sizes = readString(raw, 'sizes', path, problems);
  if (sizes !== undefined) images.sizes = sizes;
  return images;
}

/**
 * Reads the `author` key: a name, or a mapping with `name`, `email` and `url`.
 *
 * @param {unknown} raw
 * @param {string} path
 * @param {string} siteTitle Name used when the configuration gives no author.
 * @param {Problems} problems
 * @returns {AuthorConfig}
 */
function normalizeAuthor(raw, path, siteTitle, problems) {
  /** @type {AuthorConfig} */
  const author = { name: siteTitle, email: null, url: null };
  if (raw === undefined || raw === null) return author;
  if (typeof raw === 'string') {
    if (raw.trim() === '') {
      problems.add(path, 'must be a non-empty string or a mapping');
    } else {
      author.name = raw.trim();
    }
    return author;
  }
  if (!isMapping(raw)) {
    problems.add(path, 'must be a name or a mapping with "name", "email" and "url"');
    return author;
  }
  rejectUnknownKeys(raw, ['name', 'email', 'url'], path, problems);
  const name = readString(raw, 'name', path, problems, { fallback: siteTitle });
  if (name !== undefined) author.name = name;
  const email = readString(raw, 'email', path, problems);
  if (email !== undefined) {
    if (/^[^\s@<>]+@[^\s@<>]+$/.test(email)) author.email = email;
    else problems.add(`${path}.email`, 'must be an email address');
  }
  const url = readString(raw, 'url', path, problems);
  if (url !== undefined) {
    if (/^https?:/i.test(url) && isValidLinkUrl(url)) author.url = url;
    else problems.add(`${path}.url`, 'must be an absolute http(s) URL');
  }
  return author;
}

/**
 * @param {Record<string, unknown> | undefined} raw
 * @param {string} path
 * @param {Problems} problems
 * @returns {FeedsConfig}
 */
function normalizeFeeds(raw, path, problems) {
  /** @type {FeedsConfig} */
  const feeds = { limit: DEFAULT_FEED_LIMIT };
  if (raw === undefined) return feeds;
  rejectUnknownKeys(raw, ['limit'], path, problems);
  const limit = raw.limit;
  if (limit !== undefined && limit !== null) {
    if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 1) {
      feeds.limit = limit;
    } else {
      problems.add(`${path}.limit`, 'must be a positive integer');
    }
  }
  return feeds;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {string} baseDir
 * @param {Problems} problems
 * @returns {SiteConfig | undefined}
 */
function normalizeSite(raw, index, baseDir, problems) {
  const path = `sites[${index}]`;
  if (!isMapping(raw)) {
    problems.add(path, 'must be a mapping');
    return undefined;
  }
  const before = problems.list.length;
  rejectUnknownKeys(raw, SITE_KEYS, path, problems);

  const id = readString(raw, 'id', path, problems, { required: true });
  if (id !== undefined && !ID_RE.test(id)) {
    problems.add(
      `${path}.id`,
      'must be made of letters, digits, ".", "_" and "-"',
    );
  }

  const baseUrlText = readString(raw, 'baseUrl', path, problems, {
    required: true,
  });
  let baseUrl;
  if (baseUrlText !== undefined) {
    const parsed = parseBaseUrl(baseUrlText);
    if ('error' in parsed) {
      problems.add(`${path}.baseUrl`, parsed.error);
    } else {
      baseUrl = parsed.url;
    }
  }

  const langText = readString(raw, 'lang', path, problems, { fallback: 'en' });
  let lang;
  if (langText !== undefined) {
    lang = canonicalLang(langText);
    if (lang === undefined) {
      problems.add(`${path}.lang`, 'must be a valid language tag such as "en" or "ru"');
    }
  }

  const zoneText = readString(raw, 'timezone', path, problems, {
    fallback: 'UTC',
  });
  let timezone;
  if (zoneText !== undefined) {
    timezone = canonicalTimeZone(zoneText);
    if (timezone === undefined) {
      problems.add(
        `${path}.timezone`,
        'must be an IANA time zone such as "UTC" or "Europe/Samara"',
      );
    }
  }

  const title = readString(raw, 'title', path, problems, { required: true });
  const description = readText(raw, 'description', path, problems);
  const contentDir = readPath(raw, 'contentDir', path, baseDir, problems, {
    fallback: 'content',
  });
  const theme = readPath(raw, 'theme', path, baseDir, problems, {
    fallback: null,
  });
  const contentLicense = readText(raw, 'contentLicense', path, problems);
  const defaultImage = readString(raw, 'defaultImage', path, problems, {
    fallback: DEFAULT_IMAGE,
  });
  if (
    defaultImage !== undefined &&
    (defaultImage.startsWith('mailto:') || !isValidLinkUrl(defaultImage))
  ) {
    problems.add(
      `${path}.defaultImage`,
      'must be an http(s) URL or a path starting with "/"',
    );
  }
  const author = normalizeAuthor(raw.author, `${path}.author`, title ?? '', problems);
  const feeds = normalizeFeeds(
    readMapping(raw, 'feeds', path, problems),
    `${path}.feeds`,
    problems,
  );
  const links = normalizeLinks(
    readList(raw, 'links', path, problems),
    `${path}.links`,
    problems,
  );
  const blogs = normalizeBlogs(
    readList(raw, 'blogs', path, problems),
    `${path}.blogs`,
    baseDir,
    title ?? '',
    problems,
  );
  const urls = normalizeUrls(
    readMapping(raw, 'urls', path, problems),
    `${path}.urls`,
    problems,
  );
  const location = normalizeLocation(
    readMapping(raw, 'location', path, problems),
    `${path}.location`,
    problems,
  );
  const images = normalizeImages(
    readMapping(raw, 'images', path, problems),
    `${path}.images`,
    problems,
  );

  /** @type {ProjectsConfig | null} */
  let projects = null;
  const projectsRaw = readMapping(raw, 'projects', path, problems);
  if (projectsRaw !== undefined) {
    rejectUnknownKeys(projectsRaw, ['dir'], `${path}.projects`, problems);
    const dir = readPath(projectsRaw, 'dir', `${path}.projects`, baseDir, problems, {
      required: true,
    });
    if (typeof dir === 'string') projects = { dir };
  }

  for (const blog of blogs) {
    if (blog.prefix === urls.projects) {
      problems.add(
        `${path}.urls.projects`,
        `collides with the prefix of blog "${blog.id}"`,
      );
    }
  }

  if (problems.list.length > before) return undefined;
  if (
    id === undefined ||
    baseUrl === undefined ||
    lang === undefined ||
    timezone === undefined ||
    title === undefined ||
    typeof contentDir !== 'string' ||
    defaultImage === undefined ||
    theme === undefined
  ) {
    return undefined;
  }
  return {
    id,
    baseUrl,
    lang,
    timezone,
    title,
    description,
    contentDir,
    theme,
    contentLicense,
    defaultImage,
    author,
    feeds,
    links,
    blogs,
    urls,
    location,
    images,
    projects,
  };
}

/**
 * Validates a parsed configuration and applies defaults.
 *
 * @param {unknown} raw The parsed YAML document.
 * @param {{ file: string, label?: string }} source `file` is the absolute path
 *   of the configuration file; relative paths inside it resolve against its
 *   directory. `label` is how the file is named in messages (default: base name).
 * @returns {CofferConfig}
 * @throws {ConfigError} When any rule is violated; all problems are reported at once.
 */
export function normalizeConfig(raw, source) {
  const file = resolve(source.file);
  const dir = dirname(file);
  const label = source.label ?? file.slice(dir.length + 1);
  const problems = new Problems(label);

  /** @type {SiteConfig[]} */
  const sites = [];
  if (!isMapping(raw)) {
    problems.add('', 'must be a mapping with a "sites" list');
  } else {
    rejectUnknownKeys(raw, ['sites'], '', problems);
    const list = raw.sites;
    if (list === undefined || list === null) {
      problems.add('sites', 'is required');
    } else if (!Array.isArray(list)) {
      problems.add('sites', 'must be a list');
    } else if (list.length === 0) {
      problems.add('sites', 'must contain at least one site');
    } else {
      /** @type {Map<string, number>} */
      const seen = new Map();
      list.forEach((entry, index) => {
        const site = normalizeSite(entry, index, dir, problems);
        const id = isMapping(entry) ? entry.id : undefined;
        if (typeof id === 'string' && id.trim() !== '') {
          const key = id.trim();
          if (seen.has(key)) {
            problems.add(`sites[${index}].id`, `duplicates sites[${seen.get(key)}].id`);
          } else {
            seen.set(key, index);
          }
        }
        if (site !== undefined) sites.push(site);
      });
    }
  }

  if (problems.list.length > 0) throw new ConfigError(problems.list);
  return { file, dir, sites };
}

/**
 * Finds the configuration file: the explicit path when given, otherwise
 * `coffer.yaml` in `cwd` or the nearest parent directory that has one.
 *
 * @param {{ cwd?: string, configPath?: string }} [options]
 * @returns {string} Absolute path.
 * @throws {ConfigError} When no file is found.
 */
export function findConfigFile(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.configPath !== undefined) {
    const explicit = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath);
    if (!existsSync(explicit) || !statSync(explicit).isFile()) {
      throw new ConfigError([`${options.configPath}: file not found`]);
    }
    return explicit;
  }
  for (let current = cwd; ; current = dirname(current)) {
    const candidate = join(current, CONFIG_FILE_NAME);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (dirname(current) === current) break;
  }
  throw new ConfigError([
    `${CONFIG_FILE_NAME}: not found in ${cwd} or any parent directory (use --config <path>)`,
  ]);
}

/**
 * Finds, parses and validates the configuration.
 *
 * @param {{ cwd?: string, configPath?: string }} [options] `configPath` is the
 *   `--config` value, resolved against `cwd` (default: the working directory).
 * @returns {CofferConfig}
 * @throws {ConfigError} When the file is missing, is not valid YAML or breaks a rule.
 */
export function loadConfig(options = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const file = findConfigFile({ ...options, cwd });
  const shown = posix(relative(cwd, file));
  const label =
    options.configPath !== undefined ? options.configPath : shown || file;

  const lineCounter = new LineCounter();
  const document = parseDocument(readFileSync(file, 'utf8'), {
    lineCounter,
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ConfigError(
      document.errors.map((error) => {
        const line = error.pos ? lineCounter.linePos(error.pos[0]).line : undefined;
        const where = line === undefined ? '' : `line ${line}: `;
        return `${label}: ${where}${error.message.split('\n')[0]}`;
      }),
    );
  }
  return normalizeConfig(document.toJS(), { file, label });
}
