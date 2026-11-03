import { absoluteUrl } from './feeds.js';

/** Card type announced to Twitter and to every service that reads its tags. */
export const TWITTER_CARD = 'summary_large_image';

/**
 * The parts of a site that decide the metadata of its pages.
 *
 * @typedef {object} MetaSite
 * @property {string} baseUrl Absolute URL of the site, without a trailing slash.
 * @property {string} lang Language tag of the site.
 * @property {string} title
 * @property {string} description May be empty.
 * @property {string} defaultImage Site-relative path or absolute URL of the image used by pages without one.
 */

/**
 * What a page tells about itself.
 *
 * @typedef {object} MetaPage
 * @property {string} title Title of the page alone; empty for a page that is called the site.
 * @property {string} [description] Summary, page description or empty.
 * @property {string} url Site-relative address of the page (`/journal/x/`, or `/404.html`).
 * @property {string | null} [image] Site-relative path or absolute URL of the preview image; the site's default image when absent.
 * @property {'website' | 'article'} [type] `article` for a post (default `website`).
 * @property {Date | null} [published] Moment a post was published; only used for an article.
 * @property {string[]} [tags] Names of a post's tags; only used for an article.
 */

/**
 * The `meta` object that every page template receives.
 *
 * @typedef {object} PageMeta
 * @property {string} title Page title and site title, as shown in a tab and in a link preview.
 * @property {string} description Plain text; never empty.
 * @property {string} url Absolute canonical URL.
 * @property {string} image Absolute URL of the preview image.
 * @property {'website' | 'article'} type
 * @property {string} siteName
 * @property {string} locale Open Graph locale such as `en_US`.
 * @property {string} twitterCard
 * @property {string | null} publishedTime ISO 8601 moment, for an article.
 * @property {string[]} tags Names of the tags of an article.
 */

/**
 * Collapses runs of white space into single spaces.
 *
 * @param {string | null | undefined} text
 * @returns {string}
 */
function plain(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Turns a site-relative path or an absolute URL into an absolute URL.
 *
 * @param {string} baseUrl Absolute URL of the site, without a trailing slash.
 * @param {string} value
 * @returns {string}
 */
export function absolutizeUrl(baseUrl, value) {
  if (/^https?:\/\//i.test(value)) return value;
  return absoluteUrl(baseUrl, value.startsWith('/') ? value : `/${value}`);
}

/**
 * The Open Graph locale of a language tag: `en` is `en_US`, `ru` is `ru_RU`,
 * `pt-BR` is `pt_BR`. A tag without a region gets its most likely one.
 *
 * @param {string} lang
 * @returns {string}
 */
export function openGraphLocale(lang) {
  let locale;
  try {
    locale = new Intl.Locale(lang);
  } catch {
    return lang.replace(/-/g, '_');
  }
  const region = locale.region ?? locale.maximize().region;
  return region ? `${locale.language}_${region}` : locale.language;
}

/**
 * Builds the metadata of one page: the title and description for the tab and
 * search results, the canonical address, and the Open Graph and Twitter card
 * values for link previews. Every address in the result is absolute.
 *
 * The description is the page's own, else the site's, else the title, so that
 * no page is left without one.
 *
 * @param {MetaSite} site
 * @param {MetaPage} page
 * @returns {PageMeta}
 */
export function buildMeta(site, page) {
  const pageTitle = plain(page.title);
  const siteTitle = plain(site.title);
  const title = pageTitle !== '' && pageTitle !== siteTitle ? `${pageTitle} | ${siteTitle}` : siteTitle;
  const description = plain(page.description) || plain(site.description) || pageTitle || siteTitle;
  const article = page.type === 'article';
  return {
    title,
    description,
    url: absoluteUrl(site.baseUrl, page.url),
    image: absolutizeUrl(site.baseUrl, page.image || site.defaultImage),
    type: article ? 'article' : 'website',
    siteName: siteTitle,
    locale: openGraphLocale(site.lang),
    twitterCard: TWITTER_CARD,
    publishedTime: article && page.published ? page.published.toISOString() : null,
    tags: article ? (page.tags ?? []) : [],
  };
}
