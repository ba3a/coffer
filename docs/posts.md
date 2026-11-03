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
series: Alps
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
| `cover`          | no       | Cover image: a path beside the post, or a URL.                                                              |
| `series`         | no       | Name of the series the post belongs to.                                                                     |
| `seriesPosition` | no       | Whole number that fixes the post's place in its series. Needs `series`.                                     |
| `draft`          | no       | `true` keeps the post out of the published site. Default `false`.                                           |
| `aliases`        | no       | List of old slugs that redirect permanently to this post; see [URLs](urls.md).                              |
| `location`       | no       | Image location policy for this post, overriding the site and tag settings. Checked when the policy is applied. |
| `camera`         | no       | Camera metadata policy for this post. Checked when the policy is applied.                                   |
| `map`            | no       | `true` or `false` to force or suppress the map. Without it, a map appears when there is something to show. |

Keys that coffer does not know are kept in the post's `frontMatter` and otherwise ignored.

### Tags

Each tag is split at `/` into segments; every segment is trimmed and lowercased, and none may be empty. `Hiking/Alps`, ` hiking / alps ` and `hiking/alps` are the same tag. A tag with an empty segment (`""`, `a//b`, `/a`, `a/`) is an error.

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
/site/blog/old.md: tags[1]: "a//b" must be a slash separated path without empty segments
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
