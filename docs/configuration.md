# Configuration

coffer reads one file, `coffer.yaml`, that describes every site it builds. Names, URLs, languages, defaults and texts live here; behaviour lives in the engine.

## Finding the file

- `coffer <command> --config path/to/file.yaml` (or `--config=path`) uses that file.
- Without `--config`, coffer looks for `coffer.yaml` in the working directory and then in each parent directory, and uses the first one it finds.

Every relative path inside the file (`contentDir`, `theme`, blog `dir`, `projects.dir`) is resolved against the directory that holds the configuration file, never against the working directory. The loaded configuration contains absolute paths.

Check a configuration without building anything:

```
coffer config
coffer config --config example/coffer.yaml
```

The command prints the site ids and exits 0, or prints every problem and exits 1.

## Example

```yaml
sites:
  - id: journal
    baseUrl: https://example.org
    lang: en
    timezone: Europe/Samara
    title: Example Maker
    description: Things made, and notes on making them.
    contentDir: content/journal
    theme: themes/plain
    contentLicense: All rights reserved
    links:
      - { label: Code, url: https://example.com/maker }
      - { label: Email, url: "mailto:maker@example.org" }
    blogs:
      - { id: notes, dir: content/journal/notes, prefix: notes, title: Notes }
    urls: { projects: made }
    location: { default: strip, camera: strip }
    projects: { dir: content/journal/projects }
```

A file can list several sites. Each site is built on its own, with its own language, time zone, theme, blogs and policies.

## Top level

