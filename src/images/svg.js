/**
 * Checks an SVG file that is published as it is, such as the logo of a press
 * kit.
 *
 * An SVG opened directly in the browser is a document of its own, and it can
 * run script, so a file that could is refused instead of being published.
 * The check reads the text in one linear pass; it does not parse XML, and it
 * errs on the side of refusing. A file is refused when it contains:
 *
 * - a `<script>` element or a `<foreignObject>` (which can hold HTML, with
 *   its own scripts and forms), or an `<iframe>`, `<embed>` or `<object>`,
 *   whatever the case of its name and whatever namespace prefix it has
 *   (`<a:script xmlns:a="http://www.w3.org/2000/svg">` runs just as well);
 * - an event handler attribute (`onload=`, `onclick=` and so on) inside a tag;
 *   text such as `one = two` is not an attribute and is left alone;
 * - a `javascript:`, `vbscript:` or `data:text/html` address, however it is
 *   spelled with character references (with any number of digits, so
 *   `&#x000006A;` is `j`), tabs or line breaks;
 * - a `&` in a text or an attribute value that does not start one of the five
 *   XML entities (`&lt; &gt; &amp; &quot; &apos;`) or a numeric reference
 *   `&#...;` / `&#x...;` (lower-case `x`, closing semicolon) to a character that
 *   XML allows. HTML names (`&colon;`, `&Tab;`, `&nbsp;`), references without
 *   the semicolon, `&#X6A;` and references to U+0000, above U+10FFFF or to a
 *   forbidden character are errors in an XML parser, and are refused so that
 *   none of them can stand for a character this check did not see;
 * - a `data:` address in the `href` of anything but an `<image>` or
 *   `<feImage>` (a `<use>` or `<a>` must not load a document from data), and
 *   a `<set>` or `<animate>` that animates an `href` (it could switch a link
 *   to a script address);
 * - a `<set>` or `<animate>` that animates an event handler attribute
 *   (`attributeName="onclick"`);
 * - a stylesheet that is loaded from elsewhere: `@import`, or an
 *   `<?xml-stylesheet?>` instruction;
 * - a control character other than tab, line feed and carriage return (or
 *   another character that XML forbids), and an XML declaration that names an
 *   encoding other than UTF-8, or that is not at the very start. The check
 *   reads UTF-8; a browser that is told `iso-2022-jp` drops the bytes of an
 *   escape sequence, and so sees other markup than the check saw;
 * - a `<!DOCTYPE>` with an internal subset or an `<!ENTITY>` declaration,
 *   which can expand into more than the file shows;
 * - markup that is not well-formed XML, which a browser would not draw anyway:
 *   a comment, CDATA section, processing instruction, DOCTYPE, tag or quoted
 *   attribute value that is never closed, a comment with `--` inside, a `]]>`
 *   in text, or a `<` that does not start a tag.
 *
 * The tags and their attributes are read by {@link tokenize}, which skips the
 * body of comments, CDATA sections and processing instructions, so text in them
 * can neither pose as markup nor hide markup. The patterns for `<script>`,
 * `foreignObject`, `javascript:` and `data:text/html` run over the whole text,
 * comments and CDATA included, so a harmless mention of `<script>` in a comment
 * is refused too.
 *
 * Everything else is published unchanged, including links to other files.
 */

/** The largest SVG file, in bytes, that is accepted; a logo is a few kilobytes. */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;

/**
 * @typedef {object} SvgReport
 * @property {string[]} problems Why the file is refused; empty when it is accepted.
 * @property {number | null} width Width in pixels as the root element declares it (`width`, else `viewBox`), or null when it declares none.
 * @property {number | null} height Height in pixels, likewise.
 */

/**
 * Decodes the digits of a numeric character reference, however many zeros
 * pad them. The leading zeros are skipped in one scan, and a value with more
 * than eight significant digits is above U+10FFFF whatever they are, so no
 * number is ever built from an unbounded run of digits.
 *
 * @param {string} digits The digits of the reference.
 * @param {number} radix 10 or 16.
 * @returns {number} The code point, or -1 when it is above U+10FFFF.
 */
