# Themes and UI strings

Pages are rendered with [Nunjucks](https://mozilla.github.io/nunjucks/) templates. coffer ships a default theme; a site's own theme only has to contain what it changes.

```js
import { createTemplates } from 'coffer';

const templates = createTemplates({
  lang: site.lang,
  theme: site.theme, // absolute path of the theme directory, or null
  baseUrl: site.baseUrl,
  timezone: site.timezone,
  onMissing: (message) => console.warn(message),
});

const html = templates.render('page.njk', { site, page: { title: 'Hello', content: '<p>Hi</p>' } });
```

`theme` is the `theme` of the site in [`coffer.yaml`](configuration.md).

## Theme layout

```
my-theme/
  templates/        templates that replace or extend the engine's
    base.njk
    post.njk
  i18n/             UI strings, one file per language
    en.yaml
    de.yaml
```

Both folders are optional.

## Search order

For a template name such as `page.njk`, coffer looks in this order and uses the first match:

1. `templates/` of the site's theme;
2. the engine's default theme (`theme/templates/` in coffer).

A template the theme does not have is therefore taken from the engine, so a theme can start with a single file.

A name with the prefix `coffer:` skips the theme and always means the engine's copy: `coffer:page.njk`. This is what lets a theme file extend the engine template it replaces.

Templates in the engine refer to each other by plain names (`{% extends "base.njk" %}`), so a theme `base.njk` also restyles every engine page that extends it.

## Overriding one block

`base.njk` defines these blocks:

| Block    | Contents                                                              |
| -------- | --------------------------------------------------------------------- |
| `head`   | `<meta>` tags, the theme script, the stylesheet, the stylesheets in the page's `styles` list (the viewer's, on pages with images) and `<title>`; add stylesheets and feed links here |
| `theme_script` | the inline script that applies the saved colour scheme (nested in `head`) |
| `feed_links` | the `<link rel="alternate">` elements that advertise feeds (nested in `head`) |
| `header` | the site title and the navigation (inside `<header>`)                 |
| `nav`    | the navigation list; nested in `header`, so it can be replaced alone  |
| `theme_switch` | the light/dark button; nested in `header`                       |
| `main`   | the page itself (inside `<main id="main">`)                           |
| `footer` | the content license and the credit line (inside `<footer>`)           |
| `scripts`| scripts at the end of `<body>`; by default one `<script defer>` for each address in the page's `scripts` list, which holds the carousel script on pages with a carousel (see [Carousels](carousels.md)) and the scripts of the image viewer on pages with images (see [The image viewer](viewer.md)); before them, a `<script type="application/json" id="coffer-viewer">` element with the list of images when the page's `viewerData` is not empty |

To change only the footer, create `templates/page.njk` in the theme:

```njk
{% extends "coffer:page.njk" %}

{% block footer %}
  <p>{{ site.contentLicense }}</p>
  <p>{{ 'footer.credit' | t }}</p>
{% endblock %}
```

Everything outside the `footer` block is rendered exactly as before. Use `{{ super() }}` inside a block to keep the engine's content and add to it:

```njk
{% block head %}
  {{ super() }}
  <link rel="stylesheet" href="{{ '/theme.css' | url }}">
{% endblock %}
```

To change a block on every page at once, override it in `templates/base.njk`:

```njk
{% extends "coffer:base.njk" %}

{% block footer %}...{% endblock %}
```

## Colours, fonts and the theme switch

The default stylesheet (`assets/coffer.css`) takes every colour, font and width from CSS custom properties, so a site theme can restyle the engine's pages by overriding variables only, with no change to the templates.

| Variable                 | Light default | Dark default | Used for                                       |
| ------------------------ | ------------- | ------------ | ---------------------------------------------- |
| `--coffer-bg`            | `#ffffff`     | `#16181d`    | page background                                |
| `--coffer-text`          | `#1b1b1f`     | `#e8e8ec`    | body text                                      |
| `--coffer-muted`         | `#5a5a63`     | `#a9a9b3`    | dates, footer, quotes                          |
| `--coffer-accent`        | `#0b5cad`     | `#7ab7ff`    | links and the focus ring                       |
| `--coffer-border`        | `#d3d3da`     | `#3a3e48`    | rules, table and code borders                  |
| `--coffer-code-bg`       | `#f3f3f6`     | `#20232a`    | background of code (unhighlighted)             |
| `--coffer-code-fg`       | `#1b1b1f`     | `#e8e8ec`    | text of code (unhighlighted)                   |
| `--coffer-font-body`     | system sans-serif stack | same | body text                                |
| `--coffer-font-heading`  | the body font | same         | headings and the site title                    |
| `--coffer-font-mono`     | system monospace stack | same | code                                     |
| `--coffer-measure`       | `68ch`        | same         | width of a line of text                        |

