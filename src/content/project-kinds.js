import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
  directory: {
    describe: 'a folder inside the project folder',
    empty: () => null,
    check: (value, { dir }) => {
      if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be a non-empty path' };
      const target = resolve(dir, value.trim());
      const inside = relative(dir, target);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
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
  template: 'project.njk',
  fields: {
    repo: { type: 'url', required: true },
    docs: { type: 'mapping' },
  },
});

registerProjectKind({
  name: 'game',
  template: 'project.njk',
  fields: {
    stores: { type: 'url-map' },
    platforms: { type: 'string-list' },
    price: { type: 'string' },
    pressKit: { type: 'directory' },
    accent: { type: 'color' },
    displayFont: { type: 'font-name' },
  },
});
