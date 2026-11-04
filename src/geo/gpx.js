import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseXml, XmlError } from '../xml.js';

/**
 * GPX tracks: reading them, simplifying them for display and summarizing them.
 *
 * A GPX file is parsed with the strict XML reader of the engine (`../xml.js`),
 * so no dependency is needed. The file itself is published unchanged for
 * download; what the map draws is a simplified copy of the geometry, and the
 * summary (distance, elevation gain, highest point) is computed from the full
 * track.
 */

/** Mean radius of the Earth in metres, as used by the haversine formula. */
export const EARTH_RADIUS_METERS = 6_371_008.8;

/** Default tolerance of the simplification, in metres: the drawn line never strays further from the recorded one. */
export const DEFAULT_TOLERANCE_METERS = 10;

/** Default smoothing threshold of the elevation gain, in metres: smaller ups and downs are noise. */
export const DEFAULT_ELEVATION_THRESHOLD_METERS = 3;

/**
 * A recorded position.
 *
 * @typedef {object} GpxPoint
 * @property {number} latitude Degrees north, -90 to 90.
 * @property {number} longitude Degrees east, -180 to 180.
 * @property {number | null} elevation Metres above sea level, or null when the point has none.
 */

/**
 * A track as written in the file: its name and its segments of points.
 *
 * @typedef {object} GpxTrack
 * @property {string | null} name
 * @property {GpxPoint[][]} segments
 */

/**
 * @typedef {object} ParsedGpx
 * @property {string | null} name The name of the file's metadata, or null.
 * @property {GpxTrack[]} tracks The tracks (`trk`) and routes (`rte`) of the file, in file order.
 */

/**
 * The highest point of a track.
 *
 * @typedef {object} HighestPoint
 * @property {number} elevation Metres above sea level.
 * @property {number} latitude
 * @property {number} longitude
 */

/**
 * What is known about one GPX file once it is read.
 *
 * @typedef {object} TrackSummary
 * @property {string} title Title given in front matter, else the name inside the file, else the file name without its extension.
 * @property {number} distance Length in metres, measured along the recorded points (haversine).
 * @property {number | null} elevationGain Total climb in metres with small ups and downs smoothed away, or null when the file has no elevations.
 * @property {HighestPoint | null} highest The highest point, or null when the file has no elevations.
 * @property {number} points Number of recorded points.
 * @property {number} simplifiedPoints Number of points of the simplified geometry.
 * @property {[number, number, number, number]} bounds West, south, east and north of the track in degrees.
 * @property {GeoJsonFeatureCollection} geojson The simplified geometry, one feature per track.
 */

/**
 * @typedef {object} GeoJsonFeatureCollection
 * @property {'FeatureCollection'} type
 * @property {{ type: 'Feature', properties: { name: string, title: string }, geometry: { type: 'MultiLineString', coordinates: number[][][] } }[]} features
 */

/**
 * Raised for a GPX file that cannot be used. The message starts with the file.
 */
export class GpxError extends Error {
  /**
   * @param {string} file The file as it should be shown.
   * @param {string} reason What is wrong, without the file.
   */
  constructor(file, reason) {
    super(`${file}: ${reason}`);
    this.name = 'GpxError';
    this.file = file;
    this.reason = reason;
  }
}

/**
 * @param {number} degrees
 * @returns {number}
 */
function radians(degrees) {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two positions, by the haversine formula.
 *
 * @param {{ latitude: number, longitude: number }} a
 * @param {{ latitude: number, longitude: number }} b
 * @returns {number} Metres.
 */
export function haversineDistance(a, b) {
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Length of a line along its points.
 *
 * @param {readonly { latitude: number, longitude: number }[]} points
 * @returns {number} Metres.
 */
export function lineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineDistance(points[index - 1], points[index]);
  }
  return total;
}

/**
 * Simplifies a line with the Douglas-Peucker algorithm: points are dropped as
 * long as the line through the remaining ones stays within `tolerance` metres
 * of every dropped point. The first and the last point are always kept. Works
 * on a flat local projection, which is exact enough for the size of a track.
 *
 * @template {{ latitude: number, longitude: number }} P
 * @param {readonly P[]} points
 * @param {number} tolerance Metres; 0 keeps every point that is not on the line.
 * @returns {P[]} The kept points, in order.
 */
