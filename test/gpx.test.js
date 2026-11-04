import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSites } from '../src/build.js';
import { loadConfig } from '../src/config.js';
import { parsePostSource } from '../src/content/posts.js';
import {
  EARTH_RADIUS_METERS,
  GpxError,
  analyzeGpx,
  elevationGain,
  haversineDistance,
  lineLength,
  loadTracks,
  parseGpx,
  simplifyLine,
} from '../src/geo/gpx.js';
import { run } from '../src/cli.js';
import { parseXml } from '../src/xml.js';

const NOW = new Date('2026-06-01T12:00:00Z');

// ---- A known fixture -------------------------------------------------------------------------

/** One degree of latitude along a meridian, in metres. */
const METERS_PER_DEGREE = (EARTH_RADIUS_METERS * Math.PI) / 180;

/**
 * Ten steps of 0.001 degrees of latitude due north (about 111.2 m each, so
 * 1111.95 m in all). The elevations jitter by one metre at the start (noise
 * that must not count) and then climb 30 metres to the highest point.
 */
const FIXTURE_ELEVATIONS = [100, 101, 100, 101, 100, 101, 100, 110, 120, 130, 125];
const FIXTURE_LENGTH = 0.01 * METERS_PER_DEGREE;
const FIXTURE_POINTS = FIXTURE_ELEVATIONS.map((elevation, index) => ({
  latitude: 47 + index * 0.001,
  longitude: 11,
  elevation,
}));

/**
 * @param {{ latitude: number, longitude: number, elevation: number | null }[]} points
 * @param {{ name?: string, extra?: string }} [options]
 * @returns {string}
 */
