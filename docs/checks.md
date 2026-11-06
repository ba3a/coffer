# Checking a finished build

`coffer build` stops on mistakes it can see in the sources (see [Links, images and the build report](links.md)). `coffer check` looks at what the build wrote, the way a visitor or a crawler would meet it, and fails when something is off.

```
coffer check --config example/coffer.yaml --out example/dist
```

| Option            | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--config <path>` | The [configuration](configuration.md) that was built. Without it coffer looks for `coffer.yaml` in the working directory and its parents. |
| `--out <dir>`     | The output root given to `coffer build`. Default `dist`. Each site is read from `{out}/{siteId}`.                                   |
| `--w3c`           | Also post every feed to the W3C feed validator (see below).                                                                          |

The command prints one line per site, then one line per problem as `{out}/{siteId}/{file}: {message}`, and exits 1 when there was any problem (or 0 when there was none). Warnings, which do not change the exit code, start with `warning:`. A site whose directory has no build manifest fails with a pointer to `coffer build`.

## What is checked

The build writes a manifest (`.coffer-manifest.json`) into each site's output; the checks use it to know which pages, feeds and sitemap entries to expect.

- **Links.** Every `href`, `src`, `srcset` (each candidate) and `poster` in every HTML file, every link in every feed, and every link, image and `srcset` inside the HTML content of feed entries must lead to a file in the output. A host such as Cloudflare Pages decides what is served, so the check uses the same rules as [`coffer serve`](urls.md): `/a/` is `a/index.html`, `/a` is the file `a`, `a.html` or a redirect to `/a/`, and a rule in `_redirects` is followed (up to five hops) to the page it ends at. Absolute URLs on the site's own `baseUrl` are checked like relative ones; URLs on other hosts, `mailto:` and `tel:` are not.
- **Anchors.** A `#fragment` must be the `id` or `name` of an element in the page it leads to. `#` and `#top` always work.
- **Preview metadata.** Every HTML page except the redirect stubs for old slugs has a non-empty `<title>`, `description`, canonical link, `og:title`, `og:image` and `twitter:card`. The canonical link of a page the manifest lists must be that page's address on `baseUrl`, and the `og:image` must be served by the output when it is on the site. See [SEO and link previews](seo.md).
- **Feeds.** Every feed in the manifest exists and passes the [local validator](feeds.md) (well-formed Atom with the elements and dates RFC 4287 requires, absolute URLs and a correct self link).
- **Sitemap.** `sitemap.xml` lists exactly the addresses the manifest says it should, and each of them is served.
- **Image metadata.** Every image the manifest lists is read back (the viewer JPEG with exifr, the WebP variants with sharp) and compared with the [location and camera policy](location-policy.md) the manifest records for it: with `location: strip` no position anywhere; with `coarse` the viewer JPEG's position is the original's rounded to two decimals; with `keep` it is the original's; with `camera: strip` no camera fields; with `camera: keep` the fields the manifest lists; no EXIF, XMP or IPTC data in a WebP variant, and no XMP or IPTC in the viewer JPEG. The original is found through the configuration and is the reference when it is unchanged since the build (same hash); otherwise the check holds the files to what the manifest says. The full-resolution downloads of a game's [press kit](projects.md#the-press-kit), which the manifest lists under each project's `downloads`, are read back the same way: the policy and position as for the viewer JPEG, the file type, and the pixel size, which must be the manifest's and, when the original is at hand, the original's (a download is never resized). An SVG logo, which is published as it is, must still have the hash of its source and pass the same safety check as at build time (no script, no event handlers, no `javascript:` address). A failure names the file and what is wrong, and never prints a coordinate, so the log of a check does not give away what the policy hides.

## The W3C feed validator

The local validator finds the same kinds of problem without a network. `--w3c` adds the opinion of the W3C feed validator: each feed is posted to `https://validator.w3.org/feed/check.cgi` as `rawdata` with `output=soap12`, one request per second. A feed the service calls invalid is a failure that names the feed file and the validator's message; the validator's warnings are printed as warnings.

If the service cannot be reached (no network, an error status, a timeout, an answer that is not the validator's), `coffer check` prints one warning, skips the remaining feeds and does not fail because of it. Failures from the local checks still fail the command.

Do not use `--w3c` in a test suite that must run offline; the engine's own tests run `coffer check` against the example site without it, and with a stand-in for the service.

## From code

```js
import { loadConfig, checkOutput } from 'coffer';

const result = await checkOutput(loadConfig({ configPath: 'coffer.yaml' }), { out: 'dist', w3c: false });
for (const failure of result.failures) console.error(`${failure.site}/${failure.file}: ${failure.message}`);
```

`checkOutput` resolves to `{ sites, failures, warnings }`; every finding has a `site`, a `file` relative to the site's output directory and a `message`. `checkSite(outDir, siteId, { rootDir })` checks one directory without a configuration and returns a promise; `rootDir` is where the originals are (the directory of the configuration file) and may be left out.
