# The image viewer

Every image of a post opens in a fullscreen viewer when you click or tap it. The viewer walks through all the images of the post, in the order they appear in the text, carousel slides included. It is [PhotoSwipe](https://photoswipe.com) 5.4.4 (MIT license), kept in the theme and served from your own site: nothing is loaded from another host.

## What a reader gets

- **Zoom.** Pinch on a phone, double tap, or click the picture (or the zoom button). Drag a zoomed picture to move it.
- **Next and previous.** Swipe, press the left and right arrow keys, or use the arrow buttons. The counter in the top bar shows the position, for example `2 / 7`.
- **Captions.** The caption of an image (the quoted text after its address, see [Images](images.md#using-images)) is shown at the bottom of the viewer.
- **Close.** Press Esc, use the close button, or tap outside the picture. On a phone the browser's **back gesture** (and the back button) closes the viewer instead of leaving the page: opening the viewer pushes an entry on the browser's history, and going back removes it. Closing the viewer in any other way takes that entry off again, so the history is the same as before.
- Nothing moves by itself: the viewer opens without a zoom animation and has no slideshow.

## Without JavaScript

Each image is wrapped in a link to its **full-size JPEG** (`/img/{key}/{name}-full.jpg`, see [Images](images.md)), so with scripts off, or before the script has loaded, a click opens the high-resolution file in the browser. An image that is already inside a link of your own keeps that link and is not part of the viewer, and so does an image that has no full-size file (an image from the site's assets or from another site).

```html
<figure>
  <a href="/img/3223a574853e9d3b/dovetail-joint-full.jpg" class="viewer-link" data-viewer="0">
    <picture>...</picture>
  </a>
  <figcaption>The sixth attempt, unglued, on the bench.</figcaption>
</figure>
```

`data-viewer` is the place of the image in the list below. Feeds get the link without the class and the number (see [Feeds](feeds.md)).

## What a page contains

A page that has at least one such image loads the viewer; a page without images loads none of it:

- the styles `/assets/vendor/photoswipe/photoswipe.css` and `/assets/viewer.css`, as `<link rel="stylesheet">` elements;
- the scripts `/assets/vendor/photoswipe/photoswipe.umd.min.js`, `/assets/vendor/photoswipe/photoswipe-lightbox.umd.min.js` and `/assets/viewer.js`, as `<script defer>` elements, after the carousel script if there is one;
- the list of the images in a `<script type="application/json" id="coffer-viewer">` element:

```json
{
  "labels": { "close": "Close (Esc)", "zoom": "Zoom in or out", "previous": "Previous image", "next": "Next image", "error": "The image could not be loaded.", "showOnMap": "Show on map" },
  "images": [
    { "src": "/img/3223a574853e9d3b/dovetail-joint-full.jpg", "width": 3000, "height": 2000, "alt": "Two boards joined by three dovetails.", "caption": "The sixth attempt, unglued, on the bench." },
    { "src": "/img/8c1f0b2e47aa91d3/ridge-full.jpg", "width": 2000, "height": 3000, "alt": "A dark ridge against an orange evening sky.", "caption": "", "latitude": 47.01, "longitude": 11.05, "precision": "coarse" }
  ]
}
```

- `src`, `width` and `height` are those of the full-size JPEG, so the viewer can lay the picture out before it has loaded.
- `latitude`, `longitude` and `precision` (`exact` or `coarse`) are present only for an image whose published file carries a position, which is decided by the [location policy](location-policy.md); they are never more precise than that file. The viewer needs nothing else to know what to show.
- The `labels` come from the UI strings of the site (`viewer.*` in `i18n/en.yaml` and `i18n/ru.yaml`), so the viewer speaks the language of the site. In the data they are escaped so that nothing in a caption can close the `<script>` element, and the caption is put on the page as text, never as markup.

`renderMarkdown` returns the same list as `viewerImages` (see [Markdown](markdown.md#result)); `coffer build` adds the labels and writes the JSON.

## Show on map

For an image with a position the viewer has a **Show on map** button in its top bar. It is hidden for images without a position, and it is hidden on pages that have no map, that is no element with the attribute `data-map`. When it is pressed the viewer closes and the document gets a `coffer:show-on-map` event, with `detail` of `{ index, latitude, longitude, src }`. The map script of the default theme (see [Maps and GPX tracks](maps.md#the-map)) answers it: it scrolls to the map that shows the photo, centres the map on the photo's marker and opens the marker. A theme with a map of its own listens for the event itself:

```js
document.addEventListener('coffer:show-on-map', (event) => {
  const { latitude, longitude } = event.detail;
  // show the position on the map
});
```

## Files

| File                                                          | What it is                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `theme/assets/vendor/photoswipe/photoswipe.umd.min.js`        | PhotoSwipe 5.4.4, the viewer itself                                               |
| `theme/assets/vendor/photoswipe/photoswipe-lightbox.umd.min.js` | PhotoSwipe's lightbox, which opens the viewer from the page                     |
| `theme/assets/vendor/photoswipe/photoswipe.css`               | PhotoSwipe's styles                                                               |
| `theme/assets/vendor/photoswipe/LICENSE`                      | PhotoSwipe's MIT license, which must stay with the files                          |
| `theme/assets/vendor/photoswipe/README.md`                    | Where the files come from and how to update them                                  |
| `theme/assets/viewer.js`                                      | The glue: reads the list, opens the viewer on a click, captions, history, map button |
| `theme/assets/viewer.css`                                     | Additions to PhotoSwipe's styles: always dark, caption band, map button           |

All of them are copied to `assets/` of the published site like the rest of the theme's assets (see [Themes](themes.md)). A site theme can replace `viewer.js` and `viewer.css` by putting files with the same names in its `assets/` folder.

## Notes

- The click handler is a single listener on the document that looks for `a[data-viewer]`, so links inside a carousel work the same as the others. A click with Ctrl, Cmd, Shift or Alt, or with another button, is left to the browser (open in a new tab, save as).
- If PhotoSwipe or the list cannot be read, the script does nothing and the links stay links to the full-size files.
- The viewer is dark in both colour schemes of the site.
- The viewer is built for touch: PhotoSwipe handles pinch, swipe and double tap, and the caption leaves room for the safe area of phones with a notch or a gesture bar.
