import { isAbsoluteUrl, mapHtmlUrls } from './html-urls.js';
import { decodeEntities, escapeXml, escapeXmlAttribute } from './xml.js';

/** File name of a feed, under the page it belongs to. */
export const FEED_FILE_NAME = 'feed.xml';

/** Media type advertised for feeds. */
export const FEED_MEDIA_TYPE = 'application/atom+xml';

/** Longest automatic summary, in characters. */
export const MAX_EXCERPT_LENGTH = 240;

/**
 * One entry of a feed.
 *
 * @typedef {object} FeedEntry
 * @property {string} url Absolute permalink; also the entry id.
 * @property {string} title
 * @property {Date} published
 * @property {Date} updated
 * @property {string} summary Plain text.
 * @property {string} html Full post HTML with absolute URLs.
 * @property {{ term: string, label: string, scheme: string }[]} categories One per tag.
 */

/**
 * A feed ready to be written.
 *
 * @typedef {object} FeedDocument
 * @property {string} lang Language of the feed.
 * @property {string} selfUrl Absolute URL of the feed; also its id.
 * @property {string} alternateUrl Absolute URL of the page the feed belongs to.
 * @property {string} title
 * @property {string} subtitle May be empty.
 * @property {{ name: string, email: string | null, url: string | null }} author
 * @property {Date} updated Moment of the newest entry, or of the build for an empty feed.
 * @property {{ name: string, version: string }} generator
 * @property {FeedEntry[]} entries Newest first.
 */

/**
 * The address of the feed that belongs to a page.
 *
 * @param {string} pageUrl Site-relative URL of the page, ending in a slash.
 * @returns {string}
 */
export function feedUrlFor(pageUrl) {
  return `${pageUrl}${FEED_FILE_NAME}`;
}

/**
 * Joins the site's base URL and a site-relative path.
 *
 * @param {string} baseUrl Absolute URL without a trailing slash.
 * @param {string} path Site-relative path starting with `/`.
 * @returns {string}
 */
export function absoluteUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Rewrites every relative `href`, `src`, `srcset` and `poster` of an HTML
 * fragment into an absolute URL, so the text still works in a feed reader.
 * Paths starting with `/` are read from the site root (`baseUrl`, with its
 * path if it has one); other relative URLs, and fragments, from the page.
 *
 * @param {string} html
 * @param {string} pageUrl Absolute URL of the page the HTML belongs to.
 * @param {string} baseUrl Absolute URL of the site, without a trailing slash.
 * @returns {string}
 */
export function absolutizeHtml(html, pageUrl, baseUrl) {
  return mapHtmlUrls(html, (url) => {
    const value = url.trim();
    if (value === '' || isAbsoluteUrl(value)) return url;
    try {
      if (value.startsWith('/') && !value.startsWith('//')) return new URL(`${baseUrl.replace(/\/+$/, '')}${value}`).href;
      return new URL(value, pageUrl).href;
    } catch {
      return url;
    }
  });
}

/** The start tag of an element; quoted attribute values may hold ">". */
const startTag = (/** @type {string} */ name) => String.raw`<${name}\b(?:"[^"]*"|'[^']*'|[^'">])*>`;
const PICTURE_RE = new RegExp(String.raw`<picture>\s*${startTag('source')}\s*(${startTag('img')})\s*</picture>`, 'g');
const LAZY_ATTRIBUTE_RE = /\s(?:loading|decoding)="[^"]*"/g;

/**
 * Simplifies the pictures the Markdown renderer writes for feed readers, which
 * understand `<img>` and little else: each `<picture>` becomes its `<img>`,
 * whose `src` is the 1200 pixel variant, without `srcset`, `loading` and
 * `decoding`. The `width` and `height` stay.
 *
 * @param {string} html
 * @returns {string}
 */
export function simplifyPictures(html) {
  return html.replace(PICTURE_RE, (_whole, img) => String(img).replace(LAZY_ATTRIBUTE_RE, ''));
}

/**
 * A plain-text summary taken from the start of some HTML: code blocks,
 * scripts and tags are dropped and the text is cut at a word boundary.
 *
 * @param {string} html
 * @param {number} [max]
 * @returns {string}
 */
