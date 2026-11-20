import { visit, SKIP } from 'unist-util-visit';
import { resolveRules } from './rules/index.js';
import { typesetSegments } from './typeset.js';
import { headingCase } from './heading-case.js';
import { widows } from './widows.js';

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
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCKS = new Set(['p', 'li', 'td', 'th', 'dd', 'dt', ...HEADINGS]);
/** Blocks that get widow control and hanging punctuation. */
const TEXT_BLOCKS = new Set(['p', 'li', ...HEADINGS]);
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

/** Characters that may hang, with the `data-m` value of their span. */
const HANGING = new Map(/** @type {[string, string][]} */ ([
  ...Array.from('“‘«„‚‹', (c) => [c, 'quote']),
  ...Array.from('([{', (c) => [c, 'bracket']),
  ...Array.from('—–', (c) => [c, 'dash']),
]));

/**
 * Wraps the first character of a block in `<span class="hang" data-m="...">`
 * when it is an opening quote, bracket or sentence dash.
 *
 * @param {import('hast').Element} block
 */
function hangFirst(block) {
  /** @type {import('hast').Element} */
  let parent = block;
  for (;;) {
    const first = parent.children[0];
    if (!first) return;
    if (first.type === 'element') {
      const classes = first.properties?.className;
      if (Array.isArray(classes) && classes.includes('hang')) return;
      if (isOff(first) || isBareLink(first) || BOUNDARIES.has(first.tagName)) return;
      if (['img', 'br', 'input'].includes(first.tagName)) return;
      parent = first;
      continue;
    }
    if (first.type !== 'text') return;
    const char = Array.from(first.value)[0];
    const mark = char === undefined ? undefined : HANGING.get(char);
    if (!mark) return;
    /** @type {import('hast').Element} */
    const span = {
      type: 'element',
      tagName: 'span',
      properties: { className: ['hang'], dataM: mark },
      children: [{ type: 'text', value: char }],
    };
    const rest = first.value.slice(char.length);
    /** @type {import('hast').ElementContent[]} */
    const replacement = rest ? [span, { type: 'text', value: rest }] : [span];
    parent.children.splice(0, 1, ...replacement);
    return;
  }
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
 * A heading whose case the heading rule changed.
 *
 * @typedef {object} HeadingChange
 * @property {string} [file] File of the heading.
 * @property {number} [line] 1-based line of the heading.
 * @property {string} before Text after the marks were typeset, before the case rule.
 * @property {string} after Text after the case rule.
 */

/**
 * Collects the text nodes of a heading that heading case may change. Code,
 * bare links and `data-typography="off"` content stand as OPAQUE.
 *
 * @param {import('hast').Element} heading
 * @returns {{ nodes: (import('hast').Text | null)[], text: string }}
 */
function headingText(heading) {
  /** @type {(import('hast').Text | null)[]} */
  const nodes = [];
  let text = '';
  /** @param {import('hast').ElementContent[]} children */
  const walk = (children) => {
    for (const child of children) {
      if (child.type === 'text') {
        nodes.push(child);
        text += child.value;
      } else if (child.type === 'element') {
        if (isOff(child) || isBareLink(child) || child.tagName === 'img') {
          nodes.push(null);
          text += OPAQUE;
        } else if (child.tagName === 'br') {
          nodes.push(null);
          text += '\n';
        } else {
          walk(child.children);
        }
      } else if (child.type === 'raw') {
        nodes.push(null);
        text += OPAQUE;
      }
    }
  };
  walk(heading.children);
  return { nodes, text };
}

/**
 * Rehype plugin: typesets the text of paragraphs, list items, table cells and
 * definitions. The text of a block is joined across its inline elements, so
 * a quote pairs across `<em>`. Attributes, code, raw HTML, image text and
 * elements marked `data-typography="off"` are never changed.
 *
 * Headings (h1 to h6) are typeset too. With `headings: locale` (the default)
 * the heading case of the locale applies, and each changed heading is reported
 * to `onHeadingChanges`.
 *
 * @param {{ settings: Pick<TypographySettings, 'enabled' | 'locale' | 'dashStyle'> & Partial<Pick<TypographySettings, 'headings' | 'keep' | 'hanging' | 'widows'>>, plain?: boolean, file?: string, lineOffset?: number, onWarnings?: (warnings: TypographyWarning[]) => void, onHeadingChanges?: (changes: HeadingChange[]) => void }} options
 * @returns {(tree: import('hast').Root) => void}
 */
export function rehypeTypography({ settings, plain = false, file, lineOffset = 0, onWarnings, onHeadingChanges }) {
  return (tree) => {
    /** @type {TypographyWarning[]} */
    const warnings = [];
    /** @type {HeadingChange[]} */
    const headingChanges = [];
    if (settings.enabled !== false) {
      const rules = resolveRules(settings.locale);
      const options = { rules, dashStyle: settings.dashStyle, plain };
      const keepWidows = !plain && settings.widows === true;
      const keepHanging = !plain && settings.hanging === true;

      /** @type {Entry[][]} Runs flushed for the block being typeset. */
      let runs = [];

      /**
       * @param {Entry[]} run
       * @param {import('hast').Element} block
       */
      const flush = (run, block) => {
        runs.push(run);
        if (run.every((entry) => entry.node === null)) return;
        const { segments, unpaired } = typesetSegments(run.map((entry) => entry.text), options);
        run.forEach((entry, i) => {
          if (entry.node) {
            const value = /** @type {string} */ (segments[i]);
            entry.node.value = plain ? value.replace(/[\u00A0\u202F]/g, ' ') : value;
            entry.text = entry.node.value;
          }
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
        runs = [];
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
        if (HEADINGS.has(block.tagName) && settings.headings !== 'keep') caseHeading(block);
        if (!TEXT_BLOCKS.has(block.tagName)) return;
        if (keepWidows) joinWidows(runs);
        if (keepHanging) hangFirst(block);
      };

      /**
       * Joins the last two words of the last run that holds text, across inline elements.
       *
       * @param {Entry[][]} blockRuns
       */
      const joinWidows = (blockRuns) => {
        const run = blockRuns.findLast((r) => r.some((entry) => entry.node && /\S/u.test(entry.text)));
        if (!run) return;
        const current = (/** @type {Entry} */ entry) => (entry.node ? entry.node.value : entry.text);
        const text = run.map(current).join('');
        const joined = widows(text);
        if (joined === text) return;
        let offset = 0;
        for (const entry of run) {
          const length = current(entry).length;
          if (entry.node) entry.node.value = joined.slice(offset, offset + length);
          offset += length;
        }
      };

      /**
       * Applies the heading case of the locale to a typeset heading.
       *
       * @param {import('hast').Element} heading
       */
      const caseHeading = (heading) => {
        const { nodes, text } = headingText(heading);
        const result = headingCase(text, { rules, keep: settings.keep ?? [] });
        // The case rule keeps the length of the text; if it did not, leave the heading as it is.
        if (!result.changed || result.text.length !== text.length) return;
        let offset = 0;
        for (const node of nodes) {
          const length = node ? node.value.length : 1;
          if (node) node.value = result.text.slice(offset, offset + length);
          offset += length;
        }
        const start = heading.position?.start;
        headingChanges.push({
          file,
          line: start === undefined ? undefined : start.line + lineOffset,
          before: text.replaceAll(OPAQUE, ''),
          after: result.text.replaceAll(OPAQUE, ''),
        });
      };

      visit(tree, 'element', (node) => {
        if (isOff(node)) return SKIP;
        if (BLOCKS.has(node.tagName)) typesetBlock(node);
        return undefined;
      });
    }
    onWarnings?.(warnings);
    onHeadingChanges?.(headingChanges);
  };
}
