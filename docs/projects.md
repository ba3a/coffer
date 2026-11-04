# Projects

A site can show the things its owner makes: a **projects page** with a card for each project, a **page per project**, and a **showcase** of featured projects on the home page. Projects are content, not code. Adding a project is adding a folder; changing which projects are featured, or in what order, is editing a line in a file.

Projects are switched on by `projects.dir` in [`coffer.yaml`](configuration.md). The URLs use the `urls.projects` prefix (`made` by default):

| Page             | Address                       | Manifest type   |
| ---------------- | ----------------------------- | --------------- |
| All projects     | `/{projects}/`                | `project-index` |
| One project      | `/{projects}/{slug}/`         | `project`       |

A site without `projects.dir` has none of this: no projects page, no showcase, no entry in the navigation.

## A project folder

Each project is a folder `{projects.dir}/{slug}/`. The folder name is the slug, which is the last segment of the project's URL; it uses lower-case letters, digits, `-` and `_`. The folder holds:

```
content/projects/kerfcalc/
  project.yaml     the declaration of the project
  index.md         the text of the project's page
  card.png         the card picture, and any other pictures the text uses
```

Folders whose names start with `.` or `_` are ignored, and so are files directly in `projects.dir`. A folder without `project.yaml` or without `index.md` fails the build and the message names the missing file.

A project page must not share its address with another page. If `urls.projects` is `made`, a blog with the prefix `made/journal` and a project folder `journal` both want `/made/journal/`: the build fails and the message names the `project.yaml`. Rename the folder or change the prefix. `urls.projects` itself cannot be a name the build writes (`assets`, `img`, `cards` and the root files), which the configuration check reports.

### `project.yaml`

```yaml
name: Kerfcalc
pitch: A small command-line calculator for saw kerf, joint spacing and board waste.
kind: tool
status: released
card: card.png
cardAlt: A long board and a shorter one, with a thin cut between them.
featured: true
order: 2
tag: projects/kerfcalc
license: MIT
repo: https://github.example/tove-marlowe/kerfcalc
```

The fields every project has:

| Key        | Required | Default | Description                                                                                                                                      |
| ---------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`     | yes      | -       | The project's name: the heading of its page and of its card.                                                                                     |
| `pitch`    | yes      | -       | One line that says what the project is. Shown on the card and under the heading, and used as the page's description in link previews.            |
| `kind`     | yes      | -       | A registered kind, see below. `tool` and `game` ship with coffer.                                                                                |
| `status`   | yes      | -       | One of `idea`, `in-development`, `released`, `maintained`, `archived`. Shown on the card in the language of the site (`projects.status.*`).     |
| `card`     | yes      | -       | The card picture: a JPEG, PNG, WebP or HEIC file inside the project folder.                                                                      |
| `cardAlt`  | no       | empty   | Alternative text of the card picture. Leave it out when the picture only decorates the card; the project's name is the link text.                |
| `featured` | no       | `false` | Whether the project is on the home page.                                                                                                         |
| `order`    | no       | none    | A whole number: where the project stands in the showcase and on the projects page. Lower comes first.                                            |
| `tag`      | no       | none    | The devlog tag that marks posts about the project, such as `projects/kerfcalc`. Written like any [tag](tags.md); it is normalized to lower case. |
| `license`  | no       | none    | The license of the project, shown at the end of its page.                                                                                        |

The slug is not a field; a `slug:` key fails the build. Any key that neither the common fields nor the project's kind knows fails the build too, so a typo does not go unnoticed.

### `index.md`

The text of the project's page, in ordinary [Markdown](markdown.md) without front matter (a file that starts with `---` fails the build: the fields are in `project.yaml`). Images beside the file, carousels, code blocks and the image viewer work as in a post, and links are checked as in a post (see [Links, images and the build report](links.md)). Images are published under the site's [metadata policy](location-policy.md), exactly as in a post. A project page has no tracks and no located photos of its own, so a `::map` there is left out and the build warns.

## Order and the showcase

The **projects page** lists every project. The **home page showcase** lists the featured ones. Both use one order: projects with an `order` first, lowest number first, then projects without one by name. Two projects with the same `order` are ordered by name. Nothing else decides the order, so putting a project first is changing one number.

Each card shows the picture, the kind, the status, the name and the pitch; the name links to the project's page and the whole card is clickable. Card pictures go through the [image pipeline](images.md) like every picture: resized WebP variants in a `srcset`, `width` and `height` set, lazy loading. The 1200 pixel variant is also the page's preview image in link previews (`og:image`).

A site with `projects.dir` but no project shows "No projects yet." on the projects page and no showcase on the home page. A project that is not `featured` is on its page and the projects page only.

## Links to projects

In any post or project page, `[the lathe](project:lathe)` links to the project with the slug `lathe`. The link becomes the project's URL (`/made/lathe/`); an anchor or a query is kept (`project:lathe#install`). A slug that no folder declares fails the build with the file, line and column of the link and the list of registered projects.

## Kinds

The `kind` of a project decides which template renders its page and which further fields `project.yaml` may have. The shipped kinds are:

