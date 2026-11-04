# Images

Drop the originals next to the post and refer to them in Markdown. coffer resizes every image a post uses, publishes the small versions and never the original. This page describes what the build makes, what the pages look like and how to tune it. Which location and camera metadata an image may publish is decided by a policy described in [Location and camera metadata](location-policy.md); until the policy is applied to the files, every published file is stripped of all metadata.

## Using images

```markdown
![A marking gauge and a knife line scribed across a pale board.](marking-gauge.jpg)

![Two boards joined by three dovetails.](dovetail-joint.jpg "The sixth attempt, unglued, on the bench.")
```

- The text in the brackets is the **alt text**. Write it for someone who cannot see the picture. An image without alt text still builds and appears in the build report as a warning with the file, line and column; an image that is purely decoration can keep its empty alt text and its warning.
- The optional quoted text after the address is the **caption**. An image that stands alone in its paragraph becomes a `<figure>` with the caption in a `<figcaption>`; without a caption there is no `<figcaption>`.
- The address is relative to the Markdown file and must stay inside the content directory, so a folder post can keep its pictures beside `index.md`, and several posts can share a folder such as `content/journal/photos/`. An address that starts with `/` (a file of the site's assets) or is a URL (`https://...`) is not an original; it is left exactly as written, without a size.
- Accepted inputs are **JPEG, PNG, WebP and HEIC** (judged by the file's contents as well as its extension; see [HEIC photos from phones](#heic-photos-from-phones)). Another format, such as GIF or SVG, fails the build with the file, line and column; a file that cannot be decoded does too.

A post's `cover` (front matter) is processed the same way; its 1200 pixel WebP variant is the preview image of the post (see [SEO and link previews](seo.md)).

## HEIC photos from phones

iPhones and many Android phones save photos as HEIC (`.heic` or `.heif`). You can drop those files next to a post and refer to them like any other image. The published files are the same WebP variants and JPEG viewer image as for a JPEG, and the original is not published:

```markdown
![The bench at dusk.](IMG_4021.HEIC)
```

sharp's prebuilt binaries cannot read HEIC, so coffer detects the format by the first bytes of the file (an `ftyp` box with a HEVC brand such as `heic`, whatever the file is called) and decodes it with [heic-decode](https://github.com/catdad-experiments/heic-decode), which is [libheif](https://github.com/strukturag/libheif) compiled to WebAssembly. The raw pixels are then handed to sharp. Nothing has to be installed on your machine.

- **Orientation.** The rotation and mirroring that a phone stores in the file (the `irot` and `imir` properties) are applied by the decoder, so the published files are upright. When a file has neither property but an Exif orientation, [exifr](https://github.com/MikeKovarik/exifr) reads it and coffer turns the pixels accordingly. When the file has such a property the Exif orientation is ignored, as the HEIF standard says, so a picture is never turned twice.
- **Metadata.** As for every image, nothing is copied: no Exif, no GPS position, no camera fields.
- **Errors.** A HEIC file that cannot be decoded (damaged, cut short, or using a HEIF feature that libheif-js lacks) fails the build. The message names the file and says what to do, for example `image 'IMG_4021.HEIC': cannot decode the HEIC image "IMG_4021.HEIC": Could not parse HEIF file ...; convert the file to JPEG or PNG (for example by exporting it from your photo app) and use that instead`. A file called `.heic` that is not HEIC at all fails the same way. As with other formats, a damaged `cover` is a warning, and the post gets a generated card instead.
- **Limits.**
  - Only the first (primary) picture of a file is used: no burst sequences, Live Photo videos, depth maps or HDR gain maps.
  - Pictures are decoded to 8 bits per channel and the colour profile is not converted: a Display P3 photo is treated as sRGB, so very saturated colours look slightly duller than on the phone.
  - The whole decoded picture is held in memory (4 bytes per pixel while decoding, 3 afterwards), so a 48 megapixel photo needs a few hundred megabytes while it is processed. It counts as one of the images processed at the same time, see [The cache](#the-cache).
  - Decoding in WebAssembly is noticeably slower than sharp's own decoders. The result is cached like any other, so that cost is paid once per photo.
  - libheif prints a line to the console for a file it cannot parse, in addition to the build error.
  - AVIF, which is also a HEIF file, is not supported.
  - libheif is licensed under the LGPL-3.0, heic-decode under the ISC license and exifr under the MIT license.

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
