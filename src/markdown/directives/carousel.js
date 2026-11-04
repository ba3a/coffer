import { SKIP, visit } from 'unist-util-visit';

/**
 * The `:::carousel` container directive.
 *
 * ```
 * :::carousel[Optional name of the carousel]
 * ![Alt text](photo.jpg "Optional caption")
 *
 * ![Alt text](other.jpg)
 * :::
 * ```
 *
 * The body is a list of images, either one per paragraph (or per line) or as a
 * Markdown list. The plugin turns the directive into a `<section>` holding a
 * `<ul>` of `<li>` slides, each with one image alone in a paragraph. The image
 * plugin of the renderer then turns every such paragraph into a `<figure>`
 * with `<picture>` and `<figcaption>`, exactly as for an image in the text.
 */

/** Name of the directive. */
export const CAROUSEL_DIRECTIVE = 'carousel';

/** Class names the markup and the stylesheet agree on. */
export const CAROUSEL_CLASSES = Object.freeze({
  region: 'carousel',
  track: 'carousel-track',
  slide: 'carousel-slide',
});

/**
 * Raised for a carousel that is written wrongly; the caller turns it into a
 * located error.
 */
export class CarouselSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number }} where Position in the Markdown text, as parsed (before any line offset).
   */
  constructor(message, where) {
    super(message);
    this.name = 'CarouselSyntaxError';
    this.line = where.line;
    this.column = where.column;
  }
}

/**
 * @param {import('mdast').Nodes} node
 * @returns {{ line?: number, column?: number }}
 */
function whereIs(node) {
  const start = node.position?.start;
  return { line: start?.line, column: start?.column };
}

/**
 * The plain text of a node, for the name of a carousel.
 *
 * @param {any} node
 * @returns {string}
 */
function textOf(node) {
  if (typeof node.value === 'string') return node.value;
  if (Array.isArray(node.children)) return node.children.map(textOf).join('');
  return '';
}

/**
 * The images of a paragraph that holds nothing else (whitespace and line
 * breaks aside), or null when it holds something else.
 *
 * @param {import('mdast').Paragraph} paragraph
 * @returns {import('mdast').PhrasingContent[] | null}
 */
function imagesOf(paragraph) {
  const images = [];
  for (const child of paragraph.children) {
    if (child.type === 'image' || child.type === 'imageReference') images.push(child);
    else if (child.type === 'break' || (child.type === 'text' && child.value.trim() === '')) continue;
    else return null;
  }
  return images.length > 0 ? images : null;
}

const NOT_ONLY_IMAGES =
  'a carousel can only hold images; write each one as ![alt text](file.jpg "optional caption"), one per line or as a list';

/**
 * Collects the images of the body of a carousel, in order.
 *
 * @param {import('mdast').BlockContent[] | import('mdast').DefinitionContent[]} body
 * @returns {import('mdast').PhrasingContent[]}
 * @throws {CarouselSyntaxError} when the body holds anything but images.
 */
function collectImages(body) {
  /** @type {import('mdast').PhrasingContent[]} */
  const found = [];
  /** @param {import('mdast').Nodes} node */
  const fromParagraph = (node) => {
    const images = node.type === 'paragraph' ? imagesOf(node) : null;
    if (!images) throw new CarouselSyntaxError(NOT_ONLY_IMAGES, whereIs(node));
    found.push(...images);
  };
  for (const child of body) {
    if (child.type === 'paragraph') {
      fromParagraph(child);
    } else if (child.type === 'list') {
      for (const item of child.children) {
        for (const inner of item.children) fromParagraph(inner);
      }
    } else if (child.type === 'definition') {
      continue;
    } else {
      throw new CarouselSyntaxError(NOT_ONLY_IMAGES, whereIs(child));
    }
  }
  return found;
}

/**
 * Remark plugin: replaces each `:::carousel` directive with the markup of a
 * carousel. The markup needs no script: the list scrolls sideways and snaps to
 * the slides (see `coffer.css`); `carousel.js` only adds buttons on top.
 *
 * @param {{ labels: import('../render.js').CarouselLabels }} options
 * @returns {(tree: import('mdast').Root) => void}
 * @throws {CarouselSyntaxError} for a carousel that is empty, holds anything but images, or has attributes.
 */
export function remarkCarousels({ labels }) {
  return (tree) => {
    visit(tree, 'containerDirective', (node, index, parent) => {
      if (node.name !== CAROUSEL_DIRECTIVE || !parent || index === undefined) return undefined;
      if (node.attributes && Object.keys(node.attributes).length > 0) {
        throw new CarouselSyntaxError(
          `a carousel takes no attributes; give it a name in square brackets: :::carousel[Name]`,
          whereIs(node),
        );
      }
      const [first, ...rest] = node.children;
      const hasLabel = Boolean(first?.data && /** @type {any} */ (first.data).directiveLabel);
      const label = hasLabel ? textOf(first).trim() : '';
      const images = collectImages(/** @type {any} */ (hasLabel ? rest : node.children));
      if (images.length === 0) {
        throw new CarouselSyntaxError('a carousel needs at least one image', whereIs(node));
      }

      const slides = images.map((image) => ({
        type: 'carouselSlide',
        data: { hName: 'li', hProperties: { className: [CAROUSEL_CLASSES.slide] } },
        children: [{ type: 'paragraph', children: [image], position: image.position }],
        position: image.position,
      }));
      const track = {
        type: 'carouselTrack',
        data: {
          hName: 'ul',
          hProperties: { className: [CAROUSEL_CLASSES.track], tabIndex: 0 },
        },
        children: slides,
      };
      const region = {
        type: 'carousel',
        data: {
          hName: 'section',
          hProperties: {
            className: [CAROUSEL_CLASSES.region],
            ariaLabel: label === '' ? labels.label : label,
            dataCarousel: '',
            dataLabelPrevious: labels.previous,
            dataLabelNext: labels.next,
          },
        },
        children: [track],
        position: node.position,
      };
      parent.children[index] = /** @type {any} */ (region);
      return [SKIP, index + 1];
    });
  };
}
