import { UNITS, NUMBER_SIGNS } from './rules/common.js';

/** @typedef {import('./rules/neutral.js').TypographyRules} TypographyRules */

/**
 * @typedef {object} TypesetOptions
 * @property {TypographyRules} rules The rules of the locale.
 * @property {'locale' | 'spaced-en'} [dashStyle] `spaced-en` uses `rules.dash.spacedEnOption` for the sentence dash, when the rules have one.
 * @property {boolean} [plain] Text for titles and meta: normal spaces only. No effect on quotes.
 */

/**
 * A quote that has no partner. It stays as typed.
 *
 * @typedef {object} UnpairedQuote
 * @property {number} offset Offset in the joined text of all segments.
 * @property {number} segment Index of the segment that holds the quote.
 * @property {number} index Offset inside that segment.
 * @property {string} char The quote as typed.
 */

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const SPACE = /\s/u;
/** Characters after which a quote opens, besides space: brackets and dashes. */
const OPENING_CONTEXT = new Set(['(', '[', '{', '-', '‐', '‑', '‒', '–', '—', '―']);
/** Opening marks that an author may have typeset already. */
const TYPESET_OPENERS = ['«', '„', '‚'];

/**
 * Pairs the straight quotes in text that is split into segments (text nodes
 * of one block, with inline elements between them). A quote pairs across
 * segment boundaries. Marks the author typeset already are kept.
 *
 * @param {readonly string[]} segments Text segments of one block, in order.
 * @param {TypesetOptions} options
 * @returns {{ segments: string[], unpaired: UnpairedQuote[] }}
 */
export function typesetSegments(segments, options) {
  const { rules } = options;
  const text = segments.join('');
  const chars = Array.from(text);
  // Offsets are in UTF-16 units; build an index of code point starts.
  /** @type {number[]} */
  const unitOffset = [];
  let unit = 0;
  for (const ch of chars) {
    unitOffset.push(unit);
    unit += ch.length;
  }

  const openers = new Set([...TYPESET_OPENERS, rules.quotes.outer[0], rules.quotes.inner[0]]);
  /** @type {Array<'open' | 'close' | 'apostrophe' | null>} */
  const kind = chars.map(() => null);

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== '"' && c !== "'") continue;
    const prev = i > 0 ? chars[i - 1] : '';
    const next = i + 1 < chars.length ? chars[i + 1] : '';
    if (c === "'" && ((LETTER.test(prev) && LETTER.test(next)) || DIGIT.test(next))) {
      kind[i] = 'apostrophe';
      continue;
    }
    const prevOpens =
      prev === '' ||
      SPACE.test(prev) ||
      OPENING_CONTEXT.has(prev) ||
      openers.has(prev) ||
      kind[i - 1] === 'open';
    kind[i] = prevOpens ? 'open' : 'close';
  }

  // Pair each closer with the nearest open quote of the same character.
  /** @type {number[]} */
  const stack = [];
  /** @type {Map<number, number>} opener index to closer index */
  const partner = new Map();
  /** @type {Set<number>} */
  const unpairedAt = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (kind[i] === 'open') {
      stack.push(i);
    } else if (kind[i] === 'close') {
      let at = stack.length - 1;
      while (at >= 0 && chars[stack[at]] !== chars[i]) at--;
      if (at < 0) {
        unpairedAt.add(i);
        continue;
      }
      for (const lost of stack.splice(at + 1)) unpairedAt.add(lost);
      const opener = /** @type {number} */ (stack.pop());
      partner.set(opener, i);
    }
  }
  for (const rest of stack) unpairedAt.add(rest);

  // Replace pairs by depth, and apostrophes.
  const pad = rules.nbsp.insideQuotes ?? '';
  const out = chars.slice();
  let depth = 0;
  /** @type {Map<number, number>} closer index to the depth of its pair */
  const closerDepth = new Map();
  for (let i = 0; i < chars.length; i++) {
    if (kind[i] === 'apostrophe') {
      out[i] = rules.apostrophe;
    } else if (partner.has(i)) {
      closerDepth.set(/** @type {number} */ (partner.get(i)), depth);
      out[i] = (depth % 2 === 0 ? rules.quotes.outer : rules.quotes.inner)[0];
      if (depth % 2 === 0 && pad) {
        out[i] += pad;
        if (chars[i + 1] === ' ') out[i + 1] = '';
      }
      depth++;
    } else if (closerDepth.has(i)) {
      depth--;
      out[i] = (depth % 2 === 0 ? rules.quotes.outer : rules.quotes.inner)[1];
      if (depth % 2 === 0 && pad) {
        out[i] = pad + out[i];
        if (i > 0 && chars[i - 1] === ' ') out[i - 1] = '';
      }
    }
  }

  // Cut the result back into the original segments.
  /** @type {string[]} */
  const result = [];
  /** @type {UnpairedQuote[]} */
  const unpaired = [];
  let at = 0;
  const bounds = segments.map((s) => {
    const start = at;
    at += Array.from(s).length;
    return [start, at];
  });
  bounds.forEach(([start, end], segment) => {
    result.push(out.slice(start, end).join(''));
    for (let i = start; i < end; i++) {
      if (unpairedAt.has(i)) {
        unpaired.push({
          offset: unitOffset[i],
          segment,
          index: unitOffset[i] - unitOffset[start],
          char: chars[i],
        });
      }
    }
  });
  return { segments: result.map((s, i) => typesetSymbols(s, options, i === 0)), unpaired };
}

