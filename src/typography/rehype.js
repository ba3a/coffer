import { visit, SKIP } from 'unist-util-visit';
import { resolveRules } from './rules/index.js';
import { typesetSegments } from './typeset.js';

/** @typedef {import('./settings.js').TypographySettings} TypographySettings */

/**
 * An unpaired quote found in a text, located in its file.
 *
 * @typedef {object} TypographyWarning
 * @property {string} [file] File of the text.
 * @property {number} [line] 1-based line of the quote.
 * @property {string} char The quote as typed.
 * @property {string} message
 */

/** Elements whose text is typeset as one block, with its inline elements. */
const BLOCKS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt']);
/** Elements that end a run of inline text inside a block. */
const BOUNDARIES = new Set([
  'p', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'div', 'section', 'article', 'aside', 'figure', 'details', 'summary', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
/** Elements that typography never enters. */
const SKIPPED = new Set(['code', 'pre', 'kbd', 'samp', 'script', 'style', 'textarea', 'figcaption']);
/** Stands for content that is not typeset (code, images, raw HTML), so that quotes see it. */
const OPAQUE = '￼';

/**
 * @param {import('hast').Element} node
 * @returns {boolean}
 */
function isOff(node) {
  return SKIPPED.has(node.tagName) || node.properties?.dataTypography === 'off';
}

/**
 * A link whose text is its own address (a bare URL or email) is not typeset.
 *
 * @param {import('hast').Element} node
 * @returns {boolean}
 */
function isBareLink(node) {
  if (node.tagName !== 'a' || typeof node.properties?.href !== 'string') return false;
  if (node.children.length !== 1 || node.children[0]?.type !== 'text') return false;
  const text = node.children[0].value;
  const href = node.properties.href;
  return href === text || href === `mailto:${text}` || href === `http://${text}` || href === `https://${text}`;
}

/**
 * @typedef {object} Entry
 * @property {import('hast').Text | null} node Text node to write back to; null for content that stays.
 * @property {string} text
 */

/**
 * Rehype plugin: typesets the text of paragraphs, list items, table cells and
 * definitions. The text of a block is joined across its inline elements, so
 * a quote pairs across `<em>`. Attributes, code, raw HTML, image text and
 * elements marked `data-typography="off"` are never changed.
 *
 * @param {{ settings: Pick<TypographySettings, 'enabled' | 'locale' | 'dashStyle'>, file?: string, lineOffset?: number, onWarnings?: (warnings: TypographyWarning[]) => void }} options
 * @returns {(tree: import('hast').Root) => void}
 */
export function rehypeTypography({ settings, file, lineOffset = 0, onWarnings }) {
  return (tree) => {
    /** @type {TypographyWarning[]} */
    const warnings = [];
    if (settings.enabled !== false) {
      const rules = resolveRules(settings.locale);
      const options = { rules, dashStyle: settings.dashStyle };

      /**
       * @param {Entry[]} run
       * @param {import('hast').Element} block
       */
      const flush = (run, block) => {
        if (run.every((entry) => entry.node === null)) return;
        const { segments, unpaired } = typesetSegments(run.map((entry) => entry.text), options);
        run.forEach((entry, i) => {
          if (entry.node) entry.node.value = /** @type {string} */ (segments[i]);
        });
        for (const quote of unpaired) {
          const entry = /** @type {Entry} */ (run[quote.segment]);
          const start = (entry.node?.position ?? block.position)?.start;
          const line =
            start === undefined
              ? undefined
              : start.line + lineOffset + (entry.text.slice(0, quote.index).split('\n').length - 1);
          warnings.push({ file, line, char: quote.char, message: `unpaired quote ${quote.char}` });
        }
      };

      /**
       * @param {import('hast').Element} block
       */
      const typesetBlock = (block) => {
        /** @type {Entry[]} */
        let run = [];
        /** @param {import('hast').ElementContent[]} children */
        const collect = (children) => {
          for (const child of children) {
            if (child.type === 'text') {
              run.push({ node: child, text: child.value });
            } else if (child.type === 'element') {
              if (BOUNDARIES.has(child.tagName)) {
                flush(run, block);
                run = [];
              } else if (child.tagName === 'br') {
                run.push({ node: null, text: '\n' });
              } else if (isOff(child) || isBareLink(child) || child.tagName === 'img' || child.tagName === 'input') {
                run.push({ node: null, text: OPAQUE });
              } else {
                collect(child.children);
              }
            } else if (child.type === 'raw') {
              run.push({ node: null, text: OPAQUE });
            }
          }
        };
        collect(block.children);
        flush(run, block);
      };

      visit(tree, 'element', (node) => {
        if (isOff(node)) return SKIP;
        if (BLOCKS.has(node.tagName)) typesetBlock(node);
        return undefined;
      });
    }
    onWarnings?.(warnings);
  };
}
