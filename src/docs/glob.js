/**
 * A small glob matcher for the `include` and `exclude` lists of a guide.
 *
 * The patterns come from a configuration file and are matched against the
 * names of files in a repository that may not be the author's own, so the
 * matcher must never take more time than a fixed multiple of the pattern's
 * length times the path's length. It is written without regular expressions
 * and without recursion: a segment is matched by walking the pattern and the
 * name once (the classic scan with one place to go back to), and a path is
 * matched against the segments of a pattern by following every position the
 * pattern can be in at once (a set of at most one position per segment), so
 * `a*a*a*a*b` against a long name made of `a`s is as quick as anything else.
 *
 * What a pattern can say:
 *
 * - `/` separates folders; a pattern is matched against a whole path relative
 *   to the guide's folder, written with `/`;
 * - `*` is any run of characters (also none) inside one folder or file name;
 * - `?` is one character;
 * - `[abc]`, `[a-z]` and `[!abc]` (or `[^abc]`) are one character of the set
 *   (or not of it);
 * - `**` as a whole segment is any number of folders (also none), so
 *   `**` + `/*.md` matches `a.md` and `x/y/a.md`, and `docs/**` matches every
 *   file below `docs`. Inside a longer segment `**` is the same as `*`;
 * - matching is case-sensitive;
 * - a name that starts with a dot is matched only by a pattern segment that
 *   starts with a literal dot: `*`, `?`, `[...]` and `**` do not match
 *   `.hidden`, `.github/` or `.draft.md`.
 *
 * Not supported, and refused with a message that names the pattern: `{a,b}`
 * alternatives, a leading `!` (negation; use `exclude`), and `\` escapes.
 */

/** The longest pattern the matcher accepts (the same bound the configuration enforces). */
export const MAX_GLOB_LENGTH = 200;

/**
 * One position of a name segment pattern.
 *
 * @typedef {{ type: 'literal', char: string }
 *   | { type: 'any' }
 *   | { type: 'star' }
 *   | { type: 'class', negate: boolean, ranges: [number, number][] }} SegmentToken
 */

/**
 * A pattern segment: either the globstar, or tokens that match one name.
 *
 * @typedef {{ globstar: true } | { globstar: false, tokens: SegmentToken[] }} PatternSegment
 */

/**
 * A pattern, parsed.
 *
 * @typedef {object} CompiledGlob
 * @property {string} pattern The pattern as written.
 * @property {PatternSegment[]} segments
 */

/**
 * Raised for a pattern the matcher does not accept.
 */
export class GlobError extends Error {
  /**
   * @param {string} pattern
   * @param {string} reason
   */
  constructor(pattern, reason) {
    super(`the pattern "${pattern}" ${reason}`);
    this.name = 'GlobError';
    this.pattern = pattern;
  }
}

/**
 * @param {string} pattern
 * @param {string} segment A segment of the pattern that is not `**`.
 * @returns {SegmentToken[]}
 */
function parseSegment(pattern, segment) {
  /** @type {SegmentToken[]} */
  const tokens = [];
  const chars = Array.from(segment);
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (char === '*') {
      // A run of stars is one star (this is also what `**` inside a name means).
      while (chars[index + 1] === '*') index += 1;
      if (tokens.at(-1)?.type !== 'star') tokens.push({ type: 'star' });
      index += 1;
    } else if (char === '?') {
      tokens.push({ type: 'any' });
      index += 1;
    } else if (char === '[') {
      let cursor = index + 1;
      let negate = false;
      if (chars[cursor] === '!' || chars[cursor] === '^') {
        negate = true;
        cursor += 1;
      }
      /** @type {[number, number][]} */
      const ranges = [];
      let closed = false;
      let first = true;
      while (cursor < chars.length) {
        const current = chars[cursor];
        if (current === ']' && !first) {
          closed = true;
          cursor += 1;
          break;
        }
        first = false;
        const low = /** @type {number} */ (current.codePointAt(0));
        if (chars[cursor + 1] === '-' && cursor + 2 < chars.length && chars[cursor + 2] !== ']') {
          const high = /** @type {number} */ (chars[cursor + 2].codePointAt(0));
          if (high < low) throw new GlobError(pattern, `has the range "${current}-${chars[cursor + 2]}", which runs backwards`);
          ranges.push([low, high]);
          cursor += 3;
        } else {
          ranges.push([low, low]);
          cursor += 1;
        }
      }
      if (!closed) throw new GlobError(pattern, 'has a "[" that is never closed (write a plain "[" as "[[]")');
      tokens.push({ type: 'class', negate, ranges });
      index = cursor;
    } else {
      tokens.push({ type: 'literal', char });
      index += 1;
    }
  }
  return tokens;
}