function gpxOf(points, { name = '', extra = '' } = {}) {
  const body = points
    .map(
      (point) =>
        `<trkpt lat="${point.latitude}" lon="${point.longitude}">${point.elevation === null ? '' : `<ele>${point.elevation}</ele>`}</trkpt>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
${extra}<trk>${name === '' ? '' : `<name>${name}</name>`}<trkseg>
${body}
</trkseg></trk></gpx>
`;
}

const FIXTURE = gpxOf(FIXTURE_POINTS, { name: 'Fixture hike' });

// ---- Distance, simplification and elevation --------------------------------------------------

test('the haversine distance of a meridian arc is the arc length', () => {
  const a = { latitude: 47, longitude: 11 };
  const b = { latitude: 47.01, longitude: 11 };
  assert.ok(Math.abs(haversineDistance(a, b) - FIXTURE_LENGTH) < 0.01);
  assert.equal(haversineDistance(a, a), 0);
  // A quarter of the equator is a quarter of the circumference.
  const quarter = haversineDistance({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 });
  assert.ok(Math.abs(quarter - (Math.PI / 2) * EARTH_RADIUS_METERS) < 0.01);
  assert.ok(Math.abs(lineLength(FIXTURE_POINTS) - FIXTURE_LENGTH) < 0.01);
});

test('simplifying drops points inside the tolerance and keeps the ends and the corners', () => {
  const north = (/** @type {number} */ metres, /** @type {number} */ east = 0) => ({
    latitude: 47 + metres / METERS_PER_DEGREE,
    longitude: 11 + east / (METERS_PER_DEGREE * Math.cos((47 * Math.PI) / 180)),
  });
  const straight = [0, 10, 20, 30, 40, 50].map((metres) => north(metres));
  assert.deepEqual(simplifyLine(straight, 1), [straight[0], straight[5]]);

  // A wobble of 2 m goes at a tolerance of 5 m and stays at a tolerance of 1 m.
  const wobbly = [north(0), north(10, 2), north(20), north(30, -2), north(40)];
  assert.equal(simplifyLine(wobbly, 5).length, 2);
  assert.ok(simplifyLine(wobbly, 1).length > 2, 'a wobble of 2 m is kept at a tolerance of 1 m');

  // A corner of 100 m is kept at any sensible tolerance.
  const corner = [north(0), north(100), north(100, 100)];
  assert.deepEqual(simplifyLine(corner, 20), corner);

  assert.deepEqual(simplifyLine([north(0)], 5), [north(0)]);
  assert.deepEqual(simplifyLine([], 5), []);
  assert.ok(simplifyLine(wobbly, 0).length >= simplifyLine(wobbly, 1).length, 'a tolerance of 0 keeps what is not on the line');
});

test('simplifying a very long line needs no recursion', () => {
  const points = Array.from({ length: 200_000 }, (_, index) => ({
    latitude: 47 + index * 1e-6,
    longitude: 11 + Math.sin(index / 50) * 1e-4,
  }));
  const kept = simplifyLine(points, 5);
  assert.ok(kept.length > 2 && kept.length < points.length);
  assert.equal(kept[0], points[0]);
  assert.equal(kept[kept.length - 1], points[points.length - 1]);
});

test('elevation gain ignores noise below the threshold and counts real climbs', () => {
  assert.equal(elevationGain([100, 101, 100, 101, 100, 101, 100, 110, 120, 130], 3), 30);
  // Without smoothing every wobble up counts too.
  assert.equal(elevationGain([100, 101, 100, 101, 100, 101, 100, 110, 120, 130], 0), 33);
  // Going down and up again counts the second climb in full.
  assert.equal(elevationGain([200, 150, 100, 160], 3), 60);
  // A slow climb of one metre steps adds up although each step is small.
  assert.equal(elevationGain(Array.from({ length: 21 }, (_, index) => 100 + index), 3), 18);
  assert.equal(elevationGain([], 3), 0);
  assert.equal(elevationGain([500], 3), 0);
});

// ---- Parsing ---------------------------------------------------------------------------------

test('a GPX file is read into tracks, segments and points with elevations', () => {
  const text = `<?xml version="1.0"?>
<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>The file</name></metadata>
  <wpt lat="1" lon="2"><name>ignored</name></wpt>
  <trk><name>First</name>
    <trkseg><trkpt lat="47.5" lon="11.25"><ele>1200.5</ele><time>2025-01-01T10:00:00Z</time></trkpt><trkpt lat="47.6" lon="11.3"/></trkseg>
    <trkseg><trkpt lat="-1.5" lon="-179.5"><ele>-3</ele></trkpt></trkseg>
  </trk>
  <rte><name>Planned</name><rtept lat="10" lon="20"/><rtept lat="10.5" lon="20.5"/></rte>
</gpx>`;
  const parsed = parseGpx(text, 'a.gpx');
  assert.equal(parsed.name, 'The file');
  assert.deepEqual(parsed.tracks, [
    {
      name: 'First',
      segments: [
        [
          { latitude: 47.5, longitude: 11.25, elevation: 1200.5 },
          { latitude: 47.6, longitude: 11.3, elevation: null },
        ],
        [{ latitude: -1.5, longitude: -179.5, elevation: -3 }],
      ],
    },
    {
      name: 'Planned',
      segments: [
        [
          { latitude: 10, longitude: 20, elevation: null },
          { latitude: 10.5, longitude: 20.5, elevation: null },
        ],
      ],
    },
  ]);
});

test('invalid GPX names the file and what is wrong', () => {
  /** @param {string} text @param {RegExp} reason */
  const rejects = (text, reason) =>
    assert.throws(
      () => parseGpx(text, 'content/journal/hike/bad.gpx'),
      (error) => {
        assert.ok(error instanceof GpxError);
        assert.equal(error.file, 'content/journal/hike/bad.gpx');
        assert.match(error.message, /^content\/journal\/hike\/bad\.gpx: /);
        assert.match(error.reason, reason);
        return true;
      },
    );
  rejects('this is not xml', /not well-formed XML/);
  rejects('<gpx><trk><trkseg></trk></gpx>', /not well-formed XML/);
  rejects('<kml/>', /not a GPX file.*<kml>/);
  rejects('<gpx><trk><trkseg><trkpt lat="abc" lon="1"/></trkseg></trk></gpx>', /lat "abc" is not a number/);
  rejects('<gpx><trk><trkseg><trkpt lat="1"/></trkseg></trk></gpx>', /lon is missing/);
  rejects('<gpx><trk><trkseg><trkpt lat="91" lon="1"/></trkseg></trk></gpx>', /lat 91 is outside/);
  rejects('<gpx><trk><trkseg><trkpt lat="1" lon="181"/></trkseg></trk></gpx>', /lon 181 is outside/);
  rejects('<gpx><trk><trkseg><trkpt lat="1" lon="1"><ele>high</ele></trkpt></trkseg></trk></gpx>', /"high" is not a number/);
  assert.throws(() => analyzeGpx('<gpx/>', { file: 'empty.gpx' }), /^GpxError: empty\.gpx: has no track with at least two points$/);
  assert.throws(
    () => analyzeGpx(gpxOf([{ latitude: 1, longitude: 1, elevation: null }]), { file: 'one.gpx' }),
    /one\.gpx: has no track with at least two points/,
  );
});

test('the XML reader keeps correct line numbers for a long document', () => {
  const lines = Array.from({ length: 5000 }, (_, index) => `<a n="${index}"/>`);
  const root = parseXml(`<r>\n${lines.join('\n')}\n</r>`);
  assert.equal(root.children[0].line, 2);
  assert.equal(root.children[4999].line, 5001);
  assert.equal(root.children[4999].column, 1);
});

// ---- The analysis ----------------------------------------------------------------------------

test('the summary of the fixture: distance, elevation gain and highest point', () => {
  const summary = analyzeGpx(FIXTURE, { file: 'fixture.gpx' });
  assert.ok(Math.abs(summary.distance - FIXTURE_LENGTH) < 1, `${summary.distance} is not about ${FIXTURE_LENGTH}`);
  assert.ok(Math.abs(summary.distance - 1111.95) < 1);
  assert.ok(summary.elevationGain !== null && Math.abs(summary.elevationGain - 30) < 0.001, 'the one metre jitter is not a climb');
  assert.deepEqual(summary.highest, { elevation: 130, latitude: 47.009, longitude: 11 });
  assert.equal(summary.points, 11);
  assert.equal(summary.title, 'Fixture hike');
  assert.deepEqual(summary.bounds, [11, 47, 11, 47.01]);
});

test('the track is simplified for display but summarized from every point', () => {
  const summary = analyzeGpx(FIXTURE, { file: 'fixture.gpx', tolerance: 5 });
  assert.equal(summary.simplifiedPoints, 2, 'a straight line needs two points');
  assert.deepEqual(summary.geojson, {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: 'Fixture hike', title: 'Fixture hike' },
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [11, 47, 100],
              [11, 47.01, 125],
            ],
          ],
        },
      },
    ],
  });
  assert.ok(Math.abs(summary.distance - FIXTURE_LENGTH) < 1);

  const full = analyzeGpx(FIXTURE, { file: 'fixture.gpx', tolerance: 0 });
  assert.equal(full.simplifiedPoints, 2, 'collinear points are dropped even at 0');
  const bent = gpxOf([
    { latitude: 47, longitude: 11, elevation: null },
    { latitude: 47.001, longitude: 11.0005, elevation: null },
    { latitude: 47.002, longitude: 11, elevation: null },
  ]);
  assert.equal(analyzeGpx(bent, { file: 'bent.gpx', tolerance: 10 }).simplifiedPoints, 3);
  assert.equal(analyzeGpx(bent, { file: 'bent.gpx', tolerance: 100 }).simplifiedPoints, 2);
});

