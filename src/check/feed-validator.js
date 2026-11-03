import { readFileSync } from 'node:fs';

import { isAbsoluteUrl, listHtmlUrls } from '../html-urls.js';
import { XmlError, parseXml } from '../xml.js';

/** Namespace of Atom 1.0. */
export const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';

/** Media type of an Atom feed document. */
export const ATOM_MEDIA_TYPE = 'application/atom+xml';

/**
 * @typedef {import('../xml.js').XmlElement} XmlElement
 */

/**
 * @typedef {object} FeedValidationOptions
 * @property {string} [selfUrl] The absolute URL the feed is served from; its `rel="self"` link must be exactly this.
 */

/**
 * @typedef {object} FeedValidation
 * @property {boolean} valid True when there are no errors.
 * @property {string[]} errors Problems that make the feed invalid.
 * @property {string[]} warnings Things readers accept but that are worth fixing.
 * @property {number} entries Number of entries found.
 */

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether a string is an RFC 3339 date-time: full date, `T`, full time with
 * an offset, and every part within its range.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isRfc3339(value) {
  const match = RFC3339.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) return false;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > lastDay) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60) return false;
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
  return true;
}

/**
 * Elements of the Atom namespace directly inside `parent`.
 *
 * @param {XmlElement} parent
 * @param {string} local
 * @returns {XmlElement[]}
 */
function atomChildren(parent, local) {
  return parent.children.filter((child) => child.namespace === ATOM_NAMESPACE && child.local === local);
}

/**
 * Collects problems of one feed.
 */
class Report {
  constructor() {
    /** @type {string[]} */
    this.errors = [];
    /** @type {string[]} */
    this.warnings = [];
  }

  /**
   * @param {XmlElement} element
   * @param {string} message
   */
  error(element, message) {
    this.errors.push(`line ${element.line}: ${message}`);
  }

  /**
   * @param {XmlElement} element
   * @param {string} message
   */
  warn(element, message) {
    this.warnings.push(`line ${element.line}: ${message}`);
  }
}

/**
 * Checks that `parent` has exactly one child `local` and returns it.
 *
 * @param {Report} report
 * @param {XmlElement} parent
 * @param {string} local
 * @param {string} where Name of the parent for messages, such as `feed` or `entry`.
 * @returns {XmlElement | null}
 */
function requireOne(report, parent, local, where) {
  const found = atomChildren(parent, local);
  if (found.length === 0) {
    report.error(parent, `${where} has no <${local}>`);
    return null;
  }
  if (found.length > 1) report.error(found[1], `${where} has more than one <${local}>`);
  return found[0];
}

/**
 * @param {Report} report
 * @param {XmlElement} element
 * @param {string} where
 * @returns {void}
 */
function checkDate(report, element, where) {
  const value = element.text.trim();
  if (!isRfc3339(value)) {
    report.error(element, `${where} <${element.local}> is not an RFC 3339 date-time: "${value}"`);
  }
}

/**
 * @param {Report} report
 * @param {XmlElement} element A `<link>`.
 * @param {string} where
 * @returns {void}
 */
function checkLink(report, element, where) {
  const href = element.attributes.href;
  if (href === undefined || href.trim() === '') {
    report.error(element, `${where} <link> has no href`);
  } else if (!isAbsoluteUrl(href)) {
    report.error(element, `${where} <link> href is not an absolute URL: "${href}"`);
  }
}

/**
 * @param {Report} report
 * @param {XmlElement} author
 * @param {string} where
 * @returns {void}
 */
function checkAuthor(report, author, where) {
  const name = atomChildren(author, 'name');
  if (name.length !== 1 || name[0].text.trim() === '') {
    report.error(author, `${where} <author> needs exactly one non-empty <name>`);
  }
  for (const uri of atomChildren(author, 'uri')) {
    if (!isAbsoluteUrl(uri.text.trim())) report.error(uri, `${where} <author> <uri> is not an absolute URL: "${uri.text.trim()}"`);
  }
}

/**
 * @param {Report} report
 * @param {XmlElement} entry
 * @param {Set<string>} ids
 * @param {string} feedId
 * @returns {void}
 */
