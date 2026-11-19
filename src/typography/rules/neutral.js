/**
 * A pair of marks: opening and closing.
 * @typedef {readonly [string, string]} MarkPair
 */

/**
 * Language-specific non-breaking space rules. All parts are optional.
 *
 * @typedef {object} NbspRules
 * @property {readonly string[]} [wordsAfter] Words that bind to the next word (`в`, `Mr.`). Matched as whole words, ignoring case. Spaces inside an entry bind too.
 * @property {readonly string[]} [wordsBefore] Words that bind to the word before them (`же`, `ли`).
 * @property {readonly RegExp[]} [patterns] Each space (U+0020) inside a match becomes U+00A0.
 */

/**
 * The typography rules of one locale. Plain data, shared by every locale.
 *
 * @typedef {object} TypographyRules
 * @property {{ outer: MarkPair, inner: MarkPair }} quotes Quotation marks.
 * @property {string} apostrophe The apostrophe mark.
 * @property {{ sentence: string, range: string, spacedEnOption?: string }} dash Dash for a sentence (with its spacing) and for a range. `spacedEnOption` is the sentence dash for `dashStyle: spaced-en`.
 * @property {string} ellipsis The ellipsis mark.
 * @property {NbspRules} nbsp Language-specific non-breaking space rules. Empty when there are none.
 * @property {'none' | 'title' | 'sentence' | 'german'} headingCase Heading case convention.
 */

/** @type {TypographyRules} */
export const neutral = Object.freeze({
  quotes: Object.freeze({
    outer: /** @type {MarkPair} */ (Object.freeze(['“', '”'])),
    inner: /** @type {MarkPair} */ (Object.freeze(['‘', '’'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: '—', range: '–' }),
  ellipsis: '…',
  nbsp: Object.freeze({}),
  headingCase: 'none',
});
