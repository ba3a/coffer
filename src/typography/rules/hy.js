/**
 * Armenian rules. EXPERIMENTAL: a native reader has not reviewed the quote
 * marks, the spaced em dash or the full stop yet (specs/typography.md,
 * "Open questions"). The data says so with `experimental: true`.
 *
 * The question mark and the exclamation mark are left as typed: the Armenian
 * marks stand over the stressed vowel, which the engine cannot know.
 *
 * @type {import('./neutral.js').TypographyRules}
 */
export const hy = Object.freeze({
  experimental: true,
  quotes: Object.freeze({
    outer: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['«', '»'])),
    inner: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['“', '”'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: ' — ', range: '–' }),
  ellipsis: '…',
  nbsp: Object.freeze({
    wordsBefore: Object.freeze(['—']),
  }),
  // After an Armenian letter, a full stop or a colon that ends a sentence
  // becomes the Armenian full stop U+0589.
  sentenceEnd: Object.freeze({
    after: /\p{Script=Armenian}/u,
    marks: Object.freeze({ '.': '։', ':': '։' }),
  }),
  headingCase: 'sentence',
});
