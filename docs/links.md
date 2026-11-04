# Links, images and the build report

`coffer build` resolves every Markdown link and image of every post before it writes a page. A broken link, a missing image or an unknown project reference fails the build, so a mistake never reaches the published site.

## What is checked

| Written in the post | Must be | Result |
| --- | --- | --- |
| `[x](../other/)`, `[x](../other)`, `[x](../other/index.md)`, `[x](../other.md)` | A post of the site that is part of this build. The path is read relative to the post's file, as in any Markdown editor. | Rewritten to the post's canonical URL, such as `/journal/other/`. |
| `[x](../other/#heading)` | The same, and the target post must have a heading (or any element, including raw HTML, with an `id` or `name`) of that name. | Rewritten to `/journal/other/#heading`. |
| `[x](#heading)` | A heading or `id` of the same post. `#` and `#top` always work. | Kept. |
| `[x](/journal/other/)`, `![x](/assets/pic.png)` | A page or file the built site serves, with or without the trailing slash. A link to a post may carry an anchor, which is checked. | Kept. |
| `![alt](photo.jpg)` | A file inside the content directory, usually beside the post. | Resized and published by the image pipeline (see [Images](images.md)). |
| `[x](project:slug)` | A registered project: a folder `{projects.dir}/{slug}/` holding a `project.yaml`. | Kept (project pages are linked by a later feature). |
| `https:`, `mailto:`, `tel:`, `//host/...`, `data:` | Not checked. | Kept. |

Links to a draft, or to a post dated in the future, fail a normal build and pass in preview mode (`--drafts`), because in preview mode those posts are built. A relative link to another kind of file inside the content directory, such as `data.csv`, is accepted as written; a link to a Markdown file that is not a post, or to anything outside the content directory, fails. Links inside code blocks and code spans are text, not links.

## Errors

All problems are collected, then printed together, each as `file:line:column message`, and the build exits with 1:

```
content/journal/foo/index.md:12:5 broken link '../bar/'
content/journal/foo/index.md:14:1 missing image 'hill.jpg'
content/journal/foo/index.md:20:9 broken link '#nothing' (this post has no heading or id 'nothing')
content/journal/foo/index.md:21:1 unknown project 'nope' in 'project:nope' (registered: lathe)
```

The file is relative to the configuration file. The line and column point at the start of the link or image in the post file, front matter included.

## The report

Every build writes `.coffer/report.json` beside the configuration file (the `reportDir` option of `buildSites` chooses another folder). It is never inside the output, so it is not deployed. The folder is ignored by git.

```json
{
  "reportVersion": 1,
  "errors": [{ "site": "workshop", "file": "content/journal/foo/index.md", "line": 12, "column": 5, "message": "broken link '../bar/'" }],
  "warnings": [{ "site": "workshop", "message": "content/journal/foo/index.md: cover: \"x.jpg\" does not exist; using a generated card" }],
  "exactLocations": [{ "site": "workshop", "file": "content/journal/mountain-weekend.md", "images": 1 }],
  "info": [{ "site": "workshop", "message": "6 post(s), 12 page(s) built" }]
}
```

`errors` fail the build, `warnings` are worth fixing, `exactLocations` lists the posts whose published images or GPX tracks carry exact positions (post file, image count and, for posts with tracks, track count; see [Maps and GPX tracks](maps.md#exact-locations) and [Location and camera metadata](location-policy.md#what-the-build-does-with-the-decision)) and `info` is for the record. The report is written whether the build succeeds or fails. In code, `Report`, `ReportError` and `formatIssue` from `src/report.js` are the same pieces later checks use to report their findings.
