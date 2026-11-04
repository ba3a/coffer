import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import {
  DEFAULT_ATTRIBUTION,
  DEFAULT_TILE_URL,
  MAP_SCRIPTS,
  MAP_STYLES,
  formatLength,
  isTileUrl,
  markersFor,
  normalizeAddress,
  parseSelection,
  selectMapContent,
} from '../src/geo/map.js';
import { renderStaticMap } from '../src/geo/static-map.js';
import { MarkdownError, renderMarkdown } from '../src/markdown/render.js';
import { PHOTO_POSITION, geotaggedPhoto, solidImage } from './helpers/images.js';

const themeAssets = fileURLToPath(new URL('../theme/assets/', import.meta.url));
const NOW = new Date('2026-06-01T12:00:00Z');

// ---- Pure logic --------------------------------------------------------------------------------

test('the attributes of a map are "all", "none" or a list of names', () => {
  assert.deepEqual(parseSelection(undefined), { mode: 'all' });
  assert.deepEqual(parseSelection('all'), { mode: 'all' });
  assert.deepEqual(parseSelection('none'), { mode: 'none' });
  assert.deepEqual(parseSelection(' a.gpx , b '), { mode: 'list', names: ['a.gpx', 'b'] });
  assert.throws(() => parseSelection(''), /must be "all", "none" or a comma-separated list/);
  assert.throws(() => parseSelection(' , '), /must be "all"/);
});

test('image addresses are compared without query, fragment, escapes and "./"', () => {
  assert.equal(normalizeAddress('./photos/a%20b.jpg?x=1#y'), 'photos/a b.jpg');
  assert.equal(normalizeAddress('../p.jpg'), '../p.jpg');
});

/** @type {import('../src/geo/map.js').MapPhoto[]} */
const PHOTOS = [
  { index: 0, address: 'photos/ridge.jpg', src: '/img/a-full.jpg', latitude: 47.01, longitude: 11.05, precision: 'coarse', alt: 'The ridge', caption: '' },
  { index: 2, address: 'photos/lake.jpg', src: '/img/b-full.jpg', latitude: 47.01, longitude: 11.05, precision: 'coarse', alt: '', caption: 'The lake' },
  { index: 3, address: 'photos/hut.jpg', src: '/img/c-full.jpg', latitude: 47.2, longitude: 11.3, precision: 'exact', alt: '', caption: '' },
];
const TRACKS = [{ name: 'day-one' }, { name: 'day-two' }];
const ALL = { mode: /** @type {const} */ ('all') };
const NONE = { mode: /** @type {const} */ ('none') };

test('a map shows all tracks and photos, none, or the ones it names', () => {
  const images = [...PHOTOS.map((photo) => photo.address), 'photos/plain.jpg'];
  const pick = (/** @type {any} */ selectTracks, /** @type {any} */ selectPhotos) =>
    selectMapContent({ tracks: TRACKS, photos: PHOTOS, images, selectTracks, selectPhotos });

  const everything = pick(ALL, ALL);
  assert.equal(everything.tracks.length, 2);
  assert.equal(everything.photos.length, 3);
  assert.deepEqual(everything.problems, []);

  const nothing = pick(NONE, NONE);
  assert.deepEqual([nothing.tracks, nothing.photos, nothing.problems], [[], [], []]);

  const some = pick({ mode: 'list', names: ['day-two.gpx'] }, { mode: 'list', names: ['photos/lake.jpg', 'hut.jpg'] });
  assert.deepEqual(some.tracks.map((track) => track.name), ['day-two']);
  assert.deepEqual(some.photos.map((photo) => photo.index), [2, 3], 'by address and by file name, in document order');
  assert.deepEqual(pick({ mode: 'list', names: ['day-one'] }, NONE).tracks.map((track) => track.name), ['day-one'], 'the extension is optional');

  // An image that publishes no position is not a mistake; a name that is no image at all is.
  assert.deepEqual(pick(NONE, { mode: 'list', names: ['plain.jpg'] }).problems, []);
  const wrong = pick({ mode: 'list', names: ['day-three.gpx'] }, { mode: 'list', names: ['nope.jpg'] });
  assert.equal(wrong.problems.length, 2);
  assert.match(wrong.problems[0], /^tracks: "day-three\.gpx" is not a track of this post \(the tracks are day-one\.gpx, day-two\.gpx\)$/);
  assert.match(wrong.problems[1], /^photos: "nope\.jpg" is not an image of this post$/);
});

test('photos published at one point share a marker, named after the photo or the number', () => {
  const markers = markersFor(
    PHOTOS,
    (count) => `${count} photos`,
    (n) => `Photo ${n}`,
  );
  assert.equal(markers.length, 2);
  assert.deepEqual(markers[0], {
    latitude: 47.01,
    longitude: 11.05,
    precision: 'coarse',
    indexes: [0, 2],
    src: '/img/a-full.jpg',
    label: '2 photos',
  });
  assert.equal(markers[1].label, 'Photo 4', 'no alt text and no caption: the number of the photo');
  assert.equal(markersFor([PHOTOS[1]], String, (n) => `Photo ${n}`)[0].label, 'The lake', 'the caption stands in for the alt text');
  assert.equal(markersFor([PHOTOS[0]], String, (n) => `Photo ${n}`)[0].label, 'The ridge');
});

