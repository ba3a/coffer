const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
];

/** @type {import('./neutral.js').TypographyRules} */
export const en = Object.freeze({
  quotes: Object.freeze({
    outer: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['“', '”'])),
    inner: /** @type {import('./neutral.js').MarkPair} */ (Object.freeze(['‘', '’'])),
  }),
  apostrophe: '’',
  dash: Object.freeze({ sentence: '—', range: '–', spacedEnOption: ' – ' }),
  ellipsis: '…',
  nbsp: Object.freeze({
    wordsAfter: Object.freeze(['Mr.', 'Mrs.', 'Dr.', 'St.', 'vs.']),
    patterns: Object.freeze([
      new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${MONTHS.join('|')})\.? (?=\d{1,2}(?![\p{L}\p{N}_]))`, 'gu'),
    ]),
  }),
  headingCase: 'title',
  smallWords: Object.freeze(
    'a an the and but or nor for so yet as at by in of off on per to up via from with'.split(' '),
  ),
});