test('a track without elevations has no gain and no highest point; the title falls back to the file name', () => {
  const text = gpxOf([
    { latitude: 47, longitude: 11, elevation: null },
    { latitude: 47.001, longitude: 11, elevation: null },
  ]);
  const summary = analyzeGpx(text, { file: 'content/a/lake-walk.gpx' });
  assert.equal(summary.elevationGain, null);
  assert.equal(summary.highest, null);
  assert.equal(summary.title, 'lake-walk');
  assert.deepEqual(summary.geojson.features[0].geometry.coordinates, [
    [
      [11, 47],
      [11, 47.001],
    ],
  ]);
  assert.equal(analyzeGpx(text, { file: 'x.gpx', title: 'Given' }).title, 'Given');
  const metadataOnly = gpxOf(
    [
      { latitude: 47, longitude: 11, elevation: null },
      { latitude: 47.001, longitude: 11, elevation: null },
    ],
    { extra: '<metadata><name>From metadata</name></metadata>' },
  );
  assert.equal(analyzeGpx(metadataOnly, { file: 'x.gpx' }).title, 'From metadata');
});

test('a gap between segments is not walked', () => {
  const text = `<gpx><trk><trkseg>
    <trkpt lat="47" lon="11"/><trkpt lat="47.001" lon="11"/>
  </trkseg><trkseg>
    <trkpt lat="48" lon="12"/><trkpt lat="48.001" lon="12"/>
  </trkseg></trk></gpx>`;
  const summary = analyzeGpx(text, { file: 'two.gpx' });
  assert.ok(Math.abs(summary.distance - 2 * 0.001 * METERS_PER_DEGREE) < 0.01);
  assert.deepEqual(summary.geojson.features[0].geometry.coordinates.length, 2);
});

