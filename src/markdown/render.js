import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import { toString } from 'hast-util-to-string';
import { visit, SKIP } from 'unist-util-visit';
import { bundledLanguages, createHighlighter } from 'shiki';

/** Number of h2/h3 headings from which a post gets a table of contents. */
export const DEFAULT_TOC_MIN_HEADINGS = 4;

/** Reading speed used to turn a word count into minutes. */
export const DEFAULT_WORDS_PER_MINUTE = 200;

/** Shiki themes used for code, one per colour scheme. */
export const DEFAULT_CODE_THEMES = Object.freeze({
  light: 'github-light',
  dark: 'github-dark',
});

/**
 * @typedef {object} RenderOptions
 * @property {string} [file] Path of the Markdown file, used in error messages.
 * @property {number} [startLine] 1-based line of the file on which the text starts (default 1); keeps reported lines right when front matter was cut off.
 * @property {number} [tocMinHeadings] Minimum number of h2/h3 headings for a table of contents (default 4).
 * @property {number} [wordsPerMinute] Reading speed (default 200).
 * @property {{ light: string, dark: string }} [codeThemes] Shiki theme names for the light and the dark scheme.
 */

/**
 * One entry of the table of contents.
 *
 * @typedef {object} TocEntry
 * @property {string} id The `id` of the heading, usable as `#id`.
 * @property {string} text Plain text of the heading.
 * @property {2 | 3} depth Heading level.
 */

/**
 * A link or an image found in the text, kept for later link checks.
 *
 * @typedef {object} FoundLink
 * @property {string} url The `href` or `src` exactly as written.
 * @property {'link' | 'image'} kind
 * @property {number} line 1-based line of the file.
 * @property {number} column 1-based column of the link on that line.
 */

/**
 * @typedef {object} RenderResult
 * @property {string} html Rendered body.
 * @property {TocEntry[]} toc Table of contents; empty when the text has fewer headings than the threshold.
 * @property {number} words Number of words in the text, code blocks excluded.
 * @property {number} readingMinutes Estimated reading time in whole minutes, at least 1.
 * @property {{ src: string, alt: string } | null} firstImage The first Markdown image, or null.
 * @property {FoundLink[]} links Every Markdown link and image written in the text (links the renderer makes up, such as footnote back references, are left out).
 * @property {string[]} ids Every `id` a link can point at: heading ids, ids of other elements and ids and names set by raw HTML, without duplicates.
 */

/**
 * What the collecting plugin learns from the tree.
 *
 * @typedef {object} Collected
 * @property {TocEntry[]} headings
 * @property {string} text
 * @property {{ src: string, alt: string } | null} firstImage
 * @property {FoundLink[]} links
 * @property {Set<string>} ids
 */

/**
 * A problem in a Markdown text, located in its file.
 */