function referenceValue(digits, radix) {
  let first = 0;
  while (first < digits.length && digits.charCodeAt(first) === 0x30) first += 1;
  if (digits.length - first > 8) return -1;
  return first === digits.length ? 0 : Number.parseInt(digits.slice(first), radix);
}

/**
 * Replaces character references by the characters they stand for, the way a
 * browser would read an address: numeric ones with any number of digits
 * (`&#x000006A;` is `j`), with or without the closing semicolon, `&#x` or `&#X`
 * (the check is more lenient than XML here, so as to see more, not less), and
 * the names `&colon;`, `&Tab;` and `&NewLine;` that HTML knows. One pass, so
 * what a reference produces is not decoded again (`&#x26;#106;` is the text
 * `&#106;`, as it is in a browser). A reference to a character that does not
 * exist (zero, above U+10FFFF) is dropped.
 *
 * This is for finding what hides in a text. Whether the references are valid
 * XML is decided separately, by {@link referenceProblem}.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeReferences(text) {
  return text.replace(/&#[xX]([0-9a-fA-F]+);?|&#([0-9]+);?|&(colon|Tab|NewLine);/g, (_all, hex, decimal, name) => {
    if (name !== undefined) return name === 'colon' ? ':' : ' ';
    return safeCodePoint(hex !== undefined ? referenceValue(hex, 16) : referenceValue(decimal, 10));
  });
}

/**
 * @param {number} code
 * @returns {boolean} True for a code point that XML 1.0 allows in a document.
 */
function isXmlCharacter(code) {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

const XML_ENTITIES = new Set(['lt', 'gt', 'amp', 'quot', 'apos']);

/**
 * Checks that every `&` in a text or an attribute value starts a reference that
 * XML knows: one of the five names (`&lt; &gt; &amp; &quot; &apos;`) or a
 * numeric reference `&#...;` / `&#x...;` (lower-case `x`, any number of digits)
 * to a character that XML allows. Anything else is an error in an XML parser: a
 * browser would not draw the file. HTML names such as `&colon;` and `&nbsp;`,
 * references without the semicolon, `&#X6A;` and references to U+0000, above
 * U+10FFFF or to a forbidden character are all refused, so none of them can
 * stand for a character that this check did not see. Each reference is read
 * once, left to right, so the time is proportional to the length of the text.
 *
 * @param {string} text A text between tags, or the value of an attribute.
 * @returns {string | null} What is wrong, or null.
 */
function referenceProblem(text) {
  const reference = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]*));/y;
  let at = text.indexOf('&');
  while (at !== -1) {
    reference.lastIndex = at;
    const match = reference.exec(text);
    if (match === null) {
      const shown = text.slice(at, at + 12);
      if (/^&#X/.test(shown)) return `"${shown}" is a hexadecimal reference with an upper-case X, and XML needs a lower-case x`;
      return `"${shown}" is not a reference that XML knows: use &lt; &gt; &amp; &quot; &apos; or &#...; with the closing ";" (write &amp; for the character)`;
    }
    const [, hex, decimal, name] = match;
    if (name !== undefined) {
      if (!XML_ENTITIES.has(name)) return `"&${name};" is an HTML name, and XML knows only &lt; &gt; &amp; &quot; &apos;`;
    } else {
      const code = hex !== undefined ? referenceValue(hex, 16) : referenceValue(/** @type {string} */ (decimal), 10);
      if (!isXmlCharacter(code)) return `"${match[0].length > 24 ? `${match[0].slice(0, 24)}...` : match[0]}" is a reference to a character that XML does not allow`;
    }
    at = text.indexOf('&', reference.lastIndex);
  }
  return null;
}

const FORBIDDEN_CHARACTER_REASON =
  'contains a control character (or another character that XML forbids), which a browser may read differently from this check';

