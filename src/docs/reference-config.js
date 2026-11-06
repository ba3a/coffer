/**
 * The `reference` block of a tool's `docs` configuration: the command that
 * generates a reference from the project's repository and what to do with
 * its output. This module only checks the block (it is registered through
 * `checkDocsConfig`); running the command is {@link ./reference.js}.
 */

import { INDEX_ADAPTERS } from './symbols.js';

/** The keys a `docs.reference` mapping can have. */
export const REFERENCE_KEYS = Object.freeze(['command', 'format', 'output', 'title', 'undocumented', 'index', 'autoLink']);

/** The formats of a generated reference. */
export const REFERENCE_FORMATS = Object.freeze(['html', 'json']);

/** The placeholders a command and an output path can use. */
export const REFERENCE_PLACEHOLDERS = Object.freeze(['repo', 'out', 'site']);

/** The most items an argument list can have. */
export const MAX_COMMAND_ARGUMENTS = 50;

/** The longest command line, or argument, in characters. */
export const MAX_COMMAND_LENGTH = 2000;

/** The longest `output` path and `title`, in characters. */
export const MAX_REFERENCE_TEXT_LENGTH = 300;

/** The longest `undocumented.pattern`, in characters. */
export const MAX_PATTERN_LENGTH = 500;

/**
 * The checked `reference` block.
 *
 * @typedef {object} ReferenceConfig
 * @property {string | string[]} command A command line for the system's shell, or a program and its arguments (no shell). `{repo}`, `{out}` and `{site}` are replaced.
 * @property {'html' | 'json'} format What the command produces.
 * @property {string} output A directory (`html`) or a file (`json`), relative to the checkout or to `{out}`.
 * @property {string} title The name of the reference, in the sidebar and in the breadcrumbs.
 * @property {{ pattern: string } | null} undocumented A regular expression with a named group `name`, applied to the output of the command to find the elements that have no documentation.
 * @property {{ adapter: string, file: string | null } | null} index How the symbols of an `html` reference are found, so that guides can link to them: the adapter that reads the index file, and the file when it is not the adapter's usual one. Null for `json`, whose symbols are the items, and for an `html` reference without an index.
 * @property {boolean} autoLink Whether inline code in guides that is exactly the name of a symbol is linked to the reference.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Control characters other than the tab. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {{ value: string } | { problem: string }}
 */
function checkText(value, max) {
  if (typeof value !== 'string' || value.trim() === '') return { problem: 'must be non-empty text' };
  if (value.length > max) return { problem: `must be at most ${max} characters` };
  if (CONTROL.test(value)) return { problem: 'must not contain control characters or line breaks' };
  return { value: value.trim() };
}

/**
 * Checks a `docs.reference` block and normalizes it. Every problem is
 * returned, each starting with the path of the field.
 *
 * - `command` (required): a command line (text) or a list of text: the program and its arguments;
 * - `format` (required): `html` or `json`;
 * - `output` (required): where the command leaves its result;
 * - `title` (required): the name of the reference;
 * - `undocumented` (optional): `{pattern}`, a regular expression with a named group `name`;
 * - `index` (optional, `html` only): the name of an index adapter (`dokka`), or `{adapter, file}`;
 * - `autoLink` (optional, default true): `true` or `false`.
 *
 * @param {unknown} value
 * @returns {{ value: ReferenceConfig } | { problems: string[] }}
 */
