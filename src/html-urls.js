import { decodeEntities } from './xml.js';

/**
 * Where a URL was found in a piece of HTML.
 *
 * @typedef {object} UrlSite
 * @property {string} tag Lower-case tag name.
 * @property {'href' | 'src' | 'srcset' | 'poster'} attribute
 */

/** Attributes that hold a URL, or a list of URLs for `srcset`. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'poster']);

/**
 * A start tag with quoted or bare attribute values. Text and attribute values
 * produced by the Markdown renderer never contain a raw "<", so this does not
 * match inside code listings.
 */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTRIBUTE_RE = /(\s+)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Splits a `srcset` value into candidates and maps each URL.
 *
 * @param {string} value
 * @param {(url: string) => string} map
 * @returns {string}
 */
function mapSrcset(value, map) {
  /** @type {string[]} */
  const candidates = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index])) index += 1;
    if (index >= value.length) break;
    const start = index;
    while (index < value.length && !/\s/.test(value[index])) index += 1;
    let url = value.slice(start, index);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const descriptorStart = index;
      while (index < value.length && value[index] !== ',') index += 1;
      descriptor = value.slice(descriptorStart, index).trim();
    }
    candidates.push(`${map(url)}${descriptor === '' ? '' : ` ${descriptor}`}`);
  }
  return candidates.join(', ');
}

/**
 * Calls `map` for every URL in the `href`, `src`, `srcset` and `poster`
 * attributes of the HTML and replaces the URL by what it returns. A `srcset`
 * is split into its candidates first. Attributes whose URLs `map` returns
 * unchanged keep their original text exactly.
 *
 * @param {string} html
 * @param {(url: string, site: UrlSite) => string} map Receives the URL with entities decoded.
 * @returns {string}
 */
export function mapHtmlUrls(html, map) {
  return html.replace(TAG_RE, (tag, tagName, attributes) => {
    if (attributes === '') return tag;
    const lower = String(tagName).toLowerCase();
    let changed = false;
    const rewritten = String(attributes).replace(
      ATTRIBUTE_RE,
      (/** @type {string} */ whole, /** @type {string} */ space, /** @type {string} */ name, /** @type {string | undefined} */ double, /** @type {string | undefined} */ single, /** @type {string | undefined} */ bare) => {
        const attribute = name.toLowerCase();
        const raw = double ?? single ?? bare;
        if (!URL_ATTRIBUTES.has(attribute) || raw === undefined) return whole;
        const value = decodeEntities(raw, { html: true });
        const site = /** @type {UrlSite} */ ({ tag: lower, attribute });
        const next = attribute === 'srcset' ? mapSrcset(value, (url) => map(url, site)) : map(value, site);
        if (next === value) return whole;
        changed = true;
        return `${space}${name}="${next.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
      },
    );
    return changed ? `<${tagName}${rewritten}${tag.slice(1 + String(tagName).length + String(attributes).length)}` : tag;
  });
}

/**
 * Whether a URL is absolute: it has a scheme (`https:`, `mailto:`, `data:`).
 * A URL starting with `//` or `/`, a bare fragment and a relative path are not.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isAbsoluteUrl(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url.trim());
}

/**
 * Lists the URLs in the `href`, `src`, `srcset` and `poster` attributes of
 * some HTML.
 *
 * @param {string} html
 * @returns {{ url: string, tag: string, attribute: string }[]}
 */
export function listHtmlUrls(html) {
  /** @type {{ url: string, tag: string, attribute: string }[]} */
  const found = [];
  mapHtmlUrls(html, (url, site) => {
    found.push({ url, tag: site.tag, attribute: site.attribute });
    return url;
  });
  return found;
}
