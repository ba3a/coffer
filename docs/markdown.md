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

Raw HTML is allowed and is written to the page exactly as it appears. Embed a hosted video with an `<iframe>`. Put it inside a `<div>` that starts and ends on its own lines, with no blank line in between; otherwise Markdown wraps the iframe in a paragraph:

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

The engine does not rewrite, check or sandbox raw HTML, and does not read links or images inside it, so they are not part of `links` or `firstImage`. Prefer Markdown syntax for images and links.

### Directives (reserved)

The syntax `::name`, `:::name` and `:name` is reserved for features that are added later, such as carousels and maps. No directive exists yet, so using one is an error that names the file and the line:

```
blog/hike/index.md:42:1: unknown directive "carousel" (a colon followed by a letter starts a directive; write \: for a plain colon)
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

## Options

| Option           | Default                       | Description                                                          |
| ---------------- | ----------------------------- | -------------------------------------------------------------------- |
| `file`           | none                          | File name used in error messages.                                    |
| `startLine`      | `1`                           | Line of the file on which `source` starts, for error and link lines. |
| `tocMinHeadings` | `4`                           | Headings needed for a table of contents.                             |
| `wordsPerMinute` | `200`                         | Reading speed.                                                       |
| `codeThemes`     | `github-light`, `github-dark` | Shiki theme names, as `{ light, dark }`.                             |

Invalid numbers are rejected with a `TypeError`.
