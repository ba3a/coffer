import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** Directory holding the UI strings of the default theme (`en.yaml`, `ru.yaml`, ...). */
export const ENGINE_I18N_DIR = fileURLToPath(new URL('../../i18n/', import.meta.url));

/** The language every other language falls back to. */
export const FALLBACK_LANG = 'en';

/** Plural categories, as named by `Intl.PluralRules`. */
const PLURAL_CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

/** Named date formats understood by {@link formatDate}, besides `iso` and Intl option objects. */
export const DATE_STYLES = Object.freeze(['short', 'medium', 'long', 'full']);

/**
 * A UI string: plain text or the forms of a plural, keyed by plural category.
 *
 * @typedef {string | Record<string, string>} StringEntry
 */

/**
 * Called once for every string that had to be looked up in English or could
 * not be found at all.
 *
 * @callback MissingHandler
 * @param {string} message
 * @returns {void}
 */

/**
 * @typedef {object} TranslatorOptions
 * @property {string} lang BCP 47 language tag of the site.
 * @property {string | null} [themeDir] Theme directory; its `i18n/{lang}.yaml` overrides the engine's strings.
 * @property {string} [engineDir] Directory with the engine's strings (defaults to the one shipped with coffer).
 * @property {MissingHandler} [onMissing] Receives each missing-string message once, as it is found.
 */

/**
 * A problem in a strings file.
 */
export class I18nError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'I18nError';
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flattens a nested strings document into `group.name` keys. A mapping whose
 * keys are all plural categories is one plural entry, not a group.
 *
 * @param {unknown} node
 * @param {string} prefix
 * @param {Map<string, StringEntry>} into
 * @param {string} file For error messages.
 */
function flatten(node, prefix, into, file) {
  if (!isMapping(node)) {
    throw new I18nError(`${file}: expected a mapping of strings${prefix ? ` at "${prefix}"` : ''}`);
  }
  for (const [name, value] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'string') {
      into.set(key, value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      into.set(key, String(value));
    } else if (isMapping(value)) {
      const names = Object.keys(value);
      if (names.length > 0 && names.every((n) => PLURAL_CATEGORIES.has(n))) {
        /** @type {Record<string, string>} */
        const forms = {};
        for (const [category, text] of Object.entries(value)) {
          if (typeof text !== 'string') {
            throw new I18nError(`${file}: the "${category}" form of "${key}" must be a string`);
          }
          forms[category] = text;
        }
        into.set(key, forms);
      } else {
        flatten(value, key, into, file);
      }
    } else {
      throw new I18nError(`${file}: "${key}" must be a string or a mapping`);
    }
  }
}

/**
 * Reads one strings file into `into`, if the file exists.
 *
 * @param {string} file
 * @param {Map<string, StringEntry>} into
 * @returns {boolean} True when the file existed.
 */
function readStrings(file, into) {
  if (!existsSync(file)) return false;
  let document;
  try {
    document = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new I18nError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document === null || document === undefined) return true;
  flatten(document, '', into, file);
  return true;
}

/**
 * The tags to look for, most general first: `pt-BR` gives `pt`, then `pt-BR`.
 *
 * @param {string} lang
 * @returns {string[]}
 */
function langChain(lang) {
  const base = lang.split('-')[0];
  return base === lang ? [lang] : [base, lang];
}

/**
 * Loads the strings for a language: the engine's file, then the theme's file
 * on top of it, so that a theme only lists what it changes.
 *
 * @param {string} lang
 * @param {{ themeDir?: string | null, engineDir?: string }} [options]
 * @returns {{ strings: Map<string, StringEntry>, found: boolean }} `found` is false when no file exists for the language.
 */
export function loadStrings(lang, options = {}) {
  if (!/^[A-Za-z0-9-]+$/.test(lang)) {
    throw new I18nError(`"${lang}" is not a valid language tag`);
  }
  const engineDir = options.engineDir ?? ENGINE_I18N_DIR;
  /** @type {Map<string, StringEntry>} */
  const strings = new Map();
  let found = false;
  /** @type {string[]} */
  const dirs = [engineDir];
  if (options.themeDir) dirs.push(join(options.themeDir, 'i18n'));
  for (const dir of dirs) {
    for (const tag of langChain(lang)) {
      if (readStrings(join(dir, `${tag}.yaml`), strings)) found = true;
    }
  }
  return { strings, found };
}

/**
 * @param {string} lang
 * @returns {Intl.PluralRules}
 */
function pluralRules(lang) {
  try {
    return new Intl.PluralRules(lang);
  } catch {
    return new Intl.PluralRules(FALLBACK_LANG);
  }
}

