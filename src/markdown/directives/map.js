import { SKIP, visit } from 'unist-util-visit';
import { parseSelection } from '../../geo/map.js';

/**
 * The `::map` leaf directive.
 *
 * ```
 * ::map
 * ::map{tracks="day-one.gpx" photos="none"}
 * ```
 *
 * It marks the place of a map in the text. The plugin turns it into an empty
 * `<div data-coffer-map="n">`, where n counts the directives of the text from
 * 0, and lists what each one asks for; the build then replaces the `<div>`
 * with the map, once the tracks and the photo positions of the post are known.
 *
 * The attributes `tracks` and `photos` choose what the map shows: `all` (the
 * default), `none`, or a comma-separated list of names.
 */

/** Name of the directive. */
export const MAP_DIRECTIVE = 'map';

/** The attribute of the placeholder element that holds the number of the directive. */
export const MAP_PLACEHOLDER_ATTRIBUTE = 'data-coffer-map';

/**
 * What a `::map` directive asks for.
 *
 * @typedef {object} MapDirective
 * @property {number} index Number of the directive in the text, from 0.
 * @property {import('../../geo/map.js').MapSelection} tracks
 * @property {import('../../geo/map.js').MapSelection} photos
 * @property {number | undefined} line 1-based line of the directive in the text as parsed (the renderer adds the lines of the front matter).
 * @property {number | undefined} column
 */

/**
 * Raised for a `::map` that is written wrongly; the caller turns it into a
 * located error.
 */
export class MapSyntaxError extends Error {
  /**
   * @param {string} message
   * @param {{ line?: number, column?: number }} where Position in the Markdown text, as parsed.
   */
  constructor(message, where) {
    super(message);
    this.name = 'MapSyntaxError';
    this.line = where.line;
    this.column = where.column;
  }
}

/**
 * Remark plugin: replaces each `::map` directive with a placeholder.
 *
 * @param {{ onFound: (directives: MapDirective[]) => void }} options
 * @returns {(tree: import('mdast').Root) => void}
 * @throws {MapSyntaxError} for a map with an unknown attribute or a wrong value, or with a text in brackets.
 */
export function remarkMaps({ onFound }) {
  return (tree) => {
    /** @type {MapDirective[]} */
    const found = [];
    visit(tree, 'leafDirective', (node, index, parent) => {
      if (node.name !== MAP_DIRECTIVE || !parent || index === undefined) return undefined;
      const where = { line: node.position?.start.line, column: node.position?.start.column };
      if (node.children.length > 0) {
        throw new MapSyntaxError('a map takes no text in square brackets; choose what it shows with tracks="..." and photos="..."', where);
      }
      const attributes = node.attributes ?? {};
      for (const name of Object.keys(attributes)) {
        if (name !== 'tracks' && name !== 'photos') {
          throw new MapSyntaxError(`a map has no attribute "${name}" (the attributes are tracks and photos)`, where);
        }
      }
      /** @param {'tracks' | 'photos'} name */
      const selection = (name) => {
        const value = attributes[name];
        if (value === null) {
          throw new MapSyntaxError(`${name}: needs a value, as in ${name}="none"`, where);
        }
        try {
          return parseSelection(value);
        } catch (error) {
          throw new MapSyntaxError(`${name}: ${error instanceof Error ? error.message : String(error)}`, where);
        }
      };
      const directive = { index: found.length, tracks: selection('tracks'), photos: selection('photos'), ...where };
      found.push(directive);
      parent.children[index] = /** @type {any} */ ({
        type: 'coffer-map',
        data: { hName: 'div', hProperties: { dataCofferMap: String(directive.index) } },
        children: [],
        position: node.position,
      });
      return [SKIP, index + 1];
    });
    onFound(found);
  };
}
