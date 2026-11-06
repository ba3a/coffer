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
|        | `docs`        | no       | A mapping that configures the project's documentation. When it is set, the project's page links to `/{projects}/{slug}/{docs}/`. |
| `game` | `stores`      | no       | A mapping of store names to `http(s)` links, such as `itch` or `steam`. An empty value means "not set yet".          |
|        | `platforms`   | no       | A list of platform names.                                                                                            |
|        | `price`       | no       | Text such as `Free` or `4.99 EUR`.                                                                                   |
|        | `pressKit`    | no       | A mapping that describes the game's press kit: facts, two descriptions, logos and screenshots to download (see [The press kit](#the-press-kit)). |
|        | `accent`      | no       | The game's accent colour, `#rgb` or `#rrggbb`: buttons, the line under the heading and bullets on the game's page. |
|        | `displayFont` | no       | A plain font family name such as `Fraunces` (letters, digits, spaces and `-`, up to 64 characters), or a comma-separated list of such names. Quotes, braces, semicolons, angle brackets and backslashes are rejected, so the value is safe in CSS. It restyles the headings and buttons on the game's page. |
|        | `displayFontFile` | no  | A font file (`.woff2`, `.woff`, `.ttf` or `.otf`) inside the project folder. It is published with the page and declared with `@font-face` under the family name of `displayFont` (its first name), or under a fixed name when there is none. Without it `displayFont` is only a font stack: a font the reader has installed. |
|        | `logo`        | no       | A picture in the project folder, shown above the heading. It goes through the [image pipeline](images.md). Its alt text is empty, as the name follows it. |
|        | `keyArt`      | no       | A picture in the project folder, shown under the pitch. Its alt text is `keyArtAlt`.   |
|        | `keyArtAlt`   | no       | Alternative text of the key art; empty when absent.                                                                  |
|        | `trailer`     | no       | A video file (`.mp4` or `.webm`) in the project folder, or the `https` address of a YouTube or Vimeo video, see below. |
|        | `trailerPoster` | no     | A picture in the project folder, shown before a local trailer plays (the `poster` of the video). Ignored for an embedded trailer. |
|        | `features`    | no       | A list of short feature points.                                                                                      |

