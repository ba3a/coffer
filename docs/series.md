# Series

A series is a run of posts meant to be read in order. A post joins a series by naming it in its front matter:

```yaml
series: boxes-by-hand
seriesPosition: 1      # optional
```

The value of `series` is a **slug** (letters, digits, `.`, `_` and `-`; it is stored lowercase) because it becomes the last segment of the series page's address. Any other value fails the build, with the file and the field. A display name and a description go in `series.yaml`, below.

## Navigation

Every post in a series shows a navigation block twice: near the top (after the title, the date and the tags) and again after the text. The block has

- the **series name**, linking to the series page;
- **"part n of m"**: the post's place in the ordered series and the number of parts (the words come from the UI strings, so a Russian site says "Часть 2 из 3");
- links to the **previous** and **next** parts, when there are any, with their titles.

## Nothing is edited when a part is added

The navigation is computed at build time from all published posts of the blog. A post carries only the name of its series, never the number of its parts or its neighbours. Adding a third part to a series of two therefore changes "part 1 of 2" to "part 1 of 3" on the first post and gives the second post a "next" link, on the next build, and no earlier post is touched. For the same reason a series can be created after the fact: add `series: some-name` to older posts and they are linked together.

Only the posts that are published count: drafts and future-dated posts join the series in a preview build (`--drafts`), and a future-dated part joins on its date, like any other post. See [Posts](posts.md).

## Order

The parts of a series are ordered like this:

1. Posts with an explicit `seriesPosition` come first, by that number, smallest first.
2. The posts without one follow, oldest first.
3. Posts that tie (the same `seriesPosition`, or the same date) are ordered by date, then by slug. Two posts sharing a `seriesPosition` get a build warning.

With no `seriesPosition` anywhere, a series reads in date order. With a `seriesPosition` on every post, it reads in the order the author chose, whatever the dates. In a mixed series the numbered posts are first, so number all the posts, or only the ones that must come before the rest. The number is only a sort key: the "n" of "part n of m" is the place in the final order (a series numbered 10, 20, 30 shows parts 1, 2 and 3).

## The series page

For a blog with the prefix `journal`, the page of the series `boxes-by-hand` is `/journal/series/boxes-by-hand/` (the segment `series` comes from `urls.series` in the [configuration](configuration.md)). It shows the name, the description, the number of parts and the list of parts in order, each with "part n of m", the date, the reading time and the summary, or the whole body for a post whose effective `index` is `full` (the blog's `index` setting or the post's own front matter, so a series page can mix both; see [Configuration](configuration.md)). Only series that have a published post get a page.

In a blog with `index: { type: full, pageSize: N }` (see [Configuration](configuration.md#blogs)) a series with more than N parts is split into pages, like the blog index: page 1 stays at `/journal/series/boxes-by-hand/`, page n is at `/journal/series/boxes-by-hand/page/n/`. The parts stay in order across the pages and keep their numbers ("part 3 of 5"); the count of parts is that of the whole series. Each page has previous and next links, its own canonical address and sitemap entry, and `/journal/series/boxes-by-hand/page/1/` redirects to the series page with `301`. A series with at most N parts is one page. The series feed is never split. See [URLs](urls.md).

## Names and descriptions: `series.yaml`

Without further setup a series is shown by its slug. An optional `series.yaml` in the blog's directory (beside the posts and `tags.yaml`) gives it a name and a description:

```yaml
boxes-by-hand:
  name: Boxes by hand
  description: Learning to make small boxes with hand tools, one joint at a time.
```

- Keys are series slugs (case is ignored). `name` and `description` are both optional.
- The name is the heading of the series page, the link text in the navigation block and the page's title; the description is shown on the series page and is its `description` meta tag.
- Entries for series that no published post uses are reported as **warnings**, as are unknown keys inside an entry. Warnings never fail the build.
- A file that is not valid YAML, an entry that is not a mapping, a slug that is not valid, or a `name` that is not text fails the build, with the file and the key.

## Templates

`post.njk` has two blocks for the navigation, `series_top` and `series_bottom`; both call the macro `seriesNav` from `series-nav.njk`, so a theme can restyle the block by replacing `series-nav.njk`, or move or drop one of them by overriding the block. They are empty for a post that is not in a series. The template receives `series`: `slug`, `name`, `url` (the series page), `number`, `count`, `previous` and `next` (each `{ title, url }` or null). The series page uses `series.njk`, which extends `blog-index.njk` (so its `item` block applies to the list of parts) and receives `series` (`slug`, `name`, `description`, `url`, `count`) and `posts`, the parts in order, each with `part` (the "n"). See [Themes](themes.md).

The build manifest lists the series pages in `series` and the place of each post in `posts[].series` (see [Building a site](build.md)).
