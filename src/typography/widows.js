const NBSP = ' ';
/** Longest last word that is still joined to the word before it. */
const MAX_LAST_WORD = 12;
const TAIL = /^([\s\S]*?\S)([  ])(\S+)(\s*)$/u;

/**
 * Widow control for the text of one block: joins the last two words with
 * U+00A0. Skipped when the block has fewer than three words or the last word
 * is longer than 12 characters. In plain mode (titles, meta) the text is
 * returned with normal spaces and nothing is joined.
 *
 * @param {string} text Concatenated text of a block.
 * @param {{ plain?: boolean }} [options]
 * @returns {string}
 */
export function widows(text, options = {}) {
  if (options.plain) return text;
  const m = TAIL.exec(text);
  if (!m) return text;
  const [, head, , last, trailing] = m;
  if (head.split(/[\s ]+/u).filter(Boolean).length < 2) return text;
  if (Array.from(last).length > MAX_LAST_WORD) return text;
  return head + NBSP + last + trailing;
}