// ---- Finding the files of a post -------------------------------------------------------------

/**
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => Promise<T> | T} body
 * @returns {Promise<T>}
 */
async function inTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), 'coffer-gpx-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content);
    }
    return await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('every *.gpx file of a folder is a track unless the post lists its own', async () => {
  await inTree({ 'b.gpx': FIXTURE, 'a.GPX': FIXTURE, 'notes.txt': 'x', 'c.gpx': 'broken' }, (dir) => {
    const show = (/** @type {string} */ path) => path.slice(dir.length + 1);
    const all = loadTracks({ dir, listed: null, show });
    assert.deepEqual(all.tracks.map((track) => track.name), ['a', 'b']);
    assert.deepEqual(all.errors.map((error) => error.message.replace(/:.*/, '')), ['c.gpx']);
    assert.match(all.errors[0].message, /^c\.gpx: is not well-formed XML/);
    assert.equal(all.tracks[0].bytes.toString('utf8'), FIXTURE, 'the bytes are the file, unchanged');

    const listed = loadTracks({
      dir,
      listed: [
        { file: 'b.gpx', title: 'Second' },
        { file: 'a.GPX', title: null },
        { file: 'gone.gpx', title: null },
      ],
      show,
    });
    assert.deepEqual(listed.tracks.map((track) => [track.name, track.summary.title]), [
      ['b', 'Second'],
      ['a', 'Fixture hike'],
    ]);
    assert.deepEqual(listed.errors.map((error) => error.message), ['gone.gpx: is listed in "tracks" but does not exist']);

    assert.deepEqual(loadTracks({ dir, listed: [], show }).tracks, []);
    const twice = loadTracks({
      dir,
      listed: [
        { file: 'a.GPX', title: null },
        { file: 'a.gpx', title: null },
      ],
      show,
    });
    assert.equal(twice.tracks.length, 1);
  });
});

// ---- Front matter ----------------------------------------------------------------------------

/** @param {string} lines */
const frontMatter = (lines) =>
  parsePostSource({ file: 'p.md', slug: 'p', text: `---\ntitle: P\ndate: 2025-01-01\n${lines}---\nBody\n` });

test('front matter lists tracks as names or as names with titles', () => {
  assert.equal(frontMatter('').tracks, null);
  assert.deepEqual(frontMatter('tracks: []\n').tracks, []);
  assert.deepEqual(frontMatter('tracks:\n  - a.gpx\n  - { file: b.gpx, title: Day two }\n').tracks, [
    { file: 'a.gpx', title: null },
    { file: 'b.gpx', title: 'Day two' },
  ]);
  /** @param {string} lines @param {RegExp} message */
  const rejects = (lines, message) => assert.throws(() => frontMatter(lines), message);
  rejects('tracks: a.gpx\n', /p\.md: tracks: must be a list/);
  rejects('tracks: [notes.txt]\n', /p\.md: tracks\[0\]: "notes\.txt" must be the name of a \.gpx file beside the post/);
  rejects('tracks: [sub/a.gpx]\n', /tracks\[0\]: "sub\/a\.gpx" must be the name/);
  rejects('tracks: [3]\n', /tracks\[0\]: must be a GPX file name/);
  rejects('tracks: [{ file: a.gpx, titel: x }]\n', /tracks\[0\]\.titel: unknown key/);
  rejects('tracks: [{ file: a.gpx, title: "" }]\n', /tracks\[0\]\.title: must be a non-empty string/);
  rejects('tracks: [a.gpx, A.gpx]\n', /tracks\[1\]: "A\.gpx" is listed twice/);
});

// ---- The build -------------------------------------------------------------------------------

/**
 * @param {string} [extra] Extra lines of the site's configuration, indented as site keys.
 * @returns {string}
 */
function configYaml(extra = '') {
  return [
    'sites:',
    '  - id: demo',
    '    baseUrl: https://demo.example',
    '    lang: en',
    '    title: Demo',
    '    contentLicense: Some rights reserved',
    '    blogs:',
    '      - { id: notes, dir: notes, prefix: log, title: Notes }',
    extra,
    '',
  ].join('\n');
}