export function excerptOf(html, max = MAX_EXCERPT_LENGTH) {
  const text = decodeEntities(
    html
      .replace(/<(pre|script|style)[\s>][\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/?(?:a|b|i|u|em|strong|code|span|del|mark|small|sub|sup)(?:\s[^>]*)?>/gi, '')
      .replace(/<[^>]*>/g, ' '),
    { html: true },
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/**
 * Formats a moment as an RFC 3339 date-time in UTC, without fractions.
 *
 * @param {Date} date
 * @returns {string}
 */
export function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the feed entry of a post.
 *
 * @param {object} input
 * @param {string} input.baseUrl Absolute URL of the site, without a trailing slash.
 * @param {string} input.url Site-relative URL of the post.
 * @param {string} input.title
 * @param {Date} input.date
 * @param {string | null} input.summary Summary from the front matter, if any.
 * @param {string} input.html Rendered body of the post.
 * @param {{ path: string, name: string }[]} input.tags
 * @param {string} input.tagsIndexUrl Site-relative URL of the tag tree, used as the scheme of the categories.
 * @returns {FeedEntry}
 */
export function createFeedEntry({ baseUrl, url, title, date, summary, html, tags, tagsIndexUrl }) {
  const permalink = absoluteUrl(baseUrl, url);
  const full = absolutizeHtml(simplifyPictures(html), permalink, baseUrl);
  return {
    url: permalink,
    title,
    published: date,
    updated: date,
    summary: summary !== null && summary.trim() !== '' ? summary.trim() : excerptOf(full),
    html: full,
    categories: tags.map((tag) => ({
      term: tag.path,
      label: tag.name,
      scheme: absoluteUrl(baseUrl, tagsIndexUrl),
    })),
  };
}

/**
 * Orders entries newest first; entries of the same moment by address.
 *
 * @param {FeedEntry[]} entries
 * @returns {FeedEntry[]}
 */
export function sortNewestFirst(entries) {
  return [...entries].sort(
    (a, b) => b.published.getTime() - a.published.getTime() || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
  );
}

/**
 * Writes a feed as an Atom 1.0 document.
 *
 * @param {FeedDocument} feed
 * @returns {string}
 */
export function renderFeed(feed) {
  /** @type {string[]} */
  const lines = [];
  const tag = (/** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ indent = '  ') =>
    `${indent}<${name}>${escapeXml(value)}</${name}>`;
  const author = (/** @type {string} */ indent) => {
    const parts = [`${indent}<author>`, tag('name', feed.author.name, `${indent}  `)];
    if (feed.author.email) parts.push(tag('email', feed.author.email, `${indent}  `));
    if (feed.author.url) parts.push(tag('uri', feed.author.url, `${indent}  `));
    parts.push(`${indent}</author>`);
    return parts.join('\n');
  };

  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXmlAttribute(feed.lang)}">`);
  lines.push(tag('id', feed.selfUrl));
  lines.push(tag('title', feed.title));
  if (feed.subtitle !== '') lines.push(tag('subtitle', feed.subtitle));
  lines.push(tag('updated', rfc3339(feed.updated)));
  lines.push(`  <link rel="self" type="${FEED_MEDIA_TYPE}" href="${escapeXmlAttribute(feed.selfUrl)}"/>`);
  lines.push(`  <link rel="alternate" type="text/html" href="${escapeXmlAttribute(feed.alternateUrl)}"/>`);
  lines.push(author('  '));
  lines.push(
    `  <generator version="${escapeXmlAttribute(feed.generator.version)}">${escapeXml(feed.generator.name)}</generator>`,
  );
  for (const entry of feed.entries) {
    lines.push('  <entry>');
    lines.push(tag('id', entry.url, '    '));
    lines.push(tag('title', entry.title, '    '));
    lines.push(`    <link rel="alternate" type="text/html" href="${escapeXmlAttribute(entry.url)}"/>`);
    lines.push(tag('published', rfc3339(entry.published), '    '));
    lines.push(tag('updated', rfc3339(entry.updated), '    '));
    lines.push(author('    '));
    for (const category of entry.categories) {
      lines.push(
        `    <category term="${escapeXmlAttribute(category.term)}" scheme="${escapeXmlAttribute(category.scheme)}" label="${escapeXmlAttribute(category.label)}"/>`,
      );
    }
    lines.push(tag('summary', entry.summary, '    '));
    lines.push(`    <content type="html">${escapeXml(entry.html)}</content>`);
    lines.push('  </entry>');
  }
  lines.push('</feed>');
  return `${lines.join('\n')}\n`;
}

/**
 * Picks the entries a feed carries: newest first, cut to `limit` when given.
 *
 * @param {FeedEntry[]} entries
 * @param {number | null} limit `null` keeps every entry.
 * @returns {FeedEntry[]}
 */
export function selectEntries(entries, limit) {
  const sorted = sortNewestFirst(entries);
  return limit === null ? sorted : sorted.slice(0, limit);
}
