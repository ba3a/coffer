# Markdown

The body of a post is Markdown: CommonMark plus GitHub-flavoured extensions. `renderMarkdown(source, options)` turns it into HTML at build time; nothing in the result needs JavaScript in the browser.

```js
import { renderMarkdown } from 'coffer';

const { html, toc, readingMinutes, firstImage, links } = await renderMarkdown(post.body, {
  file: post.file,
  startLine: post.bodyLine,
});
```

`source` is the text after the front matter (see [Posts](posts.md)). Passing `file` and `startLine` makes errors and found links point at the right line of the real file.

## What is supported

- Headings, paragraphs, emphasis, lists, links, images and inline code.
- **Images** become responsive figures when `renderMarkdown` is given an `images` option (`coffer build` always gives one; see [Images](images.md)): `![alt](photo.jpg "caption")`.
- **Carousels**, a row of images that scrolls sideways, written as a `:::carousel` block (see [Carousels](carousels.md)).
- **Tables**, task lists, strikethrough and bare-URL links (GitHub-flavoured Markdown).
- **Quotes**, written with `>`.
- **Code blocks**, highlighted at build time.
- **Raw HTML**, passed through unchanged, which is how embeds are written.

### Quotes

A quote is a block starting with `>`. A quote can hold several paragraphs, lists and code; every line of it starts with `>`.

```markdown
> The best camera is the one you have with you.
>
> — Someone who carried it up the hill
```

This renders as a `<blockquote>` holding two paragraphs. Style `blockquote` in the theme.

### Tables

```markdown
| Day | Distance |
| --- | -------: |
| Mon |     12 km |
| Tue |      9 km |
```

A colon in the separator row sets the alignment of a column.

### Headings and their ids

Every heading gets a stable `id` made from its text, so `## Getting started` becomes `<h2 id="getting-started">`. Letters of any script are kept, so `## Привет, мир` gets the id `привет-мир`. A second heading with the same text gets `-1`, then `-2`, and so on, in document order.

The id depends only on the heading text and on the headings before it with the same text. Rewording a heading changes its id, so links to it from elsewhere need updating.

Use `##` and `###` inside a post; the post title is the `<h1>`.

### Code

