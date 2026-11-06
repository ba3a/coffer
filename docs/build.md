# Building a site

`coffer build` turns the configuration, the posts and the theme into static files, one output directory per site.

```
coffer build --config example/coffer.yaml --out example/dist
```

| Option            | Meaning                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <path>` | The [configuration](configuration.md) to build. Without it coffer looks for `coffer.yaml` in the working directory and its parents.                           |
| `--out <dir>`     | The output root. Default `dist`, relative to the working directory. Each site is written to `{out}/{siteId}`.                                                  |
| `--drafts`        | Preview mode: also build drafts and posts dated in the future (see below).                                                                                     |
| `--now <date>`    | Pretend it is this moment. A date or a date and time, read in the site's time zone when it has no offset. The `COFFER_NOW` environment variable does the same. |

Drafts and future posts built with `--drafts` carry a "Draft" or "Scheduled for ..." banner. To work on the sites rather than build them once, use `coffer dev`, a preview with live reload, and `coffer new` for a new post (see [Authoring](authoring.md)).

The command prints one line per site, then the posts that publish exact locations (see [Location and camera metadata](location-policy.md#what-the-build-does-with-the-decision)), and exits 0, or prints every problem it found (with the file and the field) and exits 1. The same build is available in code as `buildSites(config, options)`.

Before it renders anything, the build fetches the documentation source of every tool project that has a `docs` block (a git repository into `.cache/repos/{slug}`, or a folder in place) and fails with the project and the address when one cannot be fetched. `coffer docs fetch` does only that and prints the commit of each source (`--config <path>`, `--project <slug>`). See [Where a project's documentation comes from](docs-sources.md).

## What is written

For a site `workshop` with a blog whose `prefix` is `journal`:

```
{out}/workshop/
  index.html                          the home page
  404.html                            the page for unknown addresses
  journal/index.html                  the blog index
  journal/tags/index.html             the tag tree of the blog
  journal/tags/{tag path}/index.html  one page per tag
  journal/series/{series}/index.html  one page per series
  journal/search/index.html           the search page of the blog
  journal/{slug}/index.html           one page per published post
  journal/{alias}/index.html          a redirect page for each old slug (see below)
  _redirects                          redirect rules for hosts that read them
  cards/{hash}.png                    generated 1200 by 630 title cards for link previews
  img/{key}/{name}-{width}.webp       resized WebP variants of every image a page uses
  img/{key}/{name}-full.jpg           the full-size JPEG for the viewer (the originals are never published)
  pagefind/                           the full-text search index and Pagefind's scripts
  sitemap.xml                         the published canonical pages
  robots.txt                          allows crawling and names the sitemap
  assets/                             the static files of the theme
  .coffer-manifest.json               the build manifest
