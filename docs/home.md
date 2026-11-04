# The home page, the 404 page and the footer

## The home page

The home page of a site is its content, not its code. It is built from two sources:

- `{contentDir}/home.md`, which holds the title, the about text and the optional settings;
- the site's `links` in [`coffer.yaml`](configuration.md), which hold the main links (LinkedIn, GitHub, an e-mail address as `mailto:`, ...).

The page is written to `index.html` at the root of the site and is listed in the build manifest with the type `home`.

### `home.md`

```md
---
title: Tove Marlowe
latestPosts: 3
secondaryLinks:
  - { label: "Sketchbook", url: "https://sketchbook.example/tove" }
---

I am Tove, a woodworker in a small shed behind a bakery. I make boxes,
stools and the occasional crooked spoon.
```

| Key              | Required | Default | Description                                                                                                                       |
| ---------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `title`          | yes      | -       | The heading of the page and its `<title>`.                                                                                        |
| `latestPosts`    | no       | `5`     | How many of the newest posts of the site's first blog to list, from 0 to 50. With `0` the list is left out.                      |
| `secondaryLinks` | no       | `[]`    | Links shown after everything else in a smaller size, for things that matter less than the main links, for example another site. |

Each secondary link has a `label` and a `url`, written like the entries of `links`: an `http(s)` or `mailto:` URL, or a path starting with `/`. Quote a label that contains a comma or a colon.

Everything after the front matter is the about text. It is ordinary [Markdown](markdown.md), with the same rendering as a post.

A site without `home.md` still gets a home page. Its heading is the site's title and it has no about text. A problem in the file (a missing title, a `latestPosts` that is not a whole number, a link with an unsupported URL) fails the build with the file name and the field.

### What the page shows

1. The title and the about text.
2. The site's `links`, as a navigation block.
3. The **showcase**: a card for each featured project, in the order the projects declare, each with its picture, kind, status, name and pitch, and a link to the projects page. It is left out when the site has no featured project. Which projects are featured, and in what order, is set in their `project.yaml` (see [Projects](projects.md)).
4. The latest posts of the **first blog** in the site's `blogs` list, newest first, each with its date and summary, and a link to the whole blog. A draft or a future-dated post appears only in a preview build (`--drafts`) and is marked there.
5. The secondary links.

### A blog at the root of the site

A blog whose `prefix` is empty has its index at `/`, which is the address of the home page. The blog index wins: the home page is not written, and the build reports a warning that names `home.md`.

### Templates

`home.njk` extends `base.njk`. Its blocks, besides those of `base.njk`:

| Block      | Contents                                 |
| ---------- | ---------------------------------------- |
| `about`    | the about text                           |
| `links`    | the site's `links`                       |
| `showcase` | the cards of the featured projects       |
| `latest`   | the list of latest posts                 |
| `secondary`| the secondary links                      |

It receives `page` (`title`, `description`, `content` = the rendered about text), `site`, `nav`, `blog` and `blogUrl` (the first blog and its URL; absent for a site without blogs), `posts` (the latest posts, the same objects as in `blog-index.njk`), `secondaryLinks`, `showcase` (the featured projects, in order; see [Projects](projects.md) for what a project holds) and `projectsUrl` (the address of the projects page; null for a site without projects).

To show the showcase your own way, create `templates/home.njk` in the theme:

```njk
{% extends "coffer:home.njk" %}

{% block showcase %}
  <section class="showcase">
    {% for project in showcase %}<a href="{{ project.url | url }}">{{ project.name }}</a>{% endfor %}
  </section>
{% endblock %}
```

The UI strings of the page are `home.links`, `home.projects`, `home.latest`, `home.all_posts` and `home.more` (see [Themes and UI strings](themes.md)).

## The 404 page

Every site gets `404.html` at the root of its output, rendered by `404.njk`. It uses the site's theme and language: the heading and the text come from the `not_found.*` UI strings, and the page offers a link back to the home page. It carries `<meta name="robots" content="noindex">`. It is listed in the manifest with the type `not-found` and the URL `/404.html`.

Static hosts such as Cloudflare Pages and Netlify serve a `404.html` at the root of the site for every address that does not exist, with the status 404. Replace `404.njk` in the theme to change the page; keep `{% extends "base.njk" %}` for the same header and footer.

## The footer

The footer of every page shows the content license of the site, from `contentLicense` in [`coffer.yaml`](configuration.md), as "Content: CC BY 4.0" (the wording is the `footer.license` UI string). A site without `contentLicense` shows no license line. The engine's own license does not cover a site's content, which is why the text comes from the configuration. A theme can restyle or reword the line by overriding the `footer` block of `base.njk`.