/**
 * Finds a character that XML 1.0 forbids: a control character other than tab,
 * line feed and carriage return (NUL, ESC, SO and SI among them), U+FFFE,
 * U+FFFF, or an unpaired surrogate. A document in a legacy encoding such as
 * ISO-2022-JP uses escape sequences that a browser drops without a trace, so a
 * file with such characters can show a browser other markup than this check
 * sees. The scan is one pass over a character class, so it is linear.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasForbiddenCharacter(text) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);
}

/**
 * The check reads the bytes as UTF-8, so an XML declaration that names any
 * other encoding would let a browser read different characters than the ones
 * that were checked. Only the declaration at the very start of the text counts
 * (the tokenizer refuses an `xml` instruction anywhere else).
 *
 * @param {string} text The text, without a byte order mark.
 * @returns {string | null} The reason to refuse the file, or null.
 */
function declaredEncodingProblem(text) {
  if (!text.startsWith('<?xml') || !/^[ \t\r\n]$/.test(text.charAt(5))) return null;
  const end = text.indexOf('?>');
  const declaration = end === -1 ? text : text.slice(0, end);
  if (!/encoding/i.test(declaration)) return null;
  const match = /[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/.exec(declaration);
  const name = match?.[1] ?? match?.[2];
  // Exactly one mention of the word, so that a decoy value cannot stand in for the real encoding.
  const mentions = declaration.match(/encoding/gi)?.length ?? 0;
  if (mentions === 1 && name !== undefined && /^utf-?8$/i.test(name)) return null;
  return 'declares an encoding other than UTF-8 in its XML declaration, which a browser may read differently from this check';
}

/**
 * @param {number} codePoint
 * @returns {string}
 */
function safeCodePoint(codePoint) {
  return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
}

/**
 * @param {string | undefined} value A `width` or `height` attribute.
 * @returns {number | null} Pixels, when the value is a plain length in pixels (a number, optionally followed by "px").
 */
function pixels(value) {
  if (value === undefined) return null;
  // Trimmed first: two adjacent `\s*` in one pattern are quadratic on a long run of blanks.
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(?:px)?$/i.exec(value.trim());
  if (!match) return null;
  const number = Number.parseFloat(/** @type {string} */ (match[1]));
  return number > 0 ? Math.round(number) : null;
}

/**
 * @typedef {object} Tag
 * @property {string} name The name of the element, with its namespace prefix if it has one.
 * @property {boolean} closing True for an end tag (`</g>`).
 * @property {[string, string | null][]} attributes The attributes in order: name as written, and value (null when the attribute has none).
 */

/**
 * @param {number} code A UTF-16 code unit.
 * @returns {boolean} True for a blank: the XML ones, any other control character and any Unicode space. More than XML allows, so that a handler after an odd blank is still seen.
 */
function isBlank(code) {
  return code <= 0x20 || (code > 0x7e && /\s/.test(String.fromCharCode(code)));
}

/**
 * @param {number} code
 * @returns {boolean} True for a character that may be in the name of an element or an attribute.
 */
function isNameChar(code) {
  // < > / ! ? " ' =
  return !isBlank(code) && code !== 0x3c && code !== 0x3e && code !== 0x2f && code !== 0x21 && code !== 0x3f && code !== 0x22 && code !== 0x27 && code !== 0x3d;
}

/**
 * @param {string} what
 * @returns {string} The reason to refuse a file that is not well-formed.
 */
function malformed(what) {
  return `is not well-formed XML (${what}), so a browser would not draw it`;
}

const ENTITIES_REASON = 'declares entities (<!ENTITY> or a DOCTYPE with an internal subset), which are not allowed';

/**
 * Reads the markup of a text in one linear pass and tells `visit` about every
 * start, end and empty tag. Comments, CDATA sections, processing instructions
 * and the DOCTYPE are recognised and skipped (their bodies are not markup), and
 * the quotes of attribute values are respected, so that a `>` in a value does
 * not end a tag. Every construct is looked for with `indexOf` or a single walk
 * over the characters, and a construct that is never closed ends the pass with
 * a failure instead of being searched for again from the next `<`.
 *
 * @param {string} text
 * @param {(tag: Tag) => void} visit
 * @returns {{ failure: string | null, junkBeforeTags: boolean }} Why the text is not well-formed (null when it is), and whether text or CDATA comes before the first tag.
 */
function tokenize(text, visit) {
  const length = text.length;
  let junkBeforeTags = false;
  let seenTag = false;
  /** @param {string} failure */
  const fail = (failure) => ({ failure, junkBeforeTags });
  let at = 0;
  while (at < length) {
    const open = text.indexOf('<', at);
    const textEnd = open === -1 ? length : open;
    if (textEnd > at) {
      const run = text.slice(at, textEnd);
      if (run.includes(']]>')) return fail(malformed('"]]>" outside a CDATA section'));
      const badReference = referenceProblem(run);
      if (badReference !== null) return fail(malformed(badReference));
      if (!seenTag && run.trim() !== '') junkBeforeTags = true;
    }
    if (open === -1) break;

    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close === -1) return fail(malformed('a comment is never closed'));
      // XML does not allow "--" inside a comment (nor "--->").
      const dashes = text.indexOf('--', open + 4);
      if (dashes < close) return fail(malformed('a comment contains "--"'));
      at = close + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      if (close === -1) return fail(malformed('a CDATA section is never closed'));
      if (!seenTag) junkBeforeTags = true;
      at = close + 3;
    } else if (text.startsWith('<?', open)) {
      const close = text.indexOf('?>', open + 2);
      if (close === -1) return fail(malformed('a processing instruction is never closed'));
      // The XML declaration is only allowed at the very start; anywhere else its encoding would be ignored by a browser but not by a reader of this file.
      if (open > 0 && text.slice(open + 2, open + 5).toLowerCase() === 'xml' && (open + 5 >= close || isBlank(text.charCodeAt(open + 5)))) {
        return fail(malformed('an "xml" declaration that is not at the very start of the file'));
      }
      at = close + 2;
    } else if (text.slice(open, open + 9).toUpperCase() === '<!DOCTYPE') {
      let pos = open + 9;
      for (;;) {
        if (pos >= length) return fail(malformed('a DOCTYPE is never closed'));
        const code = text.charCodeAt(pos);
        if (code === 0x3e) break; // >
        if (code === 0x5b) return fail(ENTITIES_REASON); // [: an internal subset
        if (code === 0x22 || code === 0x27) {
          const close = text.indexOf(text.charAt(pos), pos + 1);
          if (close === -1) return fail(malformed('a quoted text in the DOCTYPE is never closed'));
          pos = close + 1;
        } else {
          pos += 1;
        }
      }
      at = pos + 1;
    } else if (text.startsWith('<!', open)) {
      return fail(malformed('"<!" is followed by something that is not a comment, a CDATA section or a DOCTYPE'));
    } else {
      // A start tag, an end tag or an empty tag.
      let pos = open + 1;
      const closing = text.charCodeAt(pos) === 0x2f; // /
      if (closing) pos += 1;
      const nameStart = pos;
      while (pos < length && isNameChar(text.charCodeAt(pos))) pos += 1;
      if (pos === nameStart) return fail(malformed('a "<" does not start a tag; write &lt; for the character'));
      /** @type {Tag} */
      const tag = { name: text.slice(nameStart, pos), closing, attributes: [] };
      for (;;) {
        while (pos < length && isBlank(text.charCodeAt(pos))) pos += 1;
        if (pos >= length) return fail(malformed('a tag is never closed'));
        const c = text.charAt(pos);
        if (c === '>') break;
        if (c === '/') {
          pos += 1;
          continue;
        }
        if (c === '<' || c === '"' || c === "'" || c === '=') return fail(malformed(`a tag holds a stray ${c}`));
        const attributeStart = pos;
        while (pos < length && isNameChar(text.charCodeAt(pos))) pos += 1;
        // `!` and `?` are not name characters, but they must not stop the pass either.
        if (pos === attributeStart) pos += 1;
        const attribute = text.slice(attributeStart, pos);
        while (pos < length && isBlank(text.charCodeAt(pos))) pos += 1;
        if (text.charAt(pos) !== '=') {
          tag.attributes.push([attribute, null]);
          continue;
        }
        pos += 1;
        while (pos < length && isBlank(text.charCodeAt(pos))) pos += 1;
        if (pos >= length) return fail(malformed('a tag is never closed'));
        const quote = text.charAt(pos);
        if (quote === '"' || quote === "'") {
          const close = text.indexOf(quote, pos + 1);
          if (close === -1) return fail(malformed('an attribute value is never closed'));
          const value = text.slice(pos + 1, close);
          const badReference = referenceProblem(value);
          if (badReference !== null) return fail(malformed(badReference));
          tag.attributes.push([attribute, value]);
          pos = close + 1;
        } else {
          // A value without quotes is not XML, but is read the way an HTML parser would, up to a blank or the end of the tag.
          const valueStart = pos;
          while (pos < length && !isBlank(text.charCodeAt(pos)) && text.charAt(pos) !== '>') {
            const v = text.charAt(pos);
            if (v === '"' || v === "'" || v === '<') return fail(malformed(`a value holds a stray ${v}`));
            pos += 1;
          }
          const value = text.slice(valueStart, pos);
          const badReference = referenceProblem(value);
          if (badReference !== null) return fail(malformed(badReference));
          tag.attributes.push([attribute, value]);
        }
      }
      at = pos + 1;
      seenTag = true;
      visit(tag);
    }
  }
  return { failure: null, junkBeforeTags };
}

