import { toHtml } from 'hast-util-to-html';
import { toString } from 'hast-util-to-string';
import { toHast } from 'mdast-util-to-hast';
import { SKIP, visit } from 'unist-util-visit';
import { dropComments } from '../comments.js';
import { DEFAULT_VIDEO_RULES, matchVideoUrl } from '../../video/rules.js';
import { formatTimecode, parseTimecode } from '../../video/timecode.js';
import { embedUrl, watchUrl } from '../../video/urls.js';

/**
 * The `::video` leaf directive, the `:::video` container with its chapters,
 * and a video address alone in a paragraph.
 *
 * ```
 * ::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-" start="1:23" end="4:00"}
 * ::video{src="glue-up.mp4" poster="glue.jpg"}
 *
 * :::video[Fitting the drawer]{src="https://youtu.be/aBcD3fGh1_-?t=12"}
 * - 0:12 Marking out
 * - 1:05 Sawing the *tails*
 * :::
 *
 * https://youtu.be/aBcD3fGh1_-
 * ```
 *
 * Each marks the place of a video in the text. The plugin turns it into an empty
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

/** One http(s) address, without whitespace or angle brackets. */
const ADDRESS = /^https?:\/\/[^\s<>]+$/;

/**
 * The address a paragraph consists of: its source text, trimmed, is exactly
 * one http(s) address, or one in angle brackets.
 *
 * @param {import('mdast').Paragraph} node
 * @param {string} source The Markdown text the tree was parsed from.
 * @returns {string | null} The address without angle brackets, or null when the paragraph is something else.
 */
function loneAddress(node, source) {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return null;
  let text = source.slice(from, to).trim();
  if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1);
  return ADDRESS.test(text) ? text : null;
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function notATimecode(name, value) {
  return `${name}="${value}" is not a timecode (write 83, 1:23, 1:02:03 or 1m23s)`;
}

/** The timecode at the start of a chapter, in the colon or plain-seconds form, and the blanks after it. */
const CHAPTER_TIME = /^(\d+(?::\d+){0,2})[ \t]+/;

/**
 * Joins adjacent text nodes. The parser reads the `:12` of `0:12` as a text
 * directive, which `restoreColons` turns back into a text node of its own, so a
 * timecode can be spread over several text nodes.
 *
 * @param {import('mdast').PhrasingContent[]} nodes
 * @returns {import('mdast').PhrasingContent[]}
 */
function joinTexts(nodes) {
  /** @type {import('mdast').PhrasingContent[]} */
  const joined = [];
  for (const node of nodes) {
    const last = joined.at(-1);
    if (node.type === 'text' && last?.type === 'text') {
      joined[joined.length - 1] = { type: 'text', value: last.value + node.value };
    } else {
      joined.push(node);
    }
  }
  return joined;
}

/**
 * @param {import('unist').Node} node
 * @returns {{ line: number, column: number }}
 */
function positionOf(node) {
  return { line: node.position?.start.line ?? 1, column: node.position?.start.column ?? 1 };
}

/** Phrasing content a chapter title cannot hold: the text would give it processing the title does not get. */
const NOT_IN_TITLE = new Set(['image', 'imageReference', 'footnoteReference']);

/**
 * Converts the title of a chapter to HAST the way the rest of the text is
 * converted: reference links use the definitions of the text, and HTML
 * comments are left out.
 *
 * @param {import('mdast').PhrasingContent[]} title
 * @param {import('mdast').Definition[]} definitions All the definitions of the text.
 * @returns {import('hast').ElementContent[]}
 */
function titleToHast(title, definitions) {
  const root = /** @type {import('hast').Root} */ (
    toHast({ type: 'root', children: [{ type: 'paragraph', children: title }, ...definitions] }, { allowDangerousHtml: true })
  );
  dropComments()(root);
  const paragraph = root.children.find((node) => node.type === 'element');
  return paragraph?.type === 'element' ? paragraph.children : [];
}