/**
 * Formats a date or a moment in a language.
 *
 * `format` is one of `short`, `medium` (default), `long`, `full`, `iso` (the
 * calendar date as `YYYY-MM-DD`, for `datetime` attributes), or an object of
 * `Intl.DateTimeFormat` options. A string such as `2024-05-01` is a calendar
 * date and is never shifted by the time zone.
 *
 * @param {string} lang
 * @param {Date | string | number} value
 * @param {string | Intl.DateTimeFormatOptions} [format]
 * @param {string} [timeZone] IANA time zone; `UTC` by default.
 * @returns {string}
 */
export function formatDate(lang, value, format = 'medium', timeZone = 'UTC') {
  let instant;
  let zone = timeZone;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    instant = new Date(`${value}T00:00:00Z`);
    zone = 'UTC';
  } else {
    instant = value instanceof Date ? value : new Date(value);
  }
  if (Number.isNaN(instant.getTime())) {
    throw new I18nError(`cannot format "${String(value)}" as a date`);
  }
  /** @type {Intl.DateTimeFormatOptions} */
  let options;
  if (typeof format === 'object' && format !== null) {
    options = format;
  } else if (format === 'iso') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (/** @type {string} */ type) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } else if (DATE_STYLES.includes(format)) {
    options = { dateStyle: /** @type {'short' | 'medium' | 'long' | 'full'} */ (format) };
  } else {
    throw new I18nError(
      `unknown date format "${format}"; use ${[...DATE_STYLES, 'iso'].join(', ')} or an options object`,
    );
  }
  let locale = lang;
  try {
    Intl.DateTimeFormat.supportedLocalesOf(lang);
  } catch {
    locale = FALLBACK_LANG;
  }
  return new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(instant);
}

/**
 * Looks up UI strings for one language, with English as the fallback.
 */
export class Translator {
  /**
   * @param {TranslatorOptions} options
   */
  constructor(options) {
    const { lang, themeDir = null, engineDir, onMissing } = options;
    /** @type {string} */
    this.lang = lang;
    this.onMissing = onMissing;
    const own = loadStrings(lang, { themeDir, engineDir });
    this.strings = own.strings;
    this.rules = pluralRules(lang);
    this.isFallbackLang = lang.split('-')[0] === FALLBACK_LANG;
    this.fallback = this.isFallbackLang ? own.strings : loadStrings(FALLBACK_LANG, { themeDir, engineDir }).strings;
    this.fallbackRules = pluralRules(FALLBACK_LANG);
    /** @type {Set<string>} */
    this.reported = new Set();
    /** @type {string[]} */
    this.messages = [];
    if (!own.found) {
      this.report(`no UI strings for language "${lang}"; every string falls back to English`);
    }
  }

  /**
   * @param {string} message
   */
  report(message) {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.messages.push(message);
    this.onMissing?.(message);
  }

  /**
   * Every missing-string message found so far, in order.
   *
   * @returns {string[]}
   */
  missing() {
    return [...this.messages];
  }

  /**
   * Whether a key has a string in the site's language itself (not only in English).
   *
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.strings.has(key);
  }

  /**
   * Returns a UI string with its parameters filled in. A string with plural
   * forms needs a numeric `count` parameter and picks the form for it with
   * `Intl.PluralRules`. A key missing in the site's language is taken from
   * English and reported; a key missing everywhere is returned as is and
   * reported.
   *
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   * @returns {string}
   */
  t(key, params = {}) {
    let text = this.pick(this.strings.get(key), this.rules, key, params);
    if (text === undefined && !this.isFallbackLang) {
      text = this.pick(this.fallback.get(key), this.fallbackRules, key, params);
      if (text !== undefined) {
        this.report(`${this.lang}: missing string "${key}"; using English`);
      }
    }
    if (text === undefined) {
      this.report(`${this.lang}: missing string "${key}"`);
      return key;
    }
    return text.replace(/\{(\w+)\}/g, (whole, name) =>
      params[name] === undefined || params[name] === null ? whole : String(params[name]),
    );
  }

  /**
   * @param {StringEntry | undefined} entry
   * @param {Intl.PluralRules} rules
   * @param {string} key
   * @param {Record<string, unknown>} params
   * @returns {string | undefined}
   */
  pick(entry, rules, key, params) {
    if (entry === undefined || typeof entry === 'string') return entry;
    const count = Number(params.count);
    if (params.count === undefined || Number.isNaN(count)) {
      throw new I18nError(`string "${key}" has plural forms and needs a numeric "count" parameter`);
    }
    return entry[rules.select(count)] ?? entry.other;
  }
}
