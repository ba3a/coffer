import { neutral } from './neutral.js';
import { en } from './en.js';
import { ru } from './ru.js';
import { de } from './de.js';

/** @typedef {import('./neutral.js').TypographyRules} TypographyRules */

/**
 * Rule sets by lower-case locale tag. Neutral is the fallback.
 *
 * @type {Map<string, TypographyRules>}
 */
const RULES = new Map([['en', en], ['ru', ru], ['de', de]]);

/**
 * Finds the rules for a locale: the exact tag, then its language
 * (`fr-CH` uses `fr`), then the neutral set.
 *
 * @param {string | undefined | null} locale A BCP 47 tag.
 * @returns {TypographyRules}
 */
export function resolveRules(locale) {
  const tag = String(locale ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (tag === '') return neutral;
  const exact = RULES.get(tag);
  if (exact) return exact;
  const language = tag.split('-')[0];
  return RULES.get(language) ?? neutral;
}
