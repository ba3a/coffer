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

The command prints one line per site and exits 0, or prints every problem it found (with the file and the field) and exits 1. The same build is available in code as `buildSites(config, options)`.

## What is written

For a site `workshop` with a blog whose `prefix` is `journal`:

```
{out}/workshop/
  index.html                          the home page
  404.html                            the page for unknown addresses
  journal/index.html                  the blog index
  journal/{slug}/index.html           one page per published post
  assets/                             the static files of the theme
  .coffer-manifest.json               the build manifest
```

- **Post URLs** are `/{prefix}/{slug}/` and nothing else. The slug is the folder or file name of the post, so neither the date nor the tags ever change the address. A blog with an empty `prefix` writes its posts and its index at the root of the site.
- **The home page and the 404 page** are described in [The home page, the 404 page and the footer](home.md).
- **The blog index** lists the published posts, newest first, with the date, the summary and the reading time of each.
- **A post page** shows the title, the date, the reading time, the table of contents and the body. The table of contents is built from the `h2` and `h3` headings of posts with enough of them (see [Markdown](markdown.md)). It comes before the body in the page. On a narrow screen it is a collapsible block; on a wide screen the stylesheet puts it beside the body.
- **Assets** are the files of the default theme's `assets/` folder, followed by the `assets/` folder of the site's theme, which wins on equal names. The default stylesheet is `assets/coffer.css`.
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
| `posts`            | Every post built: blog id, slug, `url`, `file`, `source` (relative to the configuration file), title, date, tags, `draft`, `published` and reading time. |
| `feeds`, `images`  | Empty lists for now; features that write feeds or images record them here.                                     |

The manifest is for checks and not for visitors. It is excluded from deployment by its name, `.coffer-manifest.json` (exported as `MANIFEST_FILE_NAME`; `DEPLOY_EXCLUDES` lists every name a deployment must skip). Leave it out when uploading the output to a host.

## The example site

`example/` in the coffer repository is a complete small site with made-up content: one site with a home page and links, a blog with the prefix `journal`, a published post, a draft and a post dated far in the future. It is what coffer's own tests build.

```
npm run example
```

builds it into `example/dist/` (ignored by Git). Open `example/dist/workshop/journal/index.html` in a browser, or serve the directory with any static file server.
