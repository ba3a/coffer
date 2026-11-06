import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { checkDocsConfig } from '../docs/sources.js';
import { IMAGE_EXTENSIONS } from '../images/defaults.js';
import { inspectSvg } from '../images/svg.js';

/**
 * The kinds of project a site can have, and the fields each kind adds to the
 * common ones of `project.yaml`.
 *
 * A kind is registered with {@link registerProjectKind}: a name, the template
 * that renders its page and a schema for its own fields. The schema is a
 * mapping from field name to a {@link FieldSpec}, so a kind never needs
 * validation code of its own. `tool` and `game` ship with the engine and are
 * registered at the bottom of this file.
 */

/**
 * Where a field is read from, for the checks that look at the disk.
 *
 * @typedef {object} FieldContext
 * @property {string} dir Absolute path of the project's folder.
 * @property {(path: (string | number)[]) => number | undefined} [lineOf] The 1-based line of `project.yaml` on which the value at a path (such as `['pressKit', 'longDescription']`) starts, or undefined when it is not known.
 */

/**
 * The outcome of checking one value: the normalized value, or what is wrong
 * with it.
 *
 * @typedef {{ value: unknown } | { problem: string }} FieldResult
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined} The URL when it is an absolute `http(s)` URL.
 */
function webUrl(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  try {
    const parsed = new URL(text);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== ''
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a path, relative to the project folder, stays inside it.
 *
 * @param {string} inside The result of `relative(dir, target)`.
 * @returns {boolean}
 */
function staysInside(inside) {
  return inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/**
 * Checks a file in the project folder: a path that stays inside the folder,
 * has one of the extensions and exists.
 *
 * @param {unknown} value
 * @param {string} dir Absolute path of the project's folder.
 * @param {readonly string[]} extensions Lower-case extensions with the dot.
 * @param {string} what What the file is, for the message ("a picture").
 * @returns {FieldResult}
 */
function fileInProject(value, dir, extensions, what) {
  if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be a non-empty path' };
  const text = value.trim();
  const target = resolve(dir, text);
  const inside = relative(dir, target);
  if (!staysInside(inside)) return { problem: `must be ${what} inside the project folder` };
  if (!extensions.includes(extname(target).toLowerCase())) {
    return { problem: `"${text}" must be ${what}: one of ${extensions.join(', ')}` };
  }
  try {
    if (!statSync(target).isFile()) return { problem: `"${text}" is not a file` };
  } catch {
    return { problem: `the file "${text}" does not exist in the project folder` };
  }
  return { value: inside.split(sep).join('/') };
}

/**
 * Whether a path, once symbolic links are followed, is still inside a folder.
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
function realPathStaysInside(root, target) {
  try {
    return staysInside(relative(realpathSync(root), realpathSync(target)));
  } catch {
    return false;
  }
}

/** The keys a `pressKit` mapping can have. */
export const PRESS_KIT_KEYS = Object.freeze([
  'dir',
  'developer',
  'releaseStatus',
  'platforms',
  'price',
  'shortDescription',
  'longDescription',
  'logos',
  'screenshots',
]);

/** File extensions of the files a press kit lists as logos: any picture, and SVG. */
export const PRESS_KIT_LOGO_EXTENSIONS = Object.freeze([...IMAGE_EXTENSIONS, '.svg']);

/** The most logos, and the most screenshots, a press kit can list. */
export const MAX_PRESS_KIT_ASSETS = 40;

/**
 * One logo or screenshot of a press kit.
 *
 * @typedef {object} PressKitAsset
 * @property {string} file Path relative to the project folder, with `/`.
 * @property {string} alt Alternative text of the thumbnail; empty when the author gave none.
 * @property {'raster' | 'svg'} kind An SVG file is published as it is; any other picture is re-encoded.
 */

/**
 * The normalized `pressKit` of a game.
 *
 * @typedef {object} PressKit
 * @property {string | null} dir The folder, relative to the project folder, that the file names are relative to; null for the project folder itself. (Each asset's `file` is already relative to the project folder.)
 * @property {string | null} developer
 * @property {string | null} releaseStatus Free text such as "Early access, summer 2027"; null to use the project's status.
 * @property {string[] | null} platforms Null to use the game's `platforms`.
 * @property {string | null} price Null to use the game's `price`.
 * @property {{ text: string, line: number } | null} shortDescription Markdown, and the line of `project.yaml` it starts on.
 * @property {{ text: string, line: number } | null} longDescription Markdown, and the line of `project.yaml` it starts on.
 * @property {PressKitAsset[]} logos
 * @property {PressKitAsset[]} screenshots
 */

/**
 * Checks the `pressKit` of a game: a mapping of facts, two descriptions and
 * two lists of picture files. Every file has to exist inside the project
 * folder, also when symbolic links are followed; an SVG logo has to pass
 * {@link inspectSvg}. All problems are reported together.
 *
 * @param {unknown} value
 * @param {FieldContext} context
 * @returns {FieldResult}
 */
function checkPressKit(value, { dir, lineOf }) {
  if (!isMapping(value)) {
    return {
      problem: `must be a mapping with some of: ${PRESS_KIT_KEYS.join(', ')} (see the documentation of projects)`,
    };
  }
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(value)) {
    if (!PRESS_KIT_KEYS.includes(key)) problems.push(`${key}: unknown key (expected one of: ${PRESS_KIT_KEYS.join(', ')})`);
  }
  /**
   * @param {string} key
   * @returns {string | null}
   */
  const text = (key) => {
    const raw = value[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' || raw.trim() === '') {
      problems.push(`${key}: must be a non-empty string`);
      return null;
    }
    return raw.trim();
  };
  /**
   * @param {string} key
   * @returns {{ text: string, line: number } | null}
   */
  const markdown = (key) => {
    const found = text(key);
    return found === null ? null : { text: found, line: lineOf?.(['pressKit', key]) ?? 1 };
  };

  /** @type {string | null} */
  let kitDir = null;
  let base = dir;
  if (value.dir !== undefined && value.dir !== null) {
    if (typeof value.dir !== 'string' || value.dir.trim() === '') {
      problems.push('dir: must be a non-empty path');
    } else {
      const target = resolve(dir, value.dir.trim());
      const inside = relative(dir, target);
      let isFolder = false;
      try {
        isFolder = statSync(target).isDirectory();
      } catch {
        // Reported below.
      }
      if (!staysInside(inside)) {
        problems.push('dir: must name a folder inside the project folder');
      } else if (!isFolder) {
        problems.push(`dir: the folder "${value.dir}" does not exist in the project folder`);
      } else if (!realPathStaysInside(dir, target)) {
        problems.push('dir: must name a folder inside the project folder (a link that leads out of it is not accepted)');
      } else {
        kitDir = inside.split(sep).join('/');
        base = target;
      }
    }
  }

  const developer = text('developer');
  const releaseStatus = text('releaseStatus');
  const price = text('price');
  const shortDescription = markdown('shortDescription');
  const longDescription = markdown('longDescription');
  /** @type {string[] | null} */
  let platforms = null;
  if (value.platforms !== undefined && value.platforms !== null) {
    const listed = FIELD_TYPES['string-list'].check(value.platforms, { dir });
    if ('problem' in listed) problems.push(`platforms: ${listed.problem}`);
    else platforms = /** @type {string[]} */ (listed.value);
  }

  /**
   * @param {'logos' | 'screenshots'} key
   * @returns {PressKitAsset[]}
   */
  const assets = (key) => {
    const raw = value[key];
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      problems.push(`${key}: must be a list of picture files`);
      return [];
    }
    if (raw.length > MAX_PRESS_KIT_ASSETS) {
      problems.push(`${key}: at most ${MAX_PRESS_KIT_ASSETS} files`);
      return [];
    }
    const extensions = key === 'logos' ? PRESS_KIT_LOGO_EXTENSIONS : IMAGE_EXTENSIONS;
    /** @type {PressKitAsset[]} */
    const found = [];
    for (const [index, item] of raw.entries()) {
      const label = `${key}: item ${index + 1}`;
      /** @type {Record<string, unknown>} */
      const entry = isMapping(item) ? item : { file: item };
      if (isMapping(item)) {
        const unknown = Object.keys(item).filter((name) => name !== 'file' && name !== 'alt');
        if (unknown.length > 0) {
          problems.push(`${label}: unknown key ${unknown.map((name) => `"${name}"`).join(', ')} (expected file and alt)`);
          continue;
        }
      }
      const checked = fileInProject(entry.file, base, extensions, key === 'logos' ? 'a logo file' : 'a screenshot file');
      if ('problem' in checked) {
        problems.push(`${label}: ${checked.problem}`);
        continue;
      }
      const relativeFile = /** @type {string} */ (checked.value);
      const absolute = resolve(base, relativeFile);
      if (!realPathStaysInside(dir, absolute)) {
        problems.push(`${label}: "${relativeFile}" must be a file inside the project folder (a link that leads out of it is not accepted)`);
        continue;
      }
      const file = relative(dir, absolute).split(sep).join('/');
      if (found.some((asset) => asset.file.toLowerCase() === file.toLowerCase())) {
        problems.push(`${label}: "${file}" is listed twice`);
        continue;
      }
      let alt = '';
      if (entry.alt !== undefined && entry.alt !== null) {
        if (typeof entry.alt !== 'string') {
          problems.push(`${label}: alt must be text`);
          continue;
        }
        alt = entry.alt.trim();
      }
      const kind = extname(file).toLowerCase() === '.svg' ? 'svg' : 'raster';
      if (kind === 'svg') {
        let svg;
        try {
          svg = inspectSvg(readFileSync(absolute));
        } catch (error) {
          problems.push(`${label}: "${file}" cannot be read: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (svg.problems.length > 0) {
          problems.push(`${label}: "${file}" ${svg.problems.join('; ')}`);
          continue;
        }
      }
      found.push({ file, alt, kind });
    }
    return found;
  };
  const logos = assets('logos');
  const screenshots = assets('screenshots');

  if (problems.length > 0) return { problem: problems.join('; ') };
  if (
    developer === null &&
    releaseStatus === null &&
    platforms === null &&
    price === null &&
    shortDescription === null &&
    longDescription === null &&
    logos.length === 0 &&
    screenshots.length === 0
  ) {
    return { value: null };
  }
  /** @type {PressKit} */
  const kit = { dir: kitDir, developer, releaseStatus, platforms, price, shortDescription, longDescription, logos, screenshots };
  return { value: kit };
}

/** File extensions of the local videos a `trailer` can be, with their media types. */
export const TRAILER_FILE_TYPES = Object.freeze({ '.mp4': 'video/mp4', '.webm': 'video/webm' });

/** File extensions of the font files a `font-file` can be, with the `format()` name that CSS uses for each. */
export const FONT_FILE_FORMATS = Object.freeze({ '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' });

/** A YouTube video id. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The embeddable address of a video on one of the sites that a `trailer` may
 * come from. The address is built from the checked video id, never copied from
 * the input, so nothing but a player of one of these sites can be embedded:
 *
 * - YouTube (`youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/embed/ID`, also `youtube-nocookie.com/embed/ID`) becomes `https://www.youtube-nocookie.com/embed/ID`;
 * - Vimeo (`vimeo.com/ID`, `player.vimeo.com/video/ID`) becomes `https://player.vimeo.com/video/ID?dnt=1`.
 *
 * @param {string} text
 * @returns {{ provider: 'youtube' | 'vimeo', url: string } | undefined} Undefined for anything else, including `http` addresses.
 */
export function embedOf(text) {
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter((part) => part !== '');
  /** @type {string | null | undefined} */
  let id;
  if (host === 'youtu.be') {
    id = parts.length === 1 ? parts[0] : undefined;
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
    if (parts.length === 2 && parts[0] === 'embed') id = parts[1];
    else if (parts.length === 1 && parts[0] === 'watch') id = parsed.searchParams.get('v');
  }
  if (id !== undefined && id !== null && YOUTUBE_ID.test(id)) {
    return { provider: 'youtube', url: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  /** @type {string | undefined} */
  let number;
  if (host === 'vimeo.com' || host === 'www.vimeo.com') number = parts.length === 1 ? parts[0] : undefined;
  else if (host === 'player.vimeo.com') number = parts.length === 2 && parts[0] === 'video' ? parts[1] : undefined;
  if (number !== undefined && /^[0-9]{1,12}$/.test(number)) {
    return { provider: 'vimeo', url: `https://player.vimeo.com/video/${number}?dnt=1` };
  }
  return undefined;
}

/**
 * The field types a kind can use. Each one checks a raw YAML value and returns
 * the normalized value, or says what is wrong.
 *
 * @type {Readonly<Record<string, { describe: string, empty: () => unknown, check: (value: unknown, context: FieldContext) => FieldResult }>>}
 */
export const FIELD_TYPES = Object.freeze({
  string: {
    describe: 'text',
    empty: () => null,
    check: (value) =>
      typeof value === 'string' && value.trim() !== ''
        ? { value: value.trim() }
        : { problem: 'must be a non-empty string' },
  },
  url: {
    describe: 'an http(s) URL',
    empty: () => null,
    check: (value) => {
      const url = webUrl(value);
      return url === undefined ? { problem: 'must be an absolute http(s) URL' } : { value: url };
    },
  },
  'font-name': {
    describe: 'a font family name such as Fraunces, or a comma-separated list of such names',
    empty: () => null,
    check: (value) => {
      if (typeof value !== 'string') return { problem: 'must be a font family name' };
      const names = value.split(',').map((name) => name.trim());
      const plain = /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/;
      if (!names.every((name) => plain.test(name))) {
        return {
          problem:
            'must be a plain font family name (letters, digits, spaces and "-", up to 64 characters), or a comma-separated list of them; no quotes, braces, semicolons or angle brackets',
        };
      }
      return { value: names.join(', ') };
    },
  },
  color: {
    describe: 'a colour such as #c2410c',
    empty: () => null,
    check: (value) =>
      typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
        ? { value: value.trim().toLowerCase() }
        : { problem: 'must be a colour written as #rgb or #rrggbb' },
  },
  image: {
    describe: 'a picture in the project folder',
    empty: () => null,
    check: (value, { dir }) => fileInProject(value, dir, IMAGE_EXTENSIONS, 'a picture'),
  },
  'font-file': {
    describe: 'a font file in the project folder',
    empty: () => null,
    check: (value, { dir }) => fileInProject(value, dir, Object.keys(FONT_FILE_FORMATS), 'a font file'),
  },
  trailer: {
    describe: 'a video file (mp4 or webm) in the project folder, or the https address of a YouTube or Vimeo video',
    empty: () => null,
    check: (value, { dir }) => {
      if (typeof value !== 'string' || value.trim() === '') {
        return { problem: 'must be a video file in the project folder, or the https address of a YouTube or Vimeo video' };
      }
      const text = value.trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        const embed = embedOf(text);
        return embed === undefined
          ? {
              problem:
                'an address must be https and from youtube.com, youtu.be, youtube-nocookie.com or vimeo.com (a video, not a channel or a playlist); for any other video use a file in the project folder',
            }
          : { value: { type: 'embed', provider: embed.provider, url: embed.url } };
      }
      const file = fileInProject(text, dir, Object.keys(TRAILER_FILE_TYPES), 'a video file');
      if ('problem' in file) return file;
      const mime = TRAILER_FILE_TYPES[/** @type {keyof typeof TRAILER_FILE_TYPES} */ (extname(text).toLowerCase())];
      return { value: { type: 'file', file: file.value, mime } };
    },
  },
  directory: {
    describe: 'a folder inside the project folder',
    empty: () => null,
    check: (value, { dir }) => {
      if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be a non-empty path' };
      const target = resolve(dir, value.trim());
      const inside = relative(dir, target);
      if (!staysInside(inside)) {
        return { problem: 'must name a folder inside the project folder' };
      }
      try {
        if (!statSync(target).isDirectory()) return { problem: `"${value}" is not a folder` };
      } catch {
        return { problem: `the folder "${value}" does not exist in the project folder` };
      }
      return { value: inside.split(sep).join('/') };
    },
  },
  'string-list': {
    describe: 'a list of texts',
    empty: () => [],
    check: (value) => {
      if (!Array.isArray(value)) return { problem: 'must be a list' };
      /** @type {string[]} */
      const items = [];
      for (const [index, item] of value.entries()) {
        if (typeof item !== 'string' || item.trim() === '') {
          return { problem: `item ${index + 1} must be a non-empty string` };
        }
        if (items.includes(item.trim())) return { problem: `"${item.trim()}" is listed twice` };
        items.push(item.trim());
      }
      return { value: items };
    },
  },
  'url-map': {
    describe: 'a mapping of names to http(s) URLs; an empty value means "not set"',
    empty: () => ({}),
    check: (value) => {
      if (!isMapping(value)) return { problem: 'must be a mapping of names to URLs' };
      /** @type {Record<string, string>} */
      const entries = {};
      for (const [key, raw] of Object.entries(value)) {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
          return { problem: `"${key}" is not a usable name (use lower-case letters, digits, "-" and "_")` };
        }
        if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) continue;
        const url = webUrl(raw);
        if (url === undefined) return { problem: `${key}: must be an absolute http(s) URL, or empty while it is not set` };
        entries[key] = url;
      }
      return { value: entries };
    },
  },
  'press-kit': {
    describe: 'a mapping of the facts, descriptions, logos and screenshots of the press kit',
    empty: () => null,
    check: checkPressKit,
  },
  docs: {
    describe: 'a mapping with the source of the documentation (a git repository or a folder), the guides to publish and, later, a reference',
    empty: () => null,
    check: checkDocsConfig,
  },
  mapping: {
    describe: 'a mapping',
    empty: () => null,
    check: (value) => (isMapping(value) ? { value } : { problem: 'must be a mapping' }),
  },
});

/**
 * One field a kind adds to `project.yaml`.
 *
 * @typedef {object} FieldSpec
 * @property {keyof typeof FIELD_TYPES} type How the value is checked and normalized.
 * @property {boolean} [required] Whether the field must be present (default false). An absent optional field is `null`, `[]` or `{}` according to its type.
 */

/**
 * A kind of project.
 *
 * @typedef {object} ProjectKind
 * @property {string} name Value of `kind:` in `project.yaml`; lower-case letters, digits and "-".
 * @property {string} template Name of the template that renders the project's page; the theme's own file wins over the engine's.
 * @property {Readonly<Record<string, FieldSpec>>} fields The fields the kind adds to the common ones.
 */

/** Keys of `project.yaml` that every kind has; a kind cannot reuse them. */
export const COMMON_PROJECT_KEYS = Object.freeze([
  'name',
  'pitch',
  'kind',
  'status',
  'card',
  'cardAlt',
  'featured',
  'order',
  'tag',
  'license',
]);

/** @type {Map<string, ProjectKind>} */
const kinds = new Map();

/**
 * Registers a kind of project. Every project of that kind is then checked
 * against the kind's schema and rendered with its template.
 *
 * @param {ProjectKind} kind
 * @returns {ProjectKind} The registered kind.
 * @throws {TypeError} When the kind is malformed or already registered.
 */
export function registerProjectKind(kind) {
  if (typeof kind?.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(kind.name)) {
    throw new TypeError('a project kind needs a name of lower-case letters, digits and "-", starting with a letter');
  }
  if (typeof kind.template !== 'string' || kind.template === '') {
    throw new TypeError(`project kind "${kind.name}": template must be the name of a template`);
  }
  if (kinds.has(kind.name)) throw new TypeError(`project kind "${kind.name}" is already registered`);
  for (const [field, spec] of Object.entries(kind.fields ?? {})) {
    if (COMMON_PROJECT_KEYS.includes(field)) {
      throw new TypeError(`project kind "${kind.name}": "${field}" is a field of every project`);
    }
    if (!Object.hasOwn(FIELD_TYPES, spec?.type)) {
      throw new TypeError(
        `project kind "${kind.name}": field "${field}" has the unknown type "${spec?.type}" (known: ${Object.keys(FIELD_TYPES).join(', ')})`,
      );
    }
  }
  const frozen = Object.freeze({
    name: kind.name,
    template: kind.template,
    fields: Object.freeze({ ...(kind.fields ?? {}) }),
  });
  kinds.set(frozen.name, frozen);
  return frozen;
}

/**
 * Removes a kind, for tests and for tools that register kinds for one run.
 *
 * @param {string} name
 * @returns {boolean} Whether the kind was registered.
 */
export function unregisterProjectKind(name) {
  return kinds.delete(name);
}

/**
 * @param {string} name
 * @returns {ProjectKind | undefined}
 */
export function getProjectKind(name) {
  return kinds.get(name);
}

/**
 * @returns {ProjectKind[]} The registered kinds, ordered by name.
 */
export function listProjectKinds() {
  return [...kinds.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Checks the kind-specific part of a `project.yaml` against the kind's schema.
 * Keys that belong to neither the kind nor the common fields are not looked at
 * here.
 *
 * @param {ProjectKind} kind
 * @param {Record<string, unknown>} data The parsed `project.yaml`.
 * @param {FieldContext} context
 * @param {(field: string, message: string) => void} fail Reports a problem with a field.
 * @returns {Record<string, unknown>} The kind's fields, normalized, with a default for each absent optional one.
 */
export function readKindFields(kind, data, context, fail) {
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const [field, spec] of Object.entries(kind.fields)) {
    const type = FIELD_TYPES[spec.type];
    const raw = data[field];
    if (raw === undefined || raw === null) {
      if (spec.required === true) fail(field, `is required for a ${kind.name} (${type.describe})`);
      values[field] = type.empty();
      continue;
    }
    const result = type.check(raw, context);
    if ('problem' in result) {
      fail(field, result.problem);
      values[field] = type.empty();
    } else {
      values[field] = result.value;
    }
  }
  return values;
}

registerProjectKind({
  name: 'tool',
  template: 'project-tool.njk',
  fields: {
    repo: { type: 'url', required: true },
    docs: { type: 'docs' },
  },
});

registerProjectKind({
  name: 'game',
  template: 'project-game.njk',
  fields: {
    stores: { type: 'url-map' },
    platforms: { type: 'string-list' },
    price: { type: 'string' },
    pressKit: { type: 'press-kit' },
    accent: { type: 'color' },
    displayFont: { type: 'font-name' },
    displayFontFile: { type: 'font-file' },
    logo: { type: 'image' },
    keyArt: { type: 'image' },
    keyArtAlt: { type: 'string' },
    trailer: { type: 'trailer' },
    trailerPoster: { type: 'image' },
    features: { type: 'string-list' },
  },
});
