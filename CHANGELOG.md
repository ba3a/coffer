# Changelog

All notable changes to coffer are recorded in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

coffer uses [semantic versioning](https://semver.org/). While the major version is 0, a minor release may change behaviour in ways that need a change in your site; the changelog says so under "Changed" or "Removed". From 1.0.0 on, a breaking change needs a new major version.

Every release is a git tag named `v` followed by the version, for example `v0.1.0`. A site should pin a tag and never follow a branch, so that it changes only when its author chooses to update. Read the section of the new version before you do.

## Unreleased

Nothing yet.

## 0.1.1 - 2026-11-08

### Fixed

- Feed addresses are percent-encoded, so a tag with non-ASCII characters or spaces no longer produces a feed that fails W3C validation.

## 0.1.0 - 2026-11-07

### Added

- A build that turns a `coffer.yaml`, Markdown posts and a theme into static files, one output directory per site, with a build manifest and a build report.
- Blogs with posts, drafts, posts dated in the future, reading time and tables of contents; code highlighted at build time for light and dark themes.
- Hierarchical tags with subtree pages, counts, display names and descriptions.
- Series with "part n of m" and previous and next navigation.
- Projects as content, with kinds for tools and games, project pages, a showcase on the home page, press kits and project posts.
- Project documentation fetched from git repositories or local folders: rendered guides, a generated reference, links from guides to reference pages and README sections on the project page.
- An image pipeline with responsive variants, carousels and a fullscreen viewer.
- A location and camera metadata policy (`strip`, `coarse`, `keep`) that can be set per site, tag subtree, post and image, and a report of posts that publish exact locations.
- GPX tracks and maps, built from tracks and photo locations without an API key.
- A media store for original photos and videos, with a lock file, a filesystem store, an S3-compatible store and git hooks that keep working copies in step.
- Atom feeds per blog, tag subtree, series and project.
- HTML comments in Markdown (for example `<!-- TODO: rewrite -->`) stay in the source and are left out of the published page. A comment that is never closed is kept as it is.
- Open Graph and Twitter metadata, generated title cards, canonical addresses, a sitemap and `robots.txt`.
- A copy-friendly share summary for posts.
- Full-text search for every blog, with word forms.
- An optional analytics snippet.
- A default theme with light and dark colours, a remembered theme switch and UI strings in English and Russian; themes can override a single template block.
- Redirects for old slugs, and a 404 page for each site.
- `build-info.json` and `coffer rebuild-needed` for scheduled rebuilds.
- The commands `build`, `serve`, `dev`, `new`, `check`, `docs fetch`, `media`, `hooks`, `rebuild-needed` and `config`.
- An example site with made-up content that builds from a fresh clone with `npm run example`.
- Documentation of every feature in `docs/`, a README, contribution guidelines and issue templates.
- A neutrality test that keeps names of people, products and sites out of the engine's code and documentation.
