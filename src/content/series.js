import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

/** Name of the optional file in a blog's directory that describes its series. */
export const SERIES_FILE_NAME = 'series.yaml';

/** Keys an entry of `series.yaml` may have. */
export const SERIES_META_KEYS = Object.freeze(['name', 'description']);

/**
 * @typedef {import('./posts.js').Post} Post
 */

/**
 * What `series.yaml` says about one series.
 *
 * @typedef {object} SeriesMeta
 * @property {string | null} name Display name, or null to show the series slug.
 * @property {string | null} description Short description, if given.
 */

/**
 * One part of a series, with its neighbours. The neighbours follow the order of
 * the series, not the order of dates.
 *
 * @typedef {object} SeriesPart
 * @property {Post} post
 * @property {number} number 1-based position in the ordered series: the "n" of "part n of m".
 * @property {Post | null} previous The part before this one, or null for the first part.
 * @property {Post | null} next The part after this one, or null for the last part.
 */

/**
 * A series of a blog: every given post that names it in its front matter.
 *
 * @typedef {object} Series
 * @property {string} slug The series slug as written in the posts (lowercase).
 * @property {string} name Display name from `series.yaml`, else the slug.
 * @property {string | null} description Description from `series.yaml`, if any.
 * @property {SeriesPart[]} parts The parts in reading order.
 * @property {number} count Number of parts: the "m" of "part n of m".
 */

/**
 * Raised when `series.yaml` cannot be read or validated. Every problem is
 * listed in {@link SeriesError#errors}; the message joins them.
 */