Light values are set on `:root`. Dark values are set twice, under `@media (prefers-color-scheme: dark)` (the reader's system setting) and under `:root[data-theme="dark"]` (the reader's choice with the switch). `:root[data-theme="light"]` sets the light values again, so a reader on a dark system can choose light. Pages follow the system setting without any JavaScript.

A site theme adds its own stylesheet after the engine's (see [Overriding one block](#overriding-one-block), `{{ super() }}` in `head`) and repeats the three places for the variables it changes:

```css
:root {
  --coffer-accent: #8a2be2;
  --coffer-font-heading: Georgia, serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --coffer-accent: #c9a0ff;
  }
}

:root[data-theme="dark"] {
  --coffer-accent: #c9a0ff;
}

:root[data-theme="light"] {
  --coffer-accent: #8a2be2;
}
```

Fonts and the measure are the same in both modes and need only the `:root` rule.

### The theme switch

With JavaScript, a button in the header cycles through "system", "light" and "dark". The choice is stored in `localStorage` under the key `coffer-theme` (nothing is stored for "system", and a browser that blocks storage simply forgets the choice). A small inline script at the top of `<head>` reads it and sets `data-theme` on `<html>` before the page is painted, so a reload does not flash the wrong theme. The same script adds the class `js` to `<html>`; the stylesheet shows the button only then, so without JavaScript there is no button and the page follows the system. The button's text comes from the UI strings `theme.button`, `theme.system`, `theme.light` and `theme.dark`.

Override the blocks `theme_script` and `theme_switch` to change the script or the button; a theme that replaces the whole `head` block without `{{ super() }}` also drops the script.

### Code

Highlighted code carries both colour schemes as the variables `--shiki-light`, `--shiki-dark`, `--shiki-light-bg` and `--shiki-dark-bg` (see [Markdown](markdown.md)). The default stylesheet picks the pair that matches the active colour scheme in the same three places as above, so code is readable in both modes.

### Motion, small screens and print

The default theme defines no animation or transition: state changes are instant. The layout is a single column that works from 360 px wide, with a table of contents beside the text on wide screens. Focus is shown with an outline in the accent colour. Printing always uses black on white, hides the navigation and the switch, and prints the address after external links.

## Title cards

