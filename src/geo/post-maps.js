/**
 * The maps of one post: decides whether the post has any, which tracks and
 * photos each one shows, and writes them into the page.
 */

import { jsonForScript, shiftViewerIndexes } from '../viewer.js';
import { MAP_PLACEHOLDER_ATTRIBUTE } from '../markdown/directives/map.js';
import { SELECT_ALL, boundsOf, formatLength, markersFor, selectMapContent } from './map.js';
import { TRACK_COLORS, renderStaticMap } from './static-map.js';

/** Matches the placeholder the renderer leaves for a `::map` directive. */
const PLACEHOLDER_RE = new RegExp(`<div ${MAP_PLACEHOLDER_ATTRIBUTE}="(\\d+)"></div>`, 'g');

/**
 * Removes the placeholders of `::map` directives: for readers of the text that
 * cannot show a map, such as feed readers and the description of a page.
 *
 * @param {string} html
 * @returns {string}
 */
export function withoutMapPlaceholders(html) {
  return html.replace(PLACEHOLDER_RE, '');
}

/**
 * What one map of a post shows, as the manifest lists it.
 *
 * @typedef {object} ManifestMap
 * @property {string[]} tracks Site-relative addresses of the GPX files of the tracks it shows.
 * @property {number} photos Number of photos it shows.
 * @property {{ latitude: number, longitude: number, precision: 'exact' | 'coarse', photos: number[] }[]} markers The markers, one per point (photos published at the same point share one): the published position, whether it is exact or rounded, and the places of its photos in the viewer's list of images.
 */

/**
 * A map that is shown, and the data its page carries.
 *
 * @typedef {object} PostMap
 * @property {ManifestMap} summary
 * @property {string} html The markup of the map.
 */

/**
 * @typedef {object} PostMapsInput
 * @property {string} lang Language of the site.
 * @property {string} basePath Path prefix of the site (empty at the root).
 * @property {import('../config.js').MapConfig} tiles The tiles of the site.
 * @property {import('../render/templates.js').TemplateEngine} templates
 * @property {import('../markdown/render.js').RenderResult} rendered The post's text.
 * @property {import('./gpx.js').LoadedTrack[]} tracks The post's tracks.
 * @property {string} url Site-relative address of the post, ending in a slash.
 * @property {boolean} enabled False when the post's front matter says `map: false`.
 * @property {number} [viewerOffset] Number of images the page lists in its viewer before this text (default 0). A list page shows several posts; the image links and the markers of this post then count on from there.
 */

/**
 * @typedef {object} PostMapsResult
 * @property {string} html The text of the post with its maps: each `::map` directive replaced by a map, or, when the text has none, one map at the end.
 * @property {string} feedHtml The text of the post for places that cannot show a map: the same text without the placeholders.
 * @property {PostMap[]} maps The maps in the order they appear; empty when the post has none.
 * @property {{ message: string, line?: number, column?: number }[]} problems Mistakes in the `::map` directives.
 * @property {string[]} warnings Directives that show nothing.
 */

/**
 * Builds the maps of a post.
 *
 * A post gets a map when it has at least one track or at least one image with
 * a published position (the location policy `keep` or `coarse`); otherwise it
 * gets none. The map goes where a `::map` directive stands, or at the end of
 * the text when there is none. `map: false` in the front matter suppresses all.
 *
 * @param {PostMapsInput} input
 * @returns {PostMapsResult}
 */