The generic `project.njk` shows the name, the pitch, the kind and the status, the text of `index.md`, the license and a link to the projects page. `tool` and `game` have templates of their own, described below. The kind-specific fields are read, validated and passed to the template as `project.fields`.

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
   | `font-name`   | a font family name, or a comma-separated list of them (letters, digits, spaces and `-`)                | the names, joined with `, `                             |
   | `image`       | the path of a picture (`.jpg`, `.png`, `.webp`, `.heic`) inside the project folder | the path relative to the project folder, with `/` |
   | `font-file`   | the path of a `.woff2`, `.woff`, `.ttf` or `.otf` file inside the project folder     | the path relative to the project folder, with `/` |
   | `trailer`     | a `.mp4` or `.webm` file inside the project folder, or an allowed video address                 | `{ type: 'file', file, mime }` or `{ type: 'embed', provider, url }` |
   | `directory`   | the path of an existing folder inside the project folder                                            | the path relative to the project folder, with `/`         |
   | `press-kit`   | a mapping with the keys of `pressKit` (see [The press kit](#the-press-kit))                         | the normalized press kit, or `null` when it is empty      |
   | `string-list` | a list of distinct non-empty texts                                                                  | the list (`[]` when absent)                               |
   | `url-map`     | a mapping of lower-case names to `http(s)` addresses; empty values are dropped                      | the mapping of the names that are set (`{}` when absent)  |
   | `mapping`     | any mapping                                                                                         | the mapping as written                                    |

   The build publishes what a kind's `image`, `font-file` and `trailer` fields name and passes the result to the template as `project.media`, by field name, so a kind needs no build code for them (see [The page of a game](#the-page-of-a-game)).

   An absent optional field is `null`, `[]` or `{}`, according to the type, so a template never has to test whether a key exists. `FIELD_TYPES` in `src/content/project-kinds.js` holds the checks; a new type is one entry there.

A site that only needs another look for `tool` or `game` does not need a new kind: put `project.njk` in the theme and override the blocks (see [Themes and UI strings](themes.md)).

## The page of a tool

`project-tool.njk` makes the page of a `tool` read like a polished README, in the default theme's strict style:

1. **The heading**: kind and status, the name, the pitch.
2. **A facts box** ("Project details") with the links a reader looks for first:
   - **Source code**: the `repo` address, as a link with `rel="noopener"` (the field is checked to be an absolute `http` or `https` address, so a `javascript:` or `ftp:` address fails the build).
   - **Documentation**: a link to the project's guides, `/{projects}/{slug}/{docs}/` (`/made/kerfcalc/docs/` with the defaults), present only when `docs` is set in `project.yaml`. The segment comes from `urls.docs`. The documentation pages themselves are a separate feature, so a site that sets `docs` before they exist links to a page that is not built yet and `coffer check` reports the link as broken; the example tool sets no `docs` for that reason.
   - **License**: the `license` text, as plain text.
3. **The text of `index.md`**: what it is, why it exists, how it works, a quick start, screenshots or a demo. Write it with ordinary headings; pictures go through the image pipeline like in a post.
4. **Latest posts**: a slot for the devlog posts about the project (block `project_latest`), filled by the posts feature. It writes nothing while there are no posts.

Nothing renders empty. A fact that is not set has no row, a page whose `index.md` is empty has no text section, and the license is shown in the facts box only. A theme overrides `project-tool.njk`, or one of its blocks `project_facts`, `project_latest`, `project_footer`, like any other template.

## The page of a game

`project-game.njk` makes the page of a `game` a small promo page. From top to bottom:

1. **The hero**: the `logo`, the kind and status, the name, the pitch (the one-line hook) and the `keyArt`.
2. **Stores, or a call to follow**: a button for each of `stores.itch` ("Get it on itch.io") and `stores.steam` ("Wishlist on Steam") whose address is set, itch first; other store names are not shown. With none set, the page shows "Follow the devlog" instead: a button that links to the feed of the devlog. Until a project feed exists this is the feed of the project's `tag` when some post carries it, else the feed of the first blog; a site without a blog has no call to action. A store button never shows with an empty address, and the call to action never shows next to a store button.
3. **The trailer**, when `trailer` is set (see below).
4. **The text of `index.md`**, with the **screenshot gallery**: write the screenshots as a [carousel](carousels.md) in `index.md` (a `:::carousel[Screenshots]` block of Markdown images with alt text and optional captions). They go through the image pipeline like any image and open in the [image viewer](viewer.md), so the template has no gallery code of its own.
5. **Features**: the `features` list, when it has items.
6. **Game details**: the status, the platforms, the price and the license; a row is written only when its value is set (the status always is).
7. **The press kit**, when `pressKit` is set (see below), at the end of the page.

A game page has **no link to a source repository**: the `game` kind has no `repo` field (a `repo:` key fails the build as an unknown key), and the template shows none for a kind that has one. Nothing renders empty: a part without data is not written.

### The trailer

`trailer` is either a video file in the project folder or an embedded video.

- **A local file**, `.mp4` or `.webm`, is copied to the output unchanged as `/{projects}/{slug}/trailer.mp4` (or `.webm`; the name does not depend on the file name) and shown in a `<video controls muted loop playsinline preload="metadata">` with the `trailerPoster` as its poster and a download link inside for browsers that cannot play it. **It never starts by itself**: nothing on the page moves or makes sound until the reader presses play, following the rule that nothing animates or pops up. That is why it needs no `prefers-reduced-motion` handling. `muted` and `loop` are there for a short silent gameplay clip. The video is published exactly as given, so the [metadata policy](location-policy.md), which covers pictures, does not touch it: strip location and camera tags from the file yourself.
- **An embedded video** is an `https` address from an allow-list: YouTube (`youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/embed/ID`, `youtube-nocookie.com/embed/ID`) and Vimeo (`vimeo.com/ID`, `player.vimeo.com/video/ID`). The page does not copy the address: it takes the checked video id and writes `https://www.youtube-nocookie.com/embed/ID` or `https://player.vimeo.com/video/ID?dnt=1` into a lazy, sandboxed `<iframe>` (`allow-scripts allow-same-origin allow-presentation`). Any other address, an `http` address, a playlist or a channel fails the build; for another host, use a file. An embed contacts the provider when the page is loaded, which a local file does not.

A file that does not exist, has another extension or lies outside the project folder fails the build with the path of `project.yaml`. A published file is listed in the manifest (see below), and `coffer check` resolves the video, its poster and the font like any other file the page refers to.

### Accent colour and display font

`accent`, `displayFont` and `displayFontFile` restyle **the body of the page only**: the page is wrapped in `<div class="game-page">` inside `<main>`, so the site header, navigation, theme switch and footer keep the site's look. They reach the page through three CSS custom properties in the `style` attribute of that wrapper, `--project-accent`, `--project-on-accent` (black or white, whichever reads better on the accent) and `--project-font` (the font stack, ending in the theme's heading font), which the rules of `.game-page` in `coffer.css` use. A font file adds one `@font-face` rule in a `<style>` element in the head.

The values are written into CSS, so they are checked twice: `project.yaml` accepts only `#rgb`/`#rrggbb` colours and plain family names, and `src/content/project-style.js`, which builds the CSS, checks them again and builds the text from nothing but the checked values. Family names are always in quotes (except generic ones such as `serif`), and the font's address is the one the build made, `/{projects}/{slug}/display-font-file.woff2` (the name comes from the field name and the extension, never from what was typed). The font file is published unchanged and declared with `font-display: swap`, so text shows at once. A font from the theme is not supported; put the file in the project folder.

## The press kit

A game with a `pressKit` in `project.yaml` ends with a press kit section for journalists and streamers: a factsheet, a short and a long description, and the game's logos and screenshots as thumbnails with a link to the **full-resolution file**. The section has the anchor `id="press-kit"`, so `/{projects}/{slug}/#press-kit` leads straight to it (and `[the press kit](project:tumble#press-kit)` in a post works). A game without a `pressKit`, or with an empty one, has no section.

```yaml
pressKit:
  dir: press-kit               # optional: the files below are relative to this folder
  developer: Sawdust Studio
  releaseStatus: Early access, summer 2027
  platforms: [Linux, Windows]  # optional: the game's own platforms are used when absent
  price: 9.99 EUR              # optional: the game's own price is used when absent
  shortDescription: A relaxed puzzle game about fitting wooden joints together.
  longDescription: |
    Markdown, with **emphasis**, lists and links.
  logos:
    - logo.png
    - { file: logo.svg, alt: The logo on a light background }
  screenshots:
    - { file: screenshot-01.jpg, alt: Four blocks in a row }
    - screenshot-02.png
```

Every key is optional. A list item is a file name, or `{ file, alt }` when the thumbnail needs alternative text (the caption and the download link name every asset anyway). Names are relative to the project folder, or to `dir` when it is given. The schema is checked when the project is read, and every problem is reported together, as `path-of-project.yaml: pressKit: logos: item 2: ...`:

- an unknown key, a wrong type, a file listed twice in a list, or more than 40 files in a list;
- a file that does not exist or has the wrong extension (logos: `.jpg`, `.png`, `.webp`, `.heic` or `.svg`; screenshots: the same without `.svg`);
- a `dir` or a file that leaves the project folder, by `../`, by an absolute path or by a symbolic link that points elsewhere;
- an SVG logo that could run script, see below.

### The factsheet

The factsheet lists, in this order, the **developer**, the **release status**, the **platforms** and the **price**. A fact that is not known is left out, never shown empty. The release status is `releaseStatus` or, when it is absent, the project's `status` as a word ("In development"). The platforms and the price are those of the press kit or, when it gives none, the `platforms` and `price` of the game, so the facts are written once.

### Descriptions

`shortDescription` and `longDescription` are Markdown, rendered by the same renderer as every page text, so raw HTML passes through as it does everywhere on the site, and other text is escaped. Links are checked as in a post (`../other/`, `project:slug`, `#press-kit`, which is the press kit section that shows the description); a broken link fails the build with the path of `project.yaml`, the line of the link in that file and the link. Pictures, carousels and `::map` do not belong in a description: a `::map` is left out, and a carousel or a local picture is reported, each as a warning with the line; an unknown directive fails the build like anywhere else. Headings in a description get anchors that can clash with the page's own, so use paragraphs and lists.

### Downloads

Each logo and screenshot is shown as a thumbnail (a responsive WebP, like every picture) next to a link such as "Download Screenshot 1 (JPEG, 1920 × 1080 px, 640 KB)". The link has the `download` attribute with a descriptive file name, and points to a file under the project's own URL:

```
/{projects}/{slug}/press-kit/{slug}-logo-01.png
/{projects}/{slug}/press-kit/{slug}-screenshot-03.jpg
```

The names are made from the slug, the kind of asset and its place in the list (`logo` or `screenshot`, two digits), never from what the author typed, so they are predictable, cannot collide with other published files and cannot hold a path. The extension comes from the file that is produced.

- **Raster pictures** (JPEG, PNG, WebP, HEIC) go through the [image pipeline](images.md) at **original resolution**: they are turned upright by their EXIF orientation and re-encoded, never reduced. Re-encoding is what makes the [metadata policy](location-policy.md) apply: the published file carries the position and the camera fields only as far as the policy of the project's page allows (by default none). A PNG stays a PNG, with its transparency; a WebP with transparency becomes a PNG; a JPEG stays a JPEG at quality 95 (4:4:4); a HEIC picture or an opaque WebP becomes a JPEG, because browsers do not open HEIC. Current limitation: a project page has no tags and no front matter, so only the **site-level** policy (`location.default` and `location.camera` in `coffer.yaml`) applies to press-kit files; the per-tag, per-post and per-image overrides described in [Location policy](location-policy.md) do not reach them.
- **SVG logos** are copied unchanged, so the file the press downloads is the file you wrote. An SVG opened directly is a document that can run script, so the build refuses one that contains a `<script>` or `<foreignObject>` element (or `<iframe>`, `<embed>`, `<object>`; the name may have a namespace prefix and any letter case, as in `<a:Script>`), an event handler attribute inside a tag (`onload=`, `onclick=`, and so on; text such as `one = two` is fine), a `javascript:`, `vbscript:` or `data:text/html` address (also when it is spelled with character references, which may have any number of digits, as in `&#x000006A;avascript:`, or with tabs or line breaks), a `data:` address in the `href` of anything but an `<image>`, a `<set>` or `<animate>` that animates an `href` or an event handler (`attributeName="onclick"`), a control character other than tab, line feed and carriage return (NUL, ESC, SO and SI among them, and the other characters that XML forbids: U+FFFE, U+FFFF and unpaired surrogates), an XML declaration with an `encoding` other than UTF-8 (`UTF-8`, `utf-8` and `utf8` are fine, and so is no declaration) or an `xml` declaration anywhere but the very start, a stylesheet loaded from elsewhere (`@import` or `<?xml-stylesheet?>`), an entity declaration, a first element other than `<svg>`, or a size above 2 MB. Markup that is not well-formed XML is refused too, since a browser would not draw it: a comment, CDATA section, processing instruction, DOCTYPE, tag or quoted attribute value that is never closed, `--` inside a comment, `]]>` in text, or a `<` that does not start a tag (write `&lt;`). Character references must be valid XML in text and attribute values: `&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`, or `&#...;` / `&#x...;` (lower-case `x`, any number of digits, closing `;`) for a character that XML allows. HTML names such as `&colon;` or `&nbsp;`, a reference without the `;`, `&#X6A;` with an upper-case `X`, and a reference to U+0000, to a character above U+10FFFF or to a forbidden character are refused (a browser would not draw the file), and so is a bare `&` (write `&amp;`). The tags and their attributes are read in one pass over the file that skips comments, CDATA sections and processing instructions, so a handler cannot hide behind a fake tag in one of them; the checks for `<script>`, `<foreignObject>`, `javascript:` and `data:text/html` look at the whole file, comments and CDATA included, so even a harmless `<script>` mentioned in a comment is refused. The last two rules exist because the check reads the file as UTF-8, while a browser honours the encoding that the XML declaration names: in `iso-2022-jp` the escape sequence ESC `(` `B` vanishes without a trace, so `-` ESC `(B` `->` ends a comment for the browser but not for the check, and `on` ESC `(B` `click` is a handler. Without control characters and with only UTF-8 allowed, both read the same text. The check reads the text and errs on the side of refusing, and it takes time proportional to the size of the file, whatever is in it. It does not follow CSS escapes (`@\69 mport`) in a stylesheet, which can only load more CSS; links to other files are not touched. `coffer check` runs the same check on the published file.

The thumbnails are pictures of the page like its card and key art, listed in the manifest under `images` with `use: "press-kit"`. The downloads are listed under the project's `downloads` (see below), and `coffer check` reads every one back: against its policy (position and camera), its size (the original's, never smaller) and, for an SVG, its hash and safety.