function checkEntry(report, entry, ids, feedId) {
  const id = requireOne(report, entry, 'id', 'entry');
  const label = id ? `entry ${id.text.trim()}` : 'entry';
  if (id) {
    const value = id.text.trim();
    if (!isAbsoluteUrl(value) || /\s/.test(value)) report.error(id, `${label}: <id> is not an absolute IRI`);
    if (ids.has(value)) report.error(id, `${label}: <id> is used by another entry`);
    if (value === feedId) report.error(id, `${label}: <id> equals the id of the feed`);
    ids.add(value);
  }
  const title = requireOne(report, entry, 'title', label);
  if (title && title.text.trim() === '') report.error(title, `${label}: <title> is empty`);
  const updated = requireOne(report, entry, 'updated', label);
  if (updated) checkDate(report, updated, label);
  for (const published of atomChildren(entry, 'published')) checkDate(report, published, label);

  const links = atomChildren(entry, 'link');
  for (const link of links) checkLink(report, link, label);
  const alternates = links.filter((link) => (link.attributes.rel ?? 'alternate') === 'alternate');
  const content = atomChildren(entry, 'content');
  if (content.length > 1) report.error(content[1], `${label} has more than one <content>`);
  const summary = atomChildren(entry, 'summary');
  if (summary.length > 1) report.error(summary[1], `${label} has more than one <summary>`);
  if (content.length === 0 && alternates.length === 0) {
    report.error(entry, `${label} needs a <content> or a link with rel="alternate"`);
  }
  if (summary.length === 0) {
    if (content.length === 0 || content[0].attributes.src !== undefined) {
      report.error(entry, `${label} needs a <summary>`);
    } else {
      report.warn(entry, `${label} has no <summary>`);
    }
  }
  for (const author of atomChildren(entry, 'author')) checkAuthor(report, author, label);
  for (const category of atomChildren(entry, 'category')) {
    if ((category.attributes.term ?? '').trim() === '') report.error(category, `${label}: <category> has no term`);
  }

  const body = content[0];
  if (body) {
    const type = body.attributes.type ?? 'text';
    if (!['text', 'html', 'xhtml'].includes(type) && !/^[^/\s]+\/[^/\s]+$/.test(type)) {
      report.error(body, `${label}: <content> type "${type}" is not text, html, xhtml or a media type`);
    }
    if (type === 'html') {
      const html = body.text;
      if (html.trim() === '') report.warn(body, `${label}: <content> is empty`);
      for (const found of listHtmlUrls(html)) {
        if (!isAbsoluteUrl(found.url)) {
          report.error(
            body,
            `${label}: <content> has a relative URL in ${found.tag} ${found.attribute}: "${found.url}"`,
          );
        }
      }
    }
  }
}

/**
 * Validates an Atom 1.0 feed locally: well-formed XML, the elements RFC 4287
 * requires, RFC 3339 dates, absolute URLs (in links and inside HTML content),
 * unique entry ids and a correct self link. It does not replace the W3C feed
 * validator, which `coffer check --w3c` calls; it finds the same kinds of
 * problem without a network.
 *
 * @param {string} xml The feed document.
 * @param {FeedValidationOptions} [options]
 * @returns {FeedValidation}
 */
export function validateFeed(xml, options = {}) {
  const report = new Report();
  let root;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlError) {
      return { valid: false, errors: [`not well-formed XML: ${error.message}`], warnings: [], entries: 0 };
    }
    throw error;
  }
  if (root.namespace !== ATOM_NAMESPACE || root.local !== 'feed') {
    return {
      valid: false,
      errors: [`the root element must be <feed xmlns="${ATOM_NAMESPACE}">, not <${root.name}>`],
      warnings: [],
      entries: 0,
    };
  }

  const id = requireOne(report, root, 'id', 'feed');
  const feedId = id ? id.text.trim() : '';
  if (id && (!isAbsoluteUrl(feedId) || /\s/.test(feedId))) report.error(id, 'feed <id> is not an absolute IRI');
  const title = requireOne(report, root, 'title', 'feed');
  if (title && title.text.trim() === '') report.error(title, 'feed <title> is empty');
  const updated = requireOne(report, root, 'updated', 'feed');
  if (updated) checkDate(report, updated, 'feed');

  const links = atomChildren(root, 'link');
  for (const link of links) checkLink(report, link, 'feed');
  const selves = links.filter((link) => link.attributes.rel === 'self');
  if (selves.length === 0) {
    report.error(root, 'feed has no <link rel="self">');
  } else {
    if (selves.length > 1) report.error(selves[1], 'feed has more than one <link rel="self">');
    const self = selves[0];
    if (self.attributes.type !== ATOM_MEDIA_TYPE) {
      report.warn(self, `the self link should have type="${ATOM_MEDIA_TYPE}"`);
    }
    if (options.selfUrl !== undefined && self.attributes.href !== options.selfUrl) {
      report.error(
        self,
        `the self link is "${self.attributes.href ?? ''}", the feed is served from "${options.selfUrl}"`,
      );
    }
  }
  if (!links.some((link) => (link.attributes.rel ?? 'alternate') === 'alternate')) {
    report.warn(root, 'feed has no <link rel="alternate"> to the page it belongs to');
  }

  const entries = atomChildren(root, 'entry');
  const feedAuthors = atomChildren(root, 'author');
  for (const author of feedAuthors) checkAuthor(report, author, 'feed');
  if (feedAuthors.length === 0) {
    const without = entries.filter((entry) => atomChildren(entry, 'author').length === 0);
    if (entries.length === 0 || without.length > 0) {
      report.error(root, 'the feed has no <author>, and not every entry has one');
    }
  }

  const ids = new Set();
  for (const entry of entries) checkEntry(report, entry, ids, feedId);

  return { valid: report.errors.length === 0, errors: report.errors, warnings: report.warnings, entries: entries.length };
}

/**
 * Reads a feed file and validates it with {@link validateFeed}.
 *
 * @param {string} file Path of the feed file.
 * @param {FeedValidationOptions} [options]
 * @returns {FeedValidation}
 */
export function validateFeedFile(file, options = {}) {
  return validateFeed(readFileSync(file, 'utf8'), options);
}
