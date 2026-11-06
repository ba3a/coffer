#!/usr/bin/env node
// Generates the made-up photographs of the example site, so that nothing
// copyrighted ships with the engine. Run it from the coffer directory:
//
//   node example/scripts/make-photos.js
//
// It overwrites the small JPEG files below `example/content`; they are committed,
// so a fresh clone does not need to run it.
//
// - dovetail-joint.jpg: a landscape picture with a made-up GPS position, the
//   workshop. Its post says `location: coarse`, so the published file carries
//   the position only rounded to about a kilometre.
// - marking-gauge.jpg: a plain landscape picture.
// - screenshot-1.jpg, screenshot-2.jpg: made-up screenshots of the example
//   game Tenon Tumble, for the gallery on its page.
// - press-kit/logo.png and press-kit/logo.svg: the made-up logo of the game
//   (wooden blocks) for its press kit, the PNG with a transparent background
//   and the SVG as hand-written text.
// - press-kit/on-the-bench.jpg: a made-up photograph of the game on a screen,
//   taken with a made-up camera at a made-up position. The press kit offers it
//   as a download, and the site's policy strips both, so the published file
//   has neither.
// - ridge.jpg: a portrait picture stored sideways with the EXIF orientation 6,
//   as phones do, with a made-up GPS position and a made-up camera. Its post
//   is tagged `trips/mountains`, which says `location: keep` and
//   `camera: keep`, so the viewer JPEG carries both. The places are invented;
//   they point at no real location of interest.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const contentDir = fileURLToPath(new URL('../content/', import.meta.url));

/** Quality of the committed files: small, and good enough for a made-up photo. */
const JPEG_QUALITY = 72;

/**
 * Wood grain: wavy, slightly different brown lines over a brown base.
 *
 * @param {number} width
 * @param {number} height
 * @param {string} base
 * @param {number} seed
 * @returns {string} SVG elements.
 */
function grain(width, height, base, seed) {
  const lines = [`<rect width="${width}" height="${height}" fill="${base}"/>`];
  for (let row = 0; row < height; row += 14) {
    const shift = Math.sin((row + seed) * 0.05) * 10;
    const tone = 70 + Math.round(Math.sin((row + seed) * 0.13) * 18);
    lines.push(
      `<path d="M0 ${row} C ${width * 0.3} ${row + shift}, ${width * 0.6} ${row - shift}, ${width} ${row + shift / 2}" stroke="rgb(${tone + 90},${tone + 40},${tone})" stroke-opacity="0.35" stroke-width="3" fill="none"/>`,
    );
  }
  return lines.join('');
}

/**
 * Two boards joined by a dovetail, on a workbench.
 *
 * @returns {string}
 */
