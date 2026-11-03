import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';

/**
 * A blog post as read from disk.
 *
 * @typedef {object} Post
 * @property {string} slug Last URL segment of the post; the folder or file name, never derived from date or tags.
 * @property {'folder' | 'file'} kind Whether the post is `{slug}/index.md` or `{slug}.md`.
 * @property {string} file Absolute path of the Markdown file.
 * @property {string} dir Directory holding the post's text; for a folder post also its images.
 * @property {string} title Title of the post.
 * @property {Date} date Moment of publication.
 * @property {boolean} dateOnly True when the front matter gave a date without a time.
 * @property {string[]} tags Normalized tag paths: lowercase, slash separated, no empty segments, no duplicates.
 * @property {string | null} summary Short summary, if given.
 * @property {string | null} cover Cover image reference as written (a path beside the post or a URL), if given.
 * @property {string | null} series Name of the series the post belongs to, if any.
 * @property {number | null} seriesPosition Explicit position in the series, if given.
 * @property {boolean} draft True for a draft.
 * @property {string[]} aliases Old slugs that redirect to this post.
 * @property {string | null} location Location policy override as written; checked when the policy is resolved.
 * @property {string | null} camera Camera metadata policy override as written; checked when the policy is resolved.
 * @property {boolean | null} map True or false to force or suppress the map; null to decide from the post's content.
 * @property {Record<string, unknown>} frontMatter The parsed front matter, including keys this module does not know.
 * @property {string} body The Markdown text after the front matter.
 * @property {number} bodyLine 1-based line of the file on which `body` starts.
 */

/**
 * Options for {@link discoverPosts} and {@link parsePostSource}.
 *
 * @typedef {object} ParseOptions
 * @property {string} [timezone] IANA time zone used for dates without a time or an offset; `UTC` by default.
 */

/**
 * Raised when posts cannot be read or validated. Every problem is listed in
 * {@link PostError#errors}; the message joins them. Each entry starts with the
 * file path and names the field.
 */
