/**
 * The videos that `renderMarkdown` finds in a text, as its result lists them.
 */

/** @typedef {import('./rules.js').Provider} Provider */
/** @typedef {import('./rules.js').VideoMatch} VideoMatch */

/**
 * A chapter of a video.
 *
 * @typedef {object} VideoChapter
 * @property {number} seconds
 * @property {string} html The rendered title (inline HTML).
 * @property {string} text Its plain text.
 */

/**
 * A feature the provider of a video lacks, asked for in the text.
 *
 * @typedef {object} VideoWarning
 * @property {string} message
 * @property {number} line In the file.
 * @property {number} column
 */

/**
 * One video of a text, made by a `::video` / `:::video` directive or by an
 * auto-embedded link.
 *
 * @typedef {object} VideoDirective
 * @property {number} index From 0, in document order.
 * @property {'directive' | 'link'} source `link` for an auto-embed.
 * @property {string | null} id The `id` attribute.
 * @property {string} htmlId `idPrefix + videoIdPrefix + 'video-' + (id ?? String(index + 1))` (see `RenderOptions`).
 * @property {string} src As written (auto-embed: the URL, without angle brackets).
 * @property {Provider | 'file'} provider
 * @property {string} providerName `match.providerName`; empty for a file.
 * @property {VideoMatch | null} match Null for a file.
 * @property {{ url: string, type: 'video/mp4' | 'video/webm' } | null} file The URL from `locateFile`.
 * @property {string | null} title The title in square brackets.
 * @property {number | null} start Effective start: attribute, else URL; 0 becomes null; null when the provider cannot start.
 * @property {number | null} end Effective end: attribute, else URL; null when the provider cannot stop.
 * @property {string | null} poster As written.
 * @property {'click' | 'iframe' | null} load Effective; null for a file.
 * @property {string | null} embedUrl `embedUrl(match, { start, end, autoplay: false })`; null for a file.
 * @property {string | null} playUrl `embedUrl(match, { start, end, autoplay: true })`; null for a file.
 * @property {string | null} watchUrl `watchUrl(match, start)`; null for a file.
 * @property {VideoChapter[]} chapters
 * @property {number} line Of the directive or the paragraph, in the file.
 * @property {number} column
 */

export {};