/**
 * @param {string} name The name of an element or attribute, possibly with a namespace prefix.
 * @returns {string} The name without the prefix, in lower case.
 */
function localName(name) {
  return name.slice(name.lastIndexOf(':') + 1).toLowerCase();
}

/**
 * @param {string} value The value of an attribute, or a whole text.
 * @returns {string} The text as a browser reads an address: references decoded, tabs and line breaks gone, in lower case.
 */
function flatten(value) {
  // eslint-disable-next-line no-control-regex
  return decodeReferences(value).replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
}

/** Elements that animate an attribute of another element. */
const ANIMATIONS = new Set(['set', 'animate']);
/** Elements whose `href` may be a `data:` picture. */
const PICTURES = new Set(['image', 'feimage']);

/**
 * Looks at what a tag holds that a pattern over the whole text cannot tell from
 * plain text: its attributes.
 *
 * @param {Tag} tag A start, empty or end tag.
 * @param {Set<string>} reasons Where the reasons to refuse the file are collected.
 */
function inspectTag(tag, reasons) {
  const element = localName(tag.name);
  for (const [name, value] of tag.attributes) {
    // The whole name: `xlink:onclick` and `a:onload` are namespaced attributes, not handlers.
    if (/^on[a-z]+$/i.test(name)) {
      reasons.add('contains an event handler attribute such as onload=, which could run script when the file is opened');
    }
    if (value === null) continue;
    if (localName(name) === 'href' && !PICTURES.has(element) && flatten(value).startsWith('data:')) {
      reasons.add('contains a data: address in an href, which could load a document when the file is opened');
    }
    if (ANIMATIONS.has(element) && name.toLowerCase() === 'attributename' && localName(flatten(value)) === 'href') {
      reasons.add('contains an animation of an href, which could turn a link into a script address');
    }
    if (ANIMATIONS.has(element) && name.toLowerCase() === 'attributename' && localName(flatten(value)).startsWith('on')) {
      reasons.add('contains an animation of an event handler attribute such as onclick, which could run script');
    }
  }
}

