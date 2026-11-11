import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { MAP_SCRIPTS, MAP_STYLES } from '../src/geo/map.js';
import { shiftViewerIndexes, VIEWER_SCRIPTS, VIEWER_STYLES } from '../src/viewer.js';
import { geotaggedPhoto, solidImage } from './helpers/images.js';

const NOW = new Date('2026-06-01T12:00:00Z');

/**
 * @param {Record<string, string | Buffer>} files
 * @param {(read: (file: string) => string) => Promise<void> | void} body
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-list-assets-'));
  try {
    const all = {
      'coffer.yaml': [
        'sites:',
        '  - id: demo',
        '    baseUrl: https://demo.example',
        '    lang: en',
        '    title: Demo',
        '    contentDir: .',
        '    blogs:',
        '      - { id: notes, dir: notes, prefix: log, title: Notes, index: full }',
        '',
      ].join('\n'),
      ...files,
    };
    for (const [name, content] of Object.entries(all)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
    await body((file) => readFileSync(join(result.outDir, ...file.split('/')), 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} html */
function viewerData(html) {
  const match = /<script type="application\/json" id="coffer-viewer">(.*?)<\/script>/s.exec(html);
  return match ? JSON.parse(/** @type {string} */ (match[1])) : null;
}

/**
 * @param {string} html
 * @param {string} src
 */
function scriptCount(html, src) {
  return html.split(`<script src="${src}" defer></script>`).length - 1;
}

/** @param {string} html */
function mapsOf(html) {
  return [...html.matchAll(/<script type="application\/json" class="map-data">(.*?)<\/script>/gs)].map((match) => JSON.parse(/** @type {string} */ (match[1])));
}

/**
 * Checks that the image links of a page count 0, 1, 2, ... in order and that every marker of every map finds its link.
 *
 * @param {string} html
 * @param {string} file
 * @param {number} count
 */
function assertViewerLinksMatchMarkers(html, file, count) {
  const links = [...html.matchAll(/data-viewer="(\d+)"/g)].map((match) => Number(match[1]));
  assert.deepEqual(links, Array.from({ length: count }, (_, index) => index), `${file}: data-viewer values`);
  for (const map of mapsOf(html)) {
    for (const marker of map.markers) {
      for (const index of marker.indexes) assert.ok(links.includes(index), `${file}: marker ${index} has a link`);
    }
  }
}

/**
 * @param {string} title
 * @param {string} date
 * @param {string} body
 * @param {string} [front]
 */
function post(title, date, body, front = '') {
  return `---\ntitle: ${title}\ndate: ${date}\ntags: [trips]\nseries: tour\n${front}---\n\n${body}\n`;
}

const CAROUSEL = ':::carousel[Photos]\n![First](one.jpg)\n\n![Second](two.jpg)\n:::';

test('shiftViewerIndexes moves the viewer links but not text that only looks like one', () => {
  const html = '<a href="/x.jpg" class="viewer-link" data-viewer="2"><img></a><pre>&lt;a data-viewer="2"></pre><code>data-viewer="2"</code>';
  assert.equal(
    shiftViewerIndexes(html, 5),
    '<a href="/x.jpg" class="viewer-link" data-viewer="7"><img></a><pre>&lt;a data-viewer="2"></pre><code>data-viewer="2"</code>',
  );
  assert.equal(shiftViewerIndexes(html, 0), html);
});

test('a list page with two full posts opens the images of both in one viewer, with a carousel each and the scripts once', async () => {
  await inTree(
    {
      'notes/newer/index.md': post('Newer', '2025-05-06', `![Cover](cover.jpg)\n\n${CAROUSEL}\n\n## Heading\n\nText.`),
      'notes/newer/cover.jpg': await solidImage(600, 400, 'jpeg', '#aa0000'),
      'notes/newer/one.jpg': await solidImage(610, 400, 'jpeg', '#bb1111'),
      'notes/newer/two.jpg': await solidImage(620, 400, 'jpeg', '#cc2222'),
      'notes/older/index.md': post('Older', '2025-05-05', `${CAROUSEL}\n\n![Cover](cover.jpg)\n\n## Heading\n\nText.`),
      'notes/older/cover.jpg': await solidImage(630, 400, 'jpeg', '#00aa00'),
      'notes/older/one.jpg': await solidImage(640, 400, 'jpeg', '#11bb11'),
      'notes/older/two.jpg': await solidImage(650, 400, 'jpeg', '#22cc22'),
    },
    (read) => {
      for (const file of ['log/index.html', 'log/tags/trips/index.html', 'log/series/tour/index.html']) {
        const html = read(file);
        const data = viewerData(html);
        assert.ok(data, `${file}: the viewer has its data`);
        assert.equal(data.images.length, 6, `${file}: images of both posts`);
        assert.equal(new Set(data.images.map((/** @type {{ src: string }} */ image) => image.src)).size, 6, file);

        // The n-th link has data-viewer="n", is the n-th of the list and leads to the n-th image.
        const links = [...html.matchAll(/<a href="([^"]+)" class="viewer-link" data-viewer="(\d+)"/g)];
        assert.deepEqual(
          links.map((link) => Number(link[2])),
          [0, 1, 2, 3, 4, 5],
          `${file}: indexes are unique and follow the document`,
        );
        assert.deepEqual(
          links.map((link) => link[1]),
          data.images.map((/** @type {{ src: string }} */ image) => image.src),
          `${file}: the list is in the order of the page`,
        );

        // The scripts and styles are included once.
        for (const src of [...VIEWER_SCRIPTS, '/assets/carousel.js']) assert.equal(scriptCount(html, src), 1, `${file}: ${src}`);
        for (const href of VIEWER_STYLES) assert.equal(html.split(`<link rel="stylesheet" href="${href}">`).length - 1, 1, `${file}: ${href}`);
        assert.equal(html.split('id="coffer-viewer"').length - 1, 1, file);

        // Each carousel is its own region; ids stay unique.
        assert.equal(html.match(/<section class="carousel"/g)?.length, 2, file);
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        assert.equal(new Set(ids).size, ids.length, `${file}: no id twice`);
        assert.ok(ids.includes('newer-heading') && ids.includes('older-heading'), file);
      }
    },
  );
});

