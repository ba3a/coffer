# Leaflet

This directory holds a copy of Leaflet 1.9.4 (https://leafletjs.com), copyright
2010-2023 Volodymyr Agafonkin and 2010-2011 CloudMade, released under the
BSD 2-Clause License (see `LICENSE`).

Files, byte for byte as published in the `leaflet` package (version 1.9.4) on the npm registry:

- `leaflet.js` is `dist/leaflet.js`;
- `leaflet.css` is `dist/leaflet.css`;
- `images/` is `dist/images/` (Leaflet's own style sheet refers to these pictures; the maps of coffer use none of them, because their markers are drawn with CSS);
- `LICENSE` is `LICENSE`, with the line endings changed to LF.

To update, fetch a new release with `npm pack leaflet@<version>`, replace the files, and change the version above, in the test `test/map.test.js` (which also holds the checksums of the two main files), in `NOTICE` and in `docs/maps.md`.
