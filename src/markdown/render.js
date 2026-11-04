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
import { CarouselSyntaxError, remarkCarousels } from './directives/carousel.js';

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
 * @property {ImageOptions} [images] Turns images into responsive figures; without it an image stays a plain `<img>`.
 * @property {Partial<CarouselLabels>} [carousel] The words the carousels need, in the language of the site (English when left out).
 */

/**
 * The words of a carousel. The label names the region for screen readers; the
 * other two name the buttons that the carousel script adds. The position
 * indicator ("2 / 7") needs no words.
 *
 * @typedef {object} CarouselLabels
 * @property {string} label Name of a carousel that was given none.
 * @property {string} previous Name of the button that shows the previous slide.
 * @property {string} next Name of the button that shows the next slide.
 */

/** The words of a carousel when the site gives none. */
export const DEFAULT_CAROUSEL_LABELS = Object.freeze({
  label: 'Image carousel',
  previous: 'Previous image',
  next: 'Next image',
});

/**
 * A picture ready to be shown: what the renderer needs to write `<picture>`.
 *
 * @typedef {object} ResponsiveImage
 * @property {string} src Address of the variant used where no `srcset` is understood.
 * @property {number} width Width of that variant in pixels.
 * @property {number} height Height of that variant in pixels.
 * @property {{ url: string, width: number }[]} srcset The variants to choose from, narrowest first.
 * @property {string} [type] Media type of the variants (default `image/webp`).
 */

/**
 * An image as written in the text.
 *
 * @typedef {object} ImageRequest
 * @property {string} src The address exactly as written (percent escapes are not decoded).
 * @property {string} alt Alternative text; empty when none was given.
 * @property {string} title The title of the image, which is shown as its caption; empty when none was given.
 * @property {number} line 1-based line of the file.
 * @property {number} column 1-based column of the image on that line.
 */

/**
 * @typedef {object} ImageOptions
 * @property {(request: ImageRequest) => Promise<ResponsiveImage | null>} resolve Finds the responsive variants of an image, or null to leave the image as it is (a remote image, a missing file). Called once per image, all at the same time.
 * @property {string} sizes The `sizes` attribute of the pictures.
 * @property {string} [carouselSizes] The `sizes` attribute of the pictures in carousels, where a slide is as wide as the carousel (default: `sizes`).
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
 * An image of the text, as the viewer needs to know it.
 *
 * @typedef {object} TextImage
 * @property {string} src The address exactly as written.
 * @property {string} alt Alternative text; empty when none was given.
 * @property {string} caption The caption (the title of the image); empty when none was given.
 * @property {boolean} carousel Whether the image is a slide of a carousel.
 */

/**
 * @typedef {object} RenderResult
 * @property {string} html Rendered body.
 * @property {TocEntry[]} toc Table of contents; empty when the text has fewer headings than the threshold.
 * @property {number} words Number of words in the text, code blocks excluded.
 * @property {number} readingMinutes Estimated reading time in whole minutes, at least 1.
 * @property {{ src: string, alt: string } | null} firstImage The first Markdown image, or null.
 * @property {TextImage[]} images Every Markdown image of the text, carousel slides included, in document order.
 * @property {number} carousels Number of carousels in the text; a page with any needs the carousel script.
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
 * @property {TextImage[]} images
 * @property {number} carousels
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
 * Remark plugin: the `:::carousel` directive, with its mistakes reported as
 * errors that name the file and the line.
 *
 * @param {{ file?: string, lineOffset: number, labels: CarouselLabels }} options
 * @returns {(tree: import('mdast').Root) => void}
 */
function carousels({ file, lineOffset, labels }) {
  const transform = remarkCarousels({ labels });
  return (tree) => {
    try {
      transform(tree);
    } catch (error) {
      if (!(error instanceof CarouselSyntaxError)) throw error;
      throw new MarkdownError(error.message, {
        file,
        line: error.line === undefined ? undefined : error.line + lineOffset,
        column: error.column,
      });
    }
  };
}

