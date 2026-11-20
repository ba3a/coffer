import { visit } from 'unist-util-visit';

/**
 * Backslash escapes and the `verbatim` directive of the typography feature.
 *
 * `remarkEscapes` replaces each escaped quote, hyphen or dot of a text node by
 * a private-use character, so that the typography pass does not see it.
 * `rehypeRestoreEscapes` puts the typed characters back and must run last.
 */

/** Name of the text directive and of the container directive. */
export const VERBATIM_DIRECTIVE = 'verbatim';

/** The placeholder of each character that an escape can protect. */
const PLACEHOLDERS = new Map([
  ['"', ''],
  ["'", ''],
  ['-', ''],
  ['.', ''],
]);

/** The characters that stay protected when they follow an escaped one: `\--` and `\...`. */
const REPEATING = new Set(['-', '.']);

const ENTITY = /^&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const PLACEHOLDER_PATTERN = /[-]/g;
const ORIGINALS = new Map([...PLACEHOLDERS].map(([character, placeholder]) => [placeholder, character]));

/**
 * @param {string} text
 * @returns {string} The text with every placeholder replaced by its character.
 */
export function restoreEscapes(text) {
  return text.replace(PLACEHOLDER_PATTERN, (placeholder) => ORIGINALS.get(placeholder) ?? placeholder);
}

/**
 * Reads the escapes of the source of a text node, and keeps in step with the
 * text of the node: an entity in the source is one or more characters of the
 * text, and a line after the first has lost its indent and its quote marks.
 *
 * @param {string} raw Source of the node.
 * @param {string} value Text of the node.
 * @returns {string | null} The text with placeholders for the escaped characters, or null when the source and the text cannot be matched.
 */
function protect(raw, value) {
  let out = '';
  let at = 0;
  /** @type {string | null} */
  let repeating = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = /** @type {string} */ (raw[index]);
    const next = raw[index + 1];
    if (character === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      if (value[at] !== next) return null;
      index += 1;
      at += 1;
      const placeholder = PLACEHOLDERS.get(next);
      out += placeholder ?? next;
      repeating = placeholder !== undefined && REPEATING.has(next) ? next : null;
      continue;
    }
    if (value[at] === character) {
      out += repeating !== null && character === repeating ? PLACEHOLDERS.get(character) : character;
      at += 1;
      if (repeating !== character) repeating = null;
      continue;
    }
    repeating = null;
    const entity = character === '&' ? ENTITY.exec(raw.slice(index)) : null;
    if (entity) {
      // The entity stands for one to four characters; the one that leaves the rest in step is the right one.
      const after = raw[index + entity[0].length];
      let length = 1;
      while (length < 4 && at + length < value.length && value[at + length] !== after) length += 1;
      out += value.slice(at, at + length);
      at += length;
      index += entity[0].length - 1;
      continue;
    }
    if ((character === ' ' || character === '\t') && (value[at] === '\n' || at === value.length)) continue;
    if (/[ \t>]/.test(character) && at > 0 && value[at - 1] === '\n') continue;
    return null;
  }
  return at === value.length ? out : null;
}

/**
 * Remark plugin: replaces each backslash-escaped `"`, `'`, `-` or `.` of the
 * text nodes by a placeholder. Hyphens and dots right after an escaped one are
 * protected too, so `\--` stays two hyphens and `\...` stays three dots. This
 * holds in a text with entities and in a text of several lines in a quote or a
 * list. A text node whose source cannot be matched with its text is left as it is.
 *
 * @returns {(tree: import('mdast').Root, file: import('vfile').VFile) => void}
 */
export function remarkEscapes() {
  return (tree, file) => {
    const source = String(file.value);
    visit(tree, 'text', (node) => {
      const { start, end } = node.position ?? {};
      if (start?.offset === undefined || end?.offset === undefined) return;
      const raw = source.slice(start.offset, end.offset);
      if (!raw.includes('\\')) return;
      const protectedText = protect(raw, node.value);
      if (protectedText === null || restoreEscapes(protectedText) !== node.value) return;
      node.value = protectedText;
    });
  };
}

/**
 * Remark plugin: `:verbatim[text]` becomes `<span data-typography="off">`, and
 * `:::verbatim` becomes `<div data-typography="off">`.
 *
 * @returns {(tree: import('mdast').Root) => void}
 */
export function remarkVerbatim() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type !== 'textDirective' && node.type !== 'containerDirective') return;
      const directive = /** @type {{ name: string, data?: object }} */ (/** @type {unknown} */ (node));
      if (directive.name !== VERBATIM_DIRECTIVE) return;
      directive.data = {
        ...directive.data,
        hName: node.type === 'textDirective' ? 'span' : 'div',
        hProperties: { dataTypography: 'off' },
      };
    });
  };
}

/**
 * Rehype plugin: puts the typed characters back in place of the placeholders,
 * in text and in attribute values. It runs after every other plugin.
 *
 * @returns {(tree: import('hast').Root) => void}
 */
export function rehypeRestoreEscapes() {
  return (tree) => {
    visit(tree, (node) => {
      if (node.type === 'text') {
        node.value = restoreEscapes(node.value);
      } else if (node.type === 'element') {
        for (const [name, value] of Object.entries(node.properties)) {
          if (typeof value === 'string') node.properties[name] = restoreEscapes(value);
          else if (Array.isArray(value)) node.properties[name] = value.map((entry) => (typeof entry === 'string' ? restoreEscapes(entry) : entry));
        }
      }
    });
  };
}
