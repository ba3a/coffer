import { absoluteUrl } from './feeds.js';

/** Name of the share summary file, in the folder of a post's address (`{post}/share.txt`). */
export const SHARE_FILE_NAME = 'share.txt';

/** Site-relative address of the script that gives the copy button its function. */
export const SHARE_SCRIPT = '/assets/share.js';

/**
 * The address of the share summary of a post.
 *
 * @param {string} postUrl Site-relative URL of the post, ending in a slash.
 * @returns {string}
 */
export function shareUrlFor(postUrl) {
  return `${postUrl}${SHARE_FILE_NAME}`;
}

/**
 * Puts a text on one line: every run of white space and every control character
 * becomes a single space, so that a title or a summary cannot add lines to the
 * share summary.
 *
 * @param {string} text
 * @returns {string}
 */
function oneLine(text) {
  return text.replace(/[\s\p{Cc}]+/gu, ' ').trim();
}

/**
 * Hashtags for the tags of a post. A hashtag is made of the words of a tag's
 * display name, each starting with a capital letter and joined without
 * separators (`Hand tools` and `hand-tools` both become `#HandTools`), the form
 * LinkedIn and other networks make linkable. A tag without a letter is left out
 * (a hashtag of digits only is not one), and so is a tag that gives a hashtag
 * an earlier tag already gave.
 *
 * @param {string[]} names Display names of the tags, in the order of the post.
 * @returns {string[]} Hashtags with their `#`.
 */
export function hashtagsFor(names) {
  /** @type {string[]} */
  const hashtags = [];
  const seen = new Set();
  for (const name of names) {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
    const joined = words
      .map((word) => (word === word.toLowerCase() ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
      .join('');
    if (!/\p{L}/u.test(joined)) continue;
    const key = joined.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hashtags.push(`#${joined}`);
  }
  return hashtags;
}

/**
 * The text of a share summary: the title, the summary and the canonical address
 * of the post, and when there are hashtags, those. Each part is a paragraph of
 * its own, so that the text pastes well into a post on a social network. It is
 * plain text with `\n` line ends and ends with one.
 *
 * @param {object} post
 * @param {string} post.baseUrl Absolute URL of the site, without a trailing slash.
 * @param {string} post.url Site-relative URL of the post, ending in a slash.
 * @param {string} post.title
 * @param {string} post.summary May be empty, then it is left out.
 * @param {string[]} [post.hashtags] Hashtags with their `#`.
 * @returns {string}
 */
export function renderShareText({ baseUrl, url, title, summary, hashtags = [] }) {
  const paragraphs = [oneLine(title), oneLine(summary), absoluteUrl(baseUrl, url), hashtags.join(' ')];
  return `${paragraphs.filter((paragraph) => paragraph !== '').join('\n\n')}\n`;
}