/**
 * Remark plugin: apart from the ones that are defined (see `carousels`),
 * directives are reserved syntax, so each one is an error that names the file
 * and the line.
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
 * @param {import('hast').Element} node
 * @returns {boolean} Whether the element is the region of a carousel.
 */
function isCarousel(node) {
  return node.tagName === 'section' && node.properties.dataCarousel !== undefined;
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
    const found = { headings: [], text: '', firstImage: null, images: [], carousels: 0, links: [], ids: new Set() };
    /** @type {string[]} */
    const textParts = [];
    /** @type {WeakSet<object>} */
    const slideImages = new WeakSet();

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

      if (isCarousel(node)) {
        found.carousels += 1;
        visit(node, 'element', (inner) => {
          if (inner.tagName === 'img') slideImages.add(inner);
        });
      }
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
        found.images.push({
          src: node.properties.src,
          alt,
          caption: typeof node.properties.title === 'string' ? node.properties.title.trim() : '',
          carousel: slideImages.has(node),
        });
      }
      // Words of adjacent blocks must not run together.
      if (!INLINE_TAGS.has(node.tagName)) textParts.push(' ');
    });

    found.text = textParts.join('');
    onResult(found);
  };
}

/**
 * @param {string} tagName
 * @param {Record<string, string | number | undefined>} properties Properties with undefined values are left out.
 * @param {import('hast').ElementContent[]} [children]
 * @returns {import('hast').Element}
 */
function element(tagName, properties, children = []) {
  /** @type {Record<string, string | number>} */
  const kept = {};
  for (const [name, value] of Object.entries(properties)) {
    if (value !== undefined) kept[name] = value;
  }
  return { type: 'element', tagName, properties: kept, children };
}

/**
 * Rehype plugin: turns every image into a `<picture>` with a `srcset`, and an
 * image that stands alone in a paragraph into a `<figure>`, with its title as
 * the `<figcaption>`. Every `<img>` gets `width` and `height` (so the page
 * does not jump while it loads), and every one but the first of the page gets
 * `loading="lazy"` and `decoding="async"`. The pictures of a carousel use the
 * sizes of carousels; its slides are images like the others, so the first
 * slide is eager only when it is the first image of the page.
 *
 * @param {{ images: ImageOptions | null, lineOffset: number }} options
 * @returns {(tree: import('hast').Root) => Promise<void>}
 */
