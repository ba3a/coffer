/** One- to three-letter prepositions, conjunctions and particles. */
const SHORT_WORDS = [
  // prepositions
  'в', 'во', 'к', 'ко', 'с', 'со', 'у', 'о', 'об', 'обо', 'от', 'ото', 'до', 'из', 'изо',
  'за', 'на', 'по', 'при', 'про', 'для', 'без', 'над', 'под', 'подо', 'через',
  // conjunctions
  'и', 'а', 'но', 'да', 'или', 'ни', 'что', 'как', 'то',
  // particles
  'не', 'вот', 'вон', 'уж', 'ну',
].filter((w) => w.length <= 3);

/** Abbreviations that bind to the next word. */
const ABBREVIATIONS = ['г.', 'гг.', 'т. е.', 'т. д.', 'руб.', 'тыс.'];

/** @type {import('./neutral.js').TypographyRules} */
export const ru = Object.freeze({
  quotes: Object.freeze({
    outer: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['«', '»'])),
    inner: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['„', '“'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: ' — ', range: '–' }),
  ellipsis: '…',
  nbsp: Object.freeze({
    wordsAfter: Object.freeze([...SHORT_WORDS, ...ABBREVIATIONS]),
    wordsBefore: Object.freeze(['же', 'ли', 'бы', 'ль', '—']),
    patterns: Object.freeze([
      // Initials and surname: А. С. Пушкин
      /(?<![\p{L}\p{N}_])(?:\p{Lu}\. ){1,2}(?=\p{Lu}\p{Ll})/gu,
    ]),
  }),
  headingCase: 'sentence',
});