| Kind   | Field         | Required | Description                                                                                                         |
| ------ | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `tool` | `repo`        | yes      | `http(s)` address of the source repository.                                                                          |
|        | `docs`        | no       | A mapping that configures the project's documentation. Read by the documentation features.                          |
| `game` | `stores`      | no       | A mapping of store names to `http(s)` links, such as `itch` or `steam`. An empty value means "not set yet".          |
|        | `platforms`   | no       | A list of platform names.                                                                                            |
|        | `price`       | no       | Text such as `Free` or `4.99 EUR`.                                                                                   |
|        | `pressKit`    | no       | A folder inside the project folder that holds the press kit.                                                         |
|        | `accent`      | no       | The game's accent colour, `#rgb` or `#rrggbb`.                                                                       |
|        | `displayFont` | no       | A plain font family name such as `Fraunces` (letters, digits, spaces and `-`, up to 64 characters), or a comma-separated list of such names. Quotes, braces, semicolons, angle brackets and backslashes are rejected, so the value is safe in CSS. |

Both kinds render with the generic `project.njk` for now: the name, the pitch, the kind and the status, the text of `index.md`, the license and a link to the projects page. The kind-specific fields are read, validated and passed to the template as `project.fields`; the pages that use them are separate features.

An unknown `kind`, a missing required field or a value of the wrong shape fails the build. Every problem is listed, each as `path-of-project.yaml: field: message`:

```
/site/content/projects/lathe/project.yaml: kind: unknown kind "podcast" (known kinds: game, tool)
/site/content/projects/lathe/project.yaml: repo: is required for a tool (an http(s) URL)
```

### Adding a kind

A kind is a name, a template and a schema for its fields. Register it with `registerProjectKind` before the build; the engine does this for `tool` and `game` at the bottom of `src/content/project-kinds.js`, which is the place to add a kind to coffer itself.

```js
import { registerProjectKind } from 'coffer';

registerProjectKind({
  name: 'podcast',
  template: 'project-podcast.njk',
  fields: {
    feed: { type: 'url', required: true },
    hosts: { type: 'string-list' },
  },
});
```

1. **Name.** Lower-case letters, digits and `-`; it is the value of `kind:` and the key of the UI string `projects.kind.{name}` (the label on cards). Without that string the card shows the name itself.
2. **Template.** The name of a template in the engine or in the site's theme. Make it extend `project.njk` and override the blocks you need (`project_header`, `project_body`, `project_footer`), or write a page of your own on top of `base.njk`. It receives `project` (see below), `page` (`title`, `description`, `content` = the rendered text of `index.md`), `site`, `nav` and `projectsUrl`.
3. **Fields.** A mapping from the field name to `{ type, required }`. A field name cannot be one of the common keys. The types are:

   | Type          | A value that is...                                                                                  | Result                                                    |
   | ------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
   | `string`      | a non-empty text                                                                                    | the trimmed text                                          |
   | `url`         | an absolute `http(s)` address                                                                       | the address                                               |
   | `color`       | `#rgb` or `#rrggbb`                                                                                 | the colour in lower case                                  |
   | `directory`   | the path of an existing folder inside the project folder                                            | the path relative to the project folder, with `/`         |
   | `string-list` | a list of distinct non-empty texts                                                                  | the list (`[]` when absent)                               |
   | `url-map`     | a mapping of lower-case names to `http(s)` addresses; empty values are dropped                      | the mapping of the names that are set (`{}` when absent)  |
   | `mapping`     | any mapping                                                                                         | the mapping as written                                    |

   An absent optional field is `null`, `[]` or `{}`, according to the type, so a template never has to test whether a key exists. `FIELD_TYPES` in `src/content/project-kinds.js` holds the checks; a new type is one entry there.

A site that only needs another look for `tool` or `game` does not need a new kind: put `project.njk` in the theme and override the blocks (see [Themes and UI strings](themes.md)).

## Templates

| Template               | Used for                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `project-index.njk`    | the projects page; block `heading`                                   |
| `project.njk`          | a project's page; blocks `project_header`, `project_body`, `project_footer` |
| `project-card.njk`     | one card, included by the projects page and the home page showcase   |
| `project-picture.njk`  | the macro `card(picture, sizes)` that writes the card's `<picture>`   |
| `home.njk`             | the `showcase` block lists the featured projects (see [The home page](home.md)) |

A project, as templates see it (`project` on a project's page, one element of `projects` or `showcase` elsewhere): `slug`, `url`, `name`, `pitch`, `kind`, `kindLabel`, `status`, `statusLabel`, `featured`, `order`, `license`, `tag`, `fields` and `picture` (`src`, `width`, `height`, `srcset` as a list of `{ url, width }`, `alt`; null when the picture could not be made, which also fails the build). The card is included with `level` set to the heading level of the name: 2 on the projects page, 3 in the showcase.

The UI strings are `home.projects`, `projects.title`, `projects.empty`, `projects.all`, `projects.license`, `projects.kind.*` and `projects.status.*`. The navigation gets a "Projects" entry (`nav.projects`) between Home and the blogs.

## In the manifest

`.coffer-manifest.json` lists the projects in showcase order under `projects` (`slug`, `url`, `file`, `source`, `name`, `pitch`, `kind`, `status`, `featured`, `order`, `tag`, `card`). Their pages are listed under `pages` and in `sitemap`. Their card pictures are among `images` with `use: "card"` and the project's URL as `post`, so the [checks](checks.md) verify their metadata like any other image.

## Not yet

Feeds of a project, the posts that carry its tag, and the pages and documentation of the kinds are separate features; the `tag` field and the kind fields are read and validated now so that a project declaration is complete from the start.
