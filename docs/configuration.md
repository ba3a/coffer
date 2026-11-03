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
| `author`         | no       | the site title | Author named in feeds: a name, or a mapping with `name`, `email` and `url` (see [Feeds](feeds.md)).                                                        |
| `feeds`          | no       | see below    | Settings of the Atom feeds.                                                                                                                                  |
| `links`          | no       | `[]`         | List of links, see below.                                                                                                                                    |
| `blogs`          | no       | `[]`         | List of blogs, see below.                                                                                                                                    |
| `urls`           | no       | see below    | URL prefixes of generated sections.                                                                                                                          |
| `location`       | no       | see below    | Image metadata policy.                                                                                                                                       |
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

## `urls`

Prefixes of generated sections. All four are optional.

| Key        | Default   | Description                                                      |
| ---------- | --------- | ---------------------------------------------------------------- |
| `projects` | `made`    | Prefix of the projects index and the project pages.              |
| `docs`     | `docs`    | Segment under a project page that holds the project's docs.      |
| `tags`     | `tags`    | Segment under a blog that holds the tag pages (see [Tags](tags.md)). |
| `series`   | `series`  | Segment under a blog that holds the series pages.                |

Values are single or nested path segments without a slash at either end. `tags` and `series` must differ, and `projects` must not equal the prefix of a blog.

## `location`

What happens to the location and the camera metadata of published images. A more specific setting (for a tag, a post or an image) overrides these site-wide defaults.

| Key       | Values                     | Default | Description                                                                                                        |
| --------- | -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `default` | `strip`, `coarse`, `keep`  | `strip` | `strip` removes the location, `coarse` rounds it to roughly a kilometre, `keep` publishes it exactly.            |
| `camera`  | `strip`, `keep`            | `strip` | Whether camera model, lens and exposure settings stay in published images.                                         |

## `projects`

| Key   | Required | Description                                                                     |
| ----- | -------- | ------------------------------------------------------------------------------- |
| `dir` | yes      | Directory that holds one folder per project, relative to the configuration file. |

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
