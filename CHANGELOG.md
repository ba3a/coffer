# Changelog

All notable changes to coffer are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

coffer uses [semantic versioning](https://semver.org/). While the major version is 0, a minor release may change behaviour in ways that need a change in your site; the changelog says so under "Changed" or "Removed". From 1.0.0 on, a breaking change needs a new major version.

Every release is a git tag named `v` followed by the version, for example `v0.1.0`. A site should pin a tag and never follow a branch, so that it changes only when its author chooses to update. Read the section of the new version before you do.

## Unreleased

### Added

- A blog setting `index`: `summary` (the default) or `full`, or `{ type: full, pageSize: <positive whole number> }` to paginate a full index. The setting is validated and normalized to `blog.index = { type, pageSize }`; an invalid value, a `pageSize` that is not a positive whole number, a `pageSize` with type `summary` or an unknown key fails the configuration and names the blog. Feeds are never paginated.
- A post front matter key `index` (`summary` or `full`) that overrides the blog's `index` setting for that post. The effective value is in the manifest (`posts[].index`) and in the template data of the post (`post.index`). Any other value fails the build and the message names the post.
- Blogs with `index: full` (or a post with `index: full`) show the whole post on the blog index, the tag pages and the series pages: title (link), date, reading time, tags and the body rendered as on the post page, one heading level lower and with ids that start with the post slug, but without table of contents, series box, project blocks and share summary. Templates of those pages receive it as `post.html` (empty for a summary post) and the effective setting as `post.index`; `post.tagLinks` is filled on them too. The default `blog-index.njk` supports `full`; its output for `summary` posts is unchanged. The images of a full post are processed once. The front matter `summary` still feeds descriptions and link previews. Pagination of these pages follows in a later change. Tag and series pages show full posts the same way, and the per-post `index` override works on them, so one page can mix full and summary posts; ids stay unique on each page.
- Two internal options of `renderMarkdown`, for showing a post inside a list page: `headingShift` (added to each heading level, h6 at most) and `idPrefix` (put in front of heading ids, footnote ids and back references, ids and anchor names written as raw HTML, and every in-text `#id` link that points at one of them). The table of contents, `ids` and `links` of the result keep the unprefixed values. Without the options the output is unchanged.
- The image viewer, carousels and maps work on list pages that show full posts (blog index, tag and series pages). The page has one viewer whose list holds the images of every full post in page order (`data-viewer` and the photo indexes of map markers count on across posts); `carousel.js`, the viewer and Leaflet, with their styles, are included once per page. Each carousel and each map works on its own; neither has `id` attributes. `renderPostMaps` takes an optional `viewerOffset`.

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
