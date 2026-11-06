import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeEntities } from '../xml.js';

/**
 * The symbol index of a project's reference: the names a reference defines and
 * the addresses of the places that define them. Guides use it to link to the
 * reference: `[text](ref:Name)` and inline code that is exactly a symbol name.
 *
 * A symbol has a name, which may be qualified (`com.example.Tool`,
 * `Kerf.waste`), and its address. Its **simple name** is the last part of the
 * name after a dot (`Tool`, `waste`). Both the name and the simple name find
 * the symbol; a key that finds more than one address is **ambiguous** and is
 * never guessed.
 *
 * An index comes from a `json` reference (item names and anchors, see
 * {@link indexOfView}) or, for an `html` reference, from an adapter that reads
 * a file of the generated folder (see {@link INDEX_ADAPTERS}).
 */

/** The largest index file an adapter reads, in bytes. */
export const MAX_INDEX_FILE_BYTES = 16 * 1024 * 1024;

/** The most symbols one index can have. */
export const MAX_SYMBOLS = 200_000;

/** The longest name or location of a symbol, in characters. */
const MAX_TEXT_LENGTH = 2000;

/** The most candidates an "ambiguous" message lists. */
const MAX_LISTED = 5;

/**
 * A symbol of a reference.
 *
 * @typedef {object} SymbolEntry
 * @property {string} name The name that identifies it, qualified when the reference qualifies names.
 * @property {string} url Site-relative address of the place that defines it, with the anchor when there is one.
 * @property {readonly string[]} [keys] More names that find it (a qualified name next to the simple one).
 */

/**
 * What {@link SymbolIndex.lookup} finds.
 *
 * @typedef {{ url: string } | { ambiguous: string[] } | null} SymbolMatch
 */

/** A symbol index that cannot be made. */
export class SymbolIndexError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SymbolIndexError';
  }
}

/**
 * @param {string} name
 * @returns {string} The last part of a dotted name.
 */
export function simpleNameOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 || dot === name.length - 1 ? name : name.slice(dot + 1);
}

/** The symbols of a reference, searched by name. */
export class SymbolIndex {
  /**
   * @param {readonly SymbolEntry[]} entries
   */
  constructor(entries) {
    /** @type {Map<string, Map<string, string>>} key -> address -> the name of the symbol that has it */
    this.byKey = new Map();
    /** @type {Set<string>} */
    const symbols = new Set();
    for (const entry of entries) {
      symbols.add(`${entry.name}\n${entry.url}`);
      for (const key of new Set([entry.name, simpleNameOf(entry.name), ...(entry.keys ?? [])])) {
        if (key === '') continue;
        let addresses = this.byKey.get(key);
        if (!addresses) {
          addresses = new Map();
          this.byKey.set(key, addresses);
        }
        if (!addresses.has(entry.url)) addresses.set(entry.url, entry.name);
      }
    }
    /** The number of distinct symbols. */
    this.size = symbols.size;
  }

  /**
   * Finds a symbol by its qualified or simple name, written exactly.
   *
   * @param {string} text
   * @returns {SymbolMatch} The address; the names of the candidates when the name finds several places; null when it finds none.
   */
  lookup(text) {
    const addresses = this.byKey.get(text);
    if (!addresses) return null;
    if (addresses.size === 1) return { url: /** @type {string} */ (addresses.keys().next().value) };
    return { ambiguous: [...new Set(addresses.values())].sort() };
  }
}

/**
 * The text of a message that says which symbols a name could mean.
 *
 * @param {string[]} names
 * @returns {string}
 */
export function listCandidates(names) {
  const shown = names.slice(0, MAX_LISTED).map((name) => `"${name}"`).join(', ');
  return names.length > MAX_LISTED ? `${shown} and ${names.length - MAX_LISTED} more` : shown;
}

// ---------------------------------------------------------------------------
// From a json reference

/**
 * The index of a `json` reference: the name of every item and the anchor it has
 * on the generated page.
 *
 * @param {{ sections: readonly { items: readonly { id: string, name: string }[] }[] }} view The reference as the template shows it (see `viewOfReference`).
 * @param {string} referenceUrl Site-relative address of the reference, ending in a slash.
 * @returns {SymbolIndex}
 */
export function indexOfView(view, referenceUrl) {
  /** @type {SymbolEntry[]} */
  const entries = [];
  for (const section of view.sections) {
    for (const item of section.items) {
      if (item.name.trim() === '') continue;
      entries.push({ name: item.name, url: `${referenceUrl}#${encodeURIComponent(item.id)}` });
    }
  }
  return new SymbolIndex(entries);
}

