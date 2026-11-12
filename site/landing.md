---
layout:
  visual:
    hero: pre
    problem: pre
    timeline: ul
    spec-example: pre
    quick-start: pre
  dogfood: plain
  when: span class="lp-when"
  brand: 0
  strings:
    terminal_title: "coffer — example site"
    hero_terminal: A terminal session that builds and checks the example site of coffer.
    problem_terminal: A shell script of the tools a photo journal usually needs besides its site generator.
    dogfood_terminal: The build-info.json that ba3a.dev serves, with the commit of every repository its documentation came from.
accent:
  light:
    accent: "#9a6b1f"
    accent-text: "#7c5516"
    accent-soft: "#f4e8cc"
  dark:
    accent: "#d9a84e"
    accent-text: "#d9a84e"
    accent-soft: "#2b2214"
---

<div class="section-marker" id="hero"></div>

###### For people who make things

# Write the post. Drop in the photos. Push.

coffer turns a folder of Markdown and photos into plain files that any static host can serve. No server, no database, no JavaScript needed to read a page. It is what builds this site.

[Get it on GitHub →](https://github.com/ba3a/coffer) [Try the example](#quick-start)

- In development, already running ba3a.dev
- Plain files for any static host
- Windows · Linux
- Apache-2.0 licensed

```console
$ npx coffer build --config example/coffer.yaml
workshop: 5 post(s), 26 page(s) -> …/dist/workshop
Posts publishing exact locations (2)
  content/journal/mountain-weekend.md: 1 image(s)
  content/journal/ridge-walk/index.md: 1 image(s), 1 track(s)

$ npx coffer check --config example/coffer.yaml
workshop: 28 page(s), 12 feed(s), 21 image(s) checked, no failures
```

<div class="section-marker" id="problem"></div>

###### The problem

## A photo journal grows a build script

A static generator renders your pages. Everything around them, you glue on yourself: stripping GPS, resizing photos, keeping originals out of git, finding broken links, adding search, uploading.

Each line works until the day it doesn't. A photo gets skipped, a link rots, a quota runs out. You find out from a reader.

```bash
# strip the GPS data from the published copies
exiftool -all= -r public/img
# resize the photos
magick mogrify -resize 1600x -path public/img photos/*.jpg
# keep the originals out of git
git lfs track "*.jpg"
# build, then look for broken links
ssg build && linkchecker public/
# add search
pagefind --site public
# publish
rsync -av public/ host:/var/www/
```

<div class="section-marker" id="audience"></div>

###### Who it's for

## Built for people who make things and write about them

- **🔨 Makers with a journal.** Woodworking, hiking, any craft with a lot of photos and a few maps. [my.ba3a.dev](https://my.ba3a.dev) is one, written in Russian.
- **🎮 Indie developers.** A devlog whose posts are branded by project, a page for each project, and press kits for games.
- **🧰 Tool authors.** Your docs stay in your repository. The site pulls them at build time and renders them in your theme.
- **🔒 Privacy-minded photographers.** Location and camera data are stripped unless you say otherwise, and every build lists the posts that publish an exact position.

**Not for you** if you want a CMS with a web editor, thousands of ready-made themes or a large community. coffer is a one-person project at version 0.1.0.

<div class="section-marker" id="how-it-works"></div>

###### How it works

## Mistakes fail the build. They never reach a reader.

You describe your sites in one `coffer.yaml`. Each step ends at a gate, and a gate that fails exits with a code your CI understands.

| Step | What happens | Gate |
|------|--------------|------|
| **01 · build** | Markdown, photos and the theme become plain files: HTML, resized WebP images, Atom feeds, a sitemap and a search index. | Exits 0 only when every link, image and project reference resolves. A bad value is reported with `file:line:column`. |
| **02 · check** | `coffer check` reads the finished output the way a visitor or a crawler would. | Exits 0 only when links, anchors, preview metadata, feeds and the sitemap are right, and every image matches its location policy. |
| **03 · refresh** | A scheduled job runs `coffer rebuild-needed` and asks the live site what it was built from. | Deploys only when the answer is `yes`: a post is due, or a documentation repository has a new commit. |

The build records what it wrote in a manifest, so the checks read facts instead of guessing from files.

<div class="section-marker" id="timeline"></div>

###### Publishing

## A push is the whole publishing step

You write. Git hooks and CI do the rest. This is the pipeline behind ba3a.dev.

- **Write** · *you* · A Markdown post and its photos in one folder. `coffer dev` shows it with live reload, drafts included.
- **Commit** · *you* · The pre-commit hook records the originals in `media.lock.json`: a path, a SHA-256 and a size per file. The photos stay out of git.
- **Push** · *you* · The pre-push hook uploads the originals the store lacks to a private bucket, and stops the push if that fails.
- **Build** · CI pulls the originals, runs `coffer build`, then `coffer check --w3c`.
- **Deploy** · The folder goes to Cloudflare Pages, and a smoke test checks the live site.
- **Refresh** · Every 15 minutes a job runs `coffer rebuild-needed`. It rebuilds when a scheduled post is due or a documentation repository has moved.

<div class="section-marker" id="spec-example"></div>

###### The input

## A post is just Markdown

Front matter says when it was written, what it is about and how much to reveal. Only `title` and `date` are required.

A photo can carry its own policy. A post that publishes an exact position is listed by every build, so a mistake is easy to see before you push.

```markdown
---
title: A day in the valley
date: 2025-07-12
tags: [hiking/alps]
location: coarse
images:
  summit.jpg:
    location: keep
---

We left at six. The ridge was clear by nine.

![The ridge at nine](ridge.jpg)
```

<div class="section-marker" id="features"></div>

###### What's in it

## Everything a journal needs, in the engine

- **🏷️ Tags and series.** Tags form a tree with a page for every subtree. A series gets "part n of m" and links to the previous and next part.
- **🖼️ Images at build time.** Resized WebP variants and a full-size JPEG for the viewer, in carousels if you like. The originals are never published.
- **📍 Location policy.** `strip`, `coarse` or `keep`, set for a site, a tag, a post or an image. When tags disagree, the strictest wins.
- **🗺️ Maps and GPX tracks.** Tracks and photo positions drawn on a map, with no API key. Visitors without JavaScript get a drawing of the route.
- **📦 Originals out of git.** A lock file in git, the content in an S3-compatible store such as Cloudflare R2, and hooks that keep them in step.
- **📚 Project documentation.** Guides pulled from the project's own repository, plus a reference generated from its source.
- **🔎 Search and feeds.** Search is built at build time and runs in the visitor's browser. Atom feeds exist per blog, tag, series and project.
- **🕒 Scheduled posts.** A post dated next Tuesday appears on Tuesday, without a rebuild every hour.

<div class="section-marker" id="compare"></div>

###### Why not Hugo

## Hugo is faster. coffer does the rest of the chores.

Hugo is a fast static generator with a large ecosystem and thousands of themes. If that is what you need, use it. coffer is for the case where the work is everything around the pages.

| What you need | coffer | With Hugo, typically |
|---------------|--------|----------------------|
| Location and camera data | A policy per site, tag, post or image. `coffer check` reads the published files back and fails on a mismatch. | A script of your own, and no check of the output |
| Original photos | A lock file in git, the originals in an S3-compatible store, git hooks that sync them | Git LFS, or a script of your own |
| Scheduled posts | A future-dated post appears when it is due. `rebuild-needed` rebuilds only when something changed. | Future posts are skipped until a rebuild, so you schedule the rebuild yourself |
| Docs of another repository | Cloned at build, rendered in your theme, with a generated reference | Hugo Modules, or a copy step |
| Broken links and images | The build fails with `file:line:column`, and `coffer check` inspects the output | Often a separate link checker |
| Search | Built in, with word forms | An add-on you wire up |

### What you give up

- It is version 0.1.0 with one maintainer. Before 1.0 a minor version may need a change in your site, and the changelog says so.
- It needs Node.js 24 or newer.
- There is one default theme and the one you write. There is no theme gallery.
- It is developed and tested on Windows and Linux.

<div class="section-marker" id="dogfood"></div>

###### Dogfooding

## coffer builds the site you're reading

ba3a.dev and my.ba3a.dev are two sites from one repository, built with coffer 0.1.0 and published to Cloudflare Pages by a push to `main`.

- **2** · sites built from one repository
- **3** · repositories whose documentation is pulled at build time: coffer, roto and specloop
- **15 min** · between checks for a due post or a new commit in a documentation repository
- **0** · servers or databases behind the live site

The `build-info.json` this site serves, as it was on 7 November 2026. Every build writes one, and `coffer rebuild-needed` compares it with the live repositories.

```json
{
  "builtAt": "2026-11-07T22:00:36.207Z",
  "engineVersion": "0.1.0",
  "sources": {
    "coffer": {
      "url": "https://github.com/ba3a/coffer.git",
      "ref": "main",
      "sha": "b0d5d2f6799fc61398975cf095cf79bed0bbbf5c"
    },
    "roto": {
      "url": "https://github.com/ba3a/roto.git",
      "ref": "main",
      "sha": "abb95488fa66cd579be03dc9a1feea80d85438fd"
    },
    "specloop": {
      "url": "https://github.com/ba3a/specloop.git",
      "ref": "main",
      "sha": "87a729ca6236344a1e33c80896af333b58cadc30"
    }
  },
  "nextScheduledAt": null
}
```

> **The docs of coffer itself are built this way.** The guides under [/made/coffer/docs/](../docs/README.md) come from the `docs/` folder of the coffer repository. Push a change there and this site picks it up within the hour.

<div class="section-marker" id="quick-start"></div>

###### Quick start

## Build the example site

You need Node.js 24 or newer and git. The example is a made-up woodworker's journal, and it builds from a fresh clone with no other setup.

To start your own site, copy `example/coffer.yaml` and `example/content`, then change the names and the texts. Pin a release tag, not the main branch.

```bash
git clone https://github.com/ba3a/coffer.git
cd coffer
npm install
npm run example
npx coffer serve example/dist/workshop
# then open http://localhost:8080/

# live preview with drafts, reloads on save
npx coffer dev --config example/coffer.yaml

# in your own project
npm install git+https://github.com/ba3a/coffer.git#v0.1.0
```

<div class="section-marker" id="faq"></div>

###### FAQ

## Questions people ask

### Does it need a server or JavaScript?

No server and no database. The output is plain files, and reading a page needs no JavaScript. Search does need it, and the search page says so without it.

### Where can I host it?

Anywhere that serves a folder of files. `coffer serve` answers the way Cloudflare Pages does, and the build writes a `_redirects` file for hosts that read one. ba3a.dev runs on Cloudflare Pages.

### Do my photos end up in git?

Not with a `media` block. The originals stay in a folder or an S3-compatible bucket such as R2, B2 or MinIO, and git holds a lock file with the hash and size of each one. The site publishes only the images derived from them.

### Can a site be in another language?

Yes. Each site has its own language and its own theme strings. my.ba3a.dev is in Russian.

### How stable is it?

It is 0.1.0 and follows semantic versioning. Before 1.0 a minor version may need a change in your site, and the changelog lists it. Pin a tag, and upgrade when you choose.

### Which systems does it run on?

It is developed and tested on Windows and Linux, and needs Node.js 24 or newer. The git hooks are POSIX shell scripts, which Git for Windows provides. macOS is not part of the tests.

<div class="section-marker" id="final-cta"></div>

## Publishing is a push

Write the post. Run one command. Push.

[★ Star coffer on GitHub](https://github.com/ba3a/coffer) [Read the docs](../docs/README.md)

---

coffer · Apache-2.0 · A "built with coffer" link is appreciated, not required.
