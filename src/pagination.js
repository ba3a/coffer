/**
 * Pagination of list pages: the blog index, the tag pages and the series
 * pages. Page 1 stays at the address of the list, page n is at
 * `{address}page/n/`.
 */

/** Path segment of the pages after the first one: `/journal/page/2/`. */
export const PAGE_URL_NAME = 'page';

/**
 * Where the reader is among the pages of a list, as templates see it.
 *
 * @typedef {object} Pagination
 * @property {number} page Number of this page, from 1.
 * @property {number} pages Number of pages, at least 2.
 * @property {string | null} previous Site-relative address of the previous page; null on the first.
 * @property {string | null} next Site-relative address of the next page; null on the last.
 */

/**
 * One page of a list.
 *
 * @template T
 * @typedef {object} ListPage
 * @property {string} url Site-relative address of the page, ending in a slash.
 * @property {T[]} items The entries of this page.
 * @property {Pagination | null} pagination Null when the list has a single page (then nothing paginated is shown).
 */

/**
 * Site-relative address of a page of a list.
 *
 * @param {string} listUrl Address of the list (its first page), ending in a slash.
 * @param {number} page Page number, from 1.
 * @returns {string}
 */
export function pageUrl(listUrl, page) {
  return page <= 1 ? listUrl : `${listUrl}${PAGE_URL_NAME}/${page}/`;
}

/**
 * Splits a list into pages. A list that fits on one page (or has no page size)
 * is one page without `pagination`.
 *
 * @template T
 * @param {T[]} items In display order.
 * @param {number | null} pageSize Entries per page; null for no pagination.
 * @param {string} listUrl Address of the list, ending in a slash.
 * @returns {ListPage<T>[]} Never empty.
 */
export function paginate(items, pageSize, listUrl) {
  if (pageSize === null || items.length <= pageSize) {
    return [{ url: listUrl, items, pagination: null }];
  }
  const pages = Math.ceil(items.length / pageSize);
  /** @type {ListPage<T>[]} */
  const result = [];
  for (let page = 1; page <= pages; page += 1) {
    result.push({
      url: pageUrl(listUrl, page),
      items: items.slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page,
        pages,
        previous: page > 1 ? pageUrl(listUrl, page - 1) : null,
        next: page < pages ? pageUrl(listUrl, page + 1) : null,
      },
    });
  }
  return result;
}

/**
 * The non-canonical address of the first page, which redirects to the list.
 * Only a list with more than one page has such an address.
 *
 * @param {string} listUrl
 * @param {ListPage<unknown>[]} listPages The result of `paginate`.
 * @returns {string[]}
 */
export function firstPageAliases(listUrl, listPages) {
  return listPages.length > 1 ? [`${listUrl}${PAGE_URL_NAME}/1/`] : [];
}