/**
 * Reads the chapters in the body of a `:::video` container, in the order of
 * the checks of the specification: the body is one list (V13), then each item
 * is a timecode and a title (V14), later than the one before (V15) and within
 * the part of the video that plays (V16). A title holds text, emphasis, code,
 * links and raw HTML; an image or a footnote reference in it is V14.
 *
 * @param {import('mdast').RootContent[]} body The children of the container after its label.
 * @param {{ start: number | null, end: number | null, line: number, column: number }} video The effective times and the position of the video.
 * @param {() => import('mdast').Definition[]} definitions The definitions of the text.
 * @returns {import('../../video/types.js').VideoChapter[]}
 * @throws {VideoSyntaxError}
 */
function readChapters(body, { start, end, line, column }, definitions) {
  if (body.length === 0) return [];
  const [list] = body;
  if (body.length !== 1 || list.type !== 'list') {
    throw new VideoSyntaxError('the body of a video must be one list of chapters', { line, column });
  }
  /** @type {import('../../video/types.js').VideoChapter[]} */
  const chapters = [];
  for (const item of list.children) {
    const where = positionOf(item);
    const notAChapter = () => new VideoSyntaxError('a chapter must start with a timecode, a space and a title', where);
    const [paragraph] = item.children;
    const inline = paragraph?.type === 'paragraph' ? joinTexts(paragraph.children) : [];
    const [first] = inline;
    const time = first?.type === 'text' ? CHAPTER_TIME.exec(first.value) : null;
    const seconds = time ? parseTimecode(time[1]) : null;
    // A task list item ("- [ ] 0:12 ...") does not start with its timecode either.
    if (item.children.length !== 1 || typeof item.checked === 'boolean' || first?.type !== 'text' || !time || seconds === null) {
      throw notAChapter();
    }
    /** @type {import('mdast').PhrasingContent[]} */
    const rest = [
      ...(first.value.length > time[0].length ? [{ ...first, value: first.value.slice(time[0].length) }] : []),
      ...inline.slice(1),
    ];
    let unsupported = false;
    visit({ type: 'paragraph', children: rest }, (node) => {
      if (NOT_IN_TITLE.has(node.type)) unsupported = true;
    });
    if (unsupported) throw notAChapter();
    const title = titleToHast(rest, definitions());
    const text = toString({ type: 'element', tagName: 'p', properties: {}, children: title });
    if (text.trim() === '') throw notAChapter();
    if (chapters.length > 0 && seconds <= chapters[chapters.length - 1].seconds) {
      throw new VideoSyntaxError('chapters must be in increasing order of time', where);
    }
    if (seconds < (start ?? 0) || (end !== null && seconds >= end)) {
      throw new VideoSyntaxError(`${formatTimecode(seconds)} is not within the part of the video that plays`, where);
    }
    chapters.push({ seconds, html: toHtml(title, { allowDangerousHtml: true }), text });
  }
  return chapters;
}

/**
 * Remark plugin: replaces each `::video` and `:::video` directive, and each
 * paragraph of the root that is only an address a rule knows, with a
 * placeholder and lists the videos with their chapters, in document order,
 * with the features their providers lack as warnings. Any other address stays
 * a link. Lines are those of the text as parsed.
 *
 * @param {{ source: string, video: VideoOptions, idPrefix: string, onFound: (videos: import('../../video/types.js').VideoDirective[], warnings: import('../../video/types.js').VideoWarning[]) => void }} options
 * @returns {(tree: import('mdast').Root) => void}
 * @throws {VideoSyntaxError} for the first video that is written wrongly, in the order of the checks of the specification.
 */
