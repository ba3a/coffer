import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { normalizeTag, parseDateValue, parsePostSource, PostError } from './content/posts.js';

/**
 * Creating the skeleton of a new post (`coffer new`).
 */

/** Latin spelling of the Russian and Ukrainian letters, for URL-friendly slugs. */
const CYRILLIC = new Map(
  Object.entries({
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    ґ: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    є: 'ye',
    ж: 'zh',
    з: 'z',
    и: 'i',
    і: 'i',
    ї: 'yi',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  }),
);

/**
 * Raised when a post cannot be created. Every problem is listed in
 * {@link NewPostError#errors}.
 */
export class NewPostError extends Error {
  /**
   * @param {string[]} errors One entry per problem.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'NewPostError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

/**
 * Makes a slug from a title: lowercase Latin letters and digits separated by
 * single hyphens. Cyrillic letters are transliterated, accented Latin letters
 * lose their accents, everything else separates words.
 *
 * @param {string} title
 * @returns {string} The slug; empty when the title has no usable letters.
 */
export function slugify(title) {
  let latin = '';
  for (const char of title.toLowerCase().normalize('NFC')) {
    latin += CYRILLIC.get(char) ?? char;
  }
  return latin
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The moment as `YYYY-MM-DD HH:MM` on the clocks of a time zone, which is how
 * a front matter date without an offset is read.
 *
 * @param {Date} moment
 * @param {string} timezone IANA time zone name.
 * @returns {string}
 */
export function formatLocalDate(moment, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(moment);
  /** @param {string} type */
  const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/**
 * Splits a list of tags written as `a, b/c`.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitTags(text) {
  return text
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/**
 * @typedef {object} NewPostOptions
 * @property {import('./config.js').BlogConfig} blog The blog that receives the post.
 * @property {string} timezone Time zone of the site, in which the date is written.
 * @property {string} title Title of the post.
 * @property {string} [date] Date or date and time for the front matter (default now).
 * @property {string[]} [tags] Tags for the front matter (default none).
 * @property {string} [slug] Folder name of the post (default made from the title).
 * @property {Date} [now] The moment that is "now" (default the clock).
 */

/**
 * @typedef {object} NewPost
 * @property {string} slug
 * @property {string} dir Absolute path of the post's folder.
 * @property {string} file Absolute path of the post's `index.md`.
 */

/**
 * Puts the title, date and slug into a template body.
 *
 * @param {string} template
 * @param {Record<'title' | 'date' | 'slug', string>} values
 * @returns {string}
 */
function fillTemplate(template, values) {
  return template.replace(/\{\{\s*(title|date|slug)\s*\}\}/g, (_, key) => values[/** @type {'title' | 'date' | 'slug'} */ (key)]);
}

/**
 * Creates `{blog.dir}/{slug}/index.md` with the front matter filled in: the
 * title, the date, the tags and `draft: true`. The text below the front matter
 * is the blog's `newPostTemplate` when it has one.
 *
 * @param {NewPostOptions} options
 * @returns {NewPost}
 * @throws {NewPostError} For an empty title, an invalid date or tag, a slug that cannot be made, an unreadable template, or a post that already exists.
 */
export function createPost(options) {
  const { blog } = options;
  /** @type {string[]} */
  const errors = [];

  const title = options.title.trim();
  if (title === '') errors.push('the title must not be empty');

  const slug = options.slug === undefined ? slugify(title) : options.slug.trim().toLowerCase();
  if (slug === '' || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) {
    errors.push(
      options.slug === undefined
        ? `cannot make a slug from "${title}"; give one with --slug`
        : `the slug "${options.slug}" must be made of letters, digits, ".", "_" and "-"`,
    );
  }

  const now = options.now ?? new Date();
  const date = options.date === undefined ? formatLocalDate(now, options.timezone) : options.date.trim();
  const parsedDate = parseDateValue(date, options.timezone);
  if ('error' in parsedDate) errors.push(`--date: ${parsedDate.error}`);

  /** @type {string[]} */
  const tags = [];
  for (const tag of options.tags ?? []) {
    const normalized = normalizeTag(tag);
    if (normalized === undefined) {
      errors.push(
        `--tags: "${tag}" must be a slash separated path whose segments are made of letters, digits, ".", "_" and "-"`,
      );
    } else if (!tags.includes(normalized)) {
      tags.push(normalized);
    }
  }

  let body = '';
  if (blog.newPostTemplate !== undefined) {
    if (!existsSync(blog.newPostTemplate) || !statSync(blog.newPostTemplate).isFile()) {
      errors.push(`${blog.newPostTemplate}: newPostTemplate: file not found`);
    } else {
      body = readFileSync(blog.newPostTemplate, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
    }
  }

  if (errors.length > 0) throw new NewPostError(errors);

  const dir = join(blog.dir, slug);
  const file = join(dir, 'index.md');
  if (existsSync(dir) || existsSync(`${dir}.md`)) {
    throw new NewPostError([
      `${existsSync(dir) ? dir : `${dir}.md`}: already exists; nothing was written`,
    ]);
  }

  const text = [
    '---',
    stringify({ title }, { lineWidth: 0 }).trimEnd(),
    `date: ${date}`,
    tags.length === 0
      ? 'tags: []'
      : `tags: ${stringify(tags, { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 }).trimEnd()}`,
    'draft: true',
    '---',
    '',
    fillTemplate(body, { title, date, slug }).replace(/^\n+/, ''),
  ].join('\n');
  const finished = text.endsWith('\n') ? text : `${text}\n`;

  // The file has to read back as a post, whatever the title looks like.
  try {
    parsePostSource({ file, text: finished, slug, kind: 'folder', dir }, { timezone: options.timezone });
  } catch (error) {
    if (error instanceof PostError) throw new NewPostError(error.errors);
    throw error;
  }

  mkdirSync(blog.dir, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new NewPostError([`${dir}: already exists; nothing was written`]);
    }
    throw error;
  }
  writeFileSync(file, finished, { flag: 'wx' });
  return { slug, dir, file };
}
