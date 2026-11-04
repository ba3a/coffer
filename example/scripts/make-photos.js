#!/usr/bin/env node
// Generates the made-up photographs of the example site, so that nothing
// copyrighted ships with the engine. Run it from the coffer directory:
//
//   node example/scripts/make-photos.js
//
// It overwrites the small JPEG files below `example/content`; they are committed,
// so a fresh clone does not need to run it.
//
// - dovetail-joint.jpg and marking-gauge.jpg: plain landscape pictures.
// - ridge.jpg: a portrait picture stored sideways with the EXIF orientation 6,
//   as phones do, and a made-up GPS position. It shows how the pipeline turns
//   it upright, reads its true size and (in later steps) applies the location
//   policy. The place is invented; it points at no real location of interest.

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

save('journal/first-dovetail/dovetail-joint.jpg', await jpegOf(dovetailSvg()));
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
