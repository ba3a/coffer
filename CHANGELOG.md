# Changelog

All notable changes to coffer are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

coffer uses [semantic versioning](https://semver.org/). While the major version is 0, a minor release may change behaviour in ways that need a change in your site; the changelog says so under "Changed" or "Removed". From 1.0.0 on, a breaking change needs a new major version.

Every release is a git tag named `v` followed by the version, for example `v0.1.0`. A site should pin a tag and never follow a branch, so that it changes only when its author chooses to update. Read the section of the new version before you do.

## Unreleased

### Added

- A blog setting `index`: `summary` (the default) or `full`, or `{ type: full, pageSize: <positive whole number> }` to paginate a full index. The setting is validated and normalized to `blog.index = { type, pageSize }`; an invalid value, a `pageSize` that is not a positive whole number, a `pageSize` with type `summary` or an unknown key fails the configuration and names the blog. Feeds are never paginated.
- A post front matter key `index` (`summary` or `full`) that overrides the blog's `index` setting for that post. The effective value is in the manifest (`posts[].index`) and in the template data of the post (`post.index`). Any other value fails the build and the message names the post.
- Blogs with `index: full` (or a post with `index: full`) show the whole post on the blog index, the tag pages and the series pages: title (link), date, reading time, tags and the body rendered as on the post page, one heading level lower and with ids that start with the post slug, but without table of contents, series box, project blocks and share summary. Templates of those pages receive it as `post.html` (empty for a summary post) and the effective setting as `post.index`; `post.tagLinks` is filled on them too. The default `blog-index.njk` supports `full`; its output for `summary` posts is unchanged. The images of a full post are processed once. The front matter `summary` still feeds descriptions and link previews. Tag and series pages show full posts the same way, and the per-post `index` override works on them, so one page can mix full and summary posts; ids stay unique on each page.
- Two internal options of `renderMarkdown`, for showing a post inside a list page: `headingShift` (added to each heading level, h6 at most) and `idPrefix` (put in front of heading ids, footnote ids and back references, ids and anchor names written as raw HTML, and every in-text `#id` link that points at one of them). The table of contents, `ids` and `links` of the result keep the unprefixed values. Without the options the output is unchanged.
- The image viewer, carousels and maps work on list pages that show full posts (blog index, tag and series pages). The page has one viewer whose list holds the images of every full post in page order (`data-viewer` and the photo indexes of map markers count on across posts); `carousel.js`, the viewer and Leaflet, with their styles, are included once per page. Each carousel and each map works on its own; neither has `id` attributes. `renderPostMaps` takes an optional `viewerOffset`.
- Pagination of the blog index: with `index: { type: full, pageSize: N }` and more than N posts, page 1 stays at the address of the blog and page n is at `{blog}/page/n/`. Each page has its own canonical address (the title of pages after the first ends in "(Page n of m)") and sitemap entry; `blog-index.njk` receives `pagination` (`page`, `pages`, `previous`, `next`; null for a single page) and shows previous and next links and a "Page n of m" label (new strings `pagination.*` in `i18n/en.yaml` and `i18n/ru.yaml`, new block `pagination` in the template). `/page/1/` (with or without the slash, and `index.html`) redirects to the blog address. A blog with at most N posts gets no extra files. In a blog with a `pageSize` a post cannot have the slug `page`, and `urls.tags` and `urls.series` cannot be `page`; the build fails and names the post. Feeds are never paginated.
- Pagination of tag pages and series pages: in a blog with a `pageSize` every tag page (each node of the tag tree, a node counting the posts of its subtree) and every series page is split like the blog index, with the same page size. Page 1 stays at the address of the tag or series, page n is at `{tag}/page/n/` or `{series}/page/n/`, with previous and next links, its own canonical address and sitemap entry, and a redirect from `/page/1/`. A series page keeps the part numbers and the whole series count on every page. Tag and series feeds are never paginated. A tag whose address is a page of its parent (for example `a/page/2` when `a` has several pages) fails the build and names the tag.
- Search keeps one hit per post when a blog shows full posts on its list pages: the blog index, tag pages and series pages (and their further pages) carry no `data-pagefind-body`, so Pagefind indexes only the post pages. Tests build a three-post blog (images; code and table of contents; a series) and check body text, unique ids and shifted headings on those pages, that `index: summary` gives the same output as a blog without the setting, and the search result. `docs/full-text-search.md` says that list pages are not indexed.
- Site settings `icon` and `logo`: paths relative to the root of the built site (a file in the `assets` folder of the theme, such as `assets/brand/icon-192.png`). The configuration rejects a value that is not a string, an absolute URL, a path starting with `/`, a path with `..` segments and a path with spaces or `%`, and names the setting; both are `null` in the loaded configuration when absent. After the theme assets are written and before the feeds, the build checks them: the file exists in the output, `icon` is a square PNG of at least 128 px, `logo` is a PNG. A failure stops the build and names the setting and the site. The checked addresses (`baseUrl` + `/` + path, with characters outside ASCII percent-encoded as in other feed URLs) are kept on the site as `iconUrl` and `logoUrl` for the feed writer. Without `icon` no element is written. Documented in `docs/configuration.md`.
- Every Atom feed (blog, tag, series and project feeds) has an `<icon>` with the absolute address of the site's `icon` after `<generator>`, and a `<logo>` after it when the site sets `logo`; nothing is written without the settings. Project feeds use the site icon. `FeedDocument` has optional `icon` and `logo` (absolute URLs or null); the feed validator checks that they are absolute and appear at most once. The example site sets `icon` (a 128 px PNG in `example/theme/assets/`, so the example now has a `theme` folder that holds only that asset). Documented in `docs/feeds.md`.

### Fixed

- The header, main and footer of the default theme have one width on every page. `--coffer-measure` is now a registered `<length>` set on `:root`, so `68ch` is resolved once with the root font size instead of in the font size of each element that uses it; the smaller footer text no longer makes the footer narrower. The text column is about 1 px narrower than before (root font 16 px instead of body 17 px). A theme that overrides `--coffer-measure` must set it on `:root` as a length.

## 0.1.1 - 2026-11-08

### Fixed

- Feed addresses are percent-encoded, so a tag with non-ASCII characters or spaces no longer produces a feed that fails W3C validation.

## 0.1.0 - 2026-11-07

### Added

- A build that turns a `coffer.yaml`, Markdown posts and a theme into static files, one output directory per site, with a build manifest and a build report.
- Blogs with posts, drafts, posts dated in the future, reading time and tables of contents; code highlighted at build time for light and dark themes.
- Hierarchical tags with subtree pages, counts, display names and descriptions.
- Series with "part n of m" and previous and next navigation.
- Projects as content, with kinds for tools and games, project pages, a showcase on the home page, press kits and project posts.
- Project documentation fetched from git repositories or local folders: rendered guides, a generated reference, links from guides to reference pages and README sections on the project page.
- An image pipeline with responsive variants, carousels and a fullscreen viewer.
- A location and camera metadata policy (`strip`, `coarse`, `keep`) that can be set per site, tag subtree, post and image, and a report of posts that publish exact locations.
- GPX tracks and maps, built from tracks and photo locations without an API key.
- A media store for original photos and videos, with a lock file, a filesystem store, an S3-compatible store and git hooks that keep working copies in step.
- Atom feeds per blog, tag subtree, series and project.
- HTML comments in Markdown (for example `<!-- TODO: rewrite -->`) stay in the source and are left out of the published page. A comment that is never closed is kept as it is.
- Open Graph and Twitter metadata, generated title cards, canonical addresses, a sitemap and `robots.txt`.
- A copy-friendly share summary for posts.
- Full-text search for every blog, with word forms.
- An optional analytics snippet.
- A default theme with light and dark colours, a remembered theme switch and UI strings in English and Russian; themes can override a single template block.
- Redirects for old slugs, and a 404 page for each site.
- `build-info.json` and `coffer rebuild-needed` for scheduled rebuilds.
- The commands `build`, `serve`, `dev`, `new`, `check`, `docs fetch`, `media`, `hooks`, `rebuild-needed` and `config`.
- An example site with made-up content that builds from a fresh clone with `npm run example`.
- Documentation of every feature in `docs/`, a README, contribution guidelines and issue templates.
- A neutrality test that keeps names of people, products and sites out of the engine's code and documentation.
