# coffer documentation

coffer is a static site engine for people who make things and write about them. The [README](../README.md) says what it is and how to try it; these pages describe each feature. Every page is about one subject and links to the others where they meet.

## Getting started

- [Configuration](configuration.md): `coffer.yaml`, the one file that describes your sites, with every key.
- [Building a site](build.md): `coffer build`, the output, the build manifest and the report.
- [Authoring](authoring.md): the live preview, `coffer dev`, and the new-post command, `coffer new`.
- [Checking a finished build](checks.md): `coffer check`, what it verifies and how to use it in CI.

## Writing

- [Posts](posts.md): front matter, drafts, scheduled posts and which posts are published.
- [Markdown](markdown.md): the Markdown dialect, code highlighting, tables of contents and directives.
- [Tags](tags.md): tag trees, subtree pages, counts, names and descriptions.
- [Series](series.md): ordered runs of posts with navigation and a series page.
- [Links, images and the build report](links.md): link and image resolution, errors that stop the build, and the report.
- [Share summary](sharing.md): a copy-friendly summary of a post for sharing by hand.

## Images, maps and media

- [Images](images.md): what the build makes from an original and what the pages look like.
- [Location and camera metadata](location-policy.md): the `strip`, `coarse` and `keep` policy and where it is set.
- [Carousels](carousels.md): several images in the width of the text.
- [The image viewer](viewer.md): the fullscreen viewer.
- [Maps and GPX tracks](maps.md): tracks, photo locations and the map of a post.
- [Media originals](media.md): keeping original files outside git, the media store and the git hooks.

## Projects

- [Projects](projects.md): the project registry, project pages, kinds (tools and games) and press kits.
- [Project documentation](project-docs.md): guides and the generated reference of a project.
- [Where a project's documentation comes from](docs-sources.md): git and path sources, fetching and caching.

## Pages, themes and publishing

- [The home page, the 404 page and the footer](home.md): the content of the front page and the shared parts of every page.
- [Themes and UI strings](themes.md): templates, overriding one block, colours, fonts, title cards and translations.
- [URLs, redirects and hosting](urls.md): canonical addresses, redirects for old slugs and `coffer serve`.
- [Feeds](feeds.md): Atom feeds per blog, tag, series and project.
- [SEO and link previews](seo.md): metadata, Open Graph and Twitter tags, the sitemap and `robots.txt`.
- [Search](full-text-search.md): full-text search for every blog.
- [Analytics](analytics.md): the optional cookieless analytics snippet.
- [Scheduled rebuilds](scheduling.md): `build-info.json` and `coffer rebuild-needed`.