```

- **Post URLs** are `/{prefix}/{slug}/` and nothing else. The slug is the folder or file name of the post, so neither the date nor the tags ever change the address. A blog with an empty `prefix` writes its posts and its index at the root of the site.
- **The home page and the 404 page** are described in [The home page, the 404 page and the footer](home.md).
- **Old slugs** declared as `aliases` in a post's front matter get a `301` rule in `_redirects` and a fallback page; an alias that collides with a live address fails the build. See [URLs, redirects and hosting](urls.md), which also covers `coffer serve`.
- **Tags**: the tree of the blog's tags and one page per tag, listing the posts with the tag or any tag below it. See [Tags](tags.md).
- **Series**: a navigation block (name, "part n of m", previous and next) at the top and the end of every post of a series, computed from all published posts, and one page per series listing its parts in order. See [Series](series.md).
- **Search**: a search page at `{blog}/search/` for every blog, linked from the navigation, which finds the blog's posts (in other word forms too) with snippets; the index is built by Pagefind after the HTML is written and lands in `pagefind/`. Searching needs JavaScript, and the page says so without it. See [Search](search.md).
- **The blog index** lists the published posts, newest first, with the date, the summary and the reading time of each.
- **A post page** shows the title, the date, the reading time, the table of contents and the body. The table of contents is built from the `h2` and `h3` headings of posts with enough of them (see [Markdown](markdown.md)). It comes before the body in the page. On a narrow screen it is a collapsible block; on a wide screen the stylesheet puts it beside the body.
- **Projects**: a site with `projects.dir` gets a projects page with a card for every project folder, a page per project, and the showcase of featured projects on the home page. Adding a folder adds a project; an unknown kind or a missing field fails the build with the path of `project.yaml`. See [Projects](projects.md).
- **Page metadata**: every page has a title, a description, a canonical address and the Open Graph and Twitter card tags for link previews, and `<html lang>` is the site's language. The build also writes `sitemap.xml` and `robots.txt`, and a title card for every page that has no image of its own (cached in `.cache/cards/`); documentation checkouts of tool projects are cached in `.cache/repos/`. See [SEO and link previews](seo.md).
- **Images**: every image a post uses (a Markdown image or the cover) is rotated upright, resized into WebP variants and one full-size JPEG, published with the metadata its [policy](location-policy.md) allows (never in the WebP variants) and cached in `.cache/images/`; the page gets a `<figure>` with `<picture>`, `srcset`, `width` and `height`, lazy loading after the first image, and a caption when the image has a title. The originals are never copied. See [Images](images.md).
- **GPX tracks** next to a post (every `*.gpx` file of a post folder, or those listed in `tracks:`) are published unchanged for download at `{post}/{name}.gpx`, summarized (distance, elevation gain, highest point) in the manifest and written as simplified GeoJSON at `{post}/{name}.geojson`; an invalid file fails the build naming it, and the post is listed among those that publish exact locations. See [Maps and GPX tracks](maps.md).
- **Maps**: a post with a track or a photo with a published position gets a map (Leaflet and OpenStreetMap tiles, markers for photos, the track summary and a download link, and a drawing of the route for visitors without JavaScript); `::map` puts it in the text, `map: false` suppresses it. See [Maps and GPX tracks](maps.md#the-map).
- **Links and images** in every post are resolved before anything is written: a broken link, a missing image or an unknown `project:` reference fails the build with `file:line:column`, relative links between posts become canonical URLs and `project:` links become the project pages' URLs. The errors, warnings and notes of the build are also written to `.coffer/report.json`, outside the output. See [Links, images and the build report](links.md).
- **Assets** are the files of the default theme's `assets/` folder, followed by the `assets/` folder of the site's theme, which wins on equal names. The default stylesheet is `assets/coffer.css`.
- **Checking the result**: `coffer check` inspects the finished output for broken links and anchors, missing preview metadata, invalid feeds, a sitemap that differs from the manifest, and published images whose location or camera metadata does not match their policy. See [Checking a finished build](checks.md).
- An earlier build of the same site is removed first, so a post that is no longer published disappears from the output.

## Drafts and future posts

A normal build contains only posts that are not drafts and whose date is not after "now". Everything else is left out: no page, no entry in the index, no entry in the manifest.

With `--drafts` the build includes drafts and future-dated posts too. They are marked with a "Preview" note on the page and in the index, and the manifest says `"published": false` for them. Use preview mode for looking at work in progress, never for deployment.

"Now" is the `--now` option, then the `COFFER_NOW` variable, then the clock. A date without a time means the start of that day in the site's time zone. Pass a fixed value in tests to make a build repeatable.

## The build manifest

Each site's output contains `.coffer-manifest.json`, which records what the build wrote, so that checks read facts instead of guessing from the files:

| Key                | Contents                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `manifestVersion`  | Version of this format (currently 1).                                                                          |
| `generator`        | Name and version of coffer.                                                                                    |
| `site`             | `id`, `baseUrl`, `lang` and `timezone` of the site.                                                            |
| `now`, `drafts`    | The moment used to decide which posts are published, and whether this was a preview build.                     |
| `pages`            | Every HTML page written: `url`, `file` (relative to the site directory), `type` and `title`.                   |
| `posts`            | Every post built: blog id, slug, `url`, `file`, `source` (relative to the configuration file), title, date, tags, `draft`, `published`, reading time, its `tracks` (see [Maps and GPX tracks](maps.md)) and its `maps` (the tracks, the number of photos and the markers each map shows, with their published positions). |
| `tags`             | Every tag page: blog id, tag `path`, `url`, `file`, shown `name`, post `count` and the `posts` (URLs, newest first) it lists. |
| `series`           | Every series page: blog id, series `slug`, `url`, `file`, shown `name`, part `count` and the `posts` (URLs, in reading order). Each entry of `posts` has a `series` field (`slug`, `number`, `count`), or null. |
| `redirects`        | Every alias redirect: `from`, `to` (site-relative URLs) and `status`.                                          |
| `feeds`            | Every Atom feed: `type` (`blog`, `tag`, `series` or `project`), blog id (null for a project feed), `url`, `selfUrl` (absolute), `file`, the `page` it belongs to, `title`, number of `entries`, and the `tag` path, `series` slug or `project` slug. See [Feeds](feeds.md). |
| `sitemap`          | The site-relative URLs listed in `sitemap.xml`, sorted. See [SEO and link previews](seo.md). |
| `projects`         | Every project: `slug`, `url`, `file`, `kind`, `status`, the posts about it, its feed, its card, its `files` and press-kit `downloads`, and `docs`, where a tool's documentation comes from (the source with the commit that was built, the GitHub repository, the guides and `pages`, the pages built from them (`url`, `file`, `source`, `title`); null without a `docs` block). See [Projects](projects.md) and [Where a project's documentation comes from](docs-sources.md#in-the-manifest). |
| `images`           | Every image a page uses: the `source` file, the `post` (page) that uses it, `use` (`body` or `cover`), the hash and upright size of the original, the metadata `policy` it was published under, the published `gps` position and `camera` fields, and the `outputs` made from it. See [Images](images.md). |

The manifest is for checks and not for visitors. It is excluded from deployment by its name, `.coffer-manifest.json` (exported as `MANIFEST_FILE_NAME`; `DEPLOY_EXCLUDES` lists every name a deployment must skip). Leave it out when uploading the output to a host.

## The example site

`example/` in the coffer repository is a complete small site with made-up content: one site with a home page and links, a blog with the prefix `journal`, three published posts with hierarchical tags (`workshop/boxes/dovetails`, `trips/mountains`) and a `tags.yaml`, a two-part series (`boxes-by-hand`, with a `series.yaml`), a draft and a post dated far in the future. It is what coffer's own tests build.

```
npm run example
```

builds it into `example/dist/` (ignored by Git). Open `example/dist/workshop/journal/index.html` in a browser, or serve the directory with any static file server.