Fenced blocks are highlighted by [Shiki](https://shiki.style) while the site is built:

````markdown
```js
const answer = 42;
```
````

The language is the word after the opening fence; anything Shiki knows works, including its aliases (`js`, `ts`, `sh`, `py`, `yaml`, `json`, `html`, `css` and many more). A block without a language, or with one Shiki does not know, is shown as plain text.

Code uses two colour themes at once, `github-light` and `github-dark`. Each token carries both colours as CSS variables, and the block carries both background colours:

```html
<pre class="shiki shiki-themes github-light github-dark" style="--shiki-light-bg:#fff;--shiki-dark-bg:#24292e" tabindex="0"><code><span class="line"><span style="--shiki-light:#D73A49;--shiki-dark:#F97583">const</span> ...
```

The stylesheet chooses which one applies. The default theme follows the system setting with a media query and the reader's choice with a `data-theme` attribute on `<html>` (see [Themes](themes.md#the-theme-switch)). In its simplest form the rules are:

```css
.shiki,
.shiki span {
  color: var(--shiki-light);
  background-color: var(--shiki-light-bg);
}

@media (prefers-color-scheme: dark) {
  .shiki,
  .shiki span {
    color: var(--shiki-dark);
    background-color: var(--shiki-dark-bg);
  }
}
```

Inline code (`` `like this` ``) is not highlighted.

### Video and other embeds

Raw HTML is allowed and is written to the page as it appears. Embed a hosted video with an `<iframe>`. Put it inside a `<div>` that starts and ends on its own lines, with no blank line in between; otherwise Markdown wraps the iframe in a paragraph:

```html
<div class="embed">
<iframe src="https://www.youtube-nocookie.com/embed/VIDEO_ID" title="What the video shows" loading="lazy" allowfullscreen></iframe>
</div>
```

Always give the iframe a `title`. A video file that sits next to the post works the same way:

```html
<div class="embed">
<video src="walk.mp4" controls preload="none"></video>
</div>
```

HTML comments are the exception: `<!-- a note to myself -->` stays in the source and is left out of the page, so it can mark text that still needs work without being published. A comment runs from `<!--` to the next `-->`, and `<!-->` and `<!--->` are complete, empty comments, as in HTML. A comment inside a `<script>` or `<style>` block is kept. A `<!--` that is never closed is kept as it is, together with the text after it, so a mistyped note cannot delete content; close it with `-->`.

The engine does not otherwise rewrite, check or sandbox raw HTML, and does not read links or images inside it, so they are not part of `links` or `firstImage`. Prefer Markdown syntax for images and links.

### Directives

The syntax `::name`, `:::name` and `:name` is reserved for features of coffer. The directives are the container `:::carousel` (see [Carousels](carousels.md)), the leaf `::map` (see [Maps and GPX tracks](maps.md#where-the-map-goes)) and, on the page of a project with a docs source, the leaf `::readme` (see [README sections on the project page](project-docs.md#readme-sections-on-the-project-page)). Any other name is an error that names the file and the line:

```
blog/hike/index.md:42:1: unknown directive "gallery" (a colon followed by a letter starts a directive; write \: for a plain colon)
```

A colon followed by a letter, as in `:smile:`, is read as a directive. Escape it as `\:` to get a plain colon. Times such as `10:30`, URLs, a colon followed by a space and a colon directly after a letter or a digit (`note:this`) are ordinary text.

## Table of contents

Headings of level 2 and 3 form the table of contents. It is returned separately from the HTML as a flat list, so the theme decides where and how to show it:

```js
[
  { id: 'getting-started', text: 'Getting started', depth: 2 },
  { id: 'install', text: 'Install', depth: 3 },
]
```

A post gets a table of contents only when it has at least `tocMinHeadings` such headings (default 4). For a shorter post `toc` is an empty list. `text` is plain text, with emphasis and code markup removed. Headings in code blocks are not headings.

## Reading time

`readingMinutes` is the number of words divided by `wordsPerMinute` (default 200), rounded up, and never less than 1. The word count, also returned as `words`, follows Unicode word boundaries, so it works the same for English, Russian and any other language written with spaces, and splits Chinese and Japanese text into words by dictionary. Numbers count as words, punctuation does not. Code blocks are left out, because they are not read at prose speed.

## Result

| Field            | Description                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `html`           | The rendered body.                                                                            |
| `toc`            | Table of contents entries `{ id, text, depth }`, or `[]` for a short post.                    |
| `words`          | Number of words in the text.                                                                  |
| `readingMinutes` | Estimated reading time in minutes, at least 1.                                                |
| `firstImage`     | `{ src, alt }` of the first Markdown image, or `null`. `src` is as written, not yet resolved. |
| `links`          | Every Markdown link and image as `{ url, kind: 'link' \| 'image', line, column }`; `coffer build` checks them (see [Links](links.md)). |
| `ids`            | Every id a link can point at: heading ids, ids of other elements and `id`/`name` attributes in raw HTML. |
| `images`         | Every Markdown image as `{ src, alt, caption, carousel }`, carousel slides included, in document order: the list the image viewer walks through. `src` is as written. |
| `carousels`      | Number of carousels in the text. A page with any loads the carousel script.                    |
| `viewerSources`  | The address of each image of `viewerImages` as written in the text, in the same order. |
| `maps`           | The `::map` directives of the text, in document order, as `{ index, tracks, photos, line, column }`, where `tracks` and `photos` are `{ mode: 'all' }`, `{ mode: 'none' }` or `{ mode: 'list', names }`. Each one is an empty `<div data-coffer-map="index"></div>` in `html` for the caller to replace with a map; `coffer build` does. |
| `readmes`        | The `::readme` directives of the text, in document order, as `{ index, file, section, line, column }`. Each one is an empty `<div data-coffer-readme="index"></div>` in `html` for the caller to replace; `coffer build` does for a project page. The directive is an error unless the option `readme` is set. |
| `viewerImages`   | The images the viewer opens, as `{ src, width, height, alt, caption, latitude?, longitude?, precision? }` in document order: every image with a full-size file that is not already inside a link. Each one is wrapped in a link to its full-size file with `data-viewer` set to its place in this list (see [The image viewer](viewer.md)). Empty without an image resolver. |

## Options

| Option           | Default                       | Description                                                          |
| ---------------- | ----------------------------- | -------------------------------------------------------------------- |
| `file`           | none                          | File name used in error messages.                                    |
| `startLine`      | `1`                           | Line of the file on which `source` starts, for error and link lines. |
| `tocMinHeadings` | `4`                           | Headings needed for a table of contents.                             |
| `wordsPerMinute` | `200`                         | Reading speed.                                                       |
| `codeThemes`     | `github-light`, `github-dark` | Shiki theme names, as `{ light, dark }`.                             |
| `carousel`       | English words                 | The words carousels need, as `{ label, previous, next }`: the name of a carousel without one and the names of its two buttons. `coffer build` takes them from the UI strings of the site. |
| `readme`         | `false`                       | Whether `::readme` directives are allowed. `coffer build` sets it for the page of a project with a docs source only. |

Invalid numbers are rejected with a `TypeError`.
