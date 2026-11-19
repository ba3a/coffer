/**
 * A pair of marks: opening and closing.
 * @typedef {readonly [string, string]} MarkPair
 */

/**
 * The typography rules of one locale. Plain data, shared by every locale.
 *
 * @typedef {object} TypographyRules
 * @property {{ outer: MarkPair, inner: MarkPair }} quotes Quotation marks.
 * @property {string} apostrophe The apostrophe mark.
 * @property {{ sentence: string, range: string, spacedEnOption?: string }} dash Dash for a sentence (with its spacing) and for a range. `spacedEnOption` is the sentence dash for `dashStyle: spaced-en`.
 * @property {string} ellipsis The ellipsis mark.
 * @property {Record<string, unknown>} nbsp Language-specific non-breaking space rules. Empty when there are none.
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
