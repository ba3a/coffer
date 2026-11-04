# SEO and link previews

Every page coffer builds says what it is, where it lives and how to show it when someone shares the link. Nothing here needs configuration, except the image that stands in for pages that have none.

## The `meta` object

The build gives every page template a `meta` object (built in `src/meta.js`). The default `base.njk` turns it into tags; a theme that replaces `base.njk` can read the same values.

| Field           | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `title`         | The page title and the site title, `Dovetails \| Tove Marlowe`. The home page, whose title is the site title, shows it once. |
| `description`   | Plain text. A post: its `summary`, or the first 240 characters of its text. Another page: its own description (tag, series), else the site `description`. Never empty: the title is the last resort. |
| `url`           | The canonical address: `baseUrl` and the page's address, always absolute and, for pages, ending in a slash. The 404 page uses `/404.html`. |
| `image`         | Absolute address of the preview image, see below.                                                                              |
| `type`          | `article` for a post, `website` for everything else.                                                                           |
| `siteName`      | The site title.                                                                                                               |
| `locale`        | The Open Graph locale of the site language: `en` is `en_US`, `ru` is `ru_RU`, `pt-BR` is `pt_BR`.                             |
| `twitterCard`   | Always `summary_large_image`.                                                                                                 |
| `publishedTime` | For a post, the moment it was published (ISO 8601); otherwise `null`.                                                         |
| `tags`          | For a post, the names of its tags; otherwise empty.                                                                           |

A `base.njk` rendered without `meta` (a theme test, for example) falls back to a plain `<title>` and description from `page`.

## Tags in the head

`base.njk` writes, in this order:

- `<title>`, `<meta name="description">` and `<link rel="canonical">`;
- Open Graph: `og:site_name`, `og:title`, `og:description`, `og:url`, `og:type`, `og:locale` and `og:image`;
- for a post, `article:published_time` and one `article:tag` per tag;
- Twitter card: `twitter:card` (`summary_large_image`), `twitter:title`, `twitter:description` and `twitter:image`.

`<html lang>` is the `lang` of the site, whatever the language of a single post. `og:url` is the canonical address. Redirect pages for old slugs carry `noindex` and a canonical link to the live page, and the 404 page carries `noindex`.

## The preview image

A page's preview image is, in this order:

1. the image the page supplies: a post's `cover`, or a generated title card (below); a project page's card picture, the 1200 pixel variant (see [Projects](projects.md));
2. the site's default image.

The default image is the `defaultImage` key of the site (see [Configuration](configuration.md)): a path starting with `/` or an absolute `http(s)` URL. It defaults to `/assets/social-default.png`, a 1200 by 630 picture that comes with the default theme; a theme can replace it by shipping a file of the same name in its `assets/` folder, or the site can point `defaultImage` at another file. When `defaultImage` is a path and no such file is in the output, the build warns. The home page and the 404 page use it.

### A post's cover

`cover` in the front matter of a post is either an `http(s)` URL, which is used as it is, or the path of an image beside the post (`cover.jpg`, `./images/cover.png`; JPEG, PNG, WebP or HEIC), which stays inside the content directory. The file goes through the image pipeline (see [Images](images.md)) and the 1200 pixel WebP variant, `img/{key}/{name}-1200.webp`, is the preview image; the original is never published. A cover that cannot be used (missing, outside the content directory, another file type, not decodable) is reported as a warning and the post gets a title card instead.

### Title cards

Every post without a cover, and every blog index, tag index, tag page and series page, gets a card: a 1200 by 630 PNG with the title of the page and the title of the site, in the theme's accent colour. The title is set in the largest size at which it takes at most three lines; a longer title is cut with an ellipsis. Cards are written to `{out}/{siteId}/cards/{hash}.png`, and the page's `og:image` and `twitter:image` point at them.

The text is drawn by [resvg](https://github.com/RazrFalcon/resvg) (the `@resvg/resvg-js` package) from an SVG template, with the font that comes with coffer, Inter (SIL Open Font License; the license is `theme/fonts/OFL.txt`), which covers Latin and Cyrillic. The renderer never reads the fonts of the machine, so a card is the same on Windows, Linux and macOS, and a Russian title needs no setup.

Cards are cached by the hash of everything they depend on (the finished SVG, the font files and the renderer version) in `.cache/cards/` beside the configuration file. A build draws only the cards that are not in the cache; the same title on the same site is one file. The cache is safe to delete, and `.cache/` belongs in `.gitignore`. A library user can pass another folder as `cacheDir` to `buildSites`, and reads how many cards a build drew and reused from the `cards` key of each site's result.

A theme changes its cards by putting files in its directory (see [Themes](themes.md#title-cards)):

- `theme.yaml` with the accent colour (and, if wanted, the card's background and text colours);
- `card.svg.njk`, its own SVG template;
- `fonts/`, its own `.ttf` or `.otf` files, which replace the bundled font.

## `sitemap.xml`

`{out}/{siteId}/sitemap.xml` lists the canonical address of every published page, in the sitemaps.org format, sorted by address, each as an absolute URL. Posts also carry `lastmod`, their date. It lists:

- the home page, the blog indexes, the tag index and tag pages, the series pages and published posts;

and leaves out:

- the 404 page;
- redirect pages for old slugs, which are not canonical;
- drafts and future-dated posts that a preview build (`--drafts`) writes, and tag or series pages that would only list such posts.

The same list, as site-relative URLs, is the `sitemap` key of the build manifest.

## `robots.txt`

`{out}/{siteId}/robots.txt` allows crawling and names the sitemap with its absolute address:

```
User-agent: *
Allow: /

Sitemap: https://example.org/sitemap.xml
```

Hosts serve `robots.txt` from the root of a domain, so a site whose `baseUrl` has a path keeps its file in the output but needs the domain's root to point to it.