function responsiveImages({ images, lineOffset }) {
  return async (tree) => {
    if (images === null) return;
    /** @type {import('hast').Element[]} */
    const found = [];
    visit(tree, 'element', (node) => {
      if (node.tagName === 'pre' || node.tagName === 'script' || node.tagName === 'style') return SKIP;
      if (node.tagName === 'img' && typeof node.properties.src === 'string') found.push(node);
      return undefined;
    });
    if (found.length === 0) return;

    /** @type {Map<import('hast').Element, ResponsiveImage>} */
    const resolved = new Map();
    await Promise.all(
      found.map(async (node) => {
        const result = await images.resolve({
          src: String(node.properties.src),
          alt: typeof node.properties.alt === 'string' ? node.properties.alt : '',
          title: typeof node.properties.title === 'string' ? node.properties.title : '',
          line: (node.position?.start.line ?? 1) + lineOffset,
          column: node.position?.start.column ?? 1,
        });
        if (result) resolved.set(node, result);
      }),
    );

    const first = found[0];
    // The images that are slides of a carousel.
    /** @type {Set<import('hast').Element>} */
    const slides = new Set();
    visit(tree, 'element', (node) => {
      if (!isCarousel(node)) return undefined;
      visit(node, 'element', (inner) => {
        if (inner.tagName === 'img') slides.add(inner);
      });
      return SKIP;
    });
    /**
     * @param {import('hast').Element} node
     * @param {boolean} keepTitle
     * @returns {import('hast').Element | null}
     */
    const picture = (node, keepTitle) => {
      const image = resolved.get(node);
      if (!image) return null;
      const lazy = node !== first;
      const source = element('source', {
        type: image.type ?? 'image/webp',
        srcSet: image.srcset.map((entry) => `${entry.url} ${entry.width}w`).join(', '),
        sizes: slides.has(node) ? (images.carouselSizes ?? images.sizes) : images.sizes,
      });
      const img = element('img', {
        src: image.src,
        alt: typeof node.properties.alt === 'string' ? node.properties.alt : '',
        title: keepTitle && typeof node.properties.title === 'string' ? node.properties.title : undefined,
        width: image.width,
        height: image.height,
        loading: lazy ? 'lazy' : undefined,
        decoding: lazy ? 'async' : undefined,
      });
      return element('picture', {}, [source, img]);
    };

    /**
     * An image on its own, with an optional caption.
     *
     * @param {import('hast').Element} node
     * @returns {import('hast').Element | null}
     */
    const figure = (node) => {
      const inner = picture(node, false);
      if (!inner) return null;
      const caption = typeof node.properties.title === 'string' ? node.properties.title.trim() : '';
      return element('figure', {}, [
        inner,
        ...(caption === '' ? [] : [element('figcaption', {}, [{ type: 'text', value: caption }])]),
      ]);
    };

    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName === 'pre' || node.tagName === 'script' || node.tagName === 'style') return SKIP;
      if (!parent || index === undefined) return undefined;
      if (node.tagName === 'p') {
        const pictures = node.children.filter((child) => child.type === 'element' && child.tagName === 'img');
        const alone =
          pictures.length > 0 &&
          node.children.every(
            (child) =>
              (child.type === 'element' && child.tagName === 'img') ||
              (child.type === 'text' && child.value.trim() === ''),
          );
        if (alone && pictures.some((image) => resolved.has(/** @type {import('hast').Element} */ (image)))) {
          // An image the resolver left alone, such as a remote one, keeps a paragraph of its own.
          const replacement = node.children.flatMap((child) =>
            child.type === 'element' ? [figure(child) ?? element('p', {}, [child])] : [],
          );
          parent.children.splice(index, 1, ...replacement);
          return [SKIP, index + replacement.length];
        }
        return undefined;
      }
      if (node.tagName === 'img') {
        const inline = picture(node, true);
        if (inline) parent.children[index] = inline;
        return SKIP;
      }
      return undefined;
    });
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
 * @throws {MarkdownError} for an unknown directive, or a carousel that is written wrongly.
 * @throws {TypeError} for an invalid option.
 */
export async function renderMarkdown(source, options = {}) {
  const tocMinHeadings = positiveInteger(options.tocMinHeadings, 'tocMinHeadings', DEFAULT_TOC_MIN_HEADINGS);
  const wordsPerMinute = positiveInteger(options.wordsPerMinute, 'wordsPerMinute', DEFAULT_WORDS_PER_MINUTE);
  const startLine = positiveInteger(options.startLine, 'startLine', 1);
  const themes = options.codeThemes ?? DEFAULT_CODE_THEMES;
  const lineOffset = startLine - 1;
  const labels = { ...DEFAULT_CAROUSEL_LABELS, ...options.carousel };

  /** @type {Collected | undefined} */
  let collected;

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(restoreColons, { source })
    .use(carousels, { file: options.file, lineOffset, labels })
    .use(rejectDirectives, { file: options.file, lineOffset })
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeSlug)
    .use(collect, {
      lineOffset,
      onResult: (found) => {
        collected = found;
      },
    })
    .use(responsiveImages, { images: options.images ?? null, lineOffset })
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
    images: collected.images,
    carousels: collected.carousels,
    links: collected.links,
    ids: [...collected.ids],
  };
}
