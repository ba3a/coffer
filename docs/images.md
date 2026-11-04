# Images

Drop the originals next to the post and refer to them in Markdown. coffer resizes every image a post uses, publishes the small versions and never the original. This page describes what the build makes, what the pages look like and how to tune it. Location and camera metadata policies (`location`) arrive with a later feature; for now every published file is stripped of all metadata.

## Using images

```markdown
![A marking gauge and a knife line scribed across a pale board.](marking-gauge.jpg)

![Two boards joined by three dovetails.](dovetail-joint.jpg "The sixth attempt, unglued, on the bench.")
```

- The text in the brackets is the **alt text**. Write it for someone who cannot see the picture. An image without alt text still builds and appears in the build report as a warning with the file, line and column; an image that is purely decoration can keep its empty alt text and its warning.
- The optional quoted text after the address is the **caption**. An image that stands alone in its paragraph becomes a `<figure>` with the caption in a `<figcaption>`; without a caption there is no `<figcaption>`.
- The address is relative to the Markdown file and must stay inside the content directory, so a folder post can keep its pictures beside `index.md`, and several posts can share a folder such as `content/journal/photos/`. An address that starts with `/` (a file of the site's assets) or is a URL (`https://...`) is not an original; it is left exactly as written, without a size.
- Accepted inputs are **JPEG, PNG and WebP** (judged by the file's contents as well as its extension). Another format, such as GIF, SVG or HEIC, fails the build with the file, line and column; a file that cannot be decoded does too.

A post's `cover` (front matter) is processed the same way; its 1200 pixel WebP variant is the preview image of the post (see [SEO and link previews](seo.md)).

## What the build makes

For every image, in the `img/{key}/` folder of the site's output (the `{key}` is a hash of the original and of the settings, so a changed photo gets a new address and old addresses can be cached for ever):

| File                    | What                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `{name}-{width}.webp`   | A WebP variant, one for each configured width that is **narrower than the original**. When the original is not wider than the widest configured width, its own width is a variant too, so the full picture is always offered and nothing is ever enlarged. |
| `{name}-full.jpg`       | One JPEG for the viewer, for downloads and for press kits: the full picture, its long edge capped at `viewerMaxEdge`. |

`{name}` comes from the file name of the original, in lower case with anything but letters and digits turned into hyphens. The original is never copied to the output.

- The **EXIF orientation** is applied: a photo that a phone stored sideways with orientation 6 is published upright, and the size recorded for it (and written into the page) is the upright size.
- All published files are stripped of metadata: no EXIF, no GPS position, no camera fields, no colour profile (pixels are converted to sRGB first).
- Transparency in a PNG is kept in the WebP variants; the viewer JPEG has a white background.

The default widths are 480, 800, 1200, 1600 and 2400 pixels and the viewer image is capped at 3200 pixels; see [`images`](configuration.md#images) to change them. An original of 3000 by 2000 pixels gets variants at 480, 800, 1200, 1600 and 2400 and a viewer JPEG at 3000 by 2000; one of 700 by 500 gets 480 and 700 and a viewer JPEG at 700 by 500.

## What the page looks like

```html
<figure>
  <picture>
    <source type="image/webp"
            srcset="/img/3223a574853e9d3b/dovetail-joint-480.webp 480w, /img/3223a574853e9d3b/dovetail-joint-800.webp 800w, /img/3223a574853e9d3b/dovetail-joint-1200.webp 1200w"
            sizes="(min-width: 44rem) 41rem, calc(100vw - 2rem)">
    <img src="/img/3223a574853e9d3b/dovetail-joint-1200.webp" alt="Two boards joined by three dovetails."
         width="1200" height="800" loading="lazy" decoding="async">
  </picture>
  <figcaption>The sixth attempt, unglued, on the bench.</figcaption>
</figure>
```

- Every `<img>` has `width` and `height`, so the browser reserves the space before the file arrives and the page does not jump. The stylesheet scales it (`max-width: 100%; height: auto`).
- The `src` is the variant closest to 1200 pixels without exceeding it (else the narrowest), for readers that ignore `srcset`.
- **All images of a page but the first** have `loading="lazy"` and `decoding="async"`. The first image, which is likely to be on screen when the page opens, loads at once. "First" means the first `<img>` of the page's Markdown, whether or not coffer could process it.
- An image inside a sentence, or inside a link, is a `<picture>` without a `<figure>`, and a title is kept as a tooltip.
- Several images on lines of their own in one paragraph become one figure each.
- The `sizes` attribute says how wide the image is shown. The default fits the text column of the default theme; a theme with another layout sets [`images.sizes`](configuration.md#images).

## Feeds

Feed readers rarely understand `<picture>`, so in a feed every picture is a plain `<img>` with the **1200 pixel variant** as an absolute address, with its `width` and `height` and without `srcset`, `loading` and `decoding`. See [Feeds](feeds.md).

## The cache

Processing a large photo takes a moment, so results are kept in `.cache/images/` beside the configuration file (or in the `cacheDir` option of `buildSites`, see [Building a site](build.md)). The folder name is a hash of the original's content, its name, the settings and the versions of the image libraries; a photo whose bytes and settings are unchanged is not processed again, so the second build of a site is much faster than the first. Deleting `.cache/` is always safe: the next build makes everything again. A cache folder that is incomplete is made again.

Images are processed at the same time, a few at once (at most four or the number of CPU cores, whichever is lower), so a post with a hundred photos does not exhaust the memory of the machine.

## The manifest

Each image a page uses is listed in `.coffer-manifest.json` under `images`, so checks can compare what was published with what was intended:

```json
{
  "source": "content/journal/first-dovetail/dovetail-joint.jpg",
  "post": "/journal/first-dovetail/",
  "use": "body",
  "sha256": "...",
  "width": 1200,
  "height": 800,
  "outputs": [
    { "role": "variant", "url": "/img/3223a574853e9d3b/dovetail-joint-480.webp", "file": "img/3223a574853e9d3b/dovetail-joint-480.webp", "type": "image/webp", "width": 480, "height": 320 },
    { "role": "viewer", "url": "/img/3223a574853e9d3b/dovetail-joint-full.jpg", "file": "img/3223a574853e9d3b/dovetail-joint-full.jpg", "type": "image/jpeg", "width": 1200, "height": 800 }
  ]
}
```

`source` is relative to the configuration file, `post` is the address of the page that uses the image (`/` for the home page) and `use` is `body` for a Markdown image and `cover` for a post's cover. `width` and `height` are the upright size of the original. An image used by two pages has two entries.

## The example photos

The example site's photographs are made up and generated, so nothing copyrighted ships with coffer. `example/scripts/make-photos.js` draws them with [sharp](https://sharp.pixelplumbing.com/) and writes small JPEGs below `example/content/`; they are committed, so you only run the script (`node example/scripts/make-photos.js` in the coffer directory) to change them. One of them, `journal/photos/ridge.jpg`, is stored sideways with EXIF orientation 6 and carries a made-up GPS position, to show what the pipeline does with a phone photo.

## From JavaScript

```js
import { createImagePipeline } from 'coffer';

const pipeline = createImagePipeline({ cacheDir: '.cache/images', widths: [480, 960] });
const image = await pipeline.process('/abs/path/photo.jpg'); // throws ImageError for a bad file
pipeline.publish(image, 'dist/site');                        // copies variants and viewer image to dist/site/img/{key}/
```

`process` returns the upright `width` and `height`, the `variants` and the `viewer` file (each with `file`, `width`, `height` and `bytes`), the cache folder `dir`, the published folder `url` and whether the files were `cached`. `pipeline.stats` counts images `generated` and `reused`.