/**
 * Checks the text of an SVG file.
 *
 * @param {string | Uint8Array} content The file.
 * @returns {SvgReport}
 */
export function inspectSvg(content) {
  /** @type {string[]} */
  const problems = [];
  const size = typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;
  if (size > MAX_SVG_BYTES) {
    return { problems: [`is ${size} bytes; an SVG logo may be at most ${MAX_SVG_BYTES} bytes`], width: null, height: null };
  }
  const text = (typeof content === 'string' ? content : Buffer.from(content).toString('utf8')).replace(/^﻿/, '');
  if (text.includes('\u0000')) problems.push('is not a text file');
  else if (hasForbiddenCharacter(text)) problems.push(FORBIDDEN_CHARACTER_REASON);
  const encoding = declaredEncodingProblem(text);
  if (encoding !== null) problems.push(encoding);

  /** @type {Set<string>} */
  const reasons = new Set();
  /** @type {Tag[]} */
  const firstTag = [];
  const { failure, junkBeforeTags } = tokenize(text, (tag) => {
    if (firstTag.length === 0) firstTag.push(tag);
    inspectTag(tag, reasons);
  });
  // The root element is the first tag; comments, instructions and the DOCTYPE may come before it.
  const [head] = firstTag;
  const root = head !== undefined && !junkBeforeTags && !head.closing && /^(?:[A-Za-z_][\w.-]*:)?svg$/.test(head.name) ? head : null;
  if (failure !== null) problems.push(failure);
  else if (!root) problems.push('is not an SVG document: its first element must be <svg>');

  if (/<!ENTITY/i.test(text)) problems.push(ENTITIES_REASON);
  for (const [name, pattern] of /** @type {const} */ ([
    ['a <script> element', 'script'],
    ['a <foreignObject> element', 'foreignObject'],
    ['an <iframe>, <embed> or <object> element', 'iframe|embed|object'],
  ])) {
    // With any prefix: `<a:script>` is a script when `a` is bound to the SVG namespace.
    if (new RegExp(`<\\s*(?:[^\\s<>/:!?"'=]+:)?(?:${pattern})(?![\\w.:-])`, 'i').test(text)) {
      problems.push(`contains ${name}, which could run script when the file is opened`);
    }
  }
  problems.push(...reasons);
  if (/@import\b/i.test(decodeReferences(text)) || /<\?xml-stylesheet\b/i.test(text)) {
    problems.push('loads a stylesheet from elsewhere (@import or <?xml-stylesheet?>), which is not allowed');
  }
  // Collapse what a browser ignores inside a scheme (tabs, line breaks) and the
  // references that spell characters, then look for the dangerous schemes.
  const flat = flatten(text);
  if (flat.includes('javascript:') || flat.includes('vbscript:') || flat.includes('data:text/html')) {
    problems.push('contains a javascript:, vbscript: or data:text/html address, which could run script when the file is opened');
  }

  /** @type {number | null} */
  let width = null;
  /** @type {number | null} */
  let height = null;
  if (root) {
    /** @type {Map<string, string>} */
    const attributes = new Map();
    for (const [name, value] of root.attributes) {
      if (!attributes.has(name.toLowerCase())) attributes.set(name.toLowerCase(), value ?? '');
    }
    width = pixels(attributes.get('width'));
    height = pixels(attributes.get('height'));
    if (width === null || height === null) {
      const box = (attributes.get('viewbox') ?? '').trim().split(/[\s,]+/).map(Number);
      if (box.length === 4 && box.every(Number.isFinite) && /** @type {number} */ (box[2]) > 0 && /** @type {number} */ (box[3]) > 0) {
        const ratio = /** @type {number} */ (box[2]) / /** @type {number} */ (box[3]);
        if (width !== null) height = Math.round(width / ratio);
        else if (height !== null) width = Math.round(height * ratio);
        else {
          width = Math.round(/** @type {number} */ (box[2]));
          height = Math.round(/** @type {number} */ (box[3]));
        }
      } else {
        width = null;
        height = null;
      }
    }
  }
  return { problems: [...new Set(problems)], width, height };
}
