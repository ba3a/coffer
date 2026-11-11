# Search

coffer gives every blog a full-text search page. The index is built at build time and searched in the visitor's browser, so there is no server and no third-party service. It is made by [Pagefind](https://pagefind.app/) (MIT license), which is installed with coffer.

## What a visitor gets

- A page at `{blog}/search/` (`/search/` for a blog at the site root), linked from the navigation of every page as "Search" or, on a site with several blogs, "Search: {blog title}".
- A search box. Results appear while typing, each with the title of the post, a snippet of the text around the match, and the matched words in bold and underlined (`<mark>`). A term in the address (`?q=word`) is searched when the page opens.
- Results are **scoped to the blog**: the page only finds posts of its own blog, never posts of another blog or guides.
- Word forms are matched. The index is built for the site's `lang`, so Pagefind stems words in it: on a Russian site "шкатулка" finds "шкатулки", "шкатулку" and "шкатулкой"; on an English site "dovetails" finds "dovetail". Pagefind has stemming for the languages it lists in its documentation; for another language the words are matched as written.

Searching needs JavaScript. Without it (or when the index cannot be loaded) the page shows a short explanation that search needs JavaScript and a link to the tag tree of the blog, which is the way to browse without searching. The form, the status line and the results are hidden until `search.js` has found the index and marked the page as ready (`data-search-ready`), so a visitor never sees a form that does nothing.

When a site has nothing to index yet (no published post and no guide, for example while every post is a draft), the search pages say "No posts yet." and load no script.

## What is indexed

After all HTML is written, the build indexes once per site:

- the **published posts** of every blog: the body of the post (`.post-body`), with the post's `<h1>` as the title. Drafts and posts dated in the future are not indexed, also not in a preview build with `--drafts`;
- the **guides** of every project that has documentation (the documentation pages written through the `docs.njk` template). Generated reference pages are not themed pages and are not indexed.

Pagefind indexes only what a page marks with `data-pagefind-body`. The default theme marks:

| Page   | Marked element                                                                       | Filter                    |
| ------ | ------------------------------------------------------------------------------------ | ------------------------- |
| Post   | `<div class="post-body" data-pagefind-body data-pagefind-filter="blog:{blog id}">`   | `blog` = the id of the blog |
| Guide  | `<div class="post-body docs-body" data-pagefind-body data-pagefind-filter="guides:{project slug}">` | `guides` = the project slug |

The search page of a blog searches with the filter `blog` = its id, which is what keeps posts of other blogs and the guides out of its results. Guides sit under their own filter, `guides`, so a later search over documentation can use it.

**List pages are not indexed.** The blog index, the tag pages and the series pages are not marked, also when the blog sets `index: full` (see [Configuration](configuration.md)) and they carry the whole text of the posts they list. Pagefind would otherwise return the same words once for the post page and once for every list page that shows the post. A search therefore gives one hit per post, the post page. A theme that lays out full posts on its own list templates must not add `data-pagefind-body` to them.

The navigation, the table of contents, the series blocks, the tag list, the project blocks and the [share summary](sharing.md) (which also carries `data-pagefind-ignore`) are outside the marked element, so they are not indexed and do not make every post match every search.

A theme that replaces `post.njk` or `docs.njk` as a whole (instead of overriding blocks through `{% extends "coffer:post.njk" %}`) must keep these two attributes on the element that holds the text, or its pages are left out of the index.

## Where the files go

The index and Pagefind's scripts are written to `{out}/{siteId}/pagefind/`. The search page loads `pagefind/pagefind-modular-ui.js` and `pagefind/pagefind.js` from there, together with the theme's own `assets/search.js`. Nothing comes from a CDN. The name `pagefind` is reserved at the top of a site's output, so `urls.projects` cannot start with it.

Pagefind compiles a WebAssembly module and starts a web worker in the visitor's browser. A site that sets a strict Content-Security-Policy therefore needs `'wasm-unsafe-eval'` in `script-src` and its own origin in `worker-src` for the search page; nothing else on the page needs inline script or `eval`.

The directory also holds Pagefind's other ready-made interfaces (`pagefind-ui.js` and `pagefind-ui.css`, `pagefind-component-ui.*`). The default theme uses only the modular interface, with its own markup and styles, so that the page speaks the language of the site and follows the light and dark themes; a theme may use any of them.

The search page is a page of the build (it is in the manifest as type `search`), but it is not listed in `sitemap.xml`: it has no content of its own.

## Translating and styling

The words of the page are UI strings under `search.*` (and `nav.search`, `nav.search_blog`) in the engine's `i18n/en.yaml` and `i18n/ru.yaml`; a theme overrides them in its own `i18n/` folder (see [Themes](themes.md)). The messages that `search.js` shows ("Searching...", "Results: {count}", "Nothing found for {query}") are handed to it by the page, already translated, in the `data-search` attribute.

The page is made by `search.njk`. Its parts are blocks (`search_nojs`, `search_form`) that a theme can replace; the classes `search`, `search-form`, `search-input`, `search-status`, `search-results`, `search-result`, `search-result-title` and `search-result-excerpt` are styled by `coffer.css`.

## Addresses that cannot be used

The address `{blog}/search/` belongs to the search page. The build stops, naming the file, when a post of the blog has the slug `search`, and when `urls.tags` or `urls.series` is `search`.

## Testing a search

Pagefind's own search API runs in Node, which is how coffer's tests check the index: they build a site, import `pagefind/pagefind.js` from its output, answer its requests for index files from the directory and search with `blog` as the filter. See `test/search.test.js` and `test/helpers/pagefind.js`.