// ---------------------------------------------------------------------------
// From an html reference: the adapters

/**
 * Something that reads the index file of an `html` reference.
 *
 * @typedef {object} IndexAdapter
 * @property {string} file The index file in the generated folder when the configuration names none.
 * @property {(text: string, referenceUrl: string) => SymbolEntry[]} parse Makes the symbols from the text of the file. Throws {@link SymbolIndexError} for a file that is not valid.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The identifier a Dokka record name stands for: the name itself, or, when the
 * name is a declaration (`fun waste(kerf: Double)`), the word before its
 * parameters, type or value.
 *
 * @param {string} name
 * @returns {string}
 */
function identifierOf(name) {
  const text = name.trim();
  if (/^[\w.$`-]+$/.test(text)) return text.replaceAll('`', '');
  const head = text.split(/[(:<=]/)[0].trim();
  return (head.split(/\s+/).pop() ?? '').replaceAll('`', '');
}

/**
 * @param {string} location
 * @returns {boolean} Whether a location stays below the reference: relative, without `..`, a scheme or white space.
 */
function isRelativeLocation(location) {
  return (
    location !== '' &&
    !/^[a-z][a-z0-9+.-]*:/i.test(location) &&
    !location.startsWith('/') &&
    !location.startsWith('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\s"'<>\\`\u0000-\u001f\u007f]/.test(location) &&
    !location.split(/[/#?]/).includes('..')
  );
}

/**
 * Reads Dokka's `scripts/pages.json`: a list of records
 * `{name, description, location, searchKeys}`, one for every package, class and
 * member of the generated documentation. `location` is the page, relative to the
 * root of the generated folder, with an anchor when the symbol has one.
 *
 * A record finds its symbol by the identifier in `name` (`Tool`, `waste`) and by
 * qualified names: a `searchKeys` entry that ends in `.{identifier}`, and the
 * `description` (the package or the owner, such as `com.example.Tool`) when it
 * ends in `.{identifier}`, or the description and the identifier joined with a dot
 * when the description is a dotted name. A record without a usable identifier
 * or location (the package list, for one) is left out.
 *
 * @param {string} text
 * @param {string} referenceUrl
 * @returns {SymbolEntry[]}
 */
export function parseDokkaPages(text, referenceUrl) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SymbolIndexError(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(data)) throw new SymbolIndexError('must be a list of records {name, description, location, searchKeys}');
  if (data.length > MAX_SYMBOLS) throw new SymbolIndexError(`has ${data.length} records; at most ${MAX_SYMBOLS} are read`);
  /** @type {SymbolEntry[]} */
  const entries = [];
  for (const [index, record] of data.entries()) {
    const where = `[${index}]`;
    if (!isMapping(record)) throw new SymbolIndexError(`${where}: must be a mapping with name and location`);
    const { name, location, description, searchKeys } = record;
    if (typeof name !== 'string' || name.length > MAX_TEXT_LENGTH) throw new SymbolIndexError(`${where}.name: must be text`);
    if (typeof location !== 'string' || location.length > MAX_TEXT_LENGTH) throw new SymbolIndexError(`${where}.location: must be text`);
    if (!isRelativeLocation(location)) {
      throw new SymbolIndexError(`${where}.location: "${location.slice(0, 80)}" must be a relative address below the reference (no scheme, no "..", no white space)`);
    }
    const identifier = identifierOf(name);
    if (identifier === '') continue;
    /** @type {Set<string>} */
    const keys = new Set([identifier]);
    const qualifies = (/** @type {string} */ key) => key === identifier || key.endsWith(`.${identifier}`);
    if (Array.isArray(searchKeys)) {
      for (const key of searchKeys) if (typeof key === 'string' && key.length <= MAX_TEXT_LENGTH && qualifies(key.trim())) keys.add(key.trim());
    }
    if (typeof description === 'string' && description.length <= MAX_TEXT_LENGTH) {
      const owner = description.trim();
      if (qualifies(owner)) keys.add(owner);
      else if (/^[\w$]+(?:\.[\w$]+)*$/.test(owner)) keys.add(`${owner}.${identifier}`);
    }
    const qualified = [...keys].sort((a, b) => b.length - a.length)[0];
    entries.push({ name: qualified, url: `${referenceUrl}${location}`, keys: [...keys] });
  }
  return entries;
}

/**
 * The index adapters coffer has. A configuration names one (`index: dokka`).
 *
 * @type {Readonly<Record<string, IndexAdapter>>}
 */
export const INDEX_ADAPTERS = Object.freeze({
  dokka: Object.freeze({ file: 'scripts/pages.json', parse: parseDokkaPages }),
});

/**
 * Reads the index file of a generated `html` reference and makes the index.
 * The generated folder is copied from the checkout without links, but the file is
 * still checked to be a regular file inside the folder, of a bounded size.
 *
 * @param {{ adapter: string, file: string | null }} index The `index` of the reference configuration.
 * @param {string} dataDir The generated folder.
 * @param {string} referenceUrl Site-relative address of the reference, ending in a slash.
 * @returns {SymbolIndex}
 * @throws {SymbolIndexError} When the file is missing or does not fit the adapter's format.
 */
export function indexOfHtmlReference(index, dataDir, referenceUrl) {
  const adapter = Object.hasOwn(INDEX_ADAPTERS, index.adapter) ? INDEX_ADAPTERS[index.adapter] : null;
  if (!adapter) throw new SymbolIndexError(`unknown index adapter "${index.adapter}" (expected one of: ${Object.keys(INDEX_ADAPTERS).join(', ')})`);
  const file = index.file ?? adapter.file;
  const parts = file.split('/');
  if (file === '' || file.startsWith('/') || parts.includes('..') || file.includes('\\')) {
    throw new SymbolIndexError(`the index file "${file}" must be a path inside the generated folder`);
  }
  const path = join(dataDir, ...parts);
  let text;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new SymbolIndexError(`the index file "${file}" is not a regular file`);
    if (stat.size > MAX_INDEX_FILE_BYTES) throw new SymbolIndexError(`the index file "${file}" is ${stat.size} bytes; at most ${MAX_INDEX_FILE_BYTES} are read`);
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof SymbolIndexError) throw error;
    throw new SymbolIndexError(`the index file "${file}" is not in the generated reference (the "${index.adapter}" adapter reads it to link guides to the reference)`);
  }
  try {
    return new SymbolIndex(adapter.parse(text, referenceUrl));
  } catch (error) {
    if (error instanceof SymbolIndexError) throw new SymbolIndexError(`${file}: ${error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Automatic links

/** Elements whose content is never linked automatically: links, code blocks and non-prose. */
const SKIPPED_ELEMENTS = new Set(['a', 'pre', 'script', 'style', 'textarea']);

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Wraps inline code that is exactly the name of a symbol in a link to it.
 * Code in a code block (`pre`), code that is already inside a link and code
 * whose name finds more than one place are left alone.
 *
 * @param {string} html The rendered HTML of a guide.
 * @param {SymbolIndex} index
 * @returns {{ html: string, linked: number }}
 */
export function linkSymbolsInHtml(html, index) {
  if (index.size === 0) return { html, linked: 0 };
  /** @type {Record<string, number>} */
  const open = {};
  let out = '';
  let copied = 0;
  let linked = 0;
  TOKEN.lastIndex = 0;
  let token;
  while ((token = TOKEN.exec(html)) !== null) {
    const [whole, closing, rawName, attributes] = token;
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    const selfClosing = attributes.trimEnd().endsWith('/');
    if (SKIPPED_ELEMENTS.has(name)) {
      if (closing) open[name] = Math.max(0, (open[name] ?? 0) - 1);
      else if (!selfClosing) open[name] = (open[name] ?? 0) + 1;
      continue;
    }
    if (name !== 'code' || closing || selfClosing || Object.values(open).some((count) => count > 0)) continue;
    const end = html.indexOf('</code>', token.index + whole.length);
    if (end < 0) continue;
    const inner = html.slice(token.index + whole.length, end);
    // Code with markup inside (highlighting, raw HTML) is not a plain name.
    if (inner.includes('<')) continue;
    const found = index.lookup(decodeEntities(inner, { html: true }));
    if (found === null || !('url' in found)) continue;
    out += `${html.slice(copied, token.index)}<a href="${escapeAttribute(found.url)}">${whole}${inner}</code></a>`;
    copied = end + '</code>'.length;
    TOKEN.lastIndex = copied;
    linked += 1;
  }
  return linked === 0 ? { html, linked } : { html: out + html.slice(copied), linked };
}
