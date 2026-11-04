/**
 * Small XML helpers: escaping for writing feeds, entity decoding, and a strict
 * parser that is just big enough to check that a generated document is
 * well-formed and to read it back (DTDs are refused; there is no schema).
 */

/** Characters that may not appear in an XML 1.0 document at all. */
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/**
 * Escapes text for an XML text node. Characters XML cannot carry are dropped.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXml(text) {
  return text
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escapes text for a double-quoted XML attribute value.
 *
 * @param {string} text
 * @returns {string}
 */
export function escapeXmlAttribute(text) {
  return escapeXml(text).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
}

/** The five entities every XML parser knows. */
const XML_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** Named entities that rendered Markdown and hand-written HTML commonly contain. */
const HTML_ENTITIES = new Map([
  ...XML_ENTITIES,
  ['nbsp', ' '],
  ['copy', '©'],
  ['reg', '®'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['hellip', '…'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['middot', '·'],
  ['times', '×'],
]);

/**
 * @param {number} code
 * @returns {string | null} The character, or null for a code point XML does not allow.
 */
function characterOf(code) {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  const allowed =
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  return allowed ? String.fromCodePoint(code) : null;
}

/**
 * Replaces character and named entities in text by the characters they stand
 * for. With `html` false only the five XML entities are known and anything
 * else throws; with `html` true unknown names are left as written, as a
 * browser would show them.
 *
 * @param {string} text
 * @param {{ html?: boolean }} [options]
 * @returns {string}
 * @throws {Error} For an unknown entity or a character reference to a forbidden character (XML mode).
 */
export function decodeEntities(text, options = {}) {
  const html = options.html === true;
  const table = html ? HTML_ENTITIES : XML_ENTITIES;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (whole, name) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      const character = html ? String.fromCodePoint(Math.min(Math.max(code, 0), 0x10ffff)) : characterOf(code);
      if (character === null) throw new Error(`character reference ${whole} is not allowed in XML`);
      if (!html && !whole.endsWith(';')) throw new Error(`entity ${whole} is not terminated by ";"`);
      return character;
    }
    const value = table.get(name);
    if (value === undefined || (!html && !whole.endsWith(';'))) {
      if (html) return whole;
      throw new Error(`unknown entity &${name}${whole.endsWith(';') ? ';' : ''}`);
    }
    return value;
  });
}

/**
 * An element of a parsed document.
 *
 * @typedef {object} XmlElement
 * @property {string} name Qualified name as written.
 * @property {string} local Name without the prefix.
 * @property {string} namespace Namespace URI, or the empty string.
 * @property {Record<string, string>} attributes Attribute values by qualified name, entities decoded.
 * @property {XmlElement[]} children Child elements in document order.
 * @property {string} text Text directly inside the element (CDATA included), entities decoded.
 * @property {number} line 1-based line of the start tag.
 * @property {number} column 1-based column of the start tag.
 */

/**
 * Raised for a document that is not well-formed.
 */
export class XmlError extends Error {
  /**
   * @param {string} message
   * @param {number} line
   * @param {number} column
   */
  constructor(message, line, column) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'XmlError';
    this.line = line;
    this.column = column;
  }
}

const NAME = '[\\p{L}_:][\\p{L}\\p{N}_.:\\u00B7-]*';
const START_TAG_NAME_RE = new RegExp(NAME, 'uy');
const ATTRIBUTE_RE = new RegExp(`(${NAME})[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')`, 'uy');
const SPACE_RE = /[ \t\r\n]*/y;

/**
 * Matches a sticky expression at `at`, without copying the text.
 *
 * @param {RegExp} pattern A sticky expression.
 * @param {string} text
 * @param {number} at
 * @returns {RegExpExecArray | null}
 */
