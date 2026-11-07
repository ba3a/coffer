# Share summary

A post is often shared by hand: copied into a post on LinkedIn, a message or a newsletter. The share summary makes that easy. It is a short plain text with the title, the summary and the address of the post, written to a file next to the post and shown, collapsed, at the end of the post, so that it can be copied with one click.

It is off by default and is switched on for a blog.

## Switching it on

```yaml
sites:
  - id: workshop
    blogs:
      - id: journal
        dir: content/journal
        shareSummary: true
        shareHashtags: true   # optional
```

| Key             | Default | Description                                                                                                                       |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `shareSummary`  | `false` | Every post of the blog gets a `share.txt` and a "Share summary" block at its end.                                                |
| `shareHashtags` | `false` | The text ends with hashtags made from the tags of the post. Needs `shareSummary: true`; on its own it is a configuration error. |

With `shareSummary` off, or absent, nothing is rendered or written: no block, no file, no script on the page.

## The text

The text has up to four paragraphs, separated by one blank line:

```text
Dovetails by hand

Cutting the joint with a saw and a chisel, and what went wrong the first time.

https://tove-marlowe.example/journal/first-dovetail/

#Workshop #Boxes
```

1. The **title** of the post.
2. Its **summary**: the `summary` of the front matter, or when there is none, the first 240 characters of the text (the same words as the page description in [SEO and link previews](seo.md)). Left out when the post has no text at all.
3. The **canonical address** of the post on the site's `baseUrl`, always absolute.
4. With `shareHashtags: true`, the **hashtags**, on one line.

Line breaks and runs of white space inside the title and the summary become single spaces, so that they cannot add paragraphs. The file is UTF-8 without a byte order mark, with `\n` line ends and a final newline. It is plain text: nothing in it is HTML, and a `<` or `&` in a title stays as it is.

### Hashtags

A hashtag is made from the display name of a tag (the `name` from `tags.yaml`, else the last segment of the tag's path; see [Tags](tags.md)): the words are capitalized and joined, so `Hand tools` and `hand-tools` both become `#HandTools`. A word that already has a capital inside (`iOS`) is kept as it is. A tag with no letter in it (`2026`) gives no hashtag, because a hashtag of digits only is not one on most networks, and tags that give the same hashtag give it once. Hashtags follow the order of the tags in the front matter.

## The file

For a post at `/journal/first-dovetail/` the file is `/journal/first-dovetail/share.txt`, served as `text/plain; charset=utf-8`. It is an output of the build and not a page:

- it is listed in the build manifest, in the `share` field of the post (`{ "url": "/journal/first-dovetail/share.txt", "file": "journal/first-dovetail/share.txt" }`, or `null` when the blog has no share summary);
- it is **not in `sitemap.xml`**, in no feed and not in the search index (Pagefind indexes HTML only, and the block in the page is marked `data-pagefind-ignore` and sits outside the marked post body, see [Search](full-text-search.md));
- the name `share.txt` is reserved in the folder of a post of such a blog. A file called `share.txt` next to the Markdown file of a post (`content/journal/first-dovetail/share.txt`) fails the build with the post's path in the message. Rename it or switch the share summary off.

Posts built only because of preview mode (`--drafts`) get the file and the block too, so that they can be seen while writing.

## The block in the page

At the very end of the post, after the project blocks, comes

```html
<details class="share" data-pagefind-ignore>
  <summary>Share summary</summary>
  <p class="share-hint">…</p>
  <pre class="share-text">…the same text, HTML-escaped…</pre>
  <p class="share-actions">
    <button type="button" class="share-copy" hidden …>Copy</button>
    <a class="share-download" href="/journal/first-dovetail/share.txt" download>Download as text file</a>
    <span class="share-status" role="status"></span>
  </p>
</details>
```

It is **collapsed**: nothing opens it but the visitor. The text is in a `<pre>`, escaped like any other text of the page, so a title with markup shows as text and cannot add markup.

The block works without JavaScript: the text can be selected and copied by hand, and the link downloads the file. The **copy button** is progressive enhancement. It is in the page with the `hidden` attribute, and the theme's `assets/share.js` (loaded with `defer`, only on pages with a share block; there is no inline script) shows it. A click copies the text with the browser's clipboard API, or, where there is none, selects the text and asks the browser to copy it, and then writes "Copied" or an error to the status line next to the button. Nothing animates.

## Translating and styling

The words of the block are the UI strings `share.title`, `share.hint`, `share.copy`, `share.copied`, `share.failed` and `share.download` in the engine's `i18n/en.yaml` and `i18n/ru.yaml`; a theme overrides them in its own `i18n/` folder (see [Themes](themes.md)). `share.copied` and `share.failed` are handed to the script in the `data-copied` and `data-failed` attributes of the button.

The block is the partial `partials/share.njk`, included by the `share` block of `post.njk`, which a theme can replace without touching the rest of the post (an empty `{% block share %}{% endblock %}` removes it). The classes `share`, `share-hint`, `share-text`, `share-actions`, `share-copy`, `share-download` and `share-status` are styled by `coffer.css`. A theme that replaces `post.njk` as a whole and wants the block includes the partial where `share` is set; the template receives `share` (`text`, `url`, `file`), which is null for a blog without a share summary.