export function simplifyLine(points, tolerance) {
  if (points.length <= 2) return [...points];
  // Metres east and north of the first point; the longitude scale is taken at
  // the middle latitude of the line.
  let lowest = Infinity;
  let highest = -Infinity;
  for (const point of points) {
    lowest = Math.min(lowest, point.latitude);
    highest = Math.max(highest, point.latitude);
  }
  const middle = (lowest + highest) / 2;
  const northScale = radians(1) * EARTH_RADIUS_METERS;
  const eastScale = northScale * Math.cos(radians(middle));
  const xs = points.map((point) => (point.longitude - points[0].longitude) * eastScale);
  const ys = points.map((point) => (point.latitude - points[0].latitude) * northScale);

  /** @param {number} index @param {number} from @param {number} to */
  const distanceToChord = (index, from, to) => {
    const dx = xs[to] - xs[from];
    const dy = ys[to] - ys[from];
    const px = xs[index] - xs[from];
    const py = ys[index] - ys[from];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px, py);
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared));
    return Math.hypot(px - t * dx, py - t * dy);
  };

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // An explicit stack instead of recursion: a track can have a hundred thousand points.
  /** @type {[number, number][]} */
  const stack = [[0, points.length - 1]];
  for (let range = stack.pop(); range !== undefined; range = stack.pop()) {
    const [from, to] = range;
    let farthest = -1;
    // Never below a micrometre, so that rounding noise on a straight line is not a bend.
    let farthestDistance = Math.max(tolerance, 1e-6);
    for (let index = from + 1; index < to; index += 1) {
      const distance = distanceToChord(index, from, to);
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([from, farthest], [farthest, to]);
    }
  }
  return points.filter((_, index) => keep[index] === 1);
}

/**
 * The total climb of a series of elevations. Recorded elevations jitter by a
 * few metres even when standing still, so a climb only counts once the
 * elevation has risen by `threshold` metres above the last reference level, and
 * the reference level follows the elevation down only after a fall of at least
 * `threshold` metres.
 *
 * @param {readonly number[]} elevations Metres, in the order of the track.
 * @param {number} [threshold]
 * @returns {number} Metres.
 */