/** Bare URLs and email addresses. Symbol rules skip them. */
const PROTECTED = /(?:\b(?:https?:\/\/|www\.)[^\s<>]+)|(?:[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)/gu;
/** Dates that are written with hyphens. Their hyphens are not ranges. */
const HYPHEN_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}-\d{1,2}-\d{4}\b/;
const RANGE = new RegExp(`${HYPHEN_DATE.source}|(?<![\\p{L}_]\\d*)(?<=\\d)-(?=\\d)`, 'gu');
const MINUS = /(?<![\p{L}\p{N}_\-–—])-(?=\d)/gu;
const TIMES = /(?<![\p{L}\d_.,])(\d+(?:[.,]\d+)*)( ?)x( ?)(?=\d)/gu;

/**
 * Dashes, minus, ellipsis and multiplication sign in one text segment.
 *
 * @param {string} text
 * @param {TypesetOptions} options
 * @param {boolean} blockStart True when the segment starts the block.
 * @returns {string}
 */
function typesetSymbols(text, options, blockStart) {
  const { rules } = options;
  const spaced = rules.dash.spacedEnOption;
  const sentence = options.dashStyle === 'spaced-en' && spaced !== undefined ? spaced : rules.dash.sentence;
  const dashChar = sentence.replace(/^[\s  ]+|[\s  ]+$/gu, '');

  // A dialogue dash at line start: only the character changes.
  let head = '';
  let body = text;
  if (blockStart && /^- /.test(body)) {
    head = dashChar;
    body = body.slice(1);
  }
  body = body.replace(/\n- /g, `\n${dashChar} `);

  let out = '';
  let last = 0;
  for (const m of body.matchAll(PROTECTED)) {
    out += typesetPlain(body.slice(last, m.index), rules, sentence);
    out += m[0];
    last = m.index + m[0].length;
  }
  out += typesetPlain(body.slice(last), rules, sentence);
  const result = head + out;
  return options.plain ? result.replace(/[\u00A0\u202F]/g, ' ') : result;
}

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NBSP = '\u00A0';
const bindSpaces = (/** @type {string} */ m) => m.replaceAll(' ', NBSP);
const NUMBER_UNIT = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.,])\d+(?:[.,]\d+)* (?=(?:${[...UNITS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\p{L}\p{N}_]))`,
  'gu',
);
const DIGIT_GROUPS = /(?<![\p{N}.,])\d{1,3}(?: \d{3})+(?![\p{N}])/gu;
const NUMBER_SIGN = new RegExp(String.raw`[${NUMBER_SIGNS.join('')}] (?=\d)`, 'gu');
/** @type {WeakMap<object, { after: RegExp | null, before: RegExp | null }>} */
const NBSP_CACHE = new WeakMap();

/**
 * @param {readonly string[]} words
 * @returns {string}
 */
const alternation = (words) =>
  [...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|');

/** @type {WeakMap<object, RegExp>} */
const PUNCT_CACHE = new WeakMap();

/**
 * A space (or none) before a mark that follows a word or a closing mark.
 * The mark must end the word: a space, the end or more punctuation follows.
 * A time such as `12:30` stays.
 *
 * @param {Readonly<Record<string, string>>} marks
 * @returns {RegExp}
 */
function punctuationRegexp(marks) {
  let re = PUNCT_CACHE.get(marks);
  if (!re) {
    const set = Object.keys(marks).map(escapeRe).join('');
    re = new RegExp(
      String.raw`(?<=[\p{L}\p{N}»”)\]…]) ?([${set}])(?=$|[\s  !?;:.,)»”])`,
      'gu',
    );
    PUNCT_CACHE.set(marks, re);
  }
  return re;
}

/**
 * Compiles the word lists of a rule set once.
 *
 * @param {TypographyRules['nbsp']} nbsp
 */
function wordRegexps(nbsp) {
  let cached = NBSP_CACHE.get(nbsp);
  if (!cached) {
    cached = {
      after: nbsp.wordsAfter?.length
        ? new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${alternation(nbsp.wordsAfter)}) (?=\S)`, 'giu')
        : null,
      before: nbsp.wordsBefore?.length
        ? new RegExp(String.raw`(?<=\S) (?=(?:${alternation(nbsp.wordsBefore)})(?![\p{L}\p{N}_]))`, 'giu')
        : null,
    };
    NBSP_CACHE.set(nbsp, cached);
  }
  return cached;
}

