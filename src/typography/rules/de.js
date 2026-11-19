/** Abbreviations that bind to the next word. */
const ABBREVIATIONS = ['z. B.', 'd. h.', 'u. a.', 'Nr.', 'Dr.', 'Prof.'];

/** @type {import('./neutral.js').TypographyRules} */
export const de = Object.freeze({
  quotes: Object.freeze({
    outer: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['„', '“'])),
    inner: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['‚', '‘'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: ' – ', range: '–' }),
  ellipsis: '…',
  nbsp: Object.freeze({
    wordsAfter: Object.freeze(ABBREVIATIONS),
  }),
  headingCase: 'german',
});
