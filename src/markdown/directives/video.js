import { SKIP, visit } from 'unist-util-visit';
import { DEFAULT_VIDEO_RULES, matchVideoUrl } from '../../video/rules.js';
import { parseTimecode } from '../../video/timecode.js';
import { embedUrl, watchUrl } from '../../video/urls.js';

/**
 * The `::video` leaf directive.
 *
 * ```
 * ::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-" start="1:23" end="4:00"}
 * ::video{src="glue-up.mp4" poster="glue.jpg"}
 * ```
 *
 * It marks the place of a video in the text. The plugin turns it into an empty
 * `<div data-coffer-video="n">`, where n counts the videos of the text from 0,
 * and lists what each one shows; the build then replaces the `<div>` with the
 * video, once its preview is known.
 */

/** Name of the directive. */
export const VIDEO_DIRECTIVE = 'video';

/** The attribute of the placeholder element that holds the number of the video. */
export const VIDEO_PLACEHOLDER_ATTRIBUTE = 'data-coffer-video';

/** The attributes a video may have. */
const ATTRIBUTES = new Set(['src', 'start', 'end', 'poster', 'load', 'id']);

/** A scheme at the start of an address, such as `ftp:` or `data:`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** @type {Record<string, 'video/mp4' | 'video/webm'>} */
const LOCAL_TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm' };

/**
 * Where the videos of a text come from and how they load.
 *
 * @typedef {object} VideoOptions
 * @property {readonly import('../../video/rules.js').VideoRule[]} rules The rules that recognise remote videos, resolved (see `resolveVideoRules`).
 * @property {'click' | 'iframe'} load How remote videos load unless a video says otherwise.
 * @property {(src: string) => string | null} locateFile The site-relative URL at which the build publishes a local video, or null when the file does not exist.
 */

/** The video options of a text rendered without any. */
export const DEFAULT_VIDEO_OPTIONS = Object.freeze({
  rules: DEFAULT_VIDEO_RULES,
  load: /** @type {'click' | 'iframe'} */ ('click'),
  locateFile: (/** @type {string} */ _src) => /** @type {string | null} */ (null),
});

/**
 * Raised for a `::video` that is written wrongly; the caller turns it into a
 * located error.
 */
export class VideoSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number }} where Position in the Markdown text, as parsed.
   */
  constructor(message, where) {
    super(message);
    this.name = 'VideoSyntaxError';
    this.line = where.line;
    this.column = where.column;
  }
}

/**
 * The text of a piece of Markdown, without its markup: what a title in square
 * brackets reads as.
 *
 * @param {import('mdast').Nodes} node
 * @returns {string}
 */
function plainText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if ('children' in node) return node.children.map((child) => plainText(child)).join('');
  return '';
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function notATimecode(name, value) {
  return `${name}="${value}" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)`;
}

/**
 * Remark plugin: replaces each `::video` directive with a placeholder and
 * lists the videos, in document order, with the features their providers lack
 * as warnings. Lines are those of the text as parsed.
 *
 * @param {{ video: VideoOptions, idPrefix: string, onFound: (videos: import('../../video/types.js').VideoDirective[], warnings: import('../../video/types.js').VideoWarning[]) => void }} options
 * @returns {(tree: import('mdast').Root) => void}
 * @throws {VideoSyntaxError} for the first video that is written wrongly, in the order of the checks of the specification.
 */