test('lengths, tile addresses and the like', () => {
  assert.deepEqual(formatLength('en', 5724.4), { unit: 'km', value: '5.7' });
  assert.deepEqual(formatLength('ru', 5724.4), { unit: 'km', value: '5,7' });
  assert.deepEqual(formatLength('en', 420.4), { unit: 'm', value: '420' });
  assert.equal(isTileUrl(DEFAULT_TILE_URL), true);
  assert.equal(isTileUrl('https://{s}.tiles.example/{z}/{x}/{y}{r}.png'), true);
  assert.equal(isTileUrl('https://tiles.example/{z}/{x}.png'), false);
  assert.equal(isTileUrl('javascript:{z}{x}{y}'), false);
  assert.equal(isTileUrl('/tiles/{z}/{x}/{y}.png'), false);
});

// ---- The drawing without JavaScript --------------------------------------------------------------

test('the drawing projects tracks and photo points to the box around them', () => {
  const svg = renderStaticMap({
    tracks: [{ lines: [[[11, 47], [11, 47.02], [11.02, 47.02]]] }],
    markers: [{ latitude: 47.01, longitude: 11, src: '/img/a-full.jpg', label: 'A <b>"quoted"</b> hill' }],
    bounds: [11, 47, 11.02, 47.02],
    label: 'Route',
  });
  assert.match(svg, /^<svg class="map-drawing" [^>]*viewBox="0 0 800 \d+" role="img" aria-label="Route"/);
  const points = /** @type {RegExpExecArray} */ (/<polyline class="map-track-line map-track-0" points="([^"]+)"\/>/.exec(svg))[1]
    .split(' ')
    .map((pair) => pair.split(',').map(Number));
  assert.equal(points.length, 3);
  // North is up and east is to the right.
  assert.ok(points[1][1] < points[0][1], 'the second point is north of the first');
  assert.equal(points[0][0], points[1][0], 'same longitude, same x');
  assert.ok(points[2][0] > points[1][0], 'the third point is east of the second');
  const [x, y] = /** @type {RegExpExecArray} */ (/cx="([\d.]+)" cy="([\d.]+)"/.exec(svg)).slice(1).map(Number);
  assert.equal(x, points[0][0], 'the photo is on the western edge of the box');
  assert.ok(y < points[0][1] && y > points[1][1], 'and half way up');
  // Labels cannot break out of the markup.
  assert.ok(!svg.includes('<b>'), svg);
  assert.match(svg, /<a href="\/img\/a-full\.jpg" aria-label="A &lt;b&gt;&quot;quoted&quot;&lt;\/b&gt; hill">/);
});

test('a single point is drawn in the middle, not zoomed in without end', () => {
  const svg = renderStaticMap({
    tracks: [],
    markers: [{ latitude: 47.01, longitude: 11.05, src: '/a.jpg', label: 'A' }],
    bounds: [11.05, 47.01, 11.05, 47.01],
    label: 'Route',
  });
  const [x, y] = /** @type {RegExpExecArray} */ (/cx="([\d.]+)" cy="([\d.]+)"/.exec(svg)).slice(1).map(Number);
  assert.equal(x, 400);
  assert.equal(y, 400);
});

// ---- The directive -------------------------------------------------------------------------------

test('a ::map directive leaves a placeholder and is listed with what it asks for', async () => {
  const result = await renderMarkdown('Before\n\n::map\n\nMiddle\n\n::map{tracks="a.gpx,b" photos=none}\n\nAfter\n', { startLine: 10 });
  assert.equal(result.html.match(/<div data-coffer-map="\d+"><\/div>/g)?.length, 2);
  assert.match(result.html, /<p>Before<\/p>\n<div data-coffer-map="0"><\/div>\n<p>Middle<\/p>\n<div data-coffer-map="1"><\/div>\n<p>After<\/p>/);
  assert.deepEqual(result.maps, [
    { index: 0, tracks: { mode: 'all' }, photos: { mode: 'all' }, line: 12, column: 1 },
    { index: 1, tracks: { mode: 'list', names: ['a.gpx', 'b'] }, photos: { mode: 'none' }, line: 16, column: 1 },
  ]);
  assert.deepEqual((await renderMarkdown('Text')).maps, []);
});

test('a ::map written wrongly is an error that names the line', async () => {
  const fails = async (/** @type {string} */ source, /** @type {RegExp} */ message) =>
    assert.rejects(
      () => renderMarkdown(source, { file: 'p.md', startLine: 5 }),
      (error) => {
        assert.ok(error instanceof MarkdownError);
        assert.match(error.message, message);
        return true;
      },
    );
  await fails('Text\n\n::map{track="a.gpx"}\n', /^p\.md:7:1: a map has no attribute "track" \(the attributes are tracks and photos\)/);
  await fails('::map[Hello]\n', /^p\.md:5:1: a map takes no text in square brackets/);
  await fails('::map{tracks=""}\n', /^p\.md:5:1: tracks: must be "all", "none" or a comma-separated list/);
  await fails('::map{photos}\n', /^p\.md:5:1: photos: must be "all"/);
  await fails('::maps\n', /unknown directive "maps"/);
});

