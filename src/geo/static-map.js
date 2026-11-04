/**
 * The drawing of a map that needs no script: tracks and photo points as an
 * inline SVG, projected to the box around them. It is what a visitor without
 * JavaScript sees in place of the map; the map script hides it when it takes
 * over.
 *
 * There is no map underneath, only the lines and the points, so the drawing
 * is a sketch of the route, not a replacement for the tiles. Colours come from
 * the style sheet (`map.css`), which is why the elements carry classes and no
 * colours.
 */

import { escapeXmlAttribute as escapeText } from '../xml.js';

/** Width of the drawing's coordinate system. */
const WIDTH = 800;
/** The drawing is never flatter or taller than this share of its width. */
const MIN_RATIO = 0.4;
const MAX_RATIO = 1;
/** Free space around the content, in drawing units. */
const PADDING = 36;
/** Smallest extent that is drawn, in degrees: a single point is not zoomed in without end. */
const MIN_SPAN = 0.004;

/** Number of colours a style sheet gives to tracks; the tracks of a map take them in turn. */
export const TRACK_COLORS = 4;

/**
 * @param {number} value
 * @returns {string}
 */
function fixed(value) {
  return (Math.round(value * 10) / 10).toString();
}

/**
 * Draws tracks and photo points.
 *
 * @param {object} input
 * @param {{ lines: number[][][] }[]} input.tracks The lines of each track as lists of `[longitude, latitude, ...]`.
 * @param {{ latitude: number, longitude: number, src: string, label: string }[]} input.markers
 * @param {[number, number, number, number]} input.bounds West, south, east and north in degrees of everything drawn.
 * @param {string} input.label The name of the drawing for screen readers.
 * @returns {string} The `<svg>` element.
 */
export function renderStaticMap({ tracks, markers, bounds, label }) {
  const [west, south, east, north] = bounds;
  const centerLongitude = (west + east) / 2;
  const centerLatitude = (south + north) / 2;
  // Degrees of longitude get shorter towards the poles; this keeps the shape of the route.
  const scaleX = Math.cos((centerLatitude * Math.PI) / 180) || 1e-6;
  const spanX = Math.max((east - west) * scaleX, MIN_SPAN * scaleX);
  const spanY = Math.max(north - south, MIN_SPAN);
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, spanY / spanX));
  const height = Math.round(WIDTH * ratio);
  const scale = Math.min((WIDTH - 2 * PADDING) / spanX, (height - 2 * PADDING) / spanY);
  /**
   * @param {number} longitude
   * @param {number} latitude
   * @returns {string}
   */
  const point = (longitude, latitude) =>
    `${fixed(WIDTH / 2 + (longitude - centerLongitude) * scaleX * scale)},${fixed(height / 2 - (latitude - centerLatitude) * scale)}`;

  const parts = [];
  tracks.forEach((track, index) => {
    for (const line of track.lines) {
      parts.push(
        `<polyline class="map-track-line map-track-${index % TRACK_COLORS}" points="${line.map(([longitude, latitude]) => point(longitude, latitude)).join(' ')}"/>`,
      );
    }
  });
  for (const marker of markers) {
    const [x, y] = point(marker.longitude, marker.latitude).split(',');
    parts.push(
      `<a href="${escapeText(marker.src)}" aria-label="${escapeText(marker.label)}"><circle class="map-point" cx="${x}" cy="${y}" r="9"><title>${escapeText(marker.label)}</title></circle></a>`,
    );
  }
  return (
    `<svg class="map-drawing" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeText(label)}" preserveAspectRatio="xMidYMid meet">` +
    parts.join('') +
    '</svg>'
  );
}
