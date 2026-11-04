# PhotoSwipe

This directory holds a copy of PhotoSwipe 5.4.4 (https://photoswipe.com),
copyright 2014-2022 Dmitry Semenov, released under the MIT License (see `LICENSE`).

Files, as published in the `photoswipe` package on the npm registry:

- `photoswipe.css` is `dist/photoswipe.css`;
- `photoswipe.umd.min.js` is `dist/umd/photoswipe.umd.min.js`;
- `photoswipe-lightbox.umd.min.js` is `dist/umd/photoswipe-lightbox.umd.min.js`.

Only the line endings were changed (to LF). To update, fetch a new release with `npm pack photoswipe@<version>`, replace the
three files and `LICENSE`, and change the version above and in `docs/viewer.md`.
