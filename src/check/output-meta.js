import { decodeEntities } from '../xml.js';

/**
 * What the head of an HTML page says about the page.
 *
 * @typedef {object} PageHead
 * @property {string | null} title Text of `<title>`, or null when there is none.
 * @property {Map<string, string[]>} meta Values of `<meta content>` by `name` or `property`, in document order.
 * @property {string[]} canonical Values of `<link rel="canonical" href>`.
 */

/** Tags whose attributes are read: `<meta ...>` and `<link ...>`. */
const HEAD_TAG_RE = /<(meta|link)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gi;
const ATTRIBUTE_RE = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * @param {string} source The attributes of a start tag.
 * @returns {Record<string, string>} Lower-case names to decoded values.
 */
function readAttributes(source) {
  /** @type {Record<string, string>} */
  const attributes = {};
  for (const match of source.matchAll(ATTRIBUTE_RE)) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[match[1].toLowerCase()] = decodeEntities(value, { html: true });
  }
  return attributes;
}

/**
 * Reads the title, the `<meta>` values and the canonical link out of the head
 * of a page.
 *
 * @param {string} html
 * @returns {PageHead}
 */
export function readPageHead(html) {
  const headMatch = /<head[\s>][\s\S]*?<\/head\s*>/i.exec(html);
  const head = headMatch ? headMatch[0] : html;
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  /** @type {Map<string, string[]>} */
  const meta = new Map();
  /** @type {string[]} */
  const canonical = [];
  for (const match of head.matchAll(HEAD_TAG_RE)) {
    const attributes = readAttributes(match[2]);
    if (match[1].toLowerCase() === 'meta') {
      const key = (attributes.property ?? attributes.name ?? '').toLowerCase();
      if (key === '' || attributes.content === undefined) continue;
      const values = meta.get(key) ?? [];
      values.push(attributes.content);
      meta.set(key, values);
    } else if (
      (attributes.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') &&
      attributes.href !== undefined
    ) {
      canonical.push(attributes.href);
    }
  }
  return {
    title: titleMatch ? decodeEntities(titleMatch[1], { html: true }).trim() : null,
    meta,
    canonical,
  };
}

/**
 * The `<meta>` keys every shareable page needs, with a label for messages.
 */
const REQUIRED_META = Object.freeze([
  ['description', 'description'],
  ['og:title', 'og:title'],
  ['og:image', 'og:image'],
  ['twitter:card', 'twitter:card'],
]);

/**
 * Lists the preview metadata a page lacks: a title, a description, a
 * canonical link, `og:title`, `og:image` and `twitter:card`, each non-empty.
 *
 * @param {PageHead} head
 * @param {string} [expectedCanonical] The absolute URL the canonical link must have.
 * @returns {string[]} One message per problem.
 */
export function pagePreviewProblems(head, expectedCanonical) {
  /** @type {string[]} */
  const problems = [];
  if (head.title === null || head.title === '') problems.push('missing title');
  for (const [key, label] of REQUIRED_META) {
    const values = head.meta.get(key) ?? [];
    if (!values.some((value) => value.trim() !== '')) problems.push(`missing ${label}`);
  }
  const canonical = head.canonical.filter((value) => value.trim() !== '');
  if (canonical.length === 0) {
    problems.push('missing canonical link');
  } else if (expectedCanonical !== undefined && !canonical.includes(expectedCanonical)) {
    problems.push(`canonical link is "${canonical[0]}", expected "${expectedCanonical}"`);
  }
  return problems;
}