export class MarkdownError extends Error {
  /**
   * @param {string} message Description of the problem, without the location.
   * @param {{ file?: string, line?: number, column?: number }} [where]
   */
  constructor(message, where = {}) {
    const place = [where.file, where.line, where.line === undefined ? undefined : where.column]
      .filter((part) => part !== undefined)
      .join(':');
    super(place ? `${place}: ${message}` : message);
    this.name = 'MarkdownError';
    this.file = where.file;
    this.line = where.line;
    this.column = where.column;
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Counts words in a way that does not depend on the language: whatever the
 * Unicode word segmentation of the runtime calls a word, which covers Latin,
 * Cyrillic, Greek and so on, and segments Chinese and Japanese by dictionary.
 *
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  let count = 0;
  for (const part of wordSegmenter.segment(text)) {
    if (part.isWordLike) count += 1;
  }
  return count;
}

/** @type {Map<string, Promise<import('shiki').HighlighterGeneric<any, any>>>} */
const highlighters = new Map();

/**
 * @param {{ light: string, dark: string }} themes
 */
function getHighlighter(themes) {
  const key = `${themes.light}\n${themes.dark}`;
  let highlighter = highlighters.get(key);
  if (!highlighter) {
    highlighter = createHighlighter({ themes: [themes.light, themes.dark], langs: [] });
    highlighters.set(key, highlighter);
  }
  return highlighter;
}

/**
 * Remark plugin: a text directive is only a directive when its name starts
 * with a letter and it does not directly follow a letter or a digit. Anything
 * else, such as the time 10:30 or "note:this", is a colon in running text and
 * is turned back into the text it was parsed from.
 *
 * @param {{ source: string }} options
 * @returns {(tree: import('mdast').Root) => void}
 */
function restoreColons({ source }) {
  return (tree) => {
    visit(tree, 'textDirective', (node, index, parent) => {
      const { start, end } = node.position ?? {};
      if (!parent || index === undefined) return;
      if (start?.offset === undefined || end?.offset === undefined) return;
      const before = source.slice(0, start.offset).at(-1) ?? '';
      if (/^\p{L}/u.test(node.name) && !/^[\p{L}\p{N}]$/u.test(before)) return;
      parent.children[index] = { type: 'text', value: source.slice(start.offset, end.offset) };
    });
  };
}

/**
 * Remark plugin: directives are reserved syntax, and none is defined yet, so
 * each one is an error that names the file and the line.
 *
 * @param {{ file?: string, lineOffset: number }} options
 * @returns {(tree: import('mdast').Root) => void}
 */
function rejectDirectives({ file, lineOffset }) {
  return (tree) => {
    visit(tree, (node) => {
      if (
        node.type !== 'textDirective' &&
        node.type !== 'leafDirective' &&
        node.type !== 'containerDirective'
      ) {
        return;
      }
      const directive = /** @type {{ name: string }} */ (/** @type {unknown} */ (node));
      const start = node.position?.start;
      throw new MarkdownError(
        `unknown directive "${directive.name}" (a colon followed by a letter starts a directive; write \\: for a plain colon)`,
        {
          file,
          line: start ? start.line + lineOffset : undefined,
          column: start?.column,
        },
      );
    });
  };
}

/**
 * Rehype plugin: collects everything the result reports besides the HTML.
 * It runs before code highlighting, on the plain tree.
 *
 * @param {{ lineOffset: number, onResult: (found: Collected) => void }} options
 * @returns {(tree: import('hast').Root) => void}
 */
function collect({ lineOffset, onResult }) {
  return (tree) => {
    /** @type {Collected} */
    const found = { headings: [], text: '', firstImage: null, links: [], ids: new Set() };
    /** @type {string[]} */
    const textParts = [];

    visit(tree, (node) => {
      if (node.type === 'text') {
        textParts.push(node.value);
        return;
      }
      if (/** @type {string} */ (node.type) === 'raw') {
        // Raw HTML is not parsed; the anchors it declares are found by their attributes.
        const html = String(/** @type {{ value?: unknown }} */ (node).value ?? '');
        for (const match of html.matchAll(/\s(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
          const id = match[1] ?? match[2] ?? match[3];
          if (id) found.ids.add(id);
        }
        return;
      }
      if (node.type !== 'element') return;
      if (typeof node.properties.id === 'string' && node.properties.id !== '') {
        found.ids.add(node.properties.id);
      }
      if (node.tagName === 'pre' || node.tagName === 'script' || node.tagName === 'style') {
        return SKIP;
      }
      const line = (node.position?.start.line ?? 1) + lineOffset;
      const column = node.position?.start.column ?? 1;

      if (node.tagName === 'h2' || node.tagName === 'h3') {
        const id = node.properties.id;
        if (typeof id === 'string') {
          found.headings.push({
            id,
            text: toString(node).trim(),
            depth: node.tagName === 'h2' ? 2 : 3,
          });
        }
      } else if (node.tagName === 'a' && typeof node.properties.href === 'string') {
        if (node.position) found.links.push({ url: node.properties.href, kind: 'link', line, column });
      } else if (node.tagName === 'img' && typeof node.properties.src === 'string') {
        const alt = typeof node.properties.alt === 'string' ? node.properties.alt : '';
        if (node.position) found.links.push({ url: node.properties.src, kind: 'image', line, column });
        found.firstImage ??= { src: node.properties.src, alt };
      }
      // Words of adjacent blocks must not run together.
      if (!INLINE_TAGS.has(node.tagName)) textParts.push(' ');
    });

    found.text = textParts.join('');
    onResult(found);
  };
}

const INLINE_TAGS = new Set(['a', 'em', 'strong', 'code', 'del', 'span', 'sup', 'sub']);

/**
 * Rehype plugin: replaces each fenced code block with Shiki's output, which
 * colours every token with `--shiki-light` and `--shiki-dark` variables so a
 * stylesheet can pick the scheme and no script is needed.
 *
 * @param {{ themes: { light: string, dark: string } }} options
 * @returns {(tree: import('hast').Root) => Promise<void>}
 */
function highlightCode({ themes }) {
  return async (tree) => {
    /** @type {{ parent: import('hast').Parents, index: number, code: string, lang: string }[]} */
    const blocks = [];

    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return;
      const code = node.children.find(
        (child) => child.type === 'element' && child.tagName === 'code',
      );
      if (!code || code.type !== 'element') return;
      const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
      const marker = classes.find(
        (name) => typeof name === 'string' && name.startsWith('language-'),
      );
      const requested = typeof marker === 'string' ? marker.slice('language-'.length) : '';
      const lang = Object.hasOwn(bundledLanguages, requested) ? requested : 'text';
      blocks.push({ parent, index, code: toString(code).replace(/\n$/, ''), lang });
      return SKIP;
    });

    if (blocks.length === 0) return;
    const highlighter = await getHighlighter(themes);
    for (const block of blocks) {
      if (block.lang !== 'text') await highlighter.loadLanguage(/** @type {any} */ (block.lang));
      const root = highlighter.codeToHast(block.code, {
        lang: block.lang,
        themes: { light: themes.light, dark: themes.dark },
        defaultColor: false,
      });
      const pre = root.children[0];
      if (pre) block.parent.children[block.index] = /** @type {import('hast').ElementContent} */ (pre);
    }
  };
}

/**
 * Renders Markdown to HTML.
 *
 * Supported on top of CommonMark: GFM (tables, task lists, strikethrough,
 * autolinks), heading ids, Shiki-highlighted code with light and dark colours,
 * and raw HTML, which is passed through unchanged (use it for embeds).
 *
 * @param {string} source Markdown text without front matter.
 * @param {RenderOptions} [options]
 * @returns {Promise<RenderResult>}
 * @throws {MarkdownError} for an unknown directive.
 * @throws {TypeError} for an invalid option.
 */
export async function renderMarkdown(source, options = {}) {
  const tocMinHeadings = positiveInteger(options.tocMinHeadings, 'tocMinHeadings', DEFAULT_TOC_MIN_HEADINGS);
  const wordsPerMinute = positiveInteger(options.wordsPerMinute, 'wordsPerMinute', DEFAULT_WORDS_PER_MINUTE);
  const startLine = positiveInteger(options.startLine, 'startLine', 1);
  const themes = options.codeThemes ?? DEFAULT_CODE_THEMES;
  const lineOffset = startLine - 1;

  /** @type {Collected | undefined} */
  let collected;

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(restoreColons, { source })
    .use(rejectDirectives, { file: options.file, lineOffset })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(collect, {
      lineOffset,
      onResult: (found) => {
        collected = found;
      },
    })
    .use(highlightCode, { themes })
    .use(rehypeStringify, { allowDangerousHtml: true });

  const file = await processor.process({ value: source, path: options.file });
  if (!collected) throw new Error('the Markdown pipeline did not run');

  const words = countWords(collected.text);
  return {
    html: String(file),
    toc: collected.headings.length >= tocMinHeadings ? collected.headings : [],
    words,
    readingMinutes: Math.max(1, Math.ceil(words / wordsPerMinute)),
    firstImage: collected.firstImage,
    links: collected.links,
    ids: [...collected.ids],
  };
}
