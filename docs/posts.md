# Posts

A blog is a directory of posts (the `dir` of a blog in [`coffer.yaml`](configuration.md)). coffer finds the posts, reads their front matter and decides which of them are published.

## Where posts live

A post is either a folder or a single file:

```
blog/
  first-walk/          a folder post: text and images together
    index.md
    cover.jpg
    photo-1.jpg
  quick-note.md        a single-file post
```

- The **slug**, the last segment of the post's URL, is the folder name (`first-walk`) or the file name without `.md` (`quick-note`). It never comes from the date or the tags, so changing either never moves the post.
- A slug is made of letters of any script, digits, `.`, `_` and `-`, and starts with a letter or a digit. Cyrillic slugs are fine.
- Slugs must be unique within a blog, ignoring case. A folder `a/` with `a/index.md` next to a file `a.md` is an error that names both files.
- Everything else in the blog directory is ignored: names starting with a dot, files that do not end in `.md`, and folders without an `index.md`. Every other `.md` file is a post, so keep notes that are not posts outside the blog directory.

## Front matter

Every post starts with YAML between two `---` lines:

```markdown
---
title: A walk in the hills
date: 2024-05-01
tags: [hiking/alps, photography]
summary: Two days, one tent.
series: alps
seriesPosition: 1
---

The text of the post.
```

| Key              | Required | Meaning                                                                                                     |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `title`          | yes      | Non-empty string. Quote it if it would otherwise be read as another YAML type (`"2024"`).                   |
| `date`           | yes      | `YYYY-MM-DD`, or `YYYY-MM-DD` and a time, see below.                                                         |
| `tags`           | no       | List of tags. A tag is a slash path such as `woodworking/boxes`. Stored lowercase, without duplicates.      |
| `summary`        | no       | Short text for lists, feeds and link previews.                                                              |
| `cover`          | no       | Cover image: a path beside the post (JPEG, PNG, WebP or HEIC; it is resized like any image, see [Images](images.md)), or a URL. |
| `series`         | no       | Slug of the series the post belongs to, such as `alps`; stored lowercase. See [Series](series.md).          |
| `seriesPosition` | no       | Whole number that puts the post ahead of the unnumbered ones, by value. Needs `series`; see [Series](series.md). |
| `draft`          | no       | `true` keeps the post out of the published site. Default `false`.                                           |
| `aliases`        | no       | List of old slugs that redirect permanently to this post; see [URLs](urls.md).                              |
| `location`       | no       | Image location policy for this post (`strip`, `coarse` or `keep`), overriding the site and tag settings. See [Location and camera metadata](location-policy.md). |
| `camera`         | no       | Camera metadata policy for this post (`strip` or `keep`). See [Location and camera metadata](location-policy.md). |
| `tracks`         | no       | The GPX files of this post, as a list of file names beside the post, each either a name or `{ file, title }`. Without it every `*.gpx` file in a post folder is a track. `tracks: []` publishes none. See [Maps and GPX tracks](maps.md). |
| `images`         | no       | Mapping of image paths to `{ location, camera }` overrides for single images, for example `images: { IMG_1.jpg: { location: strip } }`. See [Location and camera metadata](location-policy.md). |
| `map`            | no       | `true` or `false` to force or suppress the map. Without it, a map appears when there is something to show. |

Keys that coffer does not know are kept in the post's `frontMatter` and otherwise ignored.

### Tags

Each tag is split at `/` into segments; every segment is trimmed and lowercased, and none may be empty. `Hiking/Alps`, ` hiking / alps ` and `hiking/alps` are the same tag. A segment becomes part of a URL, so it is made of letters, digits, `.`, `_` and `-` and starts with a letter or a digit. A tag with an empty or unusable segment (`""`, `a//b`, `/a`, `a/`, `a b`, `a/../b`) is an error.

Tags form a tree with a page per tag; see [Tags](tags.md).

### Dates

- `2024-05-01` means 00:00 on that day in the site's `timezone`.
- `2024-05-01T18:30` (or with a space instead of `T`, and optional seconds) is that time in the site's `timezone`.
- A trailing `Z` or an offset such as `+03:00` states the time zone explicitly and overrides the site's.
- The value must be a real calendar date and time. A date written without quotes stays text in coffer's YAML reading, so `date: 2024-05-01` needs no quoting.

## Errors

Problems are collected over the whole blog and reported together. Each line starts with the path of the file and names the field:

```
/site/blog/first-walk/index.md: title: is required
/site/blog/quick-note.md: date: must be a date (YYYY-MM-DD) or a date and time (YYYY-MM-DDTHH:MM)
/site/blog/old.md: tags[1]: "a//b" must be a slash separated path whose segments are made of letters, digits, ".", "_" and "-"
```

Missing or unclosed front matter, YAML syntax errors (with the line), wrong types, unusable slugs and duplicate slugs are all reported this way.

## Which posts are published

A post is published when it is not a draft and its date is not after "now". In **preview mode** (`drafts`), every post is included, drafts and future-dated posts alike.

"Now" is decided once per run:

1. the `--now` option, if given;
2. otherwise the environment variable `COFFER_NOW`;
3. otherwise the clock.

Both give a date or a date and time in the format above (a value without an offset is read in the site's `timezone`). Tests set `COFFER_NOW` so that results do not depend on the day they run.

A post dated exactly "now" is published. Future-dated posts therefore appear on the first build after their date; the scheduled rebuild of a site is what makes that happen without anyone doing anything.

## From code

```js
import { discoverPosts, isPublished, resolveNow } from 'coffer';

const now = resolveNow({ flag: options.now, env: process.env, timezone: site.timezone });
const posts = discoverPosts(blog.dir, { timezone: site.timezone });
const published = posts.filter((post) => isPublished(post, { now, drafts: false }));
```

`discoverPosts` returns the posts newest first (ties by slug) and throws a `PostError` whose `errors` lists every problem.