test('a summary post on a list page adds nothing to the viewer, and a list without images loads no viewer', async () => {
  await inTree(
    {
      'notes/shown/index.md': post('Shown', '2025-05-06', '![Cover](cover.jpg)'),
      'notes/shown/cover.jpg': await solidImage(600, 400, 'jpeg', '#aa0000'),
      'notes/short/index.md': post('Short', '2025-05-05', '![Cover](cover.jpg)', 'index: summary\n'),
      'notes/short/cover.jpg': await solidImage(610, 400, 'jpeg', '#00aa00'),
      'notes/plain/index.md': '---\ntitle: Plain\ndate: 2025-05-04\ntags: [other]\n---\n\nOnly words.\n',
    },
    (read) => {
      const data = viewerData(read('log/index.html'));
      assert.equal(data?.images.length, 1);
      const other = read('log/tags/other/index.html');
      assert.equal(viewerData(other), null);
      assert.equal(scriptCount(other, '/assets/viewer.js'), 0);
      assert.equal(scriptCount(other, '/assets/carousel.js'), 0);
    },
  );
});

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Test walk</name><trkseg>
<trkpt lat="47.000" lon="11.000"><ele>100</ele></trkpt>
<trkpt lat="47.005" lon="11.000"><ele>150</ele></trkpt>
<trkpt lat="47.010" lon="11.010"><ele>120</ele></trkpt>
</trkseg></trk></gpx>
`;

test('each map on a list page is its own, loads Leaflet once and points at the right image of the one viewer', async () => {
  const photo = await geotaggedPhoto();
  await inTree(
    {
      'notes/newer/index.md': post('Newer', '2025-05-06', '![One](a.jpg)\n\n![Two](b.jpg)', 'location: keep\n'),
      'notes/newer/a.jpg': photo,
      'notes/newer/b.jpg': photo,
      'notes/older/index.md': post('Older', '2025-05-05', '![Three](c.jpg)', 'location: keep\n'),
      'notes/older/c.jpg': photo,
      'notes/older/loop.gpx': GPX,
    },
    (read) => {
      for (const file of ['log/index.html', 'log/tags/trips/index.html']) {
        const html = read(file);
        assert.equal(html.match(/<div class="coffer-map" data-map/g)?.length, 2, `${file}: two map containers`);
        const [first, second] = mapsOf(html);
        assert.deepEqual(first.markers[0].indexes, [0, 1], file);
        assert.deepEqual(second.markers[0].indexes, [2], `${file}: the second map points at the third image of the page`);
        assert.deepEqual(first.tracks, [], file);
        assert.equal(second.tracks.length, 1, file);
        const data = viewerData(html);
        assert.equal(data?.images.length, 3, file);
        assertViewerLinksMatchMarkers(html, file, 3);
        for (const src of [...MAP_SCRIPTS, ...VIEWER_SCRIPTS]) assert.equal(scriptCount(html, src), 1, `${file}: ${src}`);
        for (const href of MAP_STYLES) assert.equal(html.split(`<link rel="stylesheet" href="${href}">`).length - 1, 1, `${file}: ${href}`);
        // Leaflet comes after the viewer's script, which the markers rely on.
        assert.ok(html.indexOf('/assets/viewer.js') < html.indexOf('/assets/map.js'), file);
        const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
        assert.equal(new Set(ids).size, ids.length, `${file}: no id twice`);
      }
      // The post pages are unchanged: their own indexes start at 0.
      assert.deepEqual(mapsOf(read('log/older/index.html'))[0].markers[0].indexes, [0]);
    },
  );
});

test('a ::map directive on a list page counts on from the images of the posts before it', async () => {
  const photo = await geotaggedPhoto();
  await inTree(
    {
      'notes/newer/index.md': post('Newer', '2025-05-06', '![One](a.jpg)\n\n::map\n\n![Two](b.jpg)', 'location: keep\n'),
      'notes/newer/a.jpg': photo,
      'notes/newer/b.jpg': photo,
      'notes/older/index.md': post('Older', '2025-05-05', '![Three](c.jpg)\n\n::map', 'location: keep\n'),
      'notes/older/c.jpg': photo,
    },
    (read) => {
      for (const file of ['log/index.html', 'log/tags/trips/index.html']) {
        const html = read(file);
        assert.equal(html.match(/<div class="coffer-map" data-map/g)?.length, 2, `${file}: two map containers`);
        assert.equal(html.includes('data-coffer-map='), false, `${file}: no placeholder left`);
        const [first, second] = mapsOf(html);
        assert.deepEqual(first.markers[0].indexes, [0, 1], file);
        assert.deepEqual(second.markers[0].indexes, [2], file);
        assertViewerLinksMatchMarkers(html, file, 3);
      }
    },
  );
});