/**
 * @param {string} title
 * @param {string} [extra] More front matter lines.
 * @returns {string}
 */
function post(title, extra = '') {
  return `---\ntitle: ${title}\ndate: 2025-05-05\n${extra}---\n\nSome words.\n`;
}

/**
 * @param {string} root
 * @returns {Promise<import('../src/build.js').SiteResult>}
 */
async function build(root) {
  const [result] = await buildSites(loadConfig({ configPath: join(root, 'coffer.yaml') }), {
    out: join(root, 'out'),
    now: NOW,
  });
  return result;
}

test('a GPX file next to a post is published unchanged and summarized', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/hike/index.md': post('Hike'),
      'notes/hike/day one.gpx': FIXTURE,
      'notes/plain.md': post('Plain'),
    },
    async (root) => {
      const result = await build(root);
      const published = join(result.outDir, 'log', 'hike', 'day one.gpx');
      assert.equal(readFileSync(published, 'utf8'), FIXTURE, 'published byte for byte');

      const geojson = JSON.parse(readFileSync(join(result.outDir, 'log', 'hike', 'day one.geojson'), 'utf8'));
      assert.equal(geojson.type, 'FeatureCollection');
      assert.equal(geojson.features[0].geometry.type, 'MultiLineString');

      const hike = result.manifest.posts.find((entry) => entry.slug === 'hike');
      assert.ok(hike);
      assert.equal(hike.tracks.length, 1);
      const [track] = hike.tracks;
      assert.equal(track.title, 'Fixture hike');
      assert.equal(track.source, 'notes/hike/day one.gpx');
      assert.equal(track.gpx, '/log/hike/day%20one.gpx');
      assert.equal(track.geojson, '/log/hike/day%20one.geojson');
      assert.equal(track.distanceMeters, 1112);
      assert.equal(track.elevationGainMeters, 30);
      assert.deepEqual(track.highest, { elevationMeters: 130, latitude: 47.009, longitude: 11 });
      assert.equal(track.points, 11);
      assert.equal(track.simplifiedPoints, 2);
      assert.deepEqual(track.bounds, [11, 47, 11, 47.01]);

      assert.deepEqual(result.manifest.posts.find((entry) => entry.slug === 'plain')?.tracks, []);
    },
  );
});

test('a post lists its tracks with titles, and a single-file post only uses the ones it lists', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/trip/index.md': post('Trip', 'tracks:\n  - { file: two.gpx, title: Day two }\n  - one.gpx\n'),
      'notes/trip/one.gpx': FIXTURE,
      'notes/trip/two.gpx': FIXTURE,
      'notes/trip/three.gpx': FIXTURE,
      'notes/single.md': post('Single', 'tracks: [mine.gpx]\n'),
      'notes/mine.gpx': FIXTURE,
      'notes/other.gpx': FIXTURE,
      'notes/nothing.md': post('Nothing'),
    },
    async (root) => {
      const result = await build(root);
      const trip = result.manifest.posts.find((entry) => entry.slug === 'trip');
      assert.deepEqual(trip?.tracks.map((track) => [track.title, track.gpx]), [
        ['Day two', '/log/trip/two.gpx'],
        ['Fixture hike', '/log/trip/one.gpx'],
      ]);
      assert.equal(readFileSync(join(result.outDir, 'log', 'single', 'mine.gpx'), 'utf8'), FIXTURE);
      assert.deepEqual(result.manifest.posts.find((entry) => entry.slug === 'nothing')?.tracks, []);
      for (const absent of [join('log', 'trip', 'three.gpx'), join('log', 'single', 'other.gpx'), join('log', 'nothing', 'other.gpx')]) {
        assert.throws(() => readFileSync(join(result.outDir, absent)), /ENOENT/);
      }
    },
  );
});

test('an invalid GPX file fails the build and the error names the file', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/hike/index.md': post('Hike'),
      'notes/hike/good.gpx': FIXTURE,
      'notes/hike/broken.gpx': '<gpx><trk><trkseg><trkpt lat="x" lon="1"/></trkseg></trk></gpx>',
      'notes/other/index.md': post('Other', 'tracks: [missing.gpx]\n'),
    },
    async (root) => {
      await assert.rejects(
        () => build(root),
        (error) => {
          assert.ok(error instanceof Error && 'errors' in error && Array.isArray(error.errors));
          assert.deepEqual(error.errors, [
            'notes/hike/broken.gpx <trkpt> at line 1: lat "x" is not a number',
            'notes/other/missing.gpx is listed in "tracks" but does not exist',
          ]);
          return true;
        },
      );
      const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
      assert.equal(report.errors.length, 2);
      assert.equal(report.errors[0].file, 'notes/hike/broken.gpx');
    },
  );
});

