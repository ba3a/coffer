import { absoluteUrl } from './feeds.js';
import { escapeXml } from './xml.js';

/** File name of the sitemap, at the root of a site. */
export const SITEMAP_FILE_NAME = 'sitemap.xml';

/** File name of the robots file, at the root of a site. */
export const ROBOTS_FILE_NAME = 'robots.txt';

/**
 * One address in a sitemap.
 *
 * @typedef {object} SitemapEntry
 * @property {string} url Site-relative address of the page, ending in a slash.
 * @property {Date | null} [lastModified] Moment of the last change, if known.
 */

/**
 * Writes a sitemap in the sitemaps.org format. Entries are sorted by address.
 *
 * @param {string} baseUrl Absolute URL of the site, without a trailing slash.
 * @param {SitemapEntry[]} entries
 * @returns {string}
 */
export function renderSitemap(baseUrl, entries) {
  const sorted = [...entries].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const entry of sorted) {
    lines.push('  <url>');
    lines.push(`    <loc>${escapeXml(absoluteUrl(baseUrl, entry.url))}</loc>`);
    if (entry.lastModified) lines.push(`    <lastmod>${entry.lastModified.toISOString()}</lastmod>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>');
  return `${lines.join('\n')}\n`;
}

/**
 * Writes `robots.txt`: everything may be crawled, and the sitemap is named.
 *
 * @param {string} baseUrl Absolute URL of the site, without a trailing slash.
 * @returns {string}
 */
export function renderRobots(baseUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(baseUrl, `/${SITEMAP_FILE_NAME}`)}\n`;
}
