const NNBSP = '\u202F';
const NBSP = '\u00A0';

/** @type {import('./neutral.js').TypographyRules} */
export const fr = Object.freeze({
  quotes: Object.freeze({
    outer: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['«', '»'])),
    inner: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['“', '”'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: ' — ', range: '–' }),
  ellipsis: '…',
  nbsp: Object.freeze({
    beforePunctuation: Object.freeze({ ';': NNBSP, '!': NNBSP, '?': NNBSP, ':': NBSP }),
    insideQuotes: NNBSP,
    patterns: Object.freeze([
      // A one-letter word binds to the next word: à Paris, y a-t-il
      /(?<![\p{L}\p{N}_'’-])\p{L} (?=\S)/gu,
    ]),
  }),
  headingCase: 'sentence',
});
