import { resolveRules } from './rules/index.js';
import { typeset } from './typeset.js';
import { headingCase } from './heading-case.js';
import { widows } from './widows.js';

/**
 * Typesets a title shown in the body of a page, by the rules of the settings:
 * marks, heading case and widow control. Titles in `<title>`, meta text and
 * feeds use the plain text instead.
 *
 * @param {string} text
 * @param {Pick<import('./settings.js').TypographySettings, 'enabled' | 'locale' | 'dashStyle' | 'headings' | 'keep' | 'widows'>} settings
 * @returns {string}
 */
export function typesetTitle(text, settings) {
  if (settings.enabled === false || text === '') return text;
  const rules = resolveRules(settings.locale);
  let result = typeset(text, { rules, dashStyle: settings.dashStyle });
  if (settings.headings !== 'keep') result = headingCase(result, { rules, keep: settings.keep }).text;
  return settings.widows ? widows(result) : result;
}

/**
 * Typesets text for `<title>`, meta tags and share text: marks and dashes by
 * the rules of the locale, normal spaces only, no hang spans, no heading case.
 *
 * @param {string} text
 * @param {Pick<import('./settings.js').TypographySettings, 'enabled' | 'locale' | 'dashStyle'>} settings
 * @returns {string}
 */
export function typesetMeta(text, settings) {
  if (settings.enabled === false || text === '') return text;
  return typeset(text, { rules: resolveRules(settings.locale), dashStyle: settings.dashStyle, plain: true });
}
