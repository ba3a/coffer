import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pagefind from 'pagefind';

/** Name of the directory with the search index and the Pagefind scripts, at the root of a site's output. */
export const SEARCH_DIR_NAME = 'pagefind';

/** Name of the search page of a blog, below the blog's address. */
export const SEARCH_URL_NAME = 'search';

/** Name of the Pagefind filter that holds the id of the blog a post belongs to. */
export const BLOG_FILTER = 'blog';

/** Name of the Pagefind filter that holds the slug of the project a guide belongs to. */
export const GUIDES_FILTER = 'guides';

/**
 * Site-relative address of the search page of a blog.
 *
 * @param {string} blogBase Address of the blog, ending in a slash.
 * @returns {string}
 */
export function searchPageUrl(blogBase) {
  return `${blogBase}${SEARCH_URL_NAME}/`;
}

/**
 * The language Pagefind applies stemming for: the primary subtag of a BCP 47
 * language tag, which is what its `forceLanguage` option expects.
 *
 * @param {string} lang
 * @returns {string}
 */
export function indexLanguage(lang) {
  return lang.split('-')[0].toLowerCase();
}

/**
 * A page to put in the search index.
 *
 * @typedef {object} SearchPage
 * @property {string} url Site-relative address of the page, ending in a slash.
 * @property {string} file Path of its HTML file, relative to the output directory, with forward slashes.
 */

/**
 * Raised when Pagefind cannot build or write the index.
 */
export class SearchError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SearchError';
  }
}

/**
 * Builds the full-text index of a finished site and writes it, with Pagefind's
 * scripts and styles, to `{outDir}/pagefind/`.
 *
 * Only the pages given are indexed, and of each only the part marked with
 * `data-pagefind-body`, with the filters it declares (`blog` for the posts of a
 * blog, `guides` for the guides of a project). The index is built for the
 * language of the site, so that Pagefind stems words in it: in Russian,
 * "шкатулка" finds "шкатулки".
 *
 * An index with no pages is still written: the search page loads the scripts
 * from it and reports that nothing is found.
 *
 * @param {object} options
 * @param {string} options.outDir Absolute path of the site's output directory.
 * @param {string} options.lang Language tag of the site.
 * @param {string} [options.basePath] Path prefix of the site on its host, such as `/docs`, without a trailing slash; the addresses in results include it.
 * @param {SearchPage[]} options.pages
 * @returns {Promise<{ pages: number }>}
 * @throws {SearchError} When Pagefind reports an error, cannot start or stops.
 */
export async function buildSearchIndex({ outDir, lang, basePath = '', pages }) {
  try {
    const created = await pagefind.createIndex({ forceLanguage: indexLanguage(lang) });
    const index = created.index;
    if (!index) throw new SearchError(`Pagefind could not create an index: ${created.errors.join('; ')}`);
    /** @type {string[]} */
    const errors = [];
    let indexed = 0;
    for (const page of pages) {
      const added = await index.addHTMLFile({
        url: `${basePath}${page.url}`,
        content: readFileSync(join(outDir, ...page.file.split('/')), 'utf8'),
      });
      if (added.errors.length > 0) errors.push(`${page.file}: ${added.errors.join('; ')}`);
      else indexed += 1;
    }
    const written = await index.writeFiles({ outputPath: join(outDir, SEARCH_DIR_NAME) });
    errors.push(...written.errors);
    await index.deleteIndex();
    if (errors.length > 0) throw new SearchError(`Pagefind reported errors: ${errors.join('; ')}`);
    return { pages: indexed };
  } catch (error) {
    if (error instanceof SearchError) throw error;
    // Pagefind runs as a separate program: when it cannot start (no binary for
    // this platform) or stops, its API throws a plain Error.
    throw new SearchError(`Pagefind failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await pagefind.close();
  }
}