| Key     | Required | Description                                     |
| ------- | -------- | ----------------------------------------------- |
| `sites` | yes      | A non-empty list of sites, built in file order. |
| `media` | no       | Where the original photos and videos are kept when they stay out of git, and which files they are (see [`media`](#media) below and [Media originals](media.md)). Without it nothing changes. |

Unknown keys are errors everywhere in the file, so a misspelled key never passes silently.

## Site keys

| Key              | Required | Default      | Description                                                                                                                                                  |
| ---------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | yes      | -            | Identifier made of letters, digits, `.`, `_` and `-`. Unique across the file. Names the site's output directory.                                           |
| `baseUrl`        | yes      | -            | Absolute `https` URL of the site, for example `https://example.org`. No credentials, query or fragment. A trailing slash is removed; a path (`/sub`) is kept. |
| `lang`           | no       | `en`         | BCP 47 language tag. Used for the `lang` attribute, UI strings and date formatting. Stored in canonical case.                                              |
| `timezone`       | no       | `UTC`        | IANA time zone name such as `Europe/Samara`. Dates written without a time are read in this zone. Numeric offsets such as `+04:00` are not accepted.        |
| `title`          | yes      | -            | Title of the site.                                                                                                                                           |
| `description`    | no       | empty        | Short description of the site, used for page metadata.                                                                                                      |
| `contentDir`     | no       | `content`    | Directory with the site's content: the home page (`home.md`, see [Home](home.md)) and pages.                                                                |
| `theme`          | no       | default theme | Directory of the site's theme. When absent, the engine's default theme is used and the value is `null` in the loaded configuration.                       |
| `contentLicense` | no       | empty        | Text shown in the footer to state the license of the site's content, for example `All rights reserved`. The engine's own license does not cover content.    |
| `defaultImage`   | no       | `/assets/social-default.png` | Preview image of pages that have none (see [SEO and link previews](seo.md)): a path starting with `/` or an absolute `http(s)` URL. |
| `icon`           | no       | none         | Picture that stands for the site, for example in feed readers: a path relative to the root of the built site, such as `assets/brand/icon-192.png` (a file in the `assets` folder of the theme). It must exist in the output and be a square PNG of at least 128 x 128 px, or the build fails and names the setting and the site. Not a URL, not a path starting with `/`, no `..` segments, no spaces or `%`. Without `icon`, no icon element is written in the feeds. |
| `logo`           | no       | none         | Wide picture of the site, such as a banner: a path relative to the root of the built site, as for `icon`. It must exist in the output and be a PNG, or the build fails and names the setting and the site. Without `logo`, no logo element is written in the feeds. |
| `favicon`        | no       | none         | File the build copies to `/favicon.ico` at the root of the site: a path relative to the root of the built site, as for `icon` (for example `assets/brand/favicon.ico`), ending in `.ico` or `.png`. It must exist in the output and be an ICO or PNG file, or the build fails and names the setting and the site. Browsers ask for `/favicon.ico` whatever the page says, so a site that sets it answers that request. If something else is already at `/favicon.ico` (a page, a redirect or a file of the content), the build fails and names both. See [SEO and link previews](seo.md#root-icons). |
| `appleTouchIcon` | no       | none         | The same for iOS home screens: the PNG the build copies to `/apple-touch-icon.png`. A path as for `icon`, ending in `.png`; it must exist in the output and be a PNG (180 x 180 px is the usual size). Collisions fail the build as for `favicon`. |
| `author`         | no       | the site title | Author named in feeds: a name, or a mapping with `name`, `email` and `url` (see [Feeds](feeds.md)).                                                        |
| `feeds`          | no       | see below    | Settings of the Atom feeds.                                                                                                                                  |
| `links`          | no       | `[]`         | List of links, see below.                                                                                                                                    |
| `blogs`          | no       | `[]`         | List of blogs, see below.                                                                                                                                    |
| `urls`           | no       | see below    | URL prefixes of generated sections.                                                                                                                          |
| `images`         | no       | see below    | Widths, sizes and quality of the published images (see [Images](images.md)).                                                                                 |
| `location`       | no       | see below    | Image metadata policy.                                                                                                                                       |
| `tracks`         | no       | see below    | How GPX tracks are simplified and summarized (see [Maps and GPX tracks](maps.md)).                                                                           |
| `map`            | no       | OpenStreetMap | The tile server of the maps of posts (see [Maps and GPX tracks](maps.md#the-map)).                                                                          |
| `analytics`      | no       | none         | An optional analytics snippet, a third-party script in production builds only (see [Analytics](analytics.md)). |
| `projects`       | no       | none         | Where the site's projects live. Without it the site has no projects.                                                                                         |

## `author` and `feeds`

```yaml
author: { name: Tove Marlowe, email: tove@example.org, url: https://example.org/ }
feeds: { limit: 20 }
```

`author` is either a name (`author: Tove Marlowe`) or a mapping with `name` (default: the site title), `email` and `url` (an absolute `http(s)` URL). It is the author of every feed and entry. `feeds.limit` is the number of entries in the feed of a blog or a tag (a positive integer, default 20); series feeds always list every part. See [Feeds](feeds.md).

## `links`

A list of entries with two required keys:

| Key     | Description                                                                          |
| ------- | ------------------------------------------------------------------------------------ |
| `label` | Text of the link.                                                                    |
| `url`   | An `http(s)` URL, a `mailto:` address, or a site-relative path starting with a `/`. |

## `blogs`

A list of blogs. A site may have several, or none.

| Key      | Required | Default        | Description                                                                                                                                              |
| -------- | -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`     | yes      | -              | Identifier, unique within the site.                                                                                                                      |
| `dir`    | no       | the `id`       | Directory that holds the blog's posts, relative to the configuration file.                                                                              |
| `prefix` | no       | the `id`       | URL prefix of the blog, such as `journal` or `notes/2024`. No slash at either end. Set it to the empty string (`prefix: ""`) to serve the blog at the site root. Unique within the site. |
| `title`  | no       | the site title | Display title of the blog.                                                                                                                               |
| `newPostTemplate` | no | none | Markdown file, relative to the configuration file, whose text `coffer new` puts below the front matter of a new post of this blog (see [Authoring](authoring.md#new-posts-coffer-new)). |
| `shareSummary` | no | `false` | Give every post a `share.txt` and a collapsed "Share summary" block with a copy button (see [Share summary](sharing.md)). |
| `shareHashtags` | no | `false` | End the share summary with hashtags made from the tags of the post. Needs `shareSummary: true`. |
| `index` | no | `summary` | What the blog index page lists: `summary` (a card per post) or `full` (whole posts). Write `index: full`, or `index: { type: full, pageSize: 10 }` to split a full index into pages of 10 posts. `pageSize` is a positive whole number, only has an effect with type `full`, and without it a full index is one page. Feeds are never paginated: a feed always lists the same recent posts, whatever `index` says. With a `pageSize` and more posts than fit on a page, the blog index is split: page 1 stays at the address of the blog, page n is at `{blog}/page/n/` (see [URLs](urls.md)), each with previous and next links, a canonical address and a sitemap entry, and `/page/1/` redirects to the blog. A blog with at most `pageSize` posts is unchanged. A post of a paginated blog cannot have the slug `page`. The tag pages and the series pages of the blog are split the same way, with the same `pageSize` (see [Tags](tags.md#the-pages) and [Series](series.md#the-series-page)); tag and series feeds are not. With `full`, the blog index, every tag page and every series page of the blog show for each post its title (a link to the post), the date, reading time and tags, and the whole body, laid out as on the post page; the table of contents, series box, project blocks and share summary stay on the post page. A post's `index` front matter overrides this for that post, so one blog can mix full and summary posts. The `summary` of the front matter is still used for link previews, descriptions and feeds, and is what the list shows for a `summary` post. The search finds each post once, through its own page (see [Themes](themes.md#templates-of-the-blog)). An unknown value or key fails the configuration and names the blog. |

## `urls`

Prefixes of generated sections. All four are optional.

| Key        | Default   | Description                                                      |
| ---------- | --------- | ---------------------------------------------------------------- |
| `projects` | `made`    | Prefix of the projects index and the project pages.              |
| `docs`     | `docs`    | Segment under a project page that holds the project's docs (see [docs sources](docs-sources.md)). |
| `tags`     | `tags`    | Segment under a blog that holds the tag pages (see [Tags](tags.md)). |
| `series`   | `series`  | Segment under a blog that holds the series pages.                |

Values are single or nested path segments without a slash at either end. `tags` and `series` must differ, and `projects` must not equal the prefix of a blog. When the site has projects, `projects` must also not start with a name the build writes itself: `assets`, `img`, `cards`, `404.html`, `_redirects`, `robots.txt`, `sitemap.xml`, `feed.xml` or `build-info.json`. A project page that would be written to the same file as another page (for example the folder `journal` under `made` when a blog has the prefix `made/journal`) fails the build and the message names the `project.yaml`.

## `images`

How published images are made (see [Images](images.md)). Every key is optional.

```yaml
images:
  widths: [480, 800, 1200, 1600, 2400]
  viewerMaxEdge: 3200
  webpQuality: 80
  jpegQuality: 85
  sizes: "(min-width: 44rem) 41rem, calc(100vw - 2rem)"
  carouselSizes: "(min-width: 44rem) 41rem, calc(100vw - 2rem)"
```

| Key             | Default                                         | Description                                                                                                                       |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `widths`        | `[480, 800, 1200, 1600, 2400]`                  | Widths in pixels of the WebP variants, integers from 16 to 20000. An image is never enlarged: only widths below its own width are made, plus its own width when it is not wider than the widest one. |
| `viewerMaxEdge` | `3200`                                          | Longest edge in pixels of the full-size JPEG kept for the viewer and for downloads (64 to 30000). Smaller images keep their size.   |
| `webpQuality`   | `80`                                            | WebP quality of the variants, 1 to 100.                                                                                           |
| `jpegQuality`   | `85`                                            | JPEG quality of the full-size image, 1 to 100.                                                                                    |
| `sizes`         | `(min-width: 44rem) 41rem, calc(100vw - 2rem)`  | The `sizes` attribute of the pictures: how wide the image is shown at each screen width. Match it to the text column of your theme. |
| `carouselSizes` | `(min-width: 44rem) 41rem, calc(100vw - 2rem)`  | The `sizes` attribute of the pictures in [carousels](carousels.md): how wide a slide is shown at each screen width. Match it to the width of the carousel in your theme. |

Changing a value makes the next build process the images again; the cache is keyed by the settings.

## `location`

What happens to the location and the camera metadata of published images. A more specific setting (for a tag, a post or an image) overrides these site-wide defaults; see [Location and camera metadata](location-policy.md).

| Key       | Values                     | Default | Description                                                                                                        |
| --------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `default` | `strip`, `coarse`, `keep`  | `strip` | `strip` removes the location, `coarse` rounds it to roughly a kilometre, `keep` publishes it exactly.            |
| `camera`  | `strip`, `keep`            | `strip` | Whether camera model, lens and exposure settings stay in published images.                                         |

## `tracks`

How the GPX tracks of posts are simplified for the map and summarized (see [Maps and GPX tracks](maps.md)). Both keys are optional.

```yaml
tracks:
  tolerance: 10
  elevationThreshold: 3
```

| Key                  | Default | Description                                                                                                                                  |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tolerance`          | `10`    | Tolerance of the simplification of the drawn track in metres (0 to 1000): the drawn line stays within this distance of the recorded one. `0` keeps every point that is not on a straight line. |
| `elevationThreshold` | `3`     | Smoothing threshold of the elevation gain in metres (0 to 100): ups and downs smaller than this count as noise and add nothing to the climb. |

The summary of a track (distance, elevation gain, highest point) is always computed from every recorded point; `tolerance` only changes the drawn geometry.

## `map`

The tiles of the maps of posts (see [Maps and GPX tracks](maps.md#the-map)). All keys are optional.

```yaml
map:
  tileUrl: https://tiles.example/{z}/{x}/{y}.png
  attribution: Tiles by <a href="https://tiles.example">Example</a>
  maxZoom: 18
```

| Key           | Default                                          | Description |
| ------------- | ------------------------------------------------ | ----------- |
| `tileUrl`     | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | An `http(s)` address with `{z}`, `{x}` and `{y}` for the zoom level and the tile (`{s}` and `{r}` work as in Leaflet). It must not need a key. |
| `attribution` | the credit of OpenStreetMap                      | The credit of the tile provider, shown in the corner of every map; may contain links. Required when `tileUrl` is set, because the default credit belongs to the default server. |
| `maxZoom`     | `19`                                             | The deepest zoom level of the tile server, an integer from 1 to 24. |

## `analytics`

```yaml
analytics: { provider: cloudflare, token: "0123456789abcdef0123456789abcdef" }
```

| Key        | Required                     | Description |
| ---------- | ---------------------------- | ----------- |
| `provider` | no (default `none`)          | `none`, `cloudflare` or `custom`. |
| `token`    | with `cloudflare`, only then | The token of the site in Cloudflare Web Analytics: 8 to 64 letters and digits. Write it in quotes. |
| `html`     | with `custom`, only then     | The snippet, as HTML. |

A setting that does not fit its provider (no token for `cloudflare`, no `html` for `custom`, a `token` or `html` for another provider, an unknown provider) is a configuration error. See [Analytics](analytics.md).

## `projects`

| Key           | Required | Default | Description                                                                     |
| ------------- | -------- | ------- | ------------------------------------------------------------------------------- |
| `dir`         | yes      | -       | Directory that holds one folder per project, relative to the configuration file. Must be inside the content directory, so that the pictures and links in a project's text are found; a folder outside it is a configuration error. |
| `latestPosts` | no       | `5`     | How many of its latest devlog posts a project's page lists, a whole number from 0 to 50. With `0` the list is left out. It does not limit the project's feed or the list in the manifest. See [Posts about a project](projects.md#posts-about-a-project). |

See [Projects](projects.md) for what a project folder holds.

## `media`

`media` sits beside `sites`, not inside a site: one lock file, one store and one set of patterns cover the content folders of every site in the file. Without it nothing changes; the example site keeps its images in git.

```yaml
media:
  store: { type: fs, dir: ../originals }
  include: ["content/**/*.[jJ][pP][gG]", "content/**/*.mp4"]   # optional
  lock: media.lock.json                                        # optional
```

| Key       | Required | Default                       | Description |
| --------- | -------- | ----------------------------- | ----------- |
| `store`   | yes      | -                             | Where the originals are kept: `{ type: fs, dir: <folder> }` or `{ type: s3, ... }` (see below). |
| `include` | no       | images and videos under every content folder | Patterns of the files that are originals, relative to the configuration file, in the glob syntax described under [guides](docs-sources.md#guides) (`*`, `?`, `[...]`, `**`; case-sensitive; hidden files never match). The default matches `jpg`, `jpeg`, `png`, `webp`, `gif`, `avif`, `heic`, `heif`, `tiff`, `mp4`, `mov`, `webm`, `m4v` and `mkv` in any capitalisation below each `contentDir`. SVG is not included: it is small text and stays in git. A pattern that matches the lock file or the configuration file is an error. |
| `lock`    | no       | `media.lock.json`             | Path of the lock file, relative to the configuration file. |

Keys of `store`:

| Key                  | Used by | Required | Description |
| -------------------- | ------- | -------- | ----------- |
| `type`               | both    | yes      | `fs` or `s3`. |
| `dir`                | `fs`    | yes      | A folder (relative to the configuration file) that holds the objects. It must not be inside a content folder or contain one, must not be or contain the folder of the configuration file, and must not be inside `.coffer`. `~` and environment variables are not expanded, and the checks are on the path as written (links are not resolved). |
| `endpoint`           | `s3`    | yes      | An `https` address, without credentials; `${NAME}` stands for an environment variable (or a line of `.env.local`) whose value may hold only letters, digits, `.`, `_` and `-`, and not only dots. Objects are addressed path-style: `{endpoint}/{bucket}/{prefix}/originals/{sha256}`. |
| `bucket`             | `s3`    | yes      | The bucket name. |
| `region`             | `s3`    | no       | Default `auto`. |
| `prefix`             | `s3`    | no       | A folder-like prefix in the bucket. |
| `accessKeyIdEnv`     | `s3`    | no       | The NAME of the environment variable that carries the access key id. Default `COFFER_MEDIA_ACCESS_KEY_ID`. |
| `secretAccessKeyEnv` | `s3`    | no       | The NAME of the environment variable that carries the secret access key. Default `COFFER_MEDIA_SECRET_ACCESS_KEY`. |

Credentials are never read from the configuration file, and a key written in its place is an error: they come from the named environment variables or from a gitignored `.env.local` next to the configuration file. See [Media originals](media.md), which also describes `coffer hooks install`, the git hooks that run the media commands on commit, push, checkout and merge.

## Validation

All problems are collected and reported together, one per line, each naming the file and the key path:

```
coffer.yaml: sites[1].baseUrl: must be an absolute https URL
coffer.yaml: sites[1].blogs[0].id: is required
```

YAML syntax errors name the line: `coffer.yaml: line 3: ...`. When `--config` is used, messages start with the path as given. The command exits with a non-zero status when any problem is found.

## Using the loader from code

```js
import { loadConfig, ConfigError } from 'coffer';

try {
  const config = loadConfig({ configPath: 'coffer.yaml' });
  for (const site of config.sites) console.log(site.id, site.lang);
} catch (error) {
  if (error instanceof ConfigError) console.error(error.errors.join('\n'));
  else throw error;
}
```

The shape of the result is documented with JSDoc typedefs in `src/config.js`: `CofferConfig`, `SiteConfig`, `BlogConfig`, `LinkConfig`, `UrlsConfig`, `LocationConfig` and `ProjectsConfig`.
