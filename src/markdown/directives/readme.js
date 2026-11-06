import { SKIP, visit } from 'unist-util-visit';

/**
 * The `::readme` leaf directive.
 *
 * ```
 * ::readme{section="Quick start"}
 * ::readme{file="docs/install.md" section="Linux"}
 * ```
 *
 * It marks the place where a section of a file of the project's repository (by
 * default its README) is shown. The plugin turns it into an empty
 * `<div data-coffer-readme="n">`, where n counts the directives of the text from
 * 0, and lists what each one asks for; the build then replaces the `<div>` with
 * the section, once it has read the repository.
 */

/** Name of the directive. */
export const README_DIRECTIVE = 'readme';

/** The attribute of the placeholder element that holds the number of the directive. */
export const README_PLACEHOLDER_ATTRIBUTE = 'data-coffer-readme';

/**
 * What a `::readme` directive asks for.
 *
 * @typedef {object} ReadmeDirective
 * @property {number} index Number of the directive in the text, from 0.
 * @property {string | null} file Path of the file in the repository, as written; null for the README of the repository.
 * @property {string} section Text of the heading whose section is shown.
 * @property {number | undefined} line 1-based line of the directive in the text as parsed (the renderer adds the lines of the front matter).
 * @property {number | undefined} column
 */

/**
 * Raised for a `::readme` that is written wrongly, or used where it is not
 * available; the caller turns it into a located error.
 */
export class ReadmeSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number }} where Position in the Markdown text, as parsed.
   */
  constructor(message, where) {
    super(message);
    this.name = 'ReadmeSyntaxError';
    this.line = where.line;
    this.column = where.column;
  }
}

/**
 * Remark plugin: replaces each `::readme` directive with a placeholder.
 *
 * @param {{ enabled: boolean, onFound: (directives: ReadmeDirective[]) => void }} options `enabled` is false for a text that cannot show a section (every text but the page of a project with a docs source); a directive in it is an error.
 * @returns {(tree: import('mdast').Root) => void}
 * @throws {ReadmeSyntaxError} for a directive that is not available, has an unknown attribute, lacks `section` or has a text in brackets.
 */
export function remarkReadmes({ enabled, onFound }) {
  return (tree) => {
    /** @type {ReadmeDirective[]} */
    const found = [];
    visit(tree, 'leafDirective', (node, index, parent) => {
      if (node.name !== README_DIRECTIVE || !parent || index === undefined) return undefined;
      const where = { line: node.position?.start.line, column: node.position?.start.column };
      if (!enabled) {
        throw new ReadmeSyntaxError(
          'the ::readme directive is only available on the page of a project that has a docs source (set "docs" in its project.yaml)',
          where,
        );
      }
      if (node.children.length > 0) {
        throw new ReadmeSyntaxError('::readme takes no text in square brackets; name the section with section="..."', where);
      }
      const attributes = node.attributes ?? {};
      for (const name of Object.keys(attributes)) {
        if (name !== 'file' && name !== 'section') {
          throw new ReadmeSyntaxError(`::readme has no attribute "${name}" (the attributes are section and file)`, where);
        }
      }
      /** @param {'file' | 'section'} name */
      const value = (name) => {
        const text = attributes[name];
        if (text === undefined) return null;
        if (text === null || text.trim() === '') {
          throw new ReadmeSyntaxError(`::readme: ${name} needs a value, as in ${name}="${name === 'file' ? 'docs/install.md' : 'Quick start'}"`, where);
        }
        return text.trim();
      };
      const section = value('section');
      if (section === null) {
        throw new ReadmeSyntaxError('::readme needs the heading of the section to show, as in ::readme{section="Quick start"}', where);
      }
      const directive = { index: found.length, file: value('file'), section, ...where };
      found.push(directive);
      parent.children[index] = /** @type {any} */ ({
        type: 'coffer-readme',
        data: { hName: 'div', hProperties: { dataCofferReadme: String(directive.index) } },
        children: [],
        position: node.position,
      });
      return [SKIP, index + 1];
    });
    onFound(found);
  };
}