## Templates


| Template               | Used for                                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `project-index.njk`    | the projects page; block `heading`                                   |
| `project.njk`          | a project's page; blocks `project_header`, `project_body`, `project_footer` |
| `project-tool.njk`     | the page of a `tool`; extends `project.njk`; blocks `project_facts`, `project_latest` |
| `project-game.njk`     | the page of a `game`; extends `project.njk`; blocks `page_meta` (adds the font), `main` (the `.game-page` wrapper), `game_actions`, `game_trailer`, `game_features`, `game_details`, `game_press_kit` |
| `partials/press-kit.njk` | the press kit section, included by `project-game.njk`; a theme can replace the file or the `game_press_kit` block |
| `project-card.njk`     | one card, included by the projects page and the home page showcase   |
| `project-picture.njk`  | the macro `card(picture, sizes, eager)` that writes a project picture's `<picture>`; `eager` loads it at once |
| `home.njk`             | the `showcase` block lists the featured projects (see [The home page](home.md)) |

A project, as templates see it (`project` on a project's page, one element of `projects` or `showcase` elsewhere): `slug`, `url`, `name`, `pitch`, `kind`, `kindLabel`, `status`, `statusLabel`, `featured`, `order`, `license`, `tag`, `fields`, `docsUrl` (the address of the project's guides when `docs` is configured, otherwise null), `media` (what the kind's `image`, `trailer` and `font-file` fields publish, by field name: a picture like `picture` with `type: 'image'`, `{ type: 'video', url, mime }`, `{ type: 'embed', provider, url }` or `{ type: 'font', url, format }`; a field that is not set has no entry), `style` (`{ declarations, fontFace }` for a project with an accent or a font, otherwise null), `devlogUrl` (the feed that the call to follow links to, or null), `pressKit` (null, or `{ developer, releaseStatus, platforms, price, shortDescription, longDescription, logos, screenshots }`: the facts that are known, the two descriptions as HTML, and the assets as `{ number, alt, thumbnail, url, fileName, format, width, height, size }`) and `picture` (`src`, `width`, `height`, `srcset` as a list of `{ url, width }`, `alt`; null when the picture could not be made, which also fails the build). The card is included with `level` set to the heading level of the name: 2 on the projects page, 3 in the showcase.

The UI strings are `home.projects`, `projects.title`, `projects.empty`, `projects.all`, `projects.license`, `projects.facts.*` (`title`, `repo`, `docs`, `docs_link`, `license`), `projects.game.*` (`get`, `itch`, `steam`, `follow`, `follow_text`, `trailer`, `trailer_label`, `trailer_download`, `features`, `details`, `status`, `platforms`, `price`), `projects.press.*` (`title`, `facts`, `developer`, `release_status`, `platforms`, `price`, `short_description`, `long_description`, `logos`, `screenshots`, `logo_n`, `screenshot_n`, `download`, `download_sized`, `size_kb`, `size_mb`), `projects.kind.*` and `projects.status.*`. The navigation gets a "Projects" entry (`nav.projects`) between Home and the blogs.

## In the manifest

`.coffer-manifest.json` lists the projects in showcase order under `projects` (`slug`, `url`, `file`, `source`, `name`, `pitch`, `kind`, `status`, `featured`, `order`, `tag`, `card`, `files`, `downloads`). `files` lists the files that are copied unchanged for the project (a local trailer, a font file) as `{ field, source, url, file }`; it is empty for most projects. `downloads` lists the logos and screenshots of the press kit as `{ field, source, sha256, url, file, fileName, type, width, height, bytes, policy, gps, camera }`: the policy each was published under (null for an SVG, which is published as it is), the position and camera fields it carries, and its size in pixels. Their pages are listed under `pages` and in `sitemap`. Their card pictures are among `images` with `use: "card"` and the project's URL as `post`, so the [checks](checks.md) verify their metadata like any other image.

## Not yet

Feeds of a project, the posts that carry its tag and the documentation pages are separate features; the `tag` field and the kind fields are read and validated now so that a project declaration is complete from the start.