export class SeriesError extends Error {
  /**
   * @param {string[]} errors One entry per problem, each starting with the file path.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'SeriesError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders two parts of one series. The order, which the documentation repeats:
 *
 * 1. Posts with an explicit `seriesPosition` come first, by that value
 *    (smallest first); equal values fall back to the date, then the slug.
 * 2. The posts without one follow, oldest first, ties broken by slug.
 *
 * With no explicit positions the series therefore reads in date order; with
 * all of them it reads in the order the author chose.
 *
 * @param {Pick<Post, 'seriesPosition' | 'date' | 'slug'>} a
 * @param {Pick<Post, 'seriesPosition' | 'date' | 'slug'>} b
 * @returns {number}
 */
export function compareSeriesParts(a, b) {
  const aExplicit = a.seriesPosition !== null;
  const bExplicit = b.seriesPosition !== null;
  if (aExplicit !== bExplicit) return aExplicit ? -1 : 1;
  if (aExplicit && bExplicit && a.seriesPosition !== b.seriesPosition) {
    return /** @type {number} */ (a.seriesPosition) - /** @type {number} */ (b.seriesPosition);
  }
  return a.date.getTime() - b.date.getTime() || compareText(a.slug, b.slug);
}

/**
 * Groups posts by their `series` and orders each group. Posts without a series
 * are ignored. The result depends on the given posts only, so adding a post to
 * a series changes the "n of m" and the neighbours of every part of that series
 * on the next build, and no earlier post is edited for it.
 *
 * @param {readonly Post[]} posts The posts to group; pass published posts only.
 * @param {ReadonlyMap<string, SeriesMeta>} [meta] Display names and descriptions by series slug.
 * @returns {Series[]} Ordered by slug.
 */
export function buildSeries(posts, meta) {
  /** @type {Map<string, Post[]>} */
  const groups = new Map();
  for (const post of posts) {
    if (post.series === null) continue;
    const list = groups.get(post.series);
    if (list === undefined) groups.set(post.series, [post]);
    else list.push(post);
  }

  /** @type {Series[]} */
  const result = [];
  for (const slug of [...groups.keys()].sort(compareText)) {
    const ordered = [...(groups.get(slug) ?? [])].sort(compareSeriesParts);
    const entry = meta?.get(slug);
    result.push({
      slug,
      name: entry?.name ?? slug,
      description: entry?.description ?? null,
      count: ordered.length,
      parts: ordered.map((post, index) => ({
        post,
        number: index + 1,
        previous: ordered[index - 1] ?? null,
        next: ordered[index + 1] ?? null,
      })),
    });
  }
  return result;
}

/**
 * Warnings about series whose parts share an explicit `seriesPosition`; their
 * relative order then comes from the dates.
 *
 * @param {readonly Series[]} series
 * @param {(file: string) => string} [display] Turns a post file into the path shown in messages.
 * @returns {string[]}
 */
export function duplicatePositionWarnings(series, display = (file) => file) {
  /** @type {string[]} */
  const warnings = [];
  for (const entry of series) {
    /** @type {Map<number, Post[]>} */
    const byPosition = new Map();
    for (const { post } of entry.parts) {
      if (post.seriesPosition === null) continue;
      const list = byPosition.get(post.seriesPosition);
      if (list === undefined) byPosition.set(post.seriesPosition, [post]);
      else list.push(post);
    }
    for (const [position, list] of byPosition) {
      const [first, ...others] = list;
      for (const other of others) {
        warnings.push(
          `${display(other.file)}: seriesPosition: ${position} is also used by ${display(/** @type {Post} */ (first).file)} in the series "${entry.slug}"; those parts are ordered by date`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Reads the text of a `series.yaml`: a mapping of series slugs to `{ name,
 * description }`. Keys of an entry that coffer does not know are returned as
 * warnings.
 *
 * @param {string} file Path shown in messages.
 * @param {string} text Whole content of the file.
 * @returns {{ meta: Map<string, SeriesMeta>, warnings: string[] }}
 * @throws {SeriesError} When the file is not valid YAML, an entry is not a mapping, a series slug is invalid or repeated, or a value has the wrong type.
 */
export function parseSeriesMeta(file, text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, SeriesMeta>} */
  const meta = new Map();

  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const line = error.linePos?.[0]?.line;
      const where = line === undefined ? '' : ` (line ${line})`;
      const message = (error.message.split('\n')[0] ?? '')
        .replace(/ at line \d+, column \d+:?/, '')
        .trim();
      errors.push(`${file}: ${message}${where}`);
    }
    throw new SeriesError(errors);
  }
  const data = document.toJS();
  if (data === null || data === undefined) return { meta, warnings };
  if (!isMapping(data)) {
    throw new SeriesError([`${file}: must be a mapping of series slugs to { name, description }`]);
  }

  for (const [rawSlug, entry] of Object.entries(data)) {
    const slug = rawSlug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      errors.push(
        `${file}: ${rawSlug}: must be a series slug made of letters, digits, ".", "_" and "-"`,
      );
      continue;
    }
    if (meta.has(slug)) {
      errors.push(`${file}: ${rawSlug}: is the same series as an earlier entry, "${slug}"`);
      continue;
    }
    if (entry === null) {
      meta.set(slug, { name: null, description: null });
      continue;
    }
    if (!isMapping(entry)) {
      errors.push(`${file}: ${slug}: must be a mapping with "name" and "description"`);
      continue;
    }

    /** @type {SeriesMeta} */
    const value = { name: null, description: null };
    let valid = true;
    for (const [key, raw] of Object.entries(entry)) {
      if (!SERIES_META_KEYS.includes(key)) {
        warnings.push(
          `${file}: ${slug}.${key}: unknown key, ignored (expected one of: ${SERIES_META_KEYS.join(', ')})`,
        );
        continue;
      }
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== 'string' || raw.trim() === '') {
        errors.push(`${file}: ${slug}.${key}: must be a non-empty string`);
        valid = false;
        continue;
      }
      value[/** @type {'name' | 'description'} */ (key)] = raw.trim();
    }
    if (valid) meta.set(slug, value);
  }

  if (errors.length > 0) throw new SeriesError(errors);
  return { meta, warnings };
}

/**
 * Loads the optional `series.yaml` of a blog directory.
 *
 * @param {string} blogDir Directory holding the posts of the blog.
 * @returns {{ file: string | null, meta: Map<string, SeriesMeta>, warnings: string[] }} `file` is null when the blog has no `series.yaml`.
 * @throws {SeriesError} As {@link parseSeriesMeta}, or when the file cannot be read.
 */
export function loadSeriesMeta(blogDir) {
  const file = join(blogDir, SERIES_FILE_NAME);
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { file: null, meta: new Map(), warnings: [] };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SeriesError([`${file}: cannot be read: ${reason}`]);
  }
  return { file, ...parseSeriesMeta(file, text.replace(/^﻿/, '')) };
}

/**
 * Warnings about entries of `series.yaml` for series that no post uses.
 *
 * @param {string} file Path shown in messages.
 * @param {ReadonlyMap<string, SeriesMeta>} meta
 * @param {readonly Series[]} series
 * @returns {string[]}
 */
export function unusedSeriesWarnings(file, meta, series) {
  const used = new Set(series.map((entry) => entry.slug));
  /** @type {string[]} */
  const warnings = [];
  for (const slug of meta.keys()) {
    if (!used.has(slug)) {
      warnings.push(`${file}: ${slug}: no published post is in this series, entry ignored`);
    }
  }
  return warnings;
}

/**
 * Site-relative URL of a series page: `{blog}/{series}/{slug}/`.
 *
 * @param {string} blogUrl Site-relative URL of the blog, ending in a slash.
 * @param {string} seriesSegment The `urls.series` setting.
 * @param {string} slug Series slug.
 * @returns {string}
 */
export function seriesUrl(blogUrl, seriesSegment, slug) {
  return `${blogUrl}${seriesSegment}/${slug}/`;
}