Posts without a cover and the tag, series and blog index pages are shown in link previews with a generated card (see [SEO and link previews](seo.md#title-cards)). A theme can restyle the card with three optional things in its directory:

```
my-theme/
  theme.yaml        colours
  card.svg.njk      the SVG template of the card
  fonts/            .ttf or .otf files for the card
```

`theme.yaml` sets the accent colour of the theme and, optionally, the colours of the card. Colours are written as `#rgb` or `#rrggbb`; every key may be left out:

```yaml
accent: "#c9a0ff"
card:
  background: "#101014"
  text: "#ffffff"
  mutedText: "#b0b0c0"
```

`card.svg.njk` is a Nunjucks template that must produce an SVG of 1200 by 630 pixels (any other size fails the build). It receives `width`, `height`, `padding`, the colours `background`, `foreground`, `muted` and `accent`, `fontFamily`, `siteTitle`, `siteTitleSize`, `siteTitleY`, `titleSize` and `titleLines`, a list of `{ text, y }` with the wrapped title and the baseline of each line. Values are escaped. The engine's `theme/card.svg.njk` is a working example.

Font files in `fonts/` replace the bundled font; the template should use `fontFamily`, which is the family name read from the font that is closest to bold. The renderer reads only these files, never the fonts installed on the machine. WOFF and WOFF2 files are not supported, and a font should have the Latin and Cyrillic letters the site needs.

## Templates of the blog

| Template         | Page                | Blocks besides the ones of `base.njk`                                   |
| ---------------- | ------------------- | ----------------------------------------------------------------------- |
| `post.njk`       | a post              | `meta` (date and reading time), `tags`, `series_top`, `toc`, `body`, `series_bottom` |
| `blog-index.njk` | the list of posts   | `heading` (title and link to the tags), `feed_link` (the visible link to the page's feed), `item` (one entry of the list) |
| `tag.njk`        | a tag page          | extends `blog-index.njk`; `heading`, `breadcrumbs`, `children`          |
| `tag-index.njk`  | the tag tree        | `tree`                                                                  |
| `series.njk`     | a series page       | extends `blog-index.njk`; `heading`, `breadcrumbs`, `item` (see [Series](series.md)) |
| `series-nav.njk` | macro used by `post.njk` | `seriesNav(series, where)`, called by the `series_top` and `series_bottom` blocks of `post.njk` |
| `map.njk`        | partial for a map of a post | rendered by the build once per map and put into the text of the post (see [Maps and GPX tracks](maps.md#the-map)); receives `map` (`svg`, `data`, `tracks`) |
| `home.njk`       | the home page       | `about`, `links`, `showcase`, `latest`, `secondary` (see [Home](home.md)) |
| `404.njk`        | `404.html`          | `head` is extended with a `noindex` tag                                 |

`post.njk` receives `post` (`slug`, `url`, `title`, `date`, `tags`, `tagLinks` (the tags as `{ path, name, url }`), `summary`, `draft`, `unpublished`, `readingMinutes`, `series`), `series` (the same object as `post.series`: `slug`, `name`, `url`, `number`, `count`, `previous` and `next` as `{ title, url }`; null when the post is in no series), `toc` (a list of `{ id, text, depth }`, empty for short posts), `blog` and `page.content` (the rendered body). `blog-index.njk` receives `posts`, a list of the same `post` objects, newest first, `tagsUrl`, the address of the tag tree, and `pageFeed` (`url`, `title`), the feed that belongs to the page (the blog's, the tag's or the series'). Every page template receives `feedLinks`, a list of `{ url, title }`, which `base.njk` turns into `<link rel="alternate" type="application/atom+xml">` elements in the `feed_links` block of the head; see [Feeds](feeds.md). `tag.njk` receives the same, plus `tag` (`path`, `name`, `description`, `url`, `count`), `ancestors` (`{ path, name, url }`, top down) and `children` (`{ path, name, description, url, count }`); `tag-index.njk` receives `tree`, the nested list of the same tag objects with their `children`. See [Tags](tags.md). Static files of a theme go in its `assets/` folder and are copied to `assets/` of the output (see [Building a site](build.md)).

To change only the line with the date and reading time of a post:

```njk
{% extends "coffer:post.njk" %}

{% block meta %}<p>{{ post.date | date('long') }}</p>{% endblock %}
```

## Variables

The engine's pages receive `site` (title, content license, links, ...), `page` (title, description, content, ...) and, for the navigation, `nav`, a list of `{ label, url }` or `{ key, url }` items (`key` is a UI string key). Without `nav`, the navigation holds a link to the home page. `lang` and `basePath` are available in every template.

Values are escaped. Mark HTML you trust with `| safe`.

## Filters

- `t` returns a UI string: `{{ 'nav.home' | t }}`. Parameters are passed as an object: `{{ 'post.series_part' | t({ n: 2, m: 5 }) }}` gives "Part 2 of 5".
- `date` formats a date or a moment in the site's language and time zone: `{{ post.date | date }}`. The format is `short`, `medium` (default), `long`, `full`, `iso` (`2024-05-01`, for `datetime` attributes) or an object of [`Intl.DateTimeFormat`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat) options: `{{ d | date({ month: 'long', year: 'numeric' }) }}`. A date without a time (`2024-05-01`) is never shifted by the time zone.
- `url` turns a site path into a link that works on the published site: it adds the path of the site's `baseUrl` (for a site served below `/docs`) and a trailing slash, keeps any query and fragment, and leaves files (`/feed.xml`), absolute URLs (`https:`, `mailto:`), `#fragments` and relative paths alone. `{{ '/devlog' | url }}` gives `/devlog/`.

## UI strings

Words in the templates (navigation labels, "Part 2 of 5", reading time, feed titles, the 404 text) come from YAML files named after the language, for example `i18n/en.yaml` and `i18n/ru.yaml` in the engine. The language is the `lang` of the site. A regional tag such as `pt-BR` reads `pt.yaml` and then `pt-BR.yaml`.

```yaml
nav:
  home: Home
post:
  series_part: "Part {n} of {m}"
  reading_time:
    one: "{count} minute"
    other: "{count} minutes"
```

- Keys are nested: the first group above is the key `nav.home`.
- `{name}` in a string is replaced by the parameter of that name.
- A string with plural forms is a mapping of plural categories (`zero`, `one`, `two`, `few`, `many`, `other`) and needs a `count` parameter: `{{ 'post.reading_time' | t({ count: post.readingMinutes }) }}`. The category comes from [`Intl.PluralRules`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/PluralRules) for the site's language, so Russian has `one` (1, 21), `few` (2, 22), `many` (5, 11) and `other` (fractions).

A theme overrides strings with its own `i18n/{lang}.yaml`. It lists only the keys it changes; the rest keep the engine's text.

### Missing strings

A key that has no string in the site's language is taken from English and reported once, for example `ru: missing string "nav.search"; using English`. A key that does not exist even in English is shown as the key itself and reported too. Pass `onMissing` to `createTemplates`, or read `templates.missingStrings()` after rendering, to collect the messages for the build report.

## Adding a language

1. Copy the engine's `i18n/en.yaml` into the theme as `i18n/{lang}.yaml`, for example `i18n/de.yaml`.
2. Translate the values; keep the keys. For strings with plural forms, give the forms the language needs (see the CLDR plural rules); `other` is the form used when no other applies.
3. Set `lang: de` for the site in `coffer.yaml`.

Strings you leave out fall back to English and show up in the missing-strings report, so a translation can grow one string at a time. To add a language to the engine itself, put the same file in the engine's `i18n/` folder.