export function remarkVideos({ video: settings, idPrefix, onFound }) {
  return (tree) => {
    /** @type {import('../../video/types.js').VideoDirective[]} */
    const found = [];
    /** @type {import('../../video/types.js').VideoWarning[]} */
    const warnings = [];
    /** @type {Set<string>} */
    const usedIds = new Set();

    visit(tree, 'leafDirective', (node, index, parent) => {
      if (node.name !== VIDEO_DIRECTIVE || !parent || index === undefined) return undefined;
      const line = node.position?.start.line ?? 1;
      const column = node.position?.start.column ?? 1;
      const where = { line, column };
      /** @param {string} message */
      const fail = (message) => new VideoSyntaxError(message, where);

      // V2
      const attributes = /** @type {Record<string, string | null | undefined>} */ (node.attributes ?? {});
      for (const name of Object.keys(attributes)) {
        if (!ATTRIBUTES.has(name)) {
          throw fail(`a video has no attribute "${name}" (the attributes are src, start, end, poster, load and id)`);
        }
      }
      /** @param {string} name */
      const attribute = (name) => {
        const value = attributes[name];
        return value === undefined || value === null ? null : value;
      };

      // V1
      const src = attribute('src');
      if (src === null || src === '') throw fail('a video needs src="..."');

      // V3, then V4 or V5, then V6
      /** @type {import('../../video/rules.js').VideoMatch | null} */
      let match = null;
      /** @type {{ url: string, type: 'video/mp4' | 'video/webm' } | null} */
      let file = null;
      if (src.startsWith('http://') || src.startsWith('https://')) {
        match = matchVideoUrl(src, settings.rules);
        if (match === null) throw fail(`"${src}" is not a video address that any rule knows`);
      } else if (src.startsWith('/') || SCHEME.test(src)) {
        throw fail(`src="${src}" is not allowed: a video is an http(s) address or a file beside the post`);
      } else {
        const extension = /\.[^./\\]*$/.exec(src)?.[0].toLowerCase() ?? '';
        const type = Object.hasOwn(LOCAL_TYPES, extension) ? LOCAL_TYPES[extension] : undefined;
        if (type === undefined) throw fail(`a local video must be an .mp4 or .webm file: "${src}"`);
        const url = settings.locateFile(src);
        if (url === null) throw fail(`local video "${src}" does not exist`);
        file = { url, type };
      }

      // V7, V8
      const load = attribute('load');
      if (load !== null && load !== 'click' && load !== 'iframe') throw fail('load must be "click" or "iframe"');
      if (load !== null && file !== null) throw fail('load does not apply to a local video');

      // V9, V10
      const id = attribute('id');
      if (id !== null) {
        if (!/^[a-z][a-z0-9-]*$/.test(id)) {
          throw fail('id must start with a lower-case letter and hold only lower-case letters, digits and "-"');
        }
        if (usedIds.has(id)) throw fail(`two videos have the id "${id}"`);
        usedIds.add(id);
      }

      // V11, start then end
      const startText = attribute('start');
      const startValue = startText === null ? null : parseTimecode(startText);
      if (startText !== null && startValue === null) throw fail(notATimecode('start', startText));
      const endText = attribute('end');
      const endValue = endText === null ? null : parseTimecode(endText);
      if (endText !== null && endValue === null) throw fail(notATimecode('end', endText));

      // The effective times: the attribute overrides the address.
      let start = startText === null ? (match?.start ?? null) : startValue;
      let end = endText === null ? (match?.end ?? null) : endValue;

      // W1, W2: a feature the provider lacks is dropped.
      if (match !== null) {
        if (startText !== null && !match.capabilities.start) {
          warnings.push({
            message: `${match.providerName} videos cannot start at a given time; start="${startText}" is ignored`,
            line,
            column,
          });
          start = null;
        }
        if (endText !== null && !match.capabilities.end) {
          warnings.push({
            message: `${match.providerName} videos cannot stop at a given time; end="${endText}" is ignored`,
            line,
            column,
          });
          end = null;
        }
      }

      // V12
      if (end !== null && end <= (start ?? 0)) throw fail('end must be later than start');
      if (start === 0) start = null;

      const label = plainText(/** @type {import('mdast').Nodes} */ (node)).trim();
      const videoIndex = found.length;
      found.push({
        index: videoIndex,
        source: 'directive',
        id,
        htmlId: `${idPrefix}video-${id ?? String(videoIndex + 1)}`,
        src,
        provider: match === null ? 'file' : match.provider,
        providerName: match === null ? '' : match.providerName,
        match,
        file,
        title: label === '' ? null : label,
        start,
        end,
        poster: attribute('poster'),
        load: match === null ? null : (/** @type {'click' | 'iframe' | null} */ (load) ?? settings.load),
        embedUrl: match === null ? null : embedUrl(match, { start, end, autoplay: false }),
        playUrl: match === null ? null : embedUrl(match, { start, end, autoplay: true }),
        watchUrl: match === null ? null : watchUrl(match, start),
        chapters: [],
        line,
        column,
      });
      parent.children[index] = /** @type {any} */ ({
        type: 'coffer-video',
        data: { hName: 'div', hProperties: { dataCofferVideo: String(videoIndex) } },
        children: [],
        position: node.position,
      });
      return [SKIP, index + 1];
    });
    onFound(found, warnings);
  };
}