// ---- Posts ---------------------------------------------------------------------------------------

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Test walk</name><trkseg>
<trkpt lat="47.000" lon="11.000"><ele>100</ele></trkpt>
<trkpt lat="47.005" lon="11.000"><ele>150</ele></trkpt>
<trkpt lat="47.010" lon="11.010"><ele>120</ele></trkpt>
</trkseg></trk></gpx>
`;

/**
 * @param {string} title
 * @param {string} [front] More front matter lines.
 * @param {string} [body]
 */
function post(title, front = '', body = 'Some words.') {
  return `---\ntitle: ${title}\ndate: 2025-05-05\n${front}---\n\n${body}\n`;
}

/**
 * @param {string} [site] Extra lines for the site, indented as site keys.
 */
function configYaml(site = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentDir: .',
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Notes }',
    site,
    '',
  ].join('\n');
}

/**
 * Builds a site from the files and passes the result and the root to `body`.
 *
 * @template T
 * @param {Record<string, string | Buffer>} files
 * @param {(result: import('../src/build.js').SiteResult, root: string) => Promise<T> | T} body
 * @param {{ site?: string, config?: string }} [options]
 * @returns {Promise<T>}
 */
async function withSite(files, body, { site = '', config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-map-'));
  try {
    const all = { 'coffer.yaml': config ?? configYaml(site), ...files };
    for (const [name, content] of Object.entries(all)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), { out: join(root, 'out'), now: NOW });
    return await body(result, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * @param {import('../src/build.js').SiteResult} result
 * @param {string} slug
 */
function postPage(result, slug) {
  return readFileSync(join(result.outDir, 'log', slug, 'index.html'), 'utf8');
}

/** @param {string} html */
function mapsOf(html) {
  return [...html.matchAll(/<script type="application\/json" class="map-data">(.*?)<\/script>/gs)].map((match) => JSON.parse(match[1]));
}

const photo = await geotaggedPhoto();

test('a post with a GPX file gets a map with the track, the download and the summary', async () => {
  await withSite({ 'notes/walk/index.md': post('Walk'), 'notes/walk/loop.gpx': GPX }, (result) => {
    const html = postPage(result, 'walk');
    assert.equal(html.match(/data-map/g)?.length, 1);
    const [map] = mapsOf(html);
    assert.deepEqual(map.tracks, [{ title: 'Test walk', geojson: '/log/walk/loop.geojson', color: 0 }]);
    assert.deepEqual(map.markers, []);
    assert.deepEqual(map.tiles, { url: DEFAULT_TILE_URL, attribution: DEFAULT_ATTRIBUTION, maxZoom: 19 });
    assert.ok(map.bounds[0][0] <= 47 && map.bounds[1][0] >= 47.01);

    // Download link and summary.
    assert.match(html, /<a class="map-download" href="\/log\/walk\/loop\.gpx" download aria-label="Download GPX: Test walk">Download GPX<\/a>/);
    assert.match(html, /<dt>Distance<\/dt><dd>1\.5 km<\/dd>/);
    assert.match(html, /<dt>Climb<\/dt><dd>50 m<\/dd>/);
    assert.match(html, /<dt>Highest point<\/dt><dd>150 m<\/dd>/);
    // The drawing for visitors without JavaScript.
    assert.match(html, /<div class="map-static"><svg class="map-drawing"[^>]*><polyline class="map-track-line map-track-0" points="[\d., ]+"\/><\/svg><\/div>/);
    // Leaflet and the map script load after the page's other scripts; the styles are linked.
    const scripts = [...html.matchAll(/<script src="([^"]*)" defer><\/script>/g)].map((match) => match[1]);
    assert.deepEqual(scripts, [...MAP_SCRIPTS]);
    for (const href of MAP_STYLES) assert.ok(html.includes(`<link rel="stylesheet" href="${href}">`), href);
    for (const file of [...MAP_SCRIPTS, ...MAP_STYLES]) {
      assert.ok(existsSync(join(result.outDir, ...file.slice(1).split('/'))), `${file} is published`);
    }
    // The published files the map links to exist.
    assert.ok(existsSync(join(result.outDir, 'log', 'walk', 'loop.gpx')));
    assert.ok(existsSync(join(result.outDir, 'log', 'walk', 'loop.geojson')));
    assert.deepEqual(result.manifest.posts[0].maps, [{ tracks: ['/log/walk/loop.gpx'], photos: 0, markers: [] }]);
  });
});

test('the map goes at the end of the text, after the last paragraph', async () => {
  await withSite({ 'notes/walk/index.md': post('Walk', '', 'First.\n\nLast.'), 'notes/walk/loop.gpx': GPX }, (result) => {
    const html = postPage(result, 'walk');
    assert.ok(html.indexOf('<p>Last.</p>') < html.indexOf('class="coffer-map"'));
    assert.ok(html.indexOf('class="coffer-map"') < html.indexOf('</article>'));
  });
});

test('photos with a published position are markers, and a post with photos only gets a map', async () => {
  await withSite(
    {
      'notes/keep/index.md': post('Keep', 'location: keep\n', '![The hill](hill.jpg "From the top")'),
      'notes/keep/hill.jpg': photo,
      'notes/also/index.md': post('Also', 'location: keep\n', '![One](a.jpg)\n\n![Two](b.jpg)'),
      'notes/also/a.jpg': photo,
      'notes/also/b.jpg': photo,
    },
    (result) => {
      const keep = postPage(result, 'keep');
      const [map] = mapsOf(keep);
      assert.deepEqual(map.tracks, []);
      assert.equal(map.markers.length, 1);
      assert.equal(map.markers[0].precision, 'exact');
      assert.ok(Math.abs(map.markers[0].latitude - PHOTO_POSITION.latitude) < 1e-6);
      assert.ok(Math.abs(map.markers[0].longitude - PHOTO_POSITION.longitude) < 1e-6);
      assert.deepEqual(map.markers[0].indexes, [0]);
      assert.equal(map.markers[0].label, 'The hill');
      // No track: no summary list, no download link.
      assert.ok(!keep.includes('map-tracks') && !keep.includes('map-download'));
      // The viewer is loaded first, then the map; the drawing links to the photo.
      const scripts = [...keep.matchAll(/<script src="([^"]*)" defer><\/script>/g)].map((match) => match[1]);
      assert.deepEqual(scripts.slice(-2), [...MAP_SCRIPTS]);
      assert.ok(scripts.includes('/assets/viewer.js'));
      assert.match(keep, /<a href="\/img\/[0-9a-f]{16}\/hill-full\.jpg" aria-label="The hill"><circle class="map-point"/);
      // The marker's photo is the one of the link with that number.
      assert.match(keep, /data-viewer="0"/);

      // Two photos at one place are one marker with both photos.
      const [also] = mapsOf(postPage(result, 'also'));
      assert.equal(also.markers.length, 1);
      assert.deepEqual(also.markers[0].indexes, [0, 1]);
      assert.equal(also.markers[0].label, '2 photos');
      assert.deepEqual(result.manifest.posts.find((entry) => entry.slug === 'also')?.maps, [
        { tracks: [], photos: 2, markers: [{ latitude: also.markers[0].latitude, longitude: also.markers[0].longitude, precision: 'exact', photos: [0, 1] }] },
      ]);
    },
  );
});

test('with the policy coarse the markers are at the rounded position and the page never has the exact one', async () => {
  await withSite(
    {
      'notes/coarse/index.md': post('Coarse', 'location: coarse\n', '![The hill](hill.jpg)'),
      'notes/coarse/hill.jpg': photo,
      'notes/walk/index.md': post('Walk', 'location: coarse\n', '![The hill](hill.jpg)'),
      'notes/walk/hill.jpg': photo,
      'notes/walk/loop.gpx': GPX,
    },
    (result) => {
      for (const slug of ['coarse', 'walk']) {
        const html = postPage(result, slug);
        const map = mapsOf(html)[0];
        assert.deepEqual(
          map.markers.map((/** @type {any} */ marker) => [marker.latitude, marker.longitude, marker.precision]),
          [[47.01, 11.05, 'coarse']],
          slug,
        );
        // Not in the markers, the drawing, the viewer's list, nor anywhere else on the page.
        assert.ok(!/47\.012|11\.045|47\.0123|11\.0455/.test(html), `${slug}: the exact position is on the page`);
        const viewer = /id="coffer-viewer">(.*?)<\/script>/s.exec(html);
        assert.ok(viewer && JSON.parse(viewer[1]).images[0].latitude === 47.01);
      }
      assert.deepEqual(result.manifest.posts.find((entry) => entry.slug === 'coarse')?.maps[0].markers, [
        { latitude: 47.01, longitude: 11.05, precision: 'coarse', photos: [0] },
      ]);
    },
  );
});

test('a post without a track and without a published position gets no map and loads no map code', async () => {
  await withSite(
    {
      'notes/strip/index.md': post('Strip', 'location: strip\n', '![The hill](hill.jpg)'),
      'notes/strip/hill.jpg': photo,
      'notes/nolocation/index.md': post('No location', 'location: keep\n', '![Plain](plain.jpg)'),
      'notes/nolocation/plain.jpg': await solidImage(40, 30),
      'notes/text.md': post('Text'),
    },
    (result) => {
      for (const slug of ['strip', 'nolocation', 'text']) {
        const html = postPage(result, slug);
        assert.ok(!html.includes('data-map'), slug);
        assert.ok(!html.includes('coffer-map'), slug);
        assert.ok(!html.includes('leaflet'), slug);
        assert.ok(!html.includes('map.js') && !html.includes('map.css'), slug);
        assert.deepEqual(result.manifest.posts.find((entry) => entry.slug === slug)?.maps, [], slug);
      }
      // The photo of the first post is still in the viewer, without a position.
      assert.ok(postPage(result, 'strip').includes('viewer.js'));
    },
  );
});

test('map: false in the front matter suppresses the map, even with a track and located photos', async () => {
  await withSite(
    {
      'notes/off/index.md': post('Off', 'map: false\nlocation: keep\n', '![The hill](hill.jpg)\n\n::map\n'),
      'notes/off/hill.jpg': photo,
      'notes/off/loop.gpx': GPX,
      'notes/on/index.md': post('On', 'map: true\nlocation: keep\n', '![The hill](hill.jpg)'),
      'notes/on/hill.jpg': photo,
      'notes/empty/index.md': post('Empty', 'map: true\n'),
    },
    (result) => {
      const off = postPage(result, 'off');
      assert.ok(!off.includes('data-map') && !off.includes('data-coffer-map') && !off.includes('leaflet'));
      assert.ok(off.includes('data-viewer="0"'), 'the viewer still works');
      assert.ok(postPage(result, 'on').includes('data-map'));
      assert.ok(!postPage(result, 'empty').includes('data-map'), 'map: true cannot make a map from nothing');
      // The track is still published for download.
      assert.ok(existsSync(join(result.outDir, 'log', 'off', 'loop.gpx')));
    },
  );
});

test('a ::map directive puts the map in the text, and several can show parts', async () => {
  const body = [
    'Intro.',
    '',
    '::map{photos=none}',
    '',
    '![The hill](hill.jpg)',
    '',
    'Middle.',
    '',
    '::map{tracks="none" photos="hill.jpg"}',
    '',
    'Outro.',
  ].join('\n');
  await withSite(
    {
      'notes/trip/index.md': post('Trip', 'location: keep\n', body),
      'notes/trip/hill.jpg': photo,
      'notes/trip/one.gpx': GPX,
      'notes/trip/two.gpx': GPX.replace('Test walk', 'Second walk'),
    },
    (result) => {
      const html = postPage(result, 'trip');
      const maps = mapsOf(html);
      assert.equal(maps.length, 2);
      assert.deepEqual(maps[0].tracks.map((/** @type {any} */ track) => track.title), ['Test walk', 'Second walk']);
      assert.deepEqual(maps[0].tracks.map((/** @type {any} */ track) => track.color), [0, 1]);
      assert.deepEqual(maps[0].markers, []);
      assert.deepEqual(maps[1].tracks, []);
      assert.equal(maps[1].markers.length, 1);
      // Where the directives stand, and no extra map at the end.
      const positions = [...html.matchAll(/class="coffer-map"/g)].map((match) => match.index);
      assert.equal(positions.length, 2);
      assert.ok(html.indexOf('<p>Intro.</p>') < positions[0] && positions[0] < html.indexOf('<figure>'));
      assert.ok(html.indexOf('<p>Middle.</p>') < positions[1] && positions[1] < html.indexOf('<p>Outro.</p>'));
      assert.ok(!html.includes('data-coffer-map'));
      // The second map has no summary; the first lists both tracks.
      assert.equal(html.match(/<li class="map-track map-color-\d">/g)?.length, 2);
      assert.deepEqual(result.manifest.posts[0].maps.map((map) => [map.tracks.length, map.photos]), [[2, 0], [0, 1]]);
    },
  );
});

test('the feed has the text of the post without the map', async () => {
  await withSite(
    {
      'notes/walk/index.md': post('Walk', '', 'Before.\n\n::map\n\nAfter.'),
      'notes/walk/loop.gpx': GPX,
      'notes/plain/index.md': post('Plain', '', 'Words.'),
      'notes/plain/loop.gpx': GPX,
    },
    (result) => {
      const feed = readFileSync(join(result.outDir, 'log', 'feed.xml'), 'utf8');
      assert.ok(!feed.includes('coffer-map') && !feed.includes('data-map'));
      assert.match(feed, /Before\./);
      assert.match(feed, /After\./);
      assert.ok(postPage(result, 'walk').includes('data-map'));
      assert.ok(postPage(result, 'plain').includes('data-map'));
    },
  );
});

test('a ::map that names a track or a photo the post does not have fails the build with the line', async () => {
  const files = {
    'notes/trip/index.md': post('Trip', '', 'Text.\n\n::map{tracks="gone.gpx"}\n\n::map{photos="nope.jpg"}\n'),
    'notes/trip/one.gpx': GPX,
  };
  await assert.rejects(
    () => withSite(files, () => undefined),
    (error) => {
      assert.ok(error instanceof Error && 'errors' in error && Array.isArray(error.errors));
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0], /^notes\/trip\/index\.md:\d+:1 ::map tracks: "gone\.gpx" is not a track of this post \(the tracks are one\.gpx\)$/);
      assert.match(error.errors[1], /^notes\/trip\/index\.md:\d+:1 ::map photos: "nope\.jpg" is not an image of this post$/);
      return true;
    },
  );
});

test('a ::map in the home page is left out with a warning, not as an empty element', async () => {
  await withSite({ 'notes/a/index.md': post('A'), 'home.md': '---\ntitle: Hi\n---\n\nAbout.\n\n::map\n' }, (result) => {
    const html = readFileSync(join(result.outDir, 'index.html'), 'utf8');
    assert.ok(!html.includes('data-coffer-map') && !html.includes('data-map'));
    assert.ok(result.warnings.some((warning) => /^home\.md:\d+: the ::map directive is only for posts/.test(warning)), result.warnings.join('\n'));
  });
});

test('a ::map that shows nothing is left out with a warning, and no map is added at the end', async () => {
  await withSite(
    { 'notes/trip/index.md': post('Trip', '', 'Text.\n\n::map{tracks="none"}\n'), 'notes/trip/one.gpx': GPX },
    (result) => {
      assert.ok(!postPage(result, 'trip').includes('data-map'));
      assert.ok(result.warnings.some((warning) => /notes\/trip\/index\.md: line \d+: the ::map directive shows nothing/.test(warning)), result.warnings.join('\n'));
    },
  );
});

test('the tile server and its credit come from the site configuration', async () => {
  await withSite(
    { 'notes/walk/index.md': post('Walk'), 'notes/walk/loop.gpx': GPX },
    (result) => {
      const [map] = mapsOf(postPage(result, 'walk'));
      assert.deepEqual(map.tiles, { url: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'Tiles by <a href="https://tiles.example">Example</a>', maxZoom: 17 });
      assert.ok(!JSON.stringify(map).includes('openstreetmap'));
    },
    {
      site: [
        '    map:',
        '      tileUrl: https://tiles.example/{z}/{x}/{y}.png',
        '      attribution: Tiles by <a href="https://tiles.example">Example</a>',
        '      maxZoom: 17',
      ].join('\n'),
    },
  );
});

test('the tile settings are checked', () => {
  const load = (/** @type {string} */ lines) => {
    const root = mkdtempSync(join(tmpdir(), 'coffer-map-config-'));
    try {
      writeFileSync(join(root, 'coffer.yaml'), configYaml(lines));
      mkdirSync(join(root, 'notes'));
      return loadConfig({ configPath: join(root, 'coffer.yaml') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  assert.deepEqual(load('').sites[0].map, { tileUrl: DEFAULT_TILE_URL, attribution: DEFAULT_ATTRIBUTION, maxZoom: 19 });
  assert.throws(() => load('    map: { tileUrl: "https://t.example/{z}/{x}.png", attribution: x }'), /map\.tileUrl: must be an http\(s\) address with \{z\}, \{x\} and \{y\}/);
  assert.throws(() => load('    map: { tileUrl: "https://t.example/{z}/{x}/{y}.png" }'), /map\.attribution: is required with tileUrl/);
  assert.throws(() => load('    map: { maxZoom: 40 }'), /map\.maxZoom: must be an integer from 1 to 24/);
  assert.throws(() => load('    map: { key: abc }'), /map\.key/);
});

test('the words of the map follow the language of the site', async () => {
  await withSite(
    { 'notes/walk/index.md': post('Walk'), 'notes/walk/loop.gpx': GPX },
    (result) => {
      const html = postPage(result, 'walk');
      assert.match(html, /aria-label="Карта"/);
      assert.match(html, /<dt>Расстояние<\/dt><dd>1,5 км<\/dd>/);
      assert.match(html, /<dt>Набор высоты<\/dt><dd>50 м<\/dd>/);
      assert.match(html, />Скачать GPX<\/a>/);
      assert.equal(mapsOf(html)[0].labels.zoomIn, 'Приблизить');
    },
    { config: configYaml().replace('lang: en', 'lang: ru') },
  );
});

// ---- The example site ----------------------------------------------------------------------------

test('the example site has a trip post with a track and a located photo, and a post with photos only', async () => {
  const exampleConfig = fileURLToPath(new URL('../example/coffer.yaml', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'coffer-map-example-'));
  try {
    const [result] = await buildSites(loadConfig({ configPath: exampleConfig }), { out, now: NOW, reportDir: join(out, 'report'), cacheDir: join(out, 'cache') });
    const maps = (/** @type {string} */ slug) => result.manifest.posts.find((entry) => entry.slug === slug)?.maps ?? [];
    // Track and photo with the exact position (the tag subtree says keep).
    assert.equal(maps('ridge-walk').length, 1);
    assert.deepEqual(maps('ridge-walk')[0].tracks, ['/journal/ridge-walk/ridge-loop.gpx']);
    assert.equal(maps('ridge-walk')[0].markers[0].precision, 'exact');
    // Photos only: the hiking post (exact) and the dovetail post (rounded).
    assert.deepEqual(maps('mountain-weekend').map((map) => [map.tracks.length, map.markers.length, map.markers[0].precision]), [[0, 1, 'exact']]);
    assert.deepEqual(maps('first-dovetail').map((map) => [map.tracks.length, map.markers.length, map.markers[0].precision]), [[0, 1, 'coarse']]);
    // Posts with neither have none.
    for (const slug of ['photo-notes', 'walnut-box']) assert.deepEqual(maps(slug), [], slug);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// ---- The vendored library ------------------------------------------------------------------------

/** @param {string} path */
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('Leaflet is vendored as published on npm, with its licence', () => {
  const directory = join(themeAssets, 'vendor', 'leaflet');
  // Hashes of dist/leaflet.js and dist/leaflet.css in the leaflet@1.9.4 package on the npm registry.
  assert.equal(sha256(join(directory, 'leaflet.js')), 'db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a');
  assert.equal(sha256(join(directory, 'leaflet.css')), 'a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6');
  assert.match(readFileSync(join(directory, 'leaflet.js'), 'utf8'), /^\/\* @preserve\n \* Leaflet 1\.9\.4, a JS library for interactive maps\./);
  assert.match(readFileSync(join(directory, 'LICENSE'), 'utf8'), /^BSD 2-Clause License\n\nCopyright \(c\) 2010-2023, Volodymyr Agafonkin/);
  for (const file of ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png']) {
    assert.ok(existsSync(join(directory, 'images', file)), file);
  }
  assert.match(readFileSync(join(directory, 'README.md'), 'utf8'), /Leaflet 1\.9\.4/);
  const notice = readFileSync(fileURLToPath(new URL('../NOTICE', import.meta.url)), 'utf8');
  assert.match(notice, /Leaflet, copyright 2010-2023 Volodymyr Agafonkin/);
  assert.match(notice, /BSD 2-Clause License/);
});

// ---- The script ----------------------------------------------------------------------------------

/**
 * Runs map.js on a page with the given map data, with stand-ins for Leaflet
 * and the document.
 *
 * @param {object} data The data of the one map of the page.
 * @param {{ library?: boolean, size?: { x: number, y: number } }} [options]
 */
function mapPage(data, { library = true, size = { x: 600, y: 400 } } = {}) {
  const state = { size };
  /** @type {any[]} */
  const leafletMaps = [];
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const markers = [];
  /** @type {Map<string, ((event: any) => void)[]>} */
  const documentListeners = new Map();
  /** @type {string[]} */
  const clicked = [];

  const classes = new Set();
  const root = {
    classList: { add: (/** @type {string} */ name) => classes.add(name), remove: (/** @type {string} */ name) => classes.delete(name) },
    querySelector: (/** @type {string} */ selector) => {
      if (selector === 'script.map-data') return { textContent: JSON.stringify(data) };
      if (selector === '.map-frame') return frame;
      return null;
    },
    scrollIntoView: () => log.push('scroll'),
  };
  const frame = { appendChild: (/** @type {any} */ child) => log.push(`frame gets ${child.className}`) };

  const L = {
    map: (/** @type {any} */ _element, /** @type {any} */ options) => {
      const mapListeners = new Map();
      const map = {
        options,
        scrollWheelZoom: { enable: () => log.push('wheel on'), disable: () => log.push('wheel off') },
        on: (/** @type {string} */ name, /** @type {() => void} */ listener) => mapListeners.set(name, listener),
        fire: (/** @type {string} */ name) => mapListeners.get(name)?.(),
        setView: (/** @type {number[]} */ center, /** @type {number} */ zoom) => log.push(`view ${center.join(',')} ${zoom}`),
        fitBounds: (/** @type {any} */ bounds) => log.push(`fit ${JSON.stringify(bounds)}`),
        getZoom: () => 10,
        getSize: () => state.size,
        invalidateSize: () => {},
      };
      leafletMaps.push(map);
      return map;
    },
    control: { zoom: (/** @type {any} */ options) => ({ addTo: () => log.push(`zoom control ${options.zoomInTitle}`) }) },
    tileLayer: (/** @type {string} */ url, /** @type {any} */ options) => ({ addTo: () => log.push(`tiles ${url} ${options.attribution} ${options.maxZoom}`) }),
    geoJSON: (/** @type {any} */ geojson) => ({ addTo: () => log.push(`track ${geojson.name}`) }),
    divIcon: (/** @type {any} */ options) => options,
    marker: (/** @type {number[]} */ latlng, /** @type {any} */ options) => {
      const element = {
        attributes: /** @type {Record<string, string>} */ ({}),
        classes: new Set(),
        setAttribute(/** @type {string} */ name, /** @type {string} */ value) {
          this.attributes[name] = value;
        },
        classList: {
          add: (/** @type {string} */ name) => element.classes.add(name),
          remove: (/** @type {string} */ name) => element.classes.delete(name),
        },
        focus: () => log.push('focus'),
      };
      const listeners = new Map();
      const marker = {
        latlng,
        options,
        element,
        tooltip: /** @type {any} */ (null),
        addTo: () => marker,
        bindTooltip: (/** @type {any} */ content) => {
          marker.tooltip = content;
        },
        openTooltip: () => log.push(`tooltip open ${marker.tooltip.textContent}`),
        closeTooltip: () => log.push(`tooltip close ${marker.tooltip.textContent}`),
        getElement: () => element,
        getLatLng: () => ({ lat: latlng[0], lng: latlng[1] }),
        on: (/** @type {string} */ name, /** @type {() => void} */ listener) => listeners.set(name, listener),
        click: () => listeners.get('click')?.(),
      };
      markers.push(marker);
      return marker;
    },
  };

  const document = {
    readyState: 'complete',
    querySelectorAll: (/** @type {string} */ selector) => (selector === '[data-map]' ? [root] : []),
    querySelector: (/** @type {string} */ selector) => {
      const match = /^a\[data-viewer="(\d+)"\]$/.exec(selector);
      return match ? { click: () => clicked.push(match[1]) } : null;
    },
    createElement: (/** @type {string} */ tag) => ({ tag, className: '', textContent: '', setAttribute() {} }),
    addEventListener: (/** @type {string} */ type, /** @type {(event: any) => void} */ listener) =>
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]),
  };
  const window = { ...(library ? { L } : {}), fetch: () => Promise.reject(new Error('offline')) };
  vm.runInNewContext(readFileSync(join(themeAssets, 'map.js'), 'utf8'), { window, document });
  const showOnMap = (/** @type {any} */ detail) => {
    for (const listener of documentListeners.get('coffer:show-on-map') ?? []) listener({ detail });
  };
  return { log, markers, classes, clicked, showOnMap, state, maps: leafletMaps };
}

const MAP_DATA = {
  tiles: { url: 'https://tiles.example/{z}/{x}/{y}.png', attribution: 'Credit', maxZoom: 18 },
  labels: { zoomIn: 'Plus', zoomOut: 'Minus', label: 'Map', photo: 'Photo {n}' },
  bounds: [[47, 11], [47.02, 11.02]],
  tracks: [],
  markers: [
    { latitude: 47.01, longitude: 11.05, precision: 'coarse', indexes: [1, 4], label: '2 photos' },
    { latitude: 47.2, longitude: 11.3, precision: 'exact', indexes: [2], label: 'The hut' },
  ],
};

test('the map script builds the map, with the tiles of the site, and marks the page as live', () => {
  const page = mapPage(MAP_DATA);
  assert.ok(page.classes.has('map-live'));
  assert.ok(page.log.includes('frame gets map-view'));
  assert.ok(page.log.includes('zoom control Plus'));
  assert.ok(page.log.includes('tiles https://tiles.example/{z}/{x}/{y}.png Credit 18'));
  assert.ok(page.log.some((entry) => entry.startsWith('fit [[47,11],[47.02,11.02]]')));
  assert.equal(page.markers.length, 2);
  assert.equal(page.markers[0].element.attributes['aria-label'], '2 photos');
  assert.match(page.markers[0].options.icon.className, /map-marker-group/);
  assert.equal(page.markers[0].options.icon.html, '2');
  assert.equal(page.markers[1].options.icon.html, '');
});

test('the map script turns off every animation of Leaflet', () => {
  const options = mapPage(MAP_DATA).maps[0].options;
  for (const name of ['zoomAnimation', 'fadeAnimation', 'markerZoomAnimation', 'inertia']) {
    assert.equal(options[name], false, name);
  }
});

test('nothing in the styles of the map animates, and the transitions of Leaflet apply only to classes it adds while animating', () => {
  const strip = (/** @type {string} */ text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const mine = strip(readFileSync(join(themeAssets, 'map.css'), 'utf8'));
  assert.doesNotMatch(mine, /@keyframes|scroll-behavior\s*:\s*smooth/);
  // The only animation property the map styles may hold switches Leaflet's transitions off.
  for (const match of mine.matchAll(/(^|[\s{;])(animation|transition)[a-z-]*\s*:\s*([^;}]*)/g)) {
    assert.equal(match[3].trim(), 'none', match[0]);
  }
  assert.match(mine, /\.coffer-map \.map-view \.leaflet-zoom-animated[^{]*\{[^}]*transition:\s*none/);
  // Leaflet's style sheet: every transition sits in a rule for the classes
  // that the map gets only while it animates a zoom, a pan or a fade, which
  // the script turns off (see the test above).
  const leaflet = strip(readFileSync(join(themeAssets, 'vendor', 'leaflet', 'leaflet.css'), 'utf8'));
  for (const rule of leaflet.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/transition\s*:/.test(rule[2]) || /transition\s*:\s*none/.test(rule[2])) continue;
    assert.match(rule[1], /leaflet-(fade|zoom|pan)-anim\b/, rule[1].trim());
  }
});

test('without Leaflet the map script leaves the drawing alone', () => {
  const page = mapPage(MAP_DATA, { library: false });
  assert.ok(!page.classes.has('map-live'));
  assert.deepEqual(page.log, []);
});

test('a click on a marker opens its first photo in the viewer', () => {
  const page = mapPage(MAP_DATA);
  page.markers[0].click();
  page.markers[1].click();
  assert.deepEqual(page.clicked, ['1', '2']);
});

test('"show on map" scrolls to the map, centres on the marker and opens it', () => {
  const page = mapPage(MAP_DATA);
  page.log.length = 0;
  page.showOnMap({ index: 4, latitude: 47.01, longitude: 11.05 });
  assert.deepEqual(page.log, ['scroll', 'view 47.01,11.05 14', 'focus', 'tooltip open 2 photos']);
  assert.ok(page.markers[0].element.classes.has('is-selected'));
  // Another photo moves the selection.
  page.log.length = 0;
  page.showOnMap({ index: 2, latitude: 47.2, longitude: 11.3 });
  assert.ok(!page.markers[0].element.classes.has('is-selected'));
  assert.ok(page.markers[1].element.classes.has('is-selected'));
  assert.ok(page.log.includes('tooltip close 2 photos') && page.log.includes('tooltip open The hut'));
});

test('"show on map" for a photo the map leaves out still shows its place', () => {
  const page = mapPage(MAP_DATA);
  page.showOnMap({ index: 6, latitude: 46.5, longitude: 10.5 });
  assert.equal(page.markers.length, 3);
  assert.deepEqual([...page.markers[2].latlng], [46.5, 10.5]);
  assert.equal(page.markers[2].tooltip.textContent, 'Photo 7');
});

test('a map made while its box had no size is fitted again when the box gets one', () => {
  const page = mapPage(MAP_DATA, { size: { x: 0, y: 0 } });
  const fits = () => page.log.filter((entry) => entry.startsWith('fit ')).length;
  assert.equal(fits(), 1);
  page.maps[0].fire('resize');
  assert.equal(fits(), 1, 'still no size');
  page.state.size = { x: 600, y: 400 };
  page.maps[0].fire('resize');
  assert.equal(fits(), 2);
  page.maps[0].fire('resize');
  assert.equal(fits(), 2, 'only once');
});