test('posts with tracks appear in the exact-locations report', async () => {
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/hike/index.md': post('Hike'),
      'notes/hike/a.gpx': FIXTURE,
      'notes/hike/b.gpx': FIXTURE,
      'notes/walk.md': post('Walk', 'tracks: [w.gpx]\n'),
      'notes/w.gpx': FIXTURE,
      'notes/plain.md': post('Plain'),
    },
    async (root) => {
      const result = await build(root);
      assert.deepEqual(result.exactLocations, [
        { site: 'demo', file: 'notes/hike/index.md', images: 0, tracks: 2 },
        { site: 'demo', file: 'notes/walk.md', images: 0, tracks: 1 },
      ]);
      const report = JSON.parse(readFileSync(join(root, '.coffer', 'report.json'), 'utf8'));
      assert.deepEqual(report.exactLocations, result.exactLocations);

      let out = '';
      const code = await run(['build', '--config', join(root, 'coffer.yaml'), '--out', join(root, 'cli-out'), '--now', '2026-06-01'], {
        out: (text) => (out += text),
        err: () => {},
      });
      assert.equal(code, 0);
      assert.match(out, /^Posts publishing exact locations \(2\)\n {2}notes\/hike\/index\.md: 2 track\(s\)\n {2}notes\/walk\.md: 1 track\(s\)$/m);
    },
  );
});

test('the tolerance and the elevation threshold are site settings', async () => {
  const bent = gpxOf([
    { latitude: 47, longitude: 11, elevation: 100 },
    { latitude: 47.001, longitude: 11.0005, elevation: 104 },
    { latitude: 47.002, longitude: 11, elevation: 100 },
  ]);
  await inTree(
    {
      'coffer.yaml': configYaml('    tracks: { tolerance: 100, elevationThreshold: 5 }'),
      'notes/hike/index.md': post('Hike'),
      'notes/hike/bent.gpx': bent,
    },
    async (root) => {
      const [track] = (await build(root)).manifest.posts[0].tracks;
      assert.equal(track.simplifiedPoints, 2);
      assert.equal(track.elevationGainMeters, 0, 'a climb of 4 m is below the threshold of 5 m');
    },
  );
  await inTree(
    {
      'coffer.yaml': configYaml(),
      'notes/hike/index.md': post('Hike'),
      'notes/hike/bent.gpx': bent,
    },
    async (root) => {
      const [track] = (await build(root)).manifest.posts[0].tracks;
      assert.equal(track.simplifiedPoints, 3);
      assert.equal(track.elevationGainMeters, 4);
    },
  );
});

test('the example site publishes its made-up track', async () => {
  const configPath = fileURLToPath(new URL('../example/coffer.yaml', import.meta.url));
  const [result] = await buildSites(loadConfig({ configPath }), {
    out: join(tmpdir(), `coffer-gpx-example-${process.pid}`),
    now: NOW,
    cacheDir: join(tmpdir(), `coffer-gpx-example-cache-${process.pid}`),
    reportDir: join(tmpdir(), `coffer-gpx-example-report-${process.pid}`),
  });
  try {
    const ridge = result.manifest.posts.find((entry) => entry.slug === 'ridge-walk');
    assert.ok(ridge);
    const [track] = ridge.tracks;
    assert.equal(track.title, 'Ridge loop');
    assert.equal(track.gpx, '/journal/ridge-walk/ridge-loop.gpx');
    assert.ok(track.distanceMeters > 2000 && track.distanceMeters < 20000);
    assert.ok(track.elevationGainMeters !== null && track.elevationGainMeters > 200);
    assert.ok(track.highest && track.highest.elevationMeters > 1500);
    assert.ok(track.simplifiedPoints < track.points);
    assert.ok(readFileSync(join(result.outDir, 'journal', 'ridge-walk', 'ridge-loop.gpx')).length > 1000);
  } finally {
    for (const name of ['', '-cache', '-report']) {
      rmSync(join(tmpdir(), `coffer-gpx-example${name}-${process.pid}`), { recursive: true, force: true });
    }
  }
});
