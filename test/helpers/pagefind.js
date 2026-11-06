import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let counter = 0;

/**
 * One result of a search, as the Pagefind search API of the browser returns it.
 *
 * @typedef {object} Hit
 * @property {string} url
 * @property {string} title
 * @property {string} excerpt Text with the matches in `<mark>`.
 * @property {Record<string, string[]>} filters
 */

/**
 * Opens the index a build wrote to `{site}/pagefind/` with Pagefind's own search
 * API (the `pagefind.js` module of the bundle, the one the search page loads in
 * a browser). Node's `fetch` cannot read files, so the requests the module
 * makes for index files are answered from the directory.
 *
 * @param {string} siteDir Output directory of a site.
 * @returns {Promise<{ search: (term: string, filters?: Record<string, string>) => Promise<Hit[]>, filters: () => Promise<Record<string, Record<string, number>>> }>}
 */
export async function openSearch(siteDir) {
  counter += 1;
  const bundleDir = join(siteDir, 'pagefind');
  const origin = `http://pagefind-${counter}.test`;
  const realFetch = globalThis.fetch;
  /** @type {typeof fetch} */
  const fileFetch = async (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!text.startsWith(`${origin}/`)) return realFetch(input, init);
    const name = decodeURIComponent(new URL(text).pathname.replace(/^\/pagefind\//, ''));
    const bytes = readFileSync(join(bundleDir, ...name.split('/')));
    return new Response(bytes, {
      headers: { 'content-type': name.endsWith('.pagefind') && name.startsWith('wasm') ? 'application/wasm' : 'application/octet-stream' },
    });
  };
  globalThis.fetch = fileFetch;
  const pagefind = await import(`${pathToFileURL(join(bundleDir, 'pagefind.js')).href}?open=${counter}`);
  await pagefind.options({ basePath: `${origin}/pagefind/` });
  return {
    async search(term, filters) {
      const found = await pagefind.search(term, filters ? { filters } : {});
      return Promise.all(
        found.results.map(async (/** @type {{ data: () => Promise<any> }} */ result) => {
          const data = await result.data();
          return { url: new URL(data.url, origin).pathname, title: data.meta.title, excerpt: data.excerpt, filters: data.filters };
        }),
      );
    },
    filters: () => pagefind.filters(),
  };
}