function dovetailSvg() {
  const width = 1200;
  const height = 800;
  const tails = [0, 1, 2]
    .map((index) => {
      const x = 260 + index * 230;
      return `<polygon points="${x},330 ${x + 150},330 ${x + 190},470 ${x - 40},470" fill="#d8b27a" stroke="#6e4a22" stroke-width="4"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${grain(width, height, '#7a5230', 3)}
    <rect x="160" y="150" width="880" height="180" rx="6" fill="#e6c590" stroke="#6e4a22" stroke-width="4"/>
    <rect x="160" y="470" width="880" height="180" rx="6" fill="#e6c590" stroke="#6e4a22" stroke-width="4"/>
    ${tails}
    <rect x="0" y="700" width="${width}" height="100" fill="#2b2118" fill-opacity="0.55"/>
  </svg>`;
}

/**
 * A board with a knife line scribed across it and a marking gauge beside it.
 *
 * @returns {string}
 */
function gaugeSvg() {
  const width = 1200;
  const height = 800;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${grain(width, height, '#5e7a8a', 40)}
    <rect x="120" y="260" width="960" height="280" rx="8" fill="#ead3a4" stroke="#4b3b21" stroke-width="4"/>
    <line x1="120" y1="400" x2="1080" y2="400" stroke="#1d1a14" stroke-width="3"/>
    <rect x="300" y="580" width="520" height="34" fill="#9c6b34" stroke="#4b3b21" stroke-width="4"/>
    <rect x="520" y="540" width="80" height="114" rx="8" fill="#7a5230" stroke="#4b3b21" stroke-width="4"/>
    <circle cx="920" cy="640" r="46" fill="#c9ced3" stroke="#4b3b21" stroke-width="4"/>
  </svg>`;
}

/**
 * A ridge at dusk, upright (800 by 1200).
 *
 * @returns {string}
 */
function ridgeSvg() {
  const width = 800;
  const height = 1200;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1c2442"/>
        <stop offset="0.55" stop-color="#7b5a86"/>
        <stop offset="1" stop-color="#f0a368"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#sky)"/>
    <circle cx="560" cy="300" r="70" fill="#f7e9c8"/>
    <polygon points="0,820 160,640 300,760 470,540 640,730 800,620 800,1200 0,1200" fill="#3b3550"/>
    <polygon points="0,980 200,820 360,930 560,780 800,940 800,1200 0,1200" fill="#221f33"/>
    <polygon points="0,1100 260,1000 520,1090 800,1020 800,1200 0,1200" fill="#12101c"/>
  </svg>`;
}

/**
 * A made-up screenshot of the example game: wooden blocks on a grid, one of
 * them falling. Two variants, so that the game's page has a gallery.
 *
 * @param {1 | 2} variant
 * @returns {string}
 */
function tumbleSvg(variant) {
  const width = 1280;
  const height = 720;
  const cell = 80;
  const colours = ['#dd6b4d', '#e0b04a', '#6a994e', '#4d7ea8'];
  const blocks = (variant === 1
    ? [[3, 8, 0], [4, 8, 1], [5, 8, 2], [4, 7, 3], [6, 8, 1]]
    : [[2, 8, 2], [3, 8, 0], [4, 8, 1], [3, 7, 3], [3, 6, 0], [4, 7, 2], [5, 8, 3]]
  )
    .map(([column, row, tone]) => `<rect x="${160 + column * cell}" y="${row * cell - 80}" width="${cell - 6}" height="${cell - 6}" rx="6" fill="${colours[tone]}" stroke="#3a2a18" stroke-width="4"/>`)
    .join('');
  const falling = variant === 1 ? [[4, 2, 0]] : [[3, 1, 1]];
  const dropping = falling
    .map(([column, row, tone]) => `<rect x="${160 + column * cell}" y="${row * cell}" width="${cell - 6}" height="${cell - 6}" rx="6" fill="${colours[tone]}" stroke="#3a2a18" stroke-width="4"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${grain(width, height, '#4a3623', variant * 17)}
    <rect x="160" y="0" width="${cell * 8}" height="${height}" fill="#1d1710" fill-opacity="0.55"/>
    ${blocks}
    ${dropping}
  </svg>`;
}

/**
 * The logo of the example game: blocks on a staircase. No background, so that
 * the PNG made from it has a transparent one.
 *
 * @returns {string}
 */
function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <title>Tenon Tumble</title>
  <rect x="48" y="304" width="144" height="144" rx="14" fill="#dd6b4d" stroke="#3a2a18" stroke-width="10"/>
  <rect x="184" y="304" width="144" height="144" rx="14" fill="#e0b04a" stroke="#3a2a18" stroke-width="10"/>
  <rect x="320" y="304" width="144" height="144" rx="14" fill="#6a994e" stroke="#3a2a18" stroke-width="10"/>
  <rect x="116" y="160" width="144" height="144" rx="14" fill="#4d7ea8" stroke="#3a2a18" stroke-width="10"/>
  <rect x="252" y="40" width="144" height="120" rx="14" fill="#dd6b4d" stroke="#3a2a18" stroke-width="10" transform="rotate(12 324 100)"/>
</svg>
`;
}

/**
 * @param {string} relativePath Path below the content directory.
 * @param {Buffer} data
 */
function save(relativePath, data) {
  const target = join(contentDir, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(`${relativePath}: ${data.length} bytes`);
}

/**
 * @param {string} svg
 * @returns {Promise<Buffer>}
 */
function jpegOf(svg) {
  return sharp(Buffer.from(svg)).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
}

save('projects/tenon-tumble/screenshot-1.jpg', await jpegOf(tumbleSvg(1)));
save('projects/tenon-tumble/screenshot-2.jpg', await jpegOf(tumbleSvg(2)));

// The press kit of the example game: a logo as SVG and, rendered from it, as a
// PNG with transparency, and a photograph with a made-up position and camera.
save('projects/tenon-tumble/press-kit/logo.svg', Buffer.from(logoSvg()));
save(
  'projects/tenon-tumble/press-kit/logo.png',
  await sharp(Buffer.from(logoSvg())).png({ palette: true, colours: 32, compressionLevel: 9 }).toBuffer(),
);
// The made-up position is 52 deg 23' 33.0" N, 9 deg 43' 40.0" E.
save(
  'projects/tenon-tumble/press-kit/on-the-bench.jpg',
  await sharp(Buffer.from(gaugeSvg()))
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .withExif({
      IFD0: { Make: 'Examplecam', Model: 'Made-up 1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '52/1 23/1 33/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '9/1 43/1 40/1',
      },
    })
    .toBuffer(),
);

// The made-up position of the workshop is 52 deg 23' 31.7" N, 9 deg 43' 37.4" E.
save(
  'journal/first-dovetail/dovetail-joint.jpg',
  await sharp(Buffer.from(dovetailSvg()))
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '52/1 23/1 317/10',
        GPSLongitudeRef: 'E',
        GPSLongitude: '9/1 43/1 374/10',
      },
    })
    .toBuffer(),
);
save('journal/first-dovetail/marking-gauge.jpg', await jpegOf(gaugeSvg()));

// A phone holds the camera upright, stores the sensor's landscape picture and
// notes in the EXIF orientation (6: turn a quarter clockwise) how to show it.
// The made-up position is 47 deg 0' 44.3" N, 11 deg 2' 44.2" E.
const upright = await sharp(Buffer.from(ridgeSvg())).png().toBuffer();
const sideways = await sharp(upright).rotate(-90).toBuffer();
save(
  'journal/photos/ridge.jpg',
  await sharp(sideways)
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: 'Examplecam', Model: 'Made-up 1' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '47/1 0/1 443/10',
        GPSLongitudeRef: 'E',
        GPSLongitude: '11/1 2/1 442/10',
      },
    })
    .toBuffer(),
);
