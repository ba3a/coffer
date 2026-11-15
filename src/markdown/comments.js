import { visit } from 'unist-util-visit';

/**
 * Cuts the HTML comments out of a piece of raw HTML.
 *
 * The scan follows the HTML syntax: a comment runs from `<!--` to the next
 * `-->`, except that `<!-->` and `<!--->` are complete, empty comments (the
 * "abrupt closing of an empty comment" of the HTML parsing rules), so the text
 * after them is kept.
 *
 * A `<!--` that is never closed is left as it is, together with everything after
 * it. HTML itself would treat the rest of the text as a comment, but cutting
 * it here would silently delete content (and closing tags) because of one
 * mistyped note; kept as it is, the mistake stays visible in the output. The scan
 * stops at the first missing terminator, so it takes time proportional to the
 * length of the text however many `<!--` it holds.
 *
 * @param {string} html
 * @returns {string}
 */
export function removeHtmlComments(html) {
  let result = '';
  let from = 0;
  for (;;) {
    const start = html.indexOf('<!--', from);
    if (start === -1) break;
    const body = start + '<!--'.length;
    let end;
    if (html.startsWith('>', body)) {
      end = body + 1;
    } else if (html.startsWith('->', body)) {
      end = body + 2;
    } else {
      const close = html.indexOf('-->', body);
      if (close === -1) break;
      end = close + '-->'.length;
    }
    result += html.slice(from, start);
    from = end;
  }
  return from === 0 ? html : result + html.slice(from);
}

/**
 * Removes HTML comments from the page, so a note to the author such as
 * `<!-- TODO: rewrite -->` stays in the source and is never published. A comment
 * inside a raw `<script>` or `<style>` block is left alone, because it can be
 * part of the script or the style sheet. See `removeHtmlComments` for the
 * syntax that is understood.
 *
 * @returns {(tree: import('hast').Root) => void}
 */
export function dropComments() {
  return (tree) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;
      const type = /** @type {string} */ (node.type);
      if (type === 'comment') {
        parent.children.splice(index, 1);
        return index;
      }
      if (type !== 'raw') return;
      const raw = /** @type {{ value: string }} */ (/** @type {unknown} */ (node));
      if (!raw.value.includes('<!--') || /<(?:script|style)\b/i.test(raw.value)) return;
      raw.value = removeHtmlComments(raw.value);
      if (raw.value.trim() === '') {
        parent.children.splice(index, 1);
        return index;
      }
    });
  };
}