/**
 * Parses a pattern.
 *
 * @param {string} pattern
 * @returns {CompiledGlob}
 * @throws {GlobError} When the pattern is empty, too long, or uses something that is not supported.
 */
export function compileGlob(pattern) {
  if (typeof pattern !== 'string' || pattern === '') throw new GlobError(String(pattern), 'is empty');
  if (pattern.length > MAX_GLOB_LENGTH) throw new GlobError(`${pattern.slice(0, 20)}...`, `is longer than ${MAX_GLOB_LENGTH} characters`);
  if (pattern.startsWith('!')) throw new GlobError(pattern, 'starts with "!"; negation is not supported (list the files to leave out under "exclude")');
  if (pattern.includes('{') || pattern.includes('}')) throw new GlobError(pattern, 'uses "{...}" alternatives, which are not supported (list one pattern for each alternative)');
  if (pattern.includes('\\')) throw new GlobError(pattern, 'contains "\\"; escapes are not supported and paths are written with "/"');
  /** @type {PatternSegment[]} */
  const segments = [];
  for (const segment of pattern.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new GlobError(pattern, 'contains ".."');
    if (segment === '**') {
      // Two globstars in a row are one.
      if (!segments.at(-1)?.globstar) segments.push({ globstar: true });
    } else {
      segments.push({ globstar: false, tokens: parseSegment(pattern, segment) });
    }
  }
  if (segments.length === 0) throw new GlobError(pattern, 'is empty');
  return { pattern, segments };
}

/**
 * Checks a pattern without keeping it.
 *
 * @param {string} pattern
 * @returns {{ value: string } | { problem: string }}
 */
export function checkGlobPattern(pattern) {
  try {
    compileGlob(pattern);
    return { value: pattern };
  } catch (error) {
    if (error instanceof GlobError) return { problem: error.message };
    throw error;
  }
}

/**
 * @param {SegmentToken} token
 * @param {number} code
 * @returns {boolean}
 */
function tokenMatches(token, code) {
  if (token.type === 'any') return true;
  if (token.type === 'literal') return token.char.codePointAt(0) === code;
  if (token.type !== 'class') return false;
  const inside = token.ranges.some(([low, high]) => code >= low && code <= high);
  return inside !== token.negate;
}

/**
 * Matches one name (no `/`) against the tokens of one pattern segment. The
 * scan remembers only the last `*`, so it takes at most (tokens x length)
 * steps.
 *
 * @param {SegmentToken[]} tokens
 * @param {string} name
 * @returns {boolean}
 */
function matchSegment(tokens, name) {
  const first = tokens[0];
  if (name.startsWith('.') && !(first?.type === 'literal' && first.char === '.')) return false;
  const codes = Array.from(name, (char) => /** @type {number} */ (char.codePointAt(0)));
  let t = 0;
  let s = 0;
  let starToken = -1;
  let starName = 0;
  while (s < codes.length) {
    const token = tokens[t];
    if (token?.type === 'star') {
      starToken = t;
      starName = s;
      t += 1;
    } else if (token !== undefined && tokenMatches(token, codes[s])) {
      t += 1;
      s += 1;
    } else if (starToken >= 0) {
      starName += 1;
      s = starName;
      t = starToken + 1;
    } else {
      return false;
    }
  }
  while (tokens[t]?.type === 'star') t += 1;
  return t === tokens.length;
}

/**
 * Whether a path matches a pattern.
 *
 * @param {string | CompiledGlob} glob A pattern, or one parsed by {@link compileGlob} (parse once when matching many paths).
 * @param {string} path Path relative to the guide's folder, with `/`.
 * @returns {boolean}
 * @throws {GlobError} For a pattern that is not accepted.
 */
export function matchGlob(glob, path) {
  const compiled = typeof glob === 'string' ? compileGlob(glob) : glob;
  const names = path.split('/').filter((name) => name !== '' && name !== '.');
  if (names.length === 0) return false;
  const { segments } = compiled;
  /**
   * Positions of the pattern the match can be in. A globstar can match no
   * folder at all, so the position after it is reached too.
   *
   * @param {Set<number>} positions
   * @returns {Set<number>}
   */
  const settle = (positions) => {
    for (const position of [...positions].sort((a, b) => a - b)) {
      let next = position;
      while (segments[next]?.globstar) {
        next += 1;
        positions.add(next);
      }
    }
    return positions;
  };
  let positions = settle(new Set([0]));
  for (const name of names) {
    /** @type {Set<number>} */
    const next = new Set();
    for (const position of positions) {
      const segment = segments[position];
      if (segment === undefined) continue;
      if (segment.globstar) {
        if (!name.startsWith('.')) next.add(position);
      } else if (matchSegment(segment.tokens, name)) {
        next.add(position + 1);
      }
    }
    positions = settle(next);
    if (positions.size === 0) return false;
  }
  return positions.has(segments.length);
}
