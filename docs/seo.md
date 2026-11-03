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

1. the image the page supplies (later features fill it: a post's cover, a generated card with the title, a project's card picture);
2. the site's default image.

The default image is the `defaultImage` key of the site (see [Configuration](configuration.md)): a path starting with `/` or an absolute `http(s)` URL. It defaults to `/assets/social-default.png`, a 1200 by 630 picture that comes with the default theme; a theme can replace it by shipping a file of the same name in its `assets/` folder, or the site can point `defaultImage` at another file. When `defaultImage` is a path and no such file is in the output, the build warns.

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
