/**
 * Redirects for old post addresses.
 *
 * A post can declare `aliases`, old slugs that used to be its address. The
 * build turns each of them into two things: rules for hosts that read a
 * `_redirects` file (Cloudflare Pages, Netlify), and a small HTML page at the
 * old address for hosts that do not.
 */

/** Name of the redirects file in a site's output directory. */
export const REDIRECTS_FILE_NAME = '_redirects';

/** Status code of an alias redirect: the move is permanent. */
export const ALIAS_STATUS = 301;

/**
 * One redirect from an old address to a live one.
 *
 * @typedef {object} Redirect
 * @property {string} from Site-relative URL of the old address, ending in a slash.
 * @property {string} to Site-relative URL of the live page, ending in a slash.
 * @property {number} status HTTP status code.
 * @property {string} source Path of the Markdown file that declares the alias, for messages.
 */

/**
 * Lists the redirects declared by posts.
 *
 * @param {{ url: string, aliasUrls: string[], source: string }[]} posts Published posts: their site-relative URL, the site-relative URLs of their old addresses and their source file.
 * @returns {Redirect[]} Sorted by old address.
 */
export function collectRedirects(posts) {
  /** @type {Redirect[]} */
  const redirects = [];
  for (const post of posts) {
    for (const from of post.aliasUrls) {
      redirects.push({
        from,
        to: post.url,
        status: ALIAS_STATUS,
        source: post.source,
      });
    }
  }
  return redirects.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/**
 * Finds problems in a list of redirects: an old address that is also a page
 * of the site, or one that two posts both claim.
 *
 * @param {Redirect[]} redirects
 * @param {Set<string>} liveUrls Site-relative URLs of every page the site builds, ending in a slash.
 * @param {Set<string>} [publishedUrls] URLs of published posts, used only for the wording.
 * @returns {string[]} One message per problem; empty when the redirects are fine.
 */
export function checkRedirects(redirects, liveUrls, publishedUrls = new Set()) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Map<string, Redirect>} */
  const seen = new Map();
  for (const redirect of redirects) {
    if (liveUrls.has(redirect.from)) {
      const what = publishedUrls.has(redirect.from) ? 'the live post' : 'a page of the site';
      problems.push(
        `${redirect.source}: alias for ${redirect.from} collides with ${what} at the same address`,
      );
      continue;
    }
    const earlier = seen.get(redirect.from);
    if (earlier) {
      problems.push(
        `${redirect.source}: alias for ${redirect.from} is already claimed by ${earlier.source}`,
      );
      continue;
    }
    seen.set(redirect.from, redirect);
  }
  return problems;
}

/**
 * Content of the `_redirects` file: for every redirect a rule for the address
 * with the trailing slash and one for the address without it.
 *
 * @param {Redirect[]} redirects
 * @returns {string} Empty when there is nothing to redirect.
 */
export function renderRedirectsFile(redirects) {
  if (redirects.length === 0) return '';
  const lines = [];
  for (const { from, to, status } of redirects) {
    lines.push(`${from} ${to} ${status}`);
    lines.push(`${from.replace(/\/$/, '')} ${to} ${status}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The page written at an old address for hosts without `_redirects`: it
 * refreshes to the new address at once, names it as canonical and asks search
 * engines to keep the old address out of their index.
 *
 * @param {object} options
 * @param {string} options.lang Language of the site.
 * @param {string} options.target Absolute or site-relative URL of the live page.
 * @param {string} options.canonical Absolute URL of the live page.
 * @returns {string}
 */
export function renderRedirectPage({ lang, target, canonical }) {
  const href = escapeHtml(target);
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<title>${href}</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta http-equiv="refresh" content="0; url=${href}">
</head>
<body>
<p><a href="${href}">${href}</a></p>
</body>
</html>
`;
}
