# Feeds

coffer writes full-content [Atom 1.0](https://www.rfc-editor.org/rfc/rfc4287) feeds, so a reader can follow a blog, one tag or one series without opening the site.

## Where the feeds are

Every blog has these feeds, next to the pages they belong to:

| Feed                 | Address                              | Entries                                                         |
| -------------------- | ------------------------------------ | --------------------------------------------------------------- |
| Blog                 | `{blog}/feed.xml`                    | the latest posts of the blog                                    |
| Tag (with subtree)   | `{blog}/{tags}/{path}/feed.xml`      | the latest posts that have the tag or any tag below it          |
| Series               | `{blog}/{series}/{slug}/feed.xml`    | every part of the series                                        |
| Project              | `{projects}/{slug}/feed.xml`        | the latest posts about the project, from every blog of the site |

`{tags}` and `{series}` are the URL segments from the site's `urls` setting (`tags` and `series` by default), so for the blog `journal` the feed of the tag `workshop/boxes` is `/journal/tags/workshop/boxes/feed.xml`. A blog at the site root has its feed at `/feed.xml`. `{projects}` is `urls.projects` (`made` by default), so the feed of the project `kerfcalc` is `/made/kerfcalc/feed.xml`.

A **project feed** lists the published posts that are about the project: those that carry the project's `tag` or a tag below it, and those that name the project in `projects:` (see [Posts about a project](projects.md#posts-about-a-project)). The posts of every blog of the site are in it, each with its own address. Every project of a site that has a blog has a feed, also one that no post is about yet (it then has no entries), so the address a page links to always exists. A site without a blog has no project feeds. The build stops when a project's feed would be written over another file or feed.

A post whose slug is `feed.xml`, or a tag whose last segment is `feed.xml` below another tag, would collide with a feed; the build stops and says which.

Entries are listed newest first. Blog, tag and project feeds hold the latest `feeds.limit` entries (20 unless the site sets another number, see [Configuration](configuration.md)); series feeds always hold all parts.

## What a feed contains

Feed level: `id` (the feed's own address), `title`, `subtitle` (the site, tag or series description, when there is one), `updated` (the date of the newest entry; the time of the build for an empty feed), a `self` link and an `alternate` link to the HTML page, the author and a `generator` element. The feed's `xml:lang` is the site language.

When the site sets `icon` (see [Configuration](configuration.md)), every feed that the engine writes has an `icon` element after the `generator`: the absolute address of that picture, `baseUrl` followed by the path (characters outside ASCII are percent-encoded, as in every other address of a feed). This covers blog, tag, series and project feeds; project feeds use the site's icon. A site that sets `logo` also gets a `logo` element after the `icon`. Without the settings no `icon` or `logo` element is written and the feed is unchanged. `coffer check` accepts both elements and reports one that is repeated or not an absolute URL.

Entry level:

- `id` and the `alternate` link: the permalink of the post. The address of a post never depends on its date or tags, so the id is stable.
- `title`, `published` and `updated`: the post's date, as an RFC 3339 time in UTC. coffer does not track edits, so both are the date of the post.
- `author`: the site's `author` setting (a name, or `name`, `email` and `url`); the site title when none is set.
- `category`: one per tag of the post. `term` is the tag path, `label` the name shown for the tag, `scheme` the address of the tag tree.
- `summary`: the post's `summary` field, or, when there is none, the first 240 characters of the text.
- `content type="html"`: the **whole post** as HTML.

### Absolute addresses

A feed reader shows the HTML far from the site, so every relative URL in the content is rewritten to an absolute one, built from the site's `baseUrl`:

- in `href`, `src`, `poster` and every candidate of `srcset`;
- a path that starts with `/` is read from the site root, anything else from the post's own address (so `../other-post/` and `photo.jpg` work as they do on the page), and `#fragment` links point into the post's page;
- addresses that already have a scheme (`https:`, `mailto:`) are left alone, and so is text that only looks like a link, such as code in a listing.

## Drafts and future posts

Only published posts are in a feed. A draft, and a post whose date is after the build's `now`, never appear, not even in a preview build (`--drafts`) that renders them. A future-dated post enters the feeds on the first build after its date, like it enters the pages. See [Posts](posts.md).

Images in feed content are plain `<img>` elements with the 1200 pixel variant as an absolute address (and their `width` and `height`); the `<picture>`, `srcset`, `loading` and `decoding` that pages use are left out, because feed readers do not all understand them. See [Images](images.md).

## Finding the feeds

Every page lists the feeds of the site's blogs in its `<head>` as `<link rel="alternate" type="application/atom+xml">`, so readers can discover them from any address. Beyond that:

- a tag page also advertises its own tag feed, and a series page its series feed;
- a post advertises the feeds of its tags and of its series, and the feed of each project it is about;
- a project page advertises its project feed first.

The blog index, every tag page, every series page and every project page also show a visible link to the feed that belongs to the page ("Feed of ...").

A theme can change this: `base.njk` writes the head links in its `feed_links` block and `blog-index.njk` (which tag and series pages extend) writes the visible link in `feed_link`. The templates receive `feedLinks` (a list of `{ url, title }`) and `pageFeed`; see [Themes](themes.md).

## The manifest

Each feed is recorded in `.coffer-manifest.json` under `feeds`: `type` (`blog`, `tag`, `series` or `project`), `blog` (null for a project feed), `url`, `selfUrl` (absolute), `file`, `page`, `title`, `entries` and the `tag`, `series` or `project` (slug) it belongs to. See [Building a site](build.md).

## The local validator

`src/check/feed-validator.js` checks a feed without a network:

```js
import { validateFeed } from 'coffer/src/check/feed-validator.js';

const { valid, errors, warnings } = validateFeed(xml, { selfUrl: 'https://example.org/journal/feed.xml' });
```

It reports an error for

- a document that is not well-formed XML (the message has the line and column);
- a root element that is not an Atom `feed`;
- a missing `id`, `title` or `updated` on the feed or on an entry, or a missing author (on the feed, or on every entry);
- a date that is not an RFC 3339 date-time with an offset, such as `2025-04-10` or `2025-02-30T00:00:00Z`;
- an `id` that is not an absolute IRI, and two entries with the same `id`;
- a link whose `href` is not absolute, and a missing `rel="self"` link, or one that differs from `selfUrl` when that is given;
- an entry with neither content nor an `alternate` link, or content of type `html` that has a relative `href`, `src` or `srcset` URL.

Smaller problems (an entry without a `summary`, a self link without the Atom media type, no `alternate` link on the feed) are warnings.

The same function runs in coffer's tests against every feed of the example site. It is also what the `coffer check` command uses on a finished build. It is a local check: it does not replace the W3C feed validator, which is run separately.
