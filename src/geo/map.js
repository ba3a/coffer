/**
 * The maps of posts: which tracks and photos a map shows, the markers that
 * stand for the photos, and the data the map script reads from the page.
 *
 * Everything here is pure; `build.js` feeds it the tracks and the images of a
 * post and writes the result into the page with the template `map.njk`.
 */

/** Scripts of a map, in the order they run: Leaflet, then the engine's glue. */
export const MAP_SCRIPTS = Object.freeze(['/assets/vendor/leaflet/leaflet.js', '/assets/map.js']);

/** Style sheets of a map: Leaflet's, then the engine's (which also styles the drawing used without scripts). */
export const MAP_STYLES = Object.freeze(['/assets/vendor/leaflet/leaflet.css', '/assets/map.css']);

/** The tile server of a site that names none: OpenStreetMap's own, which needs no key. */
export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** The credit the OpenStreetMap licence asks for, shown in the corner of the map. */
export const DEFAULT_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The deepest zoom the default tile server serves. */
export const DEFAULT_MAX_ZOOM = 19;

/**
 * Which of the tracks or photos of a post one map shows.
 *
 * @typedef {{ mode: 'all' } | { mode: 'none' } | { mode: 'list', names: string[] }} MapSelection
 */

/** @type {MapSelection} */
export const SELECT_ALL = Object.freeze({ mode: 'all' });

/**
 * A photo that can be a marker: an image of the post that the viewer opens and
 * that publishes a position.
 *
 * @typedef {object} MapPhoto
 * @property {number} index Place of the image in the list of the viewer; the marker opens it.
 * @property {string} address The address of the image as written in the text.
 * @property {string} src Address of the full-size file.
 * @property {number} latitude Published latitude (rounded when the policy is `coarse`).
 * @property {number} longitude Published longitude (rounded when the policy is `coarse`).
 * @property {'exact' | 'coarse'} precision
 * @property {string} alt
 * @property {string} caption
 */

/**
 * One marker: all photos published at the same point share it.
 *
 * @typedef {object} MapMarker
 * @property {number} latitude
 * @property {number} longitude
 * @property {'exact' | 'coarse'} precision
 * @property {number[]} indexes The viewer indexes of the photos, in document order; a click opens the first.
 * @property {string} src Address of the full-size file of the first photo, for the drawing used without scripts.
 * @property {string} label The name of the marker: the alt text of its photo, else the caption, else "Photo n"; for several photos, their number.
 */

/**
 * Reads the value of the `tracks` or `photos` attribute of a `::map` directive:
 * `all`, `none`, or a comma-separated list of names.
 *
 * @param {string | null | undefined} value Null or undefined when the attribute is missing.
 * @returns {MapSelection}
 * @throws {Error} For an empty list.
 */
export function parseSelection(value) {
  if (value === undefined || value === null) return SELECT_ALL;
  const text = value.trim();
  if (text === 'all') return SELECT_ALL;
  if (text === 'none') return { mode: 'none' };
  const names = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return failEmpty();
  return { mode: 'list', names };
}

/** @returns {never} */
function failEmpty() {
  throw new Error('must be "all", "none" or a comma-separated list of names');
}

/**
 * The path of an image address without a query, a fragment or a leading "./",
 * percent escapes decoded; the form in which an address is compared.
 *
 * @param {string} address
 * @returns {string}
 */
