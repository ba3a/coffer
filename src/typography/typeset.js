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
      depth++;
    } else if (closerDepth.has(i)) {
      depth--;
      out[i] = (depth % 2 === 0 ? rules.quotes.outer : rules.quotes.inner)[1];
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
  return head + out;
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
  return s;
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