export function renderPostMaps({ lang, basePath, tiles, templates, rendered, tracks, url, enabled, viewerOffset = 0 }) {
  const { translator } = templates;
  /** @type {PostMapsResult['problems']} */
  const problems = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {PostMap[]} */
  const maps = [];
  const feedHtml = withoutMapPlaceholders(rendered.html);
  const bodyHtml = shiftViewerIndexes(rendered.html, viewerOffset);

  /** The photos that can be markers: images the viewer opens and that publish a position. */
  const photos = rendered.viewerImages.flatMap((image, index) =>
    image.latitude !== undefined && image.longitude !== undefined && image.precision !== undefined
      ? [
          {
            index: index + viewerOffset,
            address: rendered.viewerSources[index] ?? '',
            src: image.src,
            latitude: image.latitude,
            longitude: image.longitude,
            precision: image.precision,
            alt: image.alt,
            caption: image.caption,
          },
        ]
      : [],
  );
  const imageAddresses = rendered.images.map((image) => image.src);

  /**
   * @param {{ tracks: import('./map.js').MapSelection, photos: import('./map.js').MapSelection }} selection
   * @param {{ line?: number, column?: number } | null} where The directive, or null for the map at the end.
   * @returns {PostMap | null}
   */
  const build = (selection, where) => {
    const chosen = selectMapContent({
      tracks,
      photos,
      images: imageAddresses,
      selectTracks: selection.tracks,
      selectPhotos: selection.photos,
    });
    for (const message of chosen.problems) problems.push({ message: `::map ${message}`, ...(where ?? {}) });
    const markers = markersFor(
      chosen.photos,
      (count) => translator.t('map.photos', { count }),
      (n) => translator.t('map.photo', { n }),
    );
    const bounds = boundsOf(chosen.tracks, markers);
    if (bounds === null) {
      if (where !== null && chosen.problems.length === 0) {
        warnings.push(
          `${where.line === undefined ? '' : `line ${where.line}: `}the ::map directive shows nothing: the post has no track or located photo that it selects`,
        );
      }
      return null;
    }
    const [west, south, east, north] = bounds;
    const trackUrl = (/** @type {string} */ name, /** @type {string} */ extension) =>
      `${url}${encodeURIComponent(name)}.${extension}`;
    const svg = renderStaticMap({
      tracks: chosen.tracks.map((track) => ({
        lines: track.summary.geojson.features.flatMap((feature) => feature.geometry.coordinates),
      })),
      markers,
      bounds,
      label: translator.t('map.drawing'),
    });
    const numbers = new Intl.NumberFormat(lang, { maximumFractionDigits: 0 });
    const data = jsonForScript({
      tiles: { url: tiles.tileUrl, attribution: tiles.attribution, maxZoom: tiles.maxZoom },
      labels: {
        zoomIn: translator.t('map.zoom_in'),
        zoomOut: translator.t('map.zoom_out'),
        label: translator.t('map.label'),
        // The script puts the number of the photo in place of {n}.
        photo: translator.t('map.photo', { n: '{n}' }),
      },
      bounds: [
        [south, west],
        [north, east],
      ],
      tracks: chosen.tracks.map((track, position) => ({
        title: track.summary.title,
        geojson: `${basePath}${trackUrl(track.name, 'geojson')}`,
        color: position % TRACK_COLORS,
      })),
      markers: markers.map(({ latitude, longitude, precision, indexes, label }) => ({
        latitude,
        longitude,
        precision,
        indexes,
        label,
      })),
    });
    const html = templates.render('map.njk', {
      map: {
        svg,
        data,
        tracks: chosen.tracks.map((track, position) => ({
          title: track.summary.title,
          gpx: trackUrl(track.name, 'gpx'),
          color: position % TRACK_COLORS,
          distance: formatLength(lang, track.summary.distance),
          gain: track.summary.elevationGain === null ? null : numbers.format(Math.round(track.summary.elevationGain)),
          highest: track.summary.highest === null ? null : numbers.format(Math.round(track.summary.highest.elevation)),
        })),
      },
    });
    return {
      summary: {
        tracks: chosen.tracks.map((track) => trackUrl(track.name, 'gpx')),
        photos: chosen.photos.length,
        markers: markers.map(({ latitude, longitude, precision, indexes }) => ({
          latitude,
          longitude,
          precision,
          photos: indexes,
        })),
      },
      html,
    };
  };

  if (!enabled) return { html: shiftViewerIndexes(feedHtml, viewerOffset), feedHtml, maps, problems, warnings };

  if (rendered.maps.length === 0) {
    const map = build({ tracks: SELECT_ALL, photos: SELECT_ALL }, null);
    if (map === null) return { html: bodyHtml, feedHtml, maps, problems, warnings };
    maps.push(map);
    return { html: `${bodyHtml}\n${map.html}`, feedHtml, maps, problems, warnings };
  }

  /** @type {Map<number, string>} */
  const placed = new Map();
  for (const directive of rendered.maps) {
    const map = build(directive, { line: directive.line, column: directive.column });
    if (map !== null) maps.push(map);
    placed.set(directive.index, map === null ? '' : map.html);
  }
  const html = bodyHtml.replace(PLACEHOLDER_RE, (_match, index) => placed.get(Number(index)) ?? '');
  return { html, feedHtml, maps, problems, warnings };
}