export class PostError extends Error {
  /**
   * @param {string[]} errors One entry per problem.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'PostError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * Offset of a time zone from UTC at an instant, in milliseconds.
 *
 * @param {number} instant Milliseconds since the epoch.
 * @param {string} timeZone
 * @returns {number}
 */
function zoneOffset(instant, timeZone) {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  /** @type {Record<string, number>} */
  const fields = {};
  for (const part of format.formatToParts(new Date(instant))) {
    fields[part.type] = Number(part.value);
  }
  const wall = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * Turns a wall-clock time in a time zone into an instant.
 *
 * @param {number} wall The wall-clock time read as if it were UTC.
 * @param {string} timeZone
 * @returns {number}
 */
function wallToInstant(wall, timeZone) {
  const guess = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(guess, timeZone);
}

/**
 * Parses a front matter date: `YYYY-MM-DD`, or `YYYY-MM-DD` followed by `T` or
 * a space, `HH:MM[:SS[.fff]]` and an optional `Z` or `+HH:MM` offset. A date
 * without a time means 00:00, and a time without an offset is read in
 * `timezone`.
 *
 * @param {unknown} value
 * @param {string} [timezone] IANA time zone name; `UTC` by default.
 * @returns {{ date: Date, dateOnly: boolean } | { error: string }}
 */
export function parseDateValue(value, timezone = 'UTC') {
  const shape = 'must be a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM)';
  if (typeof value !== 'string') return { error: shape };
  const match = DATE_RE.exec(value.trim());
  if (match === null) return { error: shape };
  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = h === undefined ? 0 : Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millis =
    fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(wall);
  if (
    month < 1 ||
    month > 12 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { error: `"${value.trim()}" is not a real date or time` };
  }
  const dateOnly = h === undefined;
  if (zone === undefined) {
    return { date: new Date(wallToInstant(wall, timezone)), dateOnly };
  }
  if (zone.toUpperCase() === 'Z') return { date: new Date(wall), dateOnly };
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offsetHours = Number(digits.slice(0, 2));
  const offsetMinutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
  if (offsetHours > 23 || offsetMinutes > 59) {
    return { error: `"${value.trim()}" has an invalid UTC offset` };
  }
  const offset = sign * (offsetHours * 60 + offsetMinutes) * 60000;
  return { date: new Date(wall - offset), dateOnly };
}

/**
 * Splits a Markdown file into its front matter text and body.
 *
 * @param {string} text
 * @returns {{ yaml: string, body: string, bodyLine: number } | undefined} Undefined when the file has no front matter.
 */
function splitFrontMatter(text) {
  const source = text.replace(/^﻿/, '');
  const open = /^---[ \t]*\r?\n/.exec(source);
  if (open === null) return undefined;
  const rest = source.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (close === null) return undefined;
  const yaml = rest.slice(0, close.index);
  const body = rest.slice(close.index + close[0].length);
  const lines = (yaml.match(/\n/g) ?? []).length;
  return { yaml, body, bodyLine: lines + 3 };
}

/**
 * Normalizes a tag to a lowercase slash path. Every segment becomes part of a
 * URL and of a file name, so it must be made of letters, digits, ".", "_" and
 * "-" and start with a letter or a digit (which also rules out "." and "..").
 *
 * @param {string} tag
 * @returns {string | undefined} The normalized tag, or undefined when a segment is empty or unusable.
 */
export function normalizeTag(tag) {
  const segments = tag.split('/').map((segment) => segment.trim().toLowerCase());
  return segments.every((segment) => SLUG_RE.test(segment))
    ? segments.join('/')
    : undefined;
}

/**
 * Splits a Markdown file into its front matter, parsed, and its body.
 *
 * @param {string} file Path shown in error messages.
 * @param {string} text Whole content of the file.
 * @param {string[]} errors Receives one entry per problem.
 * @returns {{ data: Record<string, unknown>, body: string, bodyLine: number } | undefined} Undefined when problems were found.
 */
export function readFrontMatter(file, text, errors) {
  /** @param {string} field @param {string} message */
  const fail = (field, message) => {
    errors.push(`${file}: ${field}: ${message}`);
  };

  const parts = splitFrontMatter(text);
  if (parts === undefined) {
    fail(
      'front matter',
      'missing; the file must start with a "---" line and close the front matter with another "---" line',
    );
    return undefined;
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(parts.yaml, { lineCounter, uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const line = error.linePos?.[0]?.line;
      const where = line === undefined ? '' : ` (line ${line + 1})`;
      const message = (error.message.split('\n')[0] ?? '')
        .replace(/ at line \d+, column \d+:?/, '')
        .trim();
      fail('front matter', `${message}${where}`);
    }
    return undefined;
  }
  const data = document.toJS();
  if (data !== null && !isMapping(data)) {
    fail('front matter', 'must be a mapping of keys to values');
    return undefined;
  }
  return { data: data ?? {}, body: parts.body, bodyLine: parts.bodyLine };
}

/**
 * Reads the posts' YAML front matter from the text of one file.
 *
 * @param {string} file Path shown in error messages.
 * @param {string} text Whole content of the file.
 * @param {string} slug
 * @param {'folder' | 'file'} kind
 * @param {string} dir
 * @param {ParseOptions} options
 * @param {string[]} errors Receives one entry per problem.
 * @returns {Post | undefined} The post, or undefined when problems were found.
 */
function parseInto(file, text, slug, kind, dir, options, errors) {
  const before = errors.length;
  /** @param {string} field @param {string} message */
  const fail = (field, message) => {
    errors.push(`${file}: ${field}: ${message}`);
  };

  const parts = readFrontMatter(file, text, errors);
  if (parts === undefined) return undefined;
  const fm = parts.data;

  /**
   * @param {string} key
   * @returns {string | null | undefined} undefined after a reported problem.
   */
  const optionalString = (key) => {
    const value = fm[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      fail(key, 'must be a non-empty string');
      return undefined;
    }
    return value.trim();
  };

  /**
   * @param {string} key
   * @returns {boolean | null | undefined} undefined after a reported problem.
   */
  const optionalBoolean = (key) => {
    const value = fm[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'boolean') {
      fail(key, 'must be true or false');
      return undefined;
    }
    return value;
  };

  /**
   * @param {string} key
   * @returns {string[] | undefined} undefined after a reported problem.
   */
  const optionalStringList = (key) => {
    const value = fm[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      fail(key, 'must be a list');
      return undefined;
    }
    /** @type {string[]} */
    const strings = [];
    let valid = true;
    value.forEach((item, index) => {
      if (typeof item !== 'string') {
        fail(`${key}[${index}]`, 'must be a string');
        valid = false;
      } else {
        strings.push(item);
      }
    });
    return valid ? strings : undefined;
  };

  const title = fm.title;
  if (title === undefined || title === null) {
    fail('title', 'is required');
  } else if (typeof title !== 'string' || title.trim() === '') {
    fail('title', 'must be a non-empty string');
  }

  /** @type {{ date: Date, dateOnly: boolean } | undefined} */
  let when;
  if (fm.date === undefined || fm.date === null) {
    fail('date', 'is required');
  } else {
    const parsed = parseDateValue(fm.date, options.timezone ?? 'UTC');
    if ('error' in parsed) fail('date', parsed.error);
    else when = parsed;
  }

  /** @type {string[]} */
  const tags = [];
  const rawTags = optionalStringList('tags');
  if (rawTags !== undefined) {
    rawTags.forEach((tag, index) => {
      const normalized = normalizeTag(tag);
      if (normalized === undefined) {
        fail(
          `tags[${index}]`,
          `"${tag}" must be a slash separated path whose segments are made of letters, digits, ".", "_" and "-"`,
        );
      } else if (!tags.includes(normalized)) {
        tags.push(normalized);
      }
    });
  }

  const summary = optionalString('summary');
  const cover = optionalString('cover');
  const series = optionalString('series');
  const location = optionalString('location');
  const camera = optionalString('camera');
  const draft = optionalBoolean('draft');
  const map = optionalBoolean('map');

  /** @type {number | null} */
  let seriesPosition = null;
  const rawPosition = fm.seriesPosition;
  if (rawPosition !== undefined && rawPosition !== null) {
    if (typeof rawPosition !== 'number' || !Number.isInteger(rawPosition)) {
      fail('seriesPosition', 'must be an integer');
    } else if (series === null) {
      fail('seriesPosition', 'needs a "series" to belong to');
    } else {
      seriesPosition = rawPosition;
    }
  }

  /** @type {string[]} */
  const aliases = [];
  const rawAliases = optionalStringList('aliases');
  if (rawAliases !== undefined) {
    rawAliases.forEach((alias, index) => {
      const value = alias.trim();
      if (!SLUG_RE.test(value)) {
        fail(
          `aliases[${index}]`,
          `"${alias}" must be a slug made of letters, digits, ".", "_" and "-"`,
        );
      } else if (value === slug) {
        fail(`aliases[${index}]`, `"${alias}" is the post's own slug`);
      } else if (!aliases.includes(value)) {
        aliases.push(value);
      }
    });
  }

  if (errors.length > before || when === undefined) return undefined;
  return {
    slug,
    kind,
    file,
    dir,
    title: /** @type {string} */ (title).trim(),
    date: when.date,
    dateOnly: when.dateOnly,
    tags,
    summary: summary ?? null,
    cover: cover ?? null,
    series: series ?? null,
    seriesPosition,
    draft: draft ?? false,
    aliases,
    location: location ?? null,
    camera: camera ?? null,
    map: map ?? null,
    frontMatter: fm,
    body: parts.body,
    bodyLine: parts.bodyLine,
  };
}

/**
 * Parses the text of one post file.
 *
 * @param {object} source
 * @param {string} source.file Path of the file, used in error messages and stored in the post.
 * @param {string} source.text Content of the file.
 * @param {string} source.slug
 * @param {'folder' | 'file'} [source.kind]
 * @param {string} [source.dir]
 * @param {ParseOptions} [options]
 * @returns {Post}
 * @throws {PostError} When the front matter is missing or invalid.
 */
export function parsePostSource(source, options = {}) {
  /** @type {string[]} */
  const errors = [];
  const post = parseInto(
    source.file,
    source.text,
    source.slug,
    source.kind ?? 'file',
    source.dir ?? source.file,
    options,
    errors,
  );
  if (post === undefined) throw new PostError(errors);
  return post;
}

/**
 * Finds the post files of a blog directory: `{slug}/index.md` (a folder post,
 * with its images beside it) and `{slug}.md` (a single-file post). Folders
 * without an `index.md`, other files and names starting with a dot are ignored.
 *
 * @param {string} blogDir
 * @param {string[]} errors
 * @returns {{ slug: string, kind: 'folder' | 'file', file: string, dir: string }[]}
 */
function listPostFiles(blogDir, errors) {
  /** @type {{ slug: string, kind: 'folder' | 'file', file: string, dir: string }[]} */
  const found = [];
  const names = readdirSync(blogDir).sort();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(blogDir, name);
    if (statSync(path).isDirectory()) {
      const file = join(path, 'index.md');
      if (existsSync(file) && statSync(file).isFile()) {
        found.push({ slug: name, kind: 'folder', file, dir: path });
      }
    } else if (name.toLowerCase().endsWith('.md')) {
      found.push({
        slug: name.slice(0, -'.md'.length),
        kind: 'file',
        file: path,
        dir: blogDir,
      });
    }
  }
  for (const entry of found) {
    if (!SLUG_RE.test(entry.slug)) {
      errors.push(
        `${entry.file}: slug: "${entry.slug}" (the folder or file name) must be made of letters, digits, ".", "_" and "-"`,
      );
    }
  }
  return found;
}

/**
 * Finds and parses every post of a blog. Posts are returned newest first, ties
 * broken by slug. Drafts and future-dated posts are included; use
 * {@link isPublished} to filter them.
 *
 * @param {string} blogDir Directory holding the posts.
 * @param {ParseOptions} [options]
 * @returns {Post[]}
 * @throws {PostError} With every problem found: unreadable directory, invalid front matter, duplicate slugs.
 */
export function discoverPosts(blogDir, options = {}) {
  if (!existsSync(blogDir) || !statSync(blogDir).isDirectory()) {
    throw new PostError([`${blogDir}: blog directory does not exist`]);
  }
  /** @type {string[]} */
  const errors = [];
  const files = listPostFiles(blogDir, errors);

  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const entry of files) {
    const key = entry.slug.toLowerCase();
    const earlier = seen.get(key);
    if (earlier === undefined) {
      seen.set(key, entry.file);
    } else {
      errors.push(
        `${entry.file}: slug: "${entry.slug}" is already used by ${earlier}; slugs must be unique within a blog`,
      );
    }
  }

  /** @type {Post[]} */
  const posts = [];
  for (const entry of files) {
    let text;
    try {
      text = readFileSync(entry.file, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${entry.file}: cannot be read: ${reason}`);
      continue;
    }
    const post = parseInto(
      entry.file,
      text,
      entry.slug,
      entry.kind,
      entry.dir,
      options,
      errors,
    );
    if (post !== undefined) posts.push(post);
  }
  if (errors.length > 0) throw new PostError(errors);

  return posts.sort(
    (a, b) =>
      b.date.getTime() - a.date.getTime() ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
}

/**
 * Whether a post goes into the published site. Drafts are excluded and posts
 * dated after `now` are excluded, unless `drafts` (preview mode) is set, which
 * includes everything.
 *
 * @param {Pick<Post, 'draft' | 'date'>} post
 * @param {{ now: Date, drafts?: boolean }} options
 * @returns {boolean}
 */
export function isPublished(post, { now, drafts = false }) {
  if (drafts) return true;
  if (post.draft) return false;
  return post.date.getTime() <= now.getTime();
}

/**
 * Decides what "now" is for a build: the `--now` option wins, then the
 * `COFFER_NOW` environment variable, then the clock. The value is a date or a
 * date and time as in front matter; a value without an offset is read in
 * `timezone`.
 *
 * @param {object} [sources]
 * @param {string | undefined} [sources.flag] Value of `--now`.
 * @param {Record<string, string | undefined>} [sources.env] Environment variables.
 * @param {() => Date} [sources.clock] Source of the current time.
 * @param {string} [sources.timezone] IANA time zone name; `UTC` by default.
 * @returns {Date}
 * @throws {Error} When the value is not a date.
 */
export function resolveNow({
  flag,
  env = process.env,
  clock = () => new Date(),
  timezone = 'UTC',
} = {}) {
  /** @type {[string, string | undefined][]} */
  const candidates = [
    ['--now', flag],
    ['COFFER_NOW', env.COFFER_NOW],
  ];
  for (const [name, value] of candidates) {
    if (value === undefined || value.trim() === '') continue;
    const parsed = parseDateValue(value, timezone);
    if ('error' in parsed) throw new Error(`${name}: ${parsed.error}`);
    return parsed.date;
  }
  return clock();
}