export function normalizeAddress(address) {
  const cut = address.search(/[?#]/);
  let path = cut < 0 ? address : address.slice(0, cut);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the address as written.
  }
  while (path.startsWith('./')) path = path.slice(2);
  return path;
}

/**
 * Whether a name given in a `photos` list means an image address: the whole
 * address, or just the file name.
 *
 * @param {string} name
 * @param {string} address
 * @returns {boolean}
 */
function namesImage(name, address) {
  const wanted = normalizeAddress(name);
  const path = normalizeAddress(address);
  return wanted === path || wanted === path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Whether a name given in a `tracks` list means a track: its file name with or
 * without ".gpx".
 *
 * @param {string} name
 * @param {string} trackName The file name of the track without its extension.
 * @returns {boolean}
 */
function namesTrack(name, trackName) {
  return name === trackName || name.replace(/\.gpx$/i, '') === trackName;
}

/**
 * Picks what one map shows.
 *
 * @template {{ name: string }} T
 * @param {object} input
 * @param {T[]} input.tracks Every track of the post.
 * @param {MapPhoto[]} input.photos Every located photo of the post that the viewer opens.
 * @param {string[]} input.images The addresses of all images of the text, located or not; a name in a `photos` list that matches none of them is a mistake.
 * @param {MapSelection} input.selectTracks
 * @param {MapSelection} input.selectPhotos
 * @returns {{ tracks: T[], photos: MapPhoto[], problems: string[] }} The problems are messages for names that match nothing.
 */
export function selectMapContent({ tracks, photos, images, selectTracks, selectPhotos }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {T[]} */
  let chosenTracks = [];
  if (selectTracks.mode === 'all') chosenTracks = tracks;
  else if (selectTracks.mode === 'list') {
    for (const name of selectTracks.names) {
      if (!tracks.some((track) => namesTrack(name, track.name))) {
        const known = tracks.map((track) => `${track.name}.gpx`).join(', ');
        problems.push(
          `tracks: "${name}" is not a track of this post${known === '' ? ' (the post has no tracks)' : ` (the tracks are ${known})`}`,
        );
      }
    }
    chosenTracks = tracks.filter((track) => selectTracks.names.some((name) => namesTrack(name, track.name)));
  }
  /** @type {MapPhoto[]} */
  let chosenPhotos = [];
  if (selectPhotos.mode === 'all') chosenPhotos = photos;
  else if (selectPhotos.mode === 'list') {
    for (const name of selectPhotos.names) {
      if (!images.some((address) => namesImage(name, address))) {
        problems.push(`photos: "${name}" is not an image of this post`);
      }
    }
    chosenPhotos = photos.filter((photo) => selectPhotos.names.some((name) => namesImage(name, photo.address)));
  }
  return { tracks: chosenTracks, photos: chosenPhotos, problems };
}

/**
 * Turns photos into markers. Photos published at the same point (all of a
 * place, when the policy is `coarse`) share one marker, so that none hides
 * another.
 *
 * @param {MapPhoto[]} photos
 * @param {(count: number) => string} countLabel The name of a marker with several photos.
 * @param {(n: number) => string} photoLabel The name of a photo without alt text and caption, given its number in the post.
 * @returns {MapMarker[]}
 */
export function markersFor(photos, countLabel, photoLabel) {
  /** @type {Map<string, MapPhoto[]>} */
  const groups = new Map();
  for (const photo of photos) {
    const key = `${photo.latitude},${photo.longitude}`;
    const group = groups.get(key);
    if (group) group.push(photo);
    else groups.set(key, [photo]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0];
    const named = first.alt.trim() || first.caption.trim() || photoLabel(first.index + 1);
    return {
      latitude: first.latitude,
      longitude: first.longitude,
      // Exact only when every photo of the point is.
      precision: group.every((photo) => photo.precision === 'exact') ? 'exact' : 'coarse',
      indexes: group.map((photo) => photo.index),
      src: first.src,
      label: group.length === 1 ? named : countLabel(group.length),
    };
  });
}

/**
 * The box around tracks and markers.
 *
 * @param {{ summary: { bounds: [number, number, number, number] } }[]} tracks
 * @param {{ latitude: number, longitude: number }[]} markers
 * @returns {[number, number, number, number] | null} West, south, east and north in degrees; null for an empty map.
 */
export function boundsOf(tracks, markers) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const track of tracks) {
    const [w, s, e, n] = track.summary.bounds;
    west = Math.min(west, w);
    south = Math.min(south, s);
    east = Math.max(east, e);
    north = Math.max(north, n);
  }
  for (const marker of markers) {
    west = Math.min(west, marker.longitude);
    south = Math.min(south, marker.latitude);
    east = Math.max(east, marker.longitude);
    north = Math.max(north, marker.latitude);
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/**
 * Whether a tile address can be filled in by the map: it is an `http` or
 * `https` address that names the zoom level and the tile.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isTileUrl(url) {
  return /^https?:\/\/\S+$/i.test(url) && ['{z}', '{x}', '{y}'].every((part) => url.includes(part));
}

/**
 * The words of a distance, an elevation and the like, as the page shows them.
 *
 * @param {string} lang
 * @param {number} meters
 * @returns {{ unit: 'km' | 'm', value: string }} A length below a kilometre is shown in metres, a longer one in kilometres with one decimal place.
 */
export function formatLength(lang, meters) {
  if (meters < 1000) {
    return { unit: 'm', value: new Intl.NumberFormat(lang, { maximumFractionDigits: 0 }).format(Math.round(meters)) };
  }
  return {
    unit: 'km',
    value: new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(meters / 1000),
  };
}