export function checkReferenceConfig(value) {
  if (!isMapping(value)) return { problems: [`reference: must be a mapping with ${REFERENCE_KEYS.join(', ')}`] };
  /** @type {string[]} */
  const problems = [];
  for (const key of Object.keys(value)) {
    if (!REFERENCE_KEYS.includes(key)) problems.push(`reference.${key}: unknown key (expected one of: ${REFERENCE_KEYS.join(', ')})`);
  }

  /** @type {string | string[] | undefined} */
  let command;
  if (value.command === undefined || value.command === null) {
    problems.push('reference.command: is required (a command line, or a list: the program and its arguments)');
  } else if (Array.isArray(value.command)) {
    if (value.command.length === 0 || value.command.length > MAX_COMMAND_ARGUMENTS) {
      problems.push(`reference.command: a list needs from 1 to ${MAX_COMMAND_ARGUMENTS} items`);
    } else {
      /** @type {string[]} */
      const parts = [];
      for (const [index, part] of value.command.entries()) {
        if (typeof part !== 'string' || part.length > MAX_COMMAND_LENGTH || part.includes('\u0000') || (index === 0 && part.trim() === '')) {
          problems.push(`reference.command: item ${index + 1} must be text (the program must not be empty)`);
        } else {
          parts.push(part);
        }
      }
      if (parts.length === value.command.length) command = parts;
    }
  } else {
    const checked = checkText(value.command, MAX_COMMAND_LENGTH);
    if ('problem' in checked) problems.push(`reference.command: ${checked.problem}`);
    else command = checked.value;
  }

  /** @type {'html' | 'json' | undefined} */
  let format;
  if (value.format === undefined || value.format === null) {
    problems.push(`reference.format: is required (${REFERENCE_FORMATS.join(' or ')})`);
  } else if (value.format === 'html' || value.format === 'json') {
    format = value.format;
  } else {
    problems.push(`reference.format: must be ${REFERENCE_FORMATS.join(' or ')}`);
  }

  /** @type {string | undefined} */
  let output;
  if (value.output === undefined || value.output === null) {
    problems.push('reference.output: is required (a folder for html, a file for json, relative to the repository or to {out})');
  } else {
    const checked = checkText(value.output, MAX_REFERENCE_TEXT_LENGTH);
    if ('problem' in checked) problems.push(`reference.output: ${checked.problem}`);
    else output = checked.value;
  }

  /** @type {string | undefined} */
  let title;
  if (value.title === undefined || value.title === null) {
    problems.push('reference.title: is required');
  } else {
    const checked = checkText(value.title, MAX_REFERENCE_TEXT_LENGTH);
    if ('problem' in checked) problems.push(`reference.title: ${checked.problem}`);
    else title = checked.value;
  }

  /** @type {{ pattern: string } | null} */
  let undocumented = null;
  if (value.undocumented !== undefined && value.undocumented !== null) {
    if (!isMapping(value.undocumented)) {
      problems.push('reference.undocumented: must be a mapping with pattern');
    } else {
      for (const key of Object.keys(value.undocumented)) {
        if (key !== 'pattern') problems.push(`reference.undocumented.${key}: unknown key (expected: pattern)`);
      }
      const pattern = value.undocumented.pattern;
      if (typeof pattern !== 'string' || pattern === '') {
        problems.push('reference.undocumented.pattern: is required (a regular expression with a named group "name")');
      } else if (pattern.length > MAX_PATTERN_LENGTH) {
        problems.push(`reference.undocumented.pattern: must be at most ${MAX_PATTERN_LENGTH} characters`);
      } else if (!/\(\?<name>/.test(pattern)) {
        problems.push('reference.undocumented.pattern: needs a named group "name", written (?<name>...)');
      } else {
        try {
          new RegExp(pattern, 'gm');
          undocumented = { pattern };
        } catch (error) {
          problems.push(`reference.undocumented.pattern: is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /** @type {{ adapter: string, file: string | null } | null} */
  let index = null;
  if (value.index !== undefined && value.index !== null) {
    const adapters = Object.keys(INDEX_ADAPTERS).join(', ');
    /** @type {unknown} */
    let adapter = value.index;
    /** @type {unknown} */
    let file = null;
    if (isMapping(value.index)) {
      for (const key of Object.keys(value.index)) {
        if (key !== 'adapter' && key !== 'file') problems.push(`reference.index.${key}: unknown key (expected: adapter, file)`);
      }
      adapter = value.index.adapter;
      file = value.index.file ?? null;
    }
    if (typeof adapter !== 'string' || !Object.hasOwn(INDEX_ADAPTERS, adapter)) {
      problems.push(`reference.index: must be the name of an adapter (${adapters}), or a mapping with adapter and optionally file`);
    } else if (format === 'json') {
      problems.push('reference.index: is only for the format html; the symbols of a json reference are its items');
    } else if (file !== null && (typeof file !== 'string' || file.trim() === '' || file.length > MAX_REFERENCE_TEXT_LENGTH || CONTROL.test(file) || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..'))) {
      problems.push('reference.index.file: must be a path inside the generated folder (relative, with / and without ..)');
    } else {
      index = { adapter, file: file === null ? null : /** @type {string} */ (file).trim() };
    }
  }

  /** @type {boolean} */
  let autoLink = true;
  if (value.autoLink !== undefined && value.autoLink !== null) {
    if (typeof value.autoLink === 'boolean') autoLink = value.autoLink;
    else problems.push('reference.autoLink: must be true or false');
  }

  if (problems.length > 0 || command === undefined || format === undefined || output === undefined || title === undefined) {
    return { problems };
  }
  return { value: { command, format, output, title, undocumented, index, autoLink } };
}