function matchAt(pattern, text, at) {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/**
 * Parses a well-formed XML document into a tree of elements. Namespaces are
 * resolved. Comments and processing instructions are skipped; a DOCTYPE is an
 * error.
 *
 * @param {string} source
 * @returns {XmlElement} The root element.
 * @throws {XmlError} When the document is not well-formed.
 */
export function parseXml(source) {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let pos = 0;

  // Positions are asked for in increasing order (once per start tag), so the
  // line count carries on from the last answer instead of starting over.
  let countedLine = 1;
  let countedBreak = -1;
  /** @param {number} at */
  const where = (at) => {
    if (at <= countedBreak) {
      countedLine = 1;
      countedBreak = -1;
    }
    for (
      let index = text.indexOf('\n', countedBreak + 1);
      index !== -1 && index < at;
      index = text.indexOf('\n', index + 1)
    ) {
      countedLine += 1;
      countedBreak = index;
    }
    return { line: countedLine, column: at - countedBreak };
  };
  /**
   * @param {string} message
   * @param {number} [at]
   * @returns {never}
   */
  const fail = (message, at = pos) => {
    const place = where(at);
    throw new XmlError(message, place.line, place.column);
  };

  const invalid = INVALID_XML_CHARS.exec(text);
  INVALID_XML_CHARS.lastIndex = 0;
  if (invalid) fail(`character U+${invalid[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')} is not allowed in XML`, invalid.index);

  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>');
    if (end === -1) fail('unterminated XML declaration');
    if (!/^<\?xml\s+version\s*=\s*["']1\.[0-9]+["']/.test(text)) fail('the XML declaration must start with a version');
    pos = end + 2;
  }

  /** @type {{ element: XmlElement, scope: Map<string, string> }[]} */
  const stack = [];
  /** @type {XmlElement | null} */
  let root = null;

  /**
   * @param {string} value
   * @param {number} at
   */
  const decode = (value, at) => {
    try {
      return decodeEntities(value);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), at);
    }
  };

  /**
   * @param {string} qualified
   * @param {Map<string, string>} scope
   * @param {boolean} isAttribute
   */
  const resolve = (qualified, scope, isAttribute) => {
    const colon = qualified.indexOf(':');
    if (colon === -1) return { local: qualified, namespace: isAttribute ? '' : (scope.get('') ?? '') };
    const prefix = qualified.slice(0, colon);
    const namespace = prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : scope.get(prefix);
    return { local: qualified.slice(colon + 1), namespace: namespace ?? null };
  };

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    const chunkEnd = lt === -1 ? text.length : lt;
    if (chunkEnd > pos) {
      const chunk = text.slice(pos, chunkEnd);
      const current = stack[stack.length - 1];
      if (!current) {
        if (chunk.trim() !== '') fail('text outside the root element', pos);
      } else {
        if (chunk.includes(']]>')) fail('"]]>" is not allowed in text', pos);
        current.element.text += decode(chunk, pos);
      }
      pos = chunkEnd;
    }
    if (pos >= text.length) break;

    if (text.startsWith('<!--', pos)) {
      const end = text.indexOf('-->', pos + 4);
      if (end === -1) fail('unterminated comment');
      if (text.slice(pos + 4, end).includes('--')) fail('"--" is not allowed inside a comment', pos);
      pos = end + 3;
    } else if (text.startsWith('<![CDATA[', pos)) {
      const current = stack[stack.length - 1];
      if (!current) fail('CDATA outside the root element');
      const end = text.indexOf(']]>', pos + 9);
      if (end === -1) fail('unterminated CDATA section');
      current.element.text += text.slice(pos + 9, end);
      pos = end + 3;
    } else if (text.startsWith('<?', pos)) {
      const end = text.indexOf('?>', pos + 2);
      if (end === -1) fail('unterminated processing instruction');
      if (/^<\?xml[\s?]/i.test(text.slice(pos, pos + 7))) fail('the XML declaration must be at the very start', pos);
      pos = end + 2;
    } else if (text.startsWith('<!', pos)) {
      fail('DOCTYPE declarations are not allowed');
    } else if (text.startsWith('</', pos)) {
      const end = text.indexOf('>', pos);
      if (end === -1) fail('unterminated end tag');
      const name = text.slice(pos + 2, end).trim();
      const open = stack.pop();
      if (!open) fail(`unexpected end tag </${name}>`);
      if (open.element.name !== name) fail(`end tag </${name}> does not match <${open.element.name}>`);
      pos = end + 1;
    } else {
      const start = pos;
      const nameMatch = matchAt(START_TAG_NAME_RE, text, pos + 1);
      if (!nameMatch) fail('"<" must start a tag; write "&lt;" for a less-than sign');
      const name = nameMatch[0];
      pos += 1 + name.length;

      /** @type {Record<string, string>} */
      const attributes = {};
      /** @type {Map<string, string>} */
      const scope = new Map(stack[stack.length - 1]?.scope ?? []);
      let selfClosing = false;
      for (;;) {
        const space = matchAt(SPACE_RE, text, pos);
        const hadSpace = (space?.[0].length ?? 0) > 0;
        pos += space?.[0].length ?? 0;
        if (text.startsWith('/>', pos)) {
          selfClosing = true;
          pos += 2;
          break;
        }
        if (text[pos] === '>') {
          pos += 1;
          break;
        }
        if (pos >= text.length) fail(`unterminated tag <${name}>`, start);
        if (!hadSpace) fail(`unexpected character ${JSON.stringify(text[pos])} in tag <${name}>`);
        const attribute = matchAt(ATTRIBUTE_RE, text, pos);
        if (!attribute) fail(`malformed attribute in tag <${name}>`);
        const attributeName = attribute[1];
        const raw = attribute[2] ?? attribute[3] ?? '';
        if (raw.includes('<')) fail(`"<" is not allowed in the value of attribute ${attributeName}`);
        if (Object.hasOwn(attributes, attributeName)) fail(`duplicate attribute ${attributeName}`);
        const value = decode(raw, pos).replace(/[\t\n\r]/g, ' ');
        attributes[attributeName] = value;
        if (attributeName === 'xmlns') scope.set('', value);
        else if (attributeName.startsWith('xmlns:')) scope.set(attributeName.slice(6), value);
        pos += attribute[0].length;
      }

      const place = where(start);
      const resolved = resolve(name, scope, false);
      if (resolved.namespace === null) fail(`undeclared namespace prefix in <${name}>`, start);
      for (const attributeName of Object.keys(attributes)) {
        if (attributeName.includes(':') && !attributeName.startsWith('xmlns:')) {
          if (resolve(attributeName, scope, true).namespace === null) {
            fail(`undeclared namespace prefix in attribute ${attributeName}`, start);
          }
        }
      }
      /** @type {XmlElement} */
      const element = {
        name,
        local: resolved.local,
        namespace: resolved.namespace,
        attributes,
        children: [],
        text: '',
        line: place.line,
        column: place.column,
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.element.children.push(element);
      else if (root) fail('more than one root element', start);
      else root = element;
      if (!selfClosing) stack.push({ element, scope });
    }
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1].element;
    throw new XmlError(`element <${open.name}> is not closed`, open.line, open.column);
  }
  if (!root) fail('the document has no root element', 0);
  return root;
}
