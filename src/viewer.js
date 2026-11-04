/**
 * The fullscreen image viewer of the default theme: which files a page loads
 * for it and how the list of images is handed to the script.
 */

/** Scripts of the viewer, in the order they run: PhotoSwipe, its lightbox, then the engine's glue. */
export const VIEWER_SCRIPTS = Object.freeze([
  '/assets/vendor/photoswipe/photoswipe.umd.min.js',
  '/assets/vendor/photoswipe/photoswipe-lightbox.umd.min.js',
  '/assets/viewer.js',
]);

/** Style sheets of the viewer: PhotoSwipe's, then the engine's additions. */
export const VIEWER_STYLES = Object.freeze(['/assets/vendor/photoswipe/photoswipe.css', '/assets/viewer.css']);

/** The `id` of the element that holds the list of images, which `viewer.js` reads. */
export const VIEWER_DATA_ID = 'coffer-viewer';

/**
 * The words of the viewer.
 *
 * @typedef {object} ViewerLabels
 * @property {string} close
 * @property {string} zoom
 * @property {string} previous
 * @property {string} next
 * @property {string} error Shown in place of an image that cannot be loaded.
 * @property {string} showOnMap Name of the button that shows the position of an image on the map of the page.
 */

/** Characters that must not appear as they are inside a `<script>` element holding JSON. */
const UNSAFE_CHARACTERS = ['<', String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/**
 * The JSON of the viewer's list of images (see {@link jsonForScript}).
 *
 * @param {{ labels: ViewerLabels, images: import('./markdown/render.js').ViewerImage[] }} data
 * @returns {string}
 */
export function viewerJson(data) {
  return jsonForScript(data);
}

/**
 * Turns data into JSON that is safe inside a `<script>` element: `<` and the
 * two line separators that JavaScript treats as line ends are written as
 * `\uXXXX` escapes, which JSON reads back as the same characters, so the text
 * can neither close the element nor start a comment.
 *
 * @param {unknown} data
 * @returns {string}
 */
export function jsonForScript(data) {
  const backslash = String.fromCharCode(92);
  let json = JSON.stringify(data);
  for (const character of UNSAFE_CHARACTERS) {
    const code = (character.codePointAt(0) ?? 0).toString(16).padStart(4, '0');
    json = json.split(character).join(`${backslash}u${code}`);
  }
  return json;
}
