/** Characters that end a word's core: anything that is not a letter or digit. */
const EDGE = /^([^\p{L}\p{N}]*)([\s\S]*?)([^\p{L}\p{N}]*)$/u;

/**
 * Splits a word into leading punctuation, core and trailing punctuation.
 *
 * @param {string} word
 * @returns {[string, string, string]}
 */
function splitEdges(word) {
  const m = EDGE.exec(word);
  return m ? [m[1], m[2], m[3]] : ['', word, ''];
}

/**
 * True when the core of a word must never change: digits, `.` `_` `/` `@`,
 * an inner capital, or all caps of two or more letters.
 *
 * @param {string} core
 * @returns {boolean}
 */
function isProtected(core) {
  if (/[\p{N}._/@]/u.test(core)) return true;
  const letters = Array.from(core).filter((c) => /\p{L}/u.test(c));
  if (letters.length >= 2 && letters.every((c) => c === c.toUpperCase() && c !== c.toLowerCase())) {
    return true;
  }
  return letters.slice(1).some((c) => c !== c.toLowerCase());
}

/**
 * Changes the first letter of a word with `fn`.
 *
 * @param {string} word
 * @param {(c: string) => string} fn
 * @returns {string}
 */
function mapFirstLetter(word, fn) {
  const chars = Array.from(word);
  const i = chars.findIndex((c) => /\p{L}/u.test(c));
  if (i < 0) return word;
  chars[i] = fn(chars[i]);
  return chars.join('');
}

const upper = (/** @type {string} */ c) => c.toUpperCase();
const lower = (/** @type {string} */ c) => c.toLowerCase();

/**
 * @param {string} word
 * @param {Set<string>} keep
 * @returns {boolean} True when the word must stay as written.
 */
function frozen(word, keep) {
  const [, core] = splitEdges(word);
  return core === '' || keep.has(core) || keep.has(word) || isProtected(core);
}

/**
 * Applies the heading case convention of a rule set to a heading text.
 * Never changes words with an inner capital, digits, all-caps words of two
 * or more letters, words with `.` `_` `/` `@`, or words in `keep`.
 *
 * @param {string} text Heading text.
 * @param {{ rules: import('./rules/neutral.js').TypographyRules, keep?: Iterable<string> }} options
 * @returns {{ text: string, changed: boolean }}
 */
export function headingCase(text, { rules, keep = [] }) {
  const keepSet = new Set(keep);
  const convention = rules.headingCase;
  /** @type {string} */
  let out = text;
  if (convention === 'title') out = titleCase(text, rules.smallWords ?? [], keepSet);
  else if (convention === 'sentence') out = sentenceCase(text, keepSet);
  else if (convention === 'german') out = germanCase(text, keepSet);
  return { text: out, changed: out !== text };
}

/**
 * @param {string} text
 * @returns {string[]} Words and the white space between them, alternating.
 */
function tokens(text) {
  return text.split(/(\s+)/u);
}

/**
 * @param {string} text
 * @param {readonly string[]} smallWords
 * @param {Set<string>} keep
 * @returns {string}
 */
function titleCase(text, smallWords, keep) {
  const small = new Set(smallWords);
  const parts = tokens(text);
  const wordIdx = parts.map((p, i) => (i % 2 === 0 && p !== '' ? i : -1)).filter((i) => i >= 0);
  // A word in keep never counts as the last word: 'Setting Up coffer'.
  const lastIdx = wordIdx.findLast((i) => !keep.has(splitEdges(parts[i])[1]));
  let prev = '';
  for (const i of wordIdx) {
    const word = parts[i];
    const afterColon = prev.endsWith(':');
    const pieces = word.split(/(-)/u);
    const lastPiece = pieces.length - 1;
    parts[i] = pieces
      .map((piece, k) => {
        if (k % 2 === 1 || piece === '') return piece;
        if (frozen(piece, keep) || frozen(word, keep)) return piece;
        const edge =
          (k === 0 && (i === wordIdx[0] || afterColon)) || (i === lastIdx && k === lastPiece);
        const [, core] = splitEdges(piece);
        if (!edge && small.has(core.toLowerCase())) return mapFirstLetter(piece, lower);
        return mapFirstLetter(piece, upper);
      })
      .join('');
    prev = word;
  }
  return parts.join('');
}

/**
 * @param {string} text
 * @param {Set<string>} keep
 * @returns {string}
 */
function sentenceCase(text, keep) {
  const parts = tokens(text);
  const wordIdx = parts
    .map((p, i) => (i % 2 === 0 && /\p{L}/u.test(p) ? i : -1))
    .filter((i) => i >= 0);
  if (wordIdx.length < 3) return text;
  const capitalised = wordIdx.every((i) => {
    const first = Array.from(parts[i]).find((c) => /\p{L}/u.test(c)) ?? '';
    return first !== first.toLowerCase();
  });
  if (!capitalised) return text;
  let prev = '';
  for (const i of wordIdx) {
    const word = parts[i];
    const afterStop = /[:.]$/u.test(prev);
    if (i !== wordIdx[0] && !afterStop && !frozen(word, keep)) {
      parts[i] = mapFirstLetter(word, lower);
    }
    prev = word;
  }
  return parts.join('');
}

/**
 * @param {string} text
 * @param {Set<string>} keep
 * @returns {string}
 */
function germanCase(text, keep) {
  const parts = tokens(text);
  const i = parts.findIndex((p, k) => k % 2 === 0 && /\p{L}/u.test(p));
  if (i < 0 || frozen(parts[i], keep)) return text;
  parts[i] = mapFirstLetter(parts[i], upper);
  return parts.join('');
}
