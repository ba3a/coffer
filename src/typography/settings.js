/**
 * Typography settings: the keys of the `typography` setting at site, blog and
 * post level, their checks, and the merge of the three levels.
 */

/**
 * Typography settings as written at one level; every key is optional.
 *
 * @typedef {object} TypographyInput
 * @property {boolean} [enabled] False turns every rule off.
 * @property {string} [locale] Canonical language tag that overrides the typography locale only.
 * @property {boolean} [hanging] Hanging punctuation.
 * @property {boolean} [hangLines] Also hang an opening quote or bracket that starts a line inside a paragraph (needs the theme script).
 * @property {'locale' | 'keep'} [headings] `keep` turns heading case off.
 * @property {boolean} [widows] Keep the last two words together.
 * @property {boolean} [feeds] Also typeset feed titles and summaries.
 * @property {'locale' | 'spaced-en'} [dashStyle] Sentence dash of `en`.
 * @property {string[]} [keep] Words that heading case never changes.
 */

/**
 * Typography settings with every default applied.
 *
 * @typedef {object} TypographySettings
 * @property {boolean} enabled
 * @property {string} locale Typography locale: `typography.locale`, else the content language.
 * @property {boolean} hanging
 * @property {boolean} hangLines
 * @property {'locale' | 'keep'} headings
 * @property {boolean} widows
 * @property {boolean} feeds
 * @property {'locale' | 'spaced-en'} dashStyle
 * @property {string[]} keep
 */

/** The keys of a `typography` setting. */
export const TYPOGRAPHY_KEYS = Object.freeze([
  'enabled',
  'locale',
  'hanging',
  'hangLines',
  'headings',
  'widows',
  'feeds',
  'dashStyle',
  'keep',
]);

const BOOLEAN_KEYS = ['enabled', 'hanging', 'hangLines', 'widows', 'feeds'];
const CHOICES = { headings: ['locale', 'keep'], dashStyle: ['locale', 'spaced-en'] };

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a language tag.
 *
 * @param {string} value
 * @returns {string | undefined} The canonical tag, or undefined when invalid.
 */
export function canonicalTag(value) {
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/**
 * Reads a `typography` mapping. Reports each problem with its key path and
 * leaves the key out of the result.
 *
 * @param {unknown} raw The value of the `typography` key; `undefined` or `null` for none.
 * @param {string} path Key path of the value, such as `sites[0].typography`.
 * @param {(path: string, message: string) => void} report
 * @returns {TypographyInput}
 */
export function readTypographyInput(raw, path, report) {
  /** @type {Record<string, unknown>} */
  const result = {};
  if (raw === undefined || raw === null) return result;
  if (!isMapping(raw)) {
    report(path, 'must be a mapping');
    return result;
  }
  for (const key of Object.keys(raw)) {
    if (!TYPOGRAPHY_KEYS.includes(key)) {
      report(`${path}.${key}`, `unknown key (expected one of: ${TYPOGRAPHY_KEYS.join(', ')})`);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') result[key] = value;
    else report(`${path}.${key}`, 'must be true or false');
  }
  for (const [key, choices] of Object.entries(CHOICES)) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && choices.includes(value)) result[key] = value;
    else report(`${path}.${key}`, `must be one of: ${choices.join(', ')}`);
  }
  const locale = raw.locale;
  if (locale !== undefined && locale !== null) {
    const tag = typeof locale === 'string' && locale.trim() !== '' ? canonicalTag(locale.trim()) : undefined;
    if (tag === undefined) report(`${path}.locale`, 'must be a valid language tag such as "en" or "ru"');
    else result.locale = tag;
  }
  const keep = raw.keep;
  if (keep !== undefined && keep !== null) {
    if (!Array.isArray(keep)) {
      report(`${path}.keep`, 'must be a list of words');
    } else {
      /** @type {string[]} */
      const words = [];
      keep.forEach((word, index) => {
        if (typeof word === 'string' && word.trim() !== '') words.push(word.trim());
        else report(`${path}.keep[${index}]`, 'must be a non-empty string');
      });
      result.keep = words;
    }
  }
  return result;
}

/**
 * Merges the typography settings of a site, a blog and a post, key by key.
 * The nearest level wins; `keep` lists are joined without repeats.
 *
 * @param {{ lang: string, typography?: TypographyInput }} site
 * @param {{ lang?: string, typography?: TypographyInput } | null | undefined} [blog]
 * @param {{ lang?: string, typography?: TypographyInput } | null | undefined} [post]
 * @returns {TypographySettings}
 */
export function resolveTypography(site, blog, post) {
  const levels = [site, blog, post].filter((level) => level !== null && level !== undefined);
  const lang = levels.reduce((nearest, level) => level.lang ?? nearest, site.lang);
  /** @type {TypographySettings} */
  const settings = {
    enabled: true,
    locale: lang,
    hanging: true,
    hangLines: false,
    headings: 'locale',
    widows: true,
    feeds: true,
    dashStyle: 'locale',
    keep: [],
  };
  /** @type {Record<string, unknown>} */
  const target = settings;
  for (const level of levels) {
    const given = level.typography ?? {};
    for (const key of TYPOGRAPHY_KEYS) {
      if (key === 'keep' || key === 'locale') continue;
      const value = /** @type {Record<string, unknown>} */ (given)[key];
      if (value !== undefined) target[key] = value;
    }
    if (given.keep !== undefined) {
      settings.keep = [...new Set([...settings.keep, ...given.keep])];
    }
  }
  // The locale override beats the language at any level; a nearer language
  // does not cancel a locale set higher up.
  for (const level of levels) {
    if (level.typography?.locale !== undefined) settings.locale = level.typography.locale;
  }
  return settings;
}
