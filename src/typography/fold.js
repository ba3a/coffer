const DOUBLE_QUOTES = /[«»“”„‟″〝-〟]/g;
const SINGLE_QUOTES = /[‘’‚‛‹›′]/g;
const DASHES = /[‐-―−]/g;
const NO_BREAK_SPACES = /[  ]/g;

/**
 * Folds typographic characters to plain ASCII forms, so that a search
 * query and the index match whatever typography the text has.
 * @param {string} text
 * @returns {string}
 */
export function foldForSearch(text) {
  return String(text)
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(DASHES, '-')
    .replace(/…/g, '...')
    .replace(NO_BREAK_SPACES, ' ')
    .replace(/։/g, '.');
}