export function remarkVideos({ source, video: settings, idPrefix, onFound }) {
  return (tree) => {
    /** @type {import('../../video/types.js').VideoDirective[]} */
    const found = [];
    /** @type {import('../../video/types.js').VideoWarning[]} */
    const warnings = [];
    /** @type {Set<string>} */
    const usedIds = new Set();
    /** @type {import('mdast').Definition[] | null} */
    let definitions = null;
    const definitionsOfText = () => {
      if (definitions === null) {
        const all = /** @type {import('mdast').Definition[]} */ ([]);
        visit(tree, 'definition', (node) => {
          all.push(node);
        });
        definitions = all;
      }
      return definitions;
    };

    /**
     * Checks a video and adds it to the list, in the order of the checks of
     * the specification.
     *
     * @param {object} input
     * @param {'directive' | 'link'} input.source
     * @param {Record<string, string | null | undefined>} input.attributes
     * @param {string | null} input.title
     * @param {import('mdast').RootContent[]} input.body The body of a container, after its label; empty for anything else.
     * @param {number} input.line
     * @param {number} input.column
     * @returns {number} The index of the video.
     */
    const add = ({ source: kind, attributes, title, body, line, column }) => {
      const where = { line, column };
      /** @param {string} message */
      const fail = (message) => new VideoSyntaxError(message, where);

      // V2
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

      // V13 to V16, then W3: chapters the provider cannot seek to are kept, without links.
      const chapters = readChapters(body, { start, end, line, column }, definitionsOfText);
      if (match !== null && chapters.length > 0 && !match.capabilities.seek) {
        warnings.push({
          message: `${match.providerName} videos cannot seek to a time; the chapters are shown without links`,
          line,
          column,
        });
      }

      const videoIndex = found.length;
      found.push({
        index: videoIndex,
        source: kind,
        id,
        htmlId: `${idPrefix}video-${id ?? String(videoIndex + 1)}`,
        src,
        provider: match === null ? 'file' : match.provider,
        providerName: match === null ? '' : match.providerName,
        match,
        file,
        title,
        start,
        end,
        poster: attribute('poster'),
        load: match === null ? null : (/** @type {'click' | 'iframe' | null} */ (load) ?? settings.load),
        embedUrl: match === null ? null : embedUrl(match, { start, end, autoplay: false }),
        playUrl: match === null ? null : embedUrl(match, { start, end, autoplay: true }),
        watchUrl: match === null ? null : watchUrl(match, start),
        chapters,
        line,
        column,
      });
      return videoIndex;
    };

    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return undefined;
      const line = node.position?.start.line ?? 1;
      const column = node.position?.start.column ?? 1;
      /** @type {number} */
      let videoIndex;
      /** @type {import('mdast').RootContent[]} */
      let body = [];
      if (node.type === 'leafDirective' && node.name === VIDEO_DIRECTIVE) {
        const label = plainText(/** @type {import('mdast').Nodes} */ (node)).trim();
        videoIndex = add({
          source: 'directive',
          attributes: /** @type {Record<string, string | null | undefined>} */ (node.attributes ?? {}),
          title: label === '' ? null : label,
          body,
          line,
          column,
        });
      } else if (node.type === 'containerDirective' && node.name === VIDEO_DIRECTIVE) {
        const [first, ...rest] = node.children;
        const hasLabel = first?.type === 'paragraph' && Boolean(/** @type {any} */ (first.data)?.directiveLabel);
        const label = hasLabel ? plainText(first).trim() : '';
        body = hasLabel ? rest : node.children;
        videoIndex = add({
          source: 'directive',
          attributes: /** @type {Record<string, string | null | undefined>} */ (node.attributes ?? {}),
          title: label === '' ? null : label,
          body,
          line,
          column,
        });
      } else if (node.type === 'paragraph' && parent === tree) {
        const src = loneAddress(node, source);
        if (src === null || matchVideoUrl(src, settings.rules) === null) return SKIP;
        videoIndex = add({ source: 'link', attributes: { src }, title: null, body, line, column });
      } else {
        return undefined;
      }
      parent.children[index] = /** @type {any} */ ({
        type: 'coffer-video',
        // The chapters stay in the Markdown tree, so that later plugins still
        // see what they hold (an unknown directive is an error), but the
        // placeholder is written empty: hChildren replaces its content.
        data: { hName: 'div', hProperties: { dataCofferVideo: String(videoIndex) }, hChildren: [] },
        children: body,
        position: node.position,
      });
      return [SKIP, index + 1];
    });
    onFound(found, warnings);
  };
}
