# Tags

A post carries any number of tags in its front matter. A tag is a slash path such as `workshop/boxes/dovetails`, so tags form a tree. There is no list of tags to maintain: using a tag in a published post creates it.

```yaml
tags: [workshop/boxes/dovetails, trips/mountains]
```

## The tree

The tree is built from the tags of the published posts of one blog (drafts and future-dated posts count only in preview mode, like everywhere else). Every tag used by a post is a node, and so is every ancestor of such a tag: a post tagged `workshop/boxes/dovetails` makes the nodes `workshop`, `workshop/boxes` and `workshop/boxes/dovetails`.

A segment of a tag becomes part of a URL and of a file name. It is made of letters, digits, `.`, `_` and `-` and starts with a letter or a digit; `Hiking/Alps` is stored as `hiking/alps`. See [Posts](posts.md) for the rules and the error messages.

## The pages

For a blog with the prefix `journal` (the segment `tags` comes from `urls.tags` in the [configuration](configuration.md)):

| Address                           | Page                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `/journal/tags/`                  | The tag tree: every node, nested, with the number of posts in its subtree.                 |
| `/journal/tags/workshop/`         | The tag page of `workshop`.                                                                |
| `/journal/tags/workshop/boxes/`   | The tag page of `workshop/boxes`.                                                          |

A **tag page** lists the posts that have the tag **or any tag below it**, newest first: a post tagged `workshop/boxes` appears on `workshop/` and on `workshop/boxes/`, and not on `workshop/tools/`. Like the blog index, it shows a post in full when the post's effective `index` is `full` (the blog's `index` setting or the post's own front matter), so one tag page can mix full and summary posts; see [Configuration](configuration.md). It also shows a breadcrumb trail (the tag tree, then each ancestor) and links to the child tags with their counts.

The **count** of a node is the number of distinct posts in its subtree: a post tagged both `a/b` and `a/c` counts once for `a`.

### Pagination

In a blog with `index: { type: full, pageSize: N }` (see [Configuration](configuration.md#blogs)) a tag page with more than N posts is split into pages, like the blog index. Every node of the tree is paginated on its own, and it counts the posts of its whole subtree: with `pageSize: 2`, a tag `workshop` with 5 posts in total (its own and those of `workshop/boxes` and the other tags below it) has 3 pages. Page 1 stays at `/journal/tags/workshop/`, page n is at `/journal/tags/workshop/page/n/`. Each page has previous and next links, its own canonical address and sitemap entry, and the title of the pages after the first ends in "(Page n of m)". `/journal/tags/workshop/page/1/` redirects to the tag page with `301`. The breadcrumbs and the child tags with their counts are on every page. A tag with at most N posts is one page and has no `page/` directory. The tag tree page (`/journal/tags/`) is never split, and neither are the feeds: a tag's feed lists the same recent posts whatever the page size. A tag whose path would be the address of a page of its parent (`workshop/page/2` while `workshop` has several pages) fails the build and names the tag; see [URLs](urls.md).

The blog index links to the tag tree, and a post page links each of its tags. A blog without tags still gets a tag tree page, which says that there are no tags yet. A post cannot have the slug of the tags segment (`/journal/tags/` would be two pages), and an alias cannot be one either; both fail the build.

## Names and descriptions: `tags.yaml`

By default a tag is shown by the last segment of its path (`dovetails`). An optional `tags.yaml` in the blog's directory (beside the posts) gives a tag a display name and a description, for example a Russian name for a Latin slug:

```yaml
workshop:
  name: Workshop
  description: Things made at the bench.
workshop/boxes:
  name: Boxes
trips/mountains:
  name: Горы
```

- Keys are tag paths, written like in a post (case is ignored). Each value has `name` and `description`, both optional.
- The name is shown in the headings, the breadcrumbs, the lists and on the posts; the description appears on the tag page and in the tag tree, and is the page's `description` meta tag.
- Entries for tags that no published post uses are ignored and reported as **warnings**, as are unknown keys inside an entry. Warnings never fail the build.
- `location` (`strip`, `coarse` or `keep`) and `camera` (`strip` or `keep`) set the image metadata policy of the tag's whole subtree; see [Location and camera metadata](location-policy.md) for how they combine with the site, post and image settings. A value the setting does not accept fails the build.
- A file that is not valid YAML, an entry that is not a mapping, a tag path that is not valid, or a `name` that is not text fails the build, with the file and the key.

## Templates

`tag.njk` (one tag) extends `blog-index.njk`, so a theme's `item` block applies to its list of posts too; it adds the blocks `breadcrumbs` and `children`. `tag-index.njk` (the tree) has one block, `tree`. See [Themes](themes.md) for the variables.

The build manifest lists the tag pages in `tags` (see [Building a site](build.md)).