export function elevationGain(elevations, threshold = DEFAULT_ELEVATION_THRESHOLD_METERS) {
  if (elevations.length === 0) return 0;
  let reference = elevations[0];
  let gain = 0;
  for (const elevation of elevations) {
    if (elevation - reference >= threshold) {
      gain += elevation - reference;
      reference = elevation;
    } else if (reference - elevation >= threshold) {
      reference = elevation;
    }
  }
  return gain;
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * @param {import('../xml.js').XmlElement} element
 * @param {string} local
 * @returns {import('../xml.js').XmlElement | undefined}
 */
function child(element, local) {
  return element.children.find((entry) => entry.local === local);
}

/**
 * Reads the points of a segment or a route.
 *
 * @param {import('../xml.js').XmlElement} parent
 * @param {string} pointName `trkpt` or `rtept`.
 * @param {string} file
 * @returns {GpxPoint[]}
 */
function readPoints(parent, pointName, file) {
  /** @type {GpxPoint[]} */
  const points = [];
  for (const element of parent.children) {
    if (element.local !== pointName) continue;
    const where = `<${element.name}> at line ${element.line}`;
    /** @param {string} name @param {string | undefined} value */
    const number = (name, value) => {
      if (value === undefined) throw new GpxError(file, `${where}: ${name} is missing`);
      if (!NUMBER_RE.test(value.trim())) throw new GpxError(file, `${where}: ${name} "${value}" is not a number`);
      return Number(value.trim());
    };
    const latitude = number('lat', element.attributes.lat);
    const longitude = number('lon', element.attributes.lon);
    if (latitude < -90 || latitude > 90) throw new GpxError(file, `${where}: lat ${latitude} is outside -90 to 90`);
    if (longitude < -180 || longitude > 180) throw new GpxError(file, `${where}: lon ${longitude} is outside -180 to 180`);
    const ele = child(element, 'ele');
    let elevation = null;
    if (ele !== undefined) {
      const text = ele.text.trim();
      if (!NUMBER_RE.test(text)) throw new GpxError(file, `<ele> at line ${ele.line}: "${text}" is not a number`);
      elevation = Number(text);
    }
    points.push({ latitude, longitude, elevation });
  }
  return points;
}

/**
 * Parses a GPX file: its tracks with their segments (and routes, which are read
 * as tracks of one segment), each point with its elevation when it has one.
 * Waypoints and timestamps are ignored.
 *
 * @param {string} text The content of the file.
 * @param {string} file The file as it should be shown in errors.
 * @returns {ParsedGpx}
 * @throws {GpxError} When the text is not well-formed XML, is not GPX, or has a point without a valid position.
 */
export function parseGpx(text, file) {
  /** @type {import('../xml.js').XmlElement} */
  let root;
  try {
    root = parseXml(text);
  } catch (error) {
    if (error instanceof XmlError) throw new GpxError(file, `is not well-formed XML: ${error.message}`);
    throw error;
  }
  if (root.local !== 'gpx') throw new GpxError(file, `is not a GPX file (the root element is <${root.name}>, not <gpx>)`);

  const metadata = child(root, 'metadata');
  const name = (metadata && child(metadata, 'name')?.text.trim()) || null;

  /** @type {GpxTrack[]} */
  const tracks = [];
  for (const element of root.children) {
    if (element.local === 'trk') {
      const trackName = child(element, 'name')?.text.trim() || null;
      const segments = element.children
        .filter((entry) => entry.local === 'trkseg')
        .map((segment) => readPoints(segment, 'trkpt', file));
      tracks.push({ name: trackName, segments });
    } else if (element.local === 'rte') {
      tracks.push({ name: child(element, 'name')?.text.trim() || null, segments: [readPoints(element, 'rtept', file)] });
    }
  }
  return { name, tracks };
}

/**
 * @param {number} value
 * @param {number} places
 * @returns {number}
 */
function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Reads a GPX file and works out everything a post needs from it: the summary
 * (from the recorded points) and the simplified geometry as GeoJSON.
 *
 * @param {string} text The content of the file.
 * @param {object} options
 * @param {string} options.file The file as it should be shown in errors.
 * @param {string} [options.title] Title from the front matter.
 * @param {number} [options.tolerance] Tolerance of the simplification in metres.
 * @param {number} [options.elevationThreshold] Smoothing threshold of the elevation gain in metres.
 * @returns {TrackSummary}
 * @throws {GpxError} When the file is invalid or has no line of at least two points.
 */
export function analyzeGpx(text, options) {
  const { file } = options;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_METERS;
  const threshold = options.elevationThreshold ?? DEFAULT_ELEVATION_THRESHOLD_METERS;
  const parsed = parseGpx(text, file);

  /** @type {GeoJsonFeatureCollection['features']} */
  const features = [];
  let distance = 0;
  let gain = 0;
  let hasElevation = false;
  /** @type {HighestPoint | null} */
  let highest = null;
  let points = 0;
  let simplifiedPoints = 0;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  parsed.tracks.forEach((track, index) => {
    /** @type {number[][][]} */
    const lines = [];
    for (const segment of track.segments) {
      if (segment.length < 2) continue;
      points += segment.length;
      distance += lineLength(segment);
      const elevations = segment.flatMap((point) => (point.elevation === null ? [] : [point.elevation]));
      if (elevations.length > 0) {
        hasElevation = true;
        gain += elevationGain(elevations, threshold);
      }
      for (const point of segment) {
        if (point.elevation !== null && (highest === null || point.elevation > highest.elevation)) {
          highest = { elevation: point.elevation, latitude: point.latitude, longitude: point.longitude };
        }
        west = Math.min(west, point.longitude);
        east = Math.max(east, point.longitude);
        south = Math.min(south, point.latitude);
        north = Math.max(north, point.latitude);
      }
      const kept = simplifyLine(segment, tolerance);
      simplifiedPoints += kept.length;
      lines.push(
        kept.map((point) =>
          point.elevation === null
            ? [round(point.longitude, 5), round(point.latitude, 5)]
            : [round(point.longitude, 5), round(point.latitude, 5), round(point.elevation, 1)],
        ),
      );
    }
    if (lines.length > 0) {
      features.push({
        type: 'Feature',
        properties: { name: track.name ?? `Track ${index + 1}`, title: '' },
        geometry: { type: 'MultiLineString', coordinates: lines },
      });
    }
  });

  if (features.length === 0) throw new GpxError(file, 'has no track with at least two points');

  const stem = basename(file).replace(/\.gpx$/i, '');
  const title = options.title ?? parsed.tracks.find((track) => track.name !== null)?.name ?? parsed.name ?? stem;
  for (const feature of features) feature.properties.title = title;

  return {
    title,
    distance,
    elevationGain: hasElevation ? gain : null,
    highest,
    points,
    simplifiedPoints,
    bounds: [west, south, east, north],
    geojson: { type: 'FeatureCollection', features },
  };
}

/**
 * A GPX file of a post, read and analyzed.
 *
 * @typedef {object} LoadedTrack
 * @property {string} path Absolute path of the file.
 * @property {string} name File name without the extension; the published files are `{name}.gpx` and `{name}.geojson`.
 * @property {Buffer} bytes The file exactly as it is on disk, for publishing unchanged.
 * @property {TrackSummary} summary
 */

/**
 * One entry of a post's `tracks:` list.
 *
 * @typedef {object} ListedTrack
 * @property {string} file File name beside the post.
 * @property {string | null} title
 */

/**
 * Finds, reads and analyzes the GPX files of a post. Without a list every
 * `*.gpx` file in `dir` is used, in name order; with a list only the listed
 * files, in the order given. Every problem is collected, so one build reports
 * all broken files.
 *
 * @param {object} options
 * @param {string} options.dir Directory holding the post's files.
 * @param {readonly ListedTrack[] | null} options.listed The front matter `tracks:`, or null to use every GPX file in `dir`.
 * @param {(path: string) => string} options.show How a path is shown in an error.
 * @param {number} [options.tolerance]
 * @param {number} [options.elevationThreshold]
 * @returns {{ tracks: LoadedTrack[], errors: GpxError[] }}
 */
export function loadTracks({ dir, listed, show, tolerance, elevationThreshold }) {
  /** @type {ListedTrack[]} */
  let entries;
  if (listed === null) {
    entries = readdirSync(dir)
      .filter((name) => /\.gpx$/i.test(name) && !name.startsWith('.') && statSync(join(dir, name)).isFile())
      .sort()
      .map((file) => ({ file, title: null }));
  } else {
    entries = [...listed];
  }

  /** @type {LoadedTrack[]} */
  const tracks = [];
  /** @type {GpxError[]} */
  const errors = [];
  /** @type {Map<string, string>} */
  const published = new Map();
  for (const entry of entries) {
    const path = join(dir, entry.file);
    const shown = show(path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(new GpxError(shown, 'is listed in "tracks" but does not exist'));
      continue;
    }
    const name = entry.file.replace(/\.gpx$/i, '');
    const earlier = published.get(name.toLowerCase());
    if (earlier !== undefined) {
      errors.push(new GpxError(shown, `would be published at the same address as ${earlier}`));
      continue;
    }
    published.set(name.toLowerCase(), shown);
    const bytes = readFileSync(path);
    try {
      const summary = analyzeGpx(bytes.toString('utf8'), {
        file: shown,
        title: entry.title ?? undefined,
        tolerance,
        elevationThreshold,
      });
      tracks.push({ path, name, bytes, summary });
    } catch (error) {
      if (!(error instanceof GpxError)) throw error;
      errors.push(error);
    }
  }
  return { tracks, errors };
}
