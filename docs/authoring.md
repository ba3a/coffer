# Authoring: the live preview and new posts

Two commands cover the daily work of writing: `coffer dev` shows the sites while you edit, and `coffer new` creates the skeleton of a post.

## The live preview: `coffer dev`

```
coffer dev [--config <path>] [--port <number>] [--host <address>]
```

`coffer dev` builds every site in [preview mode](posts.md#which-posts-are-published) into `.cache/dev/{siteId}` (beside the configuration file), serves each site on its own port and rebuilds when something changes. It prints one line per site when it starts:

```
workshop: http://localhost:4000/ (drafts and scheduled posts included)
```

- **Ports.** The first site listens on `--port` (default 4000), the next site on the following port, and so on. `--port 0` lets the system choose every port. `--host` sets the address (default `localhost`). If a port is taken the command stops with the reason and leaves nothing running.
- **Serving.** Each site is served the way [`coffer serve`](urls.md#checking-the-rules-locally-coffer-serve) serves it: the same redirects to the address with a slash, the same `_redirects` rules, the same 404 page. Answers are sent with `Cache-Control: no-store`.
- **Drafts and scheduled posts** are built and listed like published posts, and each one carries a visible banner: **Draft** for a post with `draft: true`, **Scheduled for {date}** for a post dated in the future. The banner is the partial `partials/banner.njk` (class `preview-note preview-banner`), shown wherever a post is shown: on the post, in the blog index and on the home page. A normal `coffer build` leaves such posts out; `coffer build --drafts` builds them with the same banners.
- **Live reload.** An open page listens to a Server-Sent Events stream at `/__coffer/events` and reloads itself when a build finishes. The small script that does this, `/__coffer/reload.js`, is added to HTML pages by the dev server only; it is not part of any build.
- **What is watched:** the content directories, blog and project directories, the themes of the sites, the configuration file and the engine's own theme and strings. Changes that arrive together (an editor writing several files) start one rebuild. The configuration is read again on every rebuild, so a new blog, a new theme path or a new title applies without a restart; adding or removing a *site* does need a restart, and the terminal says so. Documentation sources that live outside the content directories are not watched; save a file in the content directory, or restart, to pick them up.
- **Speed.** The resized images and the title cards are cached in `.cache/images` and `.cache/cards`, so a rebuild only repeats the work for what changed in the pages themselves.
- **Build errors never stop the watcher.** A broken front matter, a missing image, an invalid configuration or any other problem is printed to the terminal, and every page of every site answers with an error page (status 500) that lists the same problems. The page reloads by itself when the next build succeeds. While a build runs, pages answer 503 with a short "Building" page that does the same.

Stop the preview with Ctrl+C. Everything in `.cache/` is disposable and ignored by git.

## New posts: `coffer new`

```
coffer new <blog> "Title" [--date <date>] [--tags <a,b/c>] [--slug <slug>] [--config <path>]
```

`<blog>` is the id of a blog in the configuration; write `site/blog` when two sites have a blog with the same id. The command creates `{blogDir}/{slug}/index.md`:

```
---
title: Шкатулка из ореха
date: 2026-06-01 14:30
tags: []
draft: true
---
```

- The **slug** is made from the title: lowercase, letters and digits separated by single hyphens, accents removed and Cyrillic letters transliterated (`Шкатулка из ореха` becomes `shkatulka-iz-orekha`; `ё` is `e`, `х` is `kh`, `щ` is `shch`, `ъ` and `ь` disappear). A title without Latin or Cyrillic letters needs `--slug`.
- The **date** is now, written on the clocks of the site's time zone without an offset, which is how a post date is read. `--date` takes a date (`2026-07-01`) or a date and time (`2026-07-01T09:00`) instead.
- **Tags** are empty, or the comma separated `--tags` (`--tags "tools/coffer, release"`), normalized like tags in front matter.
- Every new post is a **draft**. Remove `draft: true` to publish it; give it a future date to schedule it.
- A post that already exists, as a folder or as `{slug}.md`, is never overwritten: the command says so, writes nothing and exits 1. Problems with the title, date, tags or slug are listed together.

The file is read back with the same rules as a build before it is written, so a title that would produce invalid front matter is reported instead of saved.

### A template for the text

A blog may name a Markdown file in its [configuration](configuration.md#blogs) with `newPostTemplate`. Its content becomes the text below the front matter of every new post of that blog. The placeholders `{{title}}`, `{{date}}` and `{{slug}}` are replaced.

```yaml
blogs:
  - { id: devlog, dir: content/devlog, newPostTemplate: templates/new-post.md }
```

```markdown
Why this post exists, in one paragraph.

## What I did

## What I learned
```

A template that does not exist is an error, and nothing is written.