/**
 * Non-breaking spaces: number and unit, digit groups, number signs, and the
 * locale hooks. Only U+0020 is changed, so spaces the author wrote as U+00A0
 * or U+202F stay.
 *
 * @param {string} text Text without URLs and emails.
 * @param {TypographyRules} rules
 * @returns {string}
 */
function bindSpacesIn(text, rules) {
  let s = text
    .replace(DIGIT_GROUPS, bindSpaces)
    .replace(NUMBER_UNIT, (m) => m.slice(0, -1) + NBSP)
    .replace(NUMBER_SIGN, bindSpaces);
  const marks = rules.nbsp.beforePunctuation;
  if (marks) {
    s = s.replace(punctuationRegexp(marks), (_m, mark) => `${marks[mark]}${mark}`);
  }
  const { after, before } = wordRegexps(rules.nbsp);
  if (after) s = s.replace(after, bindSpaces);
  if (before) s = s.replace(before, NBSP);
  for (const pattern of rules.nbsp.patterns ?? []) {
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    s = s.replace(global, bindSpaces);
  }
  return s;
}

/**
 * @param {string} text Text without URLs and emails.
 * @param {TypographyRules} rules
 * @param {string} sentence The sentence dash with its spacing.
 * @returns {string}
 */
function typesetPlain(text, rules, sentence) {
  let s = text
    .replace(/(?<!-)---(?!-)/g, '—')
    .replace(/(?<!-)--(?!-)/g, '–')
    .replace(/ - /g, () => sentence)
    .replace(RANGE, (m) => (m === '-' ? rules.dash.range : m))
    .replace(MINUS, '−')
    .replace(/(?<!\.)\.\.\.(?!\.)/g, () => rules.ellipsis);
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(TIMES, (m, num, a, b) => (num === '0' && a === '' && b === '' ? m : `${num}${a}×${b}`));
  }
  if (rules.sentenceEnd) s = replaceSentenceEnd(s, rules.sentenceEnd);
  return bindSpacesIn(s, rules);
}

/**
 * Replaces a sentence-final mark that follows a letter of the script. The
 * mark ends a sentence when a space, the end or a closing mark follows. A
 * full stop after a one-letter word is an initial and stays. A colon before
 * an opening quote introduces speech and stays.
 *
 * @param {string} text
 * @param {NonNullable<TypographyRules['sentenceEnd']>} end
 * @returns {string}
 */
function replaceSentenceEnd(text, end) {
  const after = end.after.source;
  const others = Object.keys(end.marks).filter((m) => m !== '.').map(escapeRe).join('');
  const re = new RegExp(
    String.raw`(?:(?<=\p{L}${after})(\.)|(?<=${after})([${others}]))` +
      String.raw`(?=$|[»”)\]]|\s+(?!["«“„]))`,
    'gu',
  );
  return text.replace(re, (_m, dot, mark) => end.marks[dot ?? mark]);
}


/**
 * Typesets a string: quotes, apostrophes, dashes, minus, ellipsis and the
 * multiplication sign. Unpaired quotes stay as typed; use `typesetSegments`
 * to get them reported.
 *
 * @param {string} text
 * @param {TypesetOptions} options
 * @returns {string}
 */
export function typeset(text, options) {
  return typesetSegments([text], options).segments[0];
}
