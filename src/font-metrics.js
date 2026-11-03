import { readFileSync } from 'node:fs';

/**
 * What coffer needs to know about a font file to lay out text in it: how wide
 * the text is, which family name an SVG has to use, and how heavy the face is.
 * Reading it from the file keeps the layout identical on every machine, without
 * a font library or a system font.
 *
 * @typedef {object} FontMetrics
 * @property {string} file Path the font was read from.
 * @property {string} family Family name (name ID 1), as an SVG `font-family` has to spell it.
 * @property {number} weight CSS weight of the face (`usWeightClass`, 400 when the font does not say).
 * @property {number} unitsPerEm
 * @property {(codePoint: number) => boolean} has True when the font has a glyph for the character.
 * @property {(text: string, size: number) => number} width Advance width of the text at a font size, in the unit of the size. Kerning is not applied, so the result is never narrower than what a renderer draws by much.
 */

/** Raised for a file that is not a font coffer can read. */
export class FontError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'FontError';
  }
}

/**
 * Reads the layout facts of a TrueType or OpenType font (a `.ttf`, `.otf` or the
 * first face of a `.ttc`).
 *
 * @param {string} file
 * @returns {FontMetrics}
 * @throws {FontError} When the file cannot be read or is not a font.
 */
export function readFontMetrics(file) {
  /** @type {Buffer} */
  let data;
  try {
    data = readFileSync(file);
  } catch (error) {
    throw new FontError(`${file}: cannot read the font: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseFont(file, data);
  } catch (error) {
    if (error instanceof FontError) throw error;
    throw new FontError(`${file}: not a readable TrueType or OpenType font`);
  }
}

/**
 * @param {string} file
 * @param {Buffer} data
 * @returns {FontMetrics}
 */
function parseFont(file, data) {
  const u16 = (/** @type {number} */ at) => data.readUInt16BE(at);
  const i16 = (/** @type {number} */ at) => data.readInt16BE(at);
  const u32 = (/** @type {number} */ at) => data.readUInt32BE(at);

  let start = 0;
  if (data.toString('latin1', 0, 4) === 'ttcf') start = u32(12);
  const magic = u32(start);
  if (magic !== 0x00010000 && magic !== 0x4f54544f && magic !== 0x74727565) {
    throw new FontError(`${file}: not a TrueType or OpenType font (WOFF files are not supported; use .ttf or .otf)`);
  }
  /** @type {Map<string, { offset: number, length: number }>} */
  const tables = new Map();
  const count = u16(start + 4);
  for (let index = 0; index < count; index++) {
    const record = start + 12 + index * 16;
    tables.set(data.toString('latin1', record, record + 4), { offset: u32(record + 8), length: u32(record + 12) });
  }
  /** @param {string} tag */
  const table = (tag) => {
    const found = tables.get(tag);
    if (!found) throw new FontError(`${file}: the font has no "${tag}" table`);
    return found.offset;
  };

  const unitsPerEm = u16(table('head') + 18);
  const metricCount = u16(table('hhea') + 34);
  const hmtx = table('hmtx');
  if (unitsPerEm === 0 || metricCount === 0) throw new FontError(`${file}: the font has no usable metrics`);

  /** @param {number} glyph */
  const advance = (glyph) => u16(hmtx + 4 * Math.min(glyph, metricCount - 1));
  const glyphOf = readCmap(data, table('cmap'));

  const os2 = tables.get('OS/2');
  const weight = os2 ? u16(os2.offset + 4) : 400;
  const family = readFamily(data, table('name')) ?? '';
  if (family === '') throw new FontError(`${file}: the font does not name its family`);

  const fallback = advance(0);
  return {
    file,
    family,
    weight: weight >= 1 && weight <= 1000 ? weight : 400,
    unitsPerEm,
    has: (codePoint) => glyphOf(codePoint) !== 0,
    width: (text, size) => {
      let total = 0;
      for (const char of text) {
        const glyph = glyphOf(/** @type {number} */ (char.codePointAt(0)));
        total += glyph === 0 ? fallback : advance(glyph);
      }
      return (total * size) / unitsPerEm;
    },
  };
}

/**
 * Builds a lookup from characters to glyph numbers from the best Unicode
 * subtable of the `cmap` table (format 12, else format 4).
 *
 * @param {Buffer} data
 * @param {number} cmap Offset of the table.
 * @returns {(codePoint: number) => number}
 */
function readCmap(data, cmap) {
  const subtableCount = data.readUInt16BE(cmap + 2);
  /** @type {{ rank: number, offset: number } | null} */
  let best = null;
  for (let index = 0; index < subtableCount; index++) {
    const record = cmap + 4 + index * 8;
    const platform = data.readUInt16BE(record);
    const encoding = data.readUInt16BE(record + 2);
    const offset = cmap + data.readUInt32BE(record + 4);
    const format = data.readUInt16BE(offset);
    let rank = 0;
    if (format === 12 && ((platform === 3 && encoding === 10) || platform === 0)) rank = 4;
    else if (format === 4 && ((platform === 3 && encoding === 1) || platform === 0)) rank = 2;
    if (rank > (best?.rank ?? 0)) best = { rank, offset };
  }
  if (!best) throw new FontError('the font has no Unicode character map');
  const base = best.offset;

  if (data.readUInt16BE(base) === 12) {
    const groups = data.readUInt32BE(base + 12);
    return (codePoint) => {
      let low = 0;
      let high = groups - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const at = base + 16 + middle * 12;
        const first = data.readUInt32BE(at);
        const last = data.readUInt32BE(at + 4);
        if (codePoint < first) high = middle - 1;
        else if (codePoint > last) low = middle + 1;
        else return data.readUInt32BE(at + 8) + (codePoint - first);
      }
      return 0;
    };
  }

  const segments = data.readUInt16BE(base + 6) / 2;
  const ends = base + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let segment = 0; segment < segments; segment++) {
      if (data.readUInt16BE(ends + segment * 2) < codePoint) continue;
      if (data.readUInt16BE(starts + segment * 2) > codePoint) return 0;
      const delta = data.readInt16BE(deltas + segment * 2);
      const rangeOffset = data.readUInt16BE(rangeOffsets + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const at =
        rangeOffsets + segment * 2 + rangeOffset + (codePoint - data.readUInt16BE(starts + segment * 2)) * 2;
      const glyph = data.readUInt16BE(at);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/**
 * The family name (name ID 1) of a font, preferring English.
 *
 * @param {Buffer} data
 * @param {number} name Offset of the `name` table.
 * @returns {string | null}
 */
function readFamily(data, name) {
  const count = data.readUInt16BE(name + 2);
  const strings = name + data.readUInt16BE(name + 4);
  /** @type {{ rank: number, text: string } | null} */
  let best = null;
  for (let index = 0; index < count; index++) {
    const record = name + 6 + index * 12;
    if (data.readUInt16BE(record + 6) !== 1) continue;
    const platform = data.readUInt16BE(record);
    const language = data.readUInt16BE(record + 4);
    const length = data.readUInt16BE(record + 8);
    const at = strings + data.readUInt16BE(record + 10);
    let text;
    let rank;
    if (platform === 3 || platform === 0) {
      const raw = Buffer.from(data.subarray(at, at + length));
      text = raw.swap16().toString('utf16le');
      rank = platform === 3 && language === 0x0409 ? 3 : 2;
    } else if (platform === 1) {
      text = data.toString('latin1', at, at + length);
      rank = 1;
    } else {
      continue;
    }
    if (text !== '' && rank > (best?.rank ?? 0)) best = { rank, text };
  }
  return best?.text ?? null;
}
