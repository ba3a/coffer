/**
 * The markup of a video in a page or a feed (spec section 10.1). The output is
 * byte-exact: lines separated by `\n`, no indentation, no final newline.
 */

import { formatTimecode, isoDuration } from './timecode.js';
import { embedUrl, watchUrl } from './urls.js';

/** @typedef {import('./types.js').VideoDirective} VideoDirective */
/** @typedef {import('./types.js').VideoChapter} VideoChapter */

/**
 * The UI strings of a video. `play` contains `{title}`, `watchOn` contains
 * `{provider}`.
 *
 * @typedef {object} VideoLabels
 * @property {string} play
 * @property {string} watchOn
 * @property {string} untitled
 * @property {string} chapters
 * @property {string} download
 */

/**
 * The preview or poster of a video, as the image pipeline made it.
 *
 * @typedef {object} VideoPreview
 * @property {string} src
 * @property {number} width
 * @property {number} height
 * @property {{ url: string, width: number }[]} srcset Narrowest first.
 */

/**
 * @typedef {object} VideoRenderInput
 * @property {VideoDirective} video
 * @property {string} title The resolved title.
 * @property {boolean} titleShown Whether the title is not the fallback.
 * @property {VideoPreview | null} preview
 * @property {string} sizes The site's `images.sizes`.
 * @property {VideoLabels} labels
 * @property {boolean} feed
 */

/** The English UI strings of a video. */
export const DEFAULT_VIDEO_LABELS = Object.freeze({
  play: 'Play: {title}',
  watchOn: 'Watch on {provider}',
  untitled: 'Video',
  chapters: 'Chapters',
  download: 'Download the video',
});

const ALLOW = 'autoplay; encrypted-media; fullscreen; picture-in-picture';

/**
 * Escapes `&`, `<`, `>` and `"`, in that order.
 *
 * @param {string | number} value
 * @returns {string}
 */
function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * A label with every `{name}` placeholder replaced by `value`, escaped.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function fill(text, name, value) {
  return esc(text.replaceAll(`{${name}}`, () => value));
}

/**
 * A start tag of HTML: a name, then attributes with double-quoted,
 * single-quoted or unquoted values.
 */
const START_TAG = /<[A-Za-z][^\s/>]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/g;

/** One attribute of a start tag, with its leading space. */
const ATTRIBUTE = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Removes every attribute whose name starts with `data-`, with its leading
 * space, from the start tags of `html`. Attribute values and texts that only
 * look like such an attribute are kept.
 *
 * @param {string} html
 * @returns {string}
 */
function removeDataAttributes(html) {
  return html.replace(START_TAG, (tag) =>
    tag.replace(ATTRIBUTE, (attribute, name) => (name.toLowerCase().startsWith('data-') ? '' : attribute)),
  );
}

/**
 * @param {VideoPreview | null} preview
 * @param {string} sizes
 * @returns {string}
 */
function image(preview, sizes) {
  if (!preview) return '<span class="video-placeholder"></span>';
  const srcset = preview.srcset.map(({ url, width }) => `${url} ${width}w`).join(', ');
  return (
    `<img src="${esc(preview.src)}" srcset="${esc(srcset)}" sizes="${esc(sizes)}"` +
    ` width="${esc(preview.width)}" height="${esc(preview.height)}" alt="" loading="lazy" decoding="async">`
  );
}

/**
 * The `<time>` of a chapter.
 *
 * @param {number} seconds
 * @returns {string}
 */
function time(seconds) {
  return `<time datetime="${isoDuration(seconds)}">${formatTimecode(seconds)}</time>`;
}

/**
 * One chapter: linked to the time when the video can seek, else plain.
 *
 * @param {VideoDirective} video
 * @param {VideoChapter} chapter
 * @returns {string}
 */
function chapterItem(video, chapter) {
  const t = chapter.seconds;
  const { match, file } = video;
  if (match && !match.capabilities.seek) return `<li>${time(t)} ${chapter.html}</li>`;
  let attributes;
  if (match) {
    const play = embedUrl(match, { start: t, end: video.end, autoplay: true });
    attributes =
      `href="${esc(watchUrl(match, t))}" data-video-seek="${t}" data-video-target="${esc(video.htmlId)}"` +
      ` data-video-play="${esc(play)}"`;
  } else {
    if (!file) throw new TypeError(`video ${video.htmlId} has neither a match nor a file`);
    attributes = `href="${esc(`${file.url}#t=${t}`)}" data-video-seek="${t}" data-video-target="${esc(video.htmlId)}"`;
  }
  return `<li><a ${attributes}>${time(t)}</a> ${chapter.html}</li>`;
}

/**
 * The list of chapters, or null when the video has none.
 *
 * @param {VideoDirective} video
 * @param {VideoLabels} labels
 * @returns {string | null}
 */
function chapterList(video, labels) {
  if (video.chapters.length === 0) return null;
  const items = video.chapters.map((chapter) => chapterItem(video, chapter)).join('');
  return `<ol class="video-chapters" aria-label="${esc(labels.chapters)}">${items}</ol>`;
}

/**
 * The `#t=` fragment of a local video.
 *
 * @param {number | null} start
 * @param {number | null} end
 * @returns {string}
 */
function fragment(start, end) {
  if (start !== null && end !== null) return `#t=${start},${end}`;
  if (start !== null) return `#t=${start}`;
  if (end !== null) return `#t=0,${end}`;
  return '';
}

/**
 * @param {VideoRenderInput} input
 * @returns {(string | null)[]}
 */
function remoteLines({ video, title, titleShown, preview, sizes, labels, feed }) {
  const { match } = video;
  if (!match || video.watchUrl === null || video.playUrl === null || video.embedUrl === null) {
    throw new TypeError(`remote video ${video.htmlId} has no match or URLs`);
  }
  const watch = esc(video.watchUrl);
  const caption =
    '<figcaption>' +
    (titleShown ? `<span class="video-title">${esc(title)}</span> ` : '') +
    `<a class="video-source" href="${watch}">${fill(labels.watchOn, 'provider', video.providerName)}</a>` +
    '</figcaption>';
  const figure = `<figure class="video" id="${esc(video.htmlId)}" data-video="${esc(video.provider)}"`;
  const lines =
    video.load === 'iframe' && !feed
      ? [
          `${figure} data-video-load="iframe" data-video-title="${esc(title)}">`,
          `<div class="video-frame"><iframe src="${esc(video.embedUrl)}" title="${esc(title)}" loading="lazy"` +
            ` allow="${ALLOW}" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`,
        ]
      : [
          `${figure} data-video-load="click" data-video-play="${esc(video.playUrl)}" data-video-title="${esc(title)}">`,
          `<a class="video-preview" href="${watch}">${image(preview, sizes)}` +
            `<span class="video-play">${fill(labels.play, 'title', title)}</span></a>`,
        ];
  return [...lines, caption, chapterList(video, labels), '</figure>'];
}

/**
 * @param {VideoRenderInput} input
 * @returns {(string | null)[]}
 */
function localLines({ video, title, titleShown, preview, labels }) {
  const { file } = video;
  if (!file) throw new TypeError(`local video ${video.htmlId} has no file`);
  const poster = preview ? ` poster="${esc(preview.src)}"` : '';
  return [
    `<figure class="video" id="${esc(video.htmlId)}" data-video="file">`,
    `<video controls preload="metadata"${poster}>` +
      `<source src="${esc(file.url + fragment(video.start, video.end))}" type="${esc(file.type)}">` +
      `<a href="${esc(file.url)}">${esc(labels.download)}</a></video>`,
    titleShown ? `<figcaption><span class="video-title">${esc(title)}</span></figcaption>` : null,
    chapterList(video, labels),
    '</figure>',
  ];
}

/**
 * The markup of a video: a `<figure>` for a page (`feed` false) or, without
 * any `data-` attribute and always in click mode, for a feed.
 *
 * @param {VideoRenderInput} input
 * @returns {string}
 */
export function renderVideoHtml(input) {
  const lines = input.video.provider === 'file' ? localLines(input) : remoteLines(input);
  const html = lines.filter((line) => line !== null).join('\n');
  return input.feed ? removeDataAttributes(html) : html;
}
