import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { checkReferenceConfig } from './reference-config.js';
import { findExecutable, killTree, tailOf } from './sources.js';

export { checkReferenceConfig };

/**
 * The reference of a tool project: a command run in the checkout of the
 * project's repository produces either a folder of HTML (published as it is,
 * with a bar that leads back to the site) or a JSON file in the format below,
 * which coffer renders as one plain page.
 *
 * Results are cached by the commit of the source and by the configuration
 * (see {@link generateReference}); a command that fails, or an output that is
 * not what the configuration promised, is a {@link ReferenceFailure} that fails
 * the build with the exit code and the end of the command's output. Elements
 * without documentation never fail anything: they are listed in the build
 * report.
 */

/** Version of what is stored in the cache; a change makes every stored result unusable. */
const CACHE_VERSION = 1;

/** Name of the file, inside a cache entry, that says the entry is complete. */
const META_FILE = 'meta.json';

/** Name of the folder, inside a cache entry, that holds the result. */
const DATA_DIR = 'data';

/** Name of the JSON file, inside {@link DATA_DIR}, of a `json` reference. */
export const REFERENCE_JSON_FILE = 'reference.json';

/** How many results of one project the cache keeps. */
const KEEP_ENTRIES = 5;

/** How long a command can run before it is killed, in milliseconds. */
export const DEFAULT_REFERENCE_TIMEOUT_MS = 15 * 60_000;

/** How long a killed command is waited for, in milliseconds. */
const KILL_GRACE_MS = 3000;

/** The most output of the command that is kept (the end of it), in bytes. */
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

/** The largest `json` reference, in bytes. */
export const MAX_REFERENCE_JSON_BYTES = 8 * 1024 * 1024;

/** The most files an `html` reference can have. */
export const MAX_REFERENCE_FILES = 50_000;

/** The most bytes an `html` reference can have in all. */
export const MAX_REFERENCE_BYTES = 512 * 1024 * 1024;

/** The deepest folder nesting of an `html` reference. */
const MAX_REFERENCE_DEPTH = 40;

/** The most sections of a `json` reference. */
export const MAX_REFERENCE_SECTIONS = 1000;

/** The most items of a `json` reference, in all sections. */
export const MAX_REFERENCE_ITEMS = 20_000;

/** The longest `name`, `kind` and `title`, in characters. */
const MAX_SHORT_TEXT = 500;

/** The longest `signature`, in characters. */
const MAX_SIGNATURE = 5000;

/** The longest `description`, in characters. */
const MAX_DESCRIPTION = 50_000;

/** The longest `anchor`, in characters. */
const MAX_ANCHOR = 200;

/** What an explicit `anchor` can look like: it becomes an `id` and a `#fragment`, so nothing needs escaping. */
const ANCHOR = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** The most problems of one JSON file that are listed. */
const MAX_PROBLEMS = 20;

/** The most names of undocumented elements found in the output of a command. */
const MAX_UNDOCUMENTED = 10_000;

/** The most skipped links of a folder that are kept for the report. */
const MAX_SKIPPED = 20;

/**
 * Raised when a reference cannot be generated. The message is complete; the
 * build adds the project's file in front of it.
 */
export class ReferenceFailure extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ReferenceFailure';
  }
}

// ---------------------------------------------------------------------------
// The JSON format

/**
 * One element of a `json` reference.
 *
 * @typedef {object} ReferenceItem
 * @property {string} name
 * @property {string} kind Free text such as "function" or "option"; empty when not given.
 * @property {string} signature Empty when not given.
 * @property {string} description Plain text; paragraphs are separated by a blank line. Empty when not given.
 * @property {string | null} anchor The `id` of the element on the page, if the file gave one.
 * @property {boolean} undocumented Whether the element has no documentation; its description is then not shown.
 */

/**
 * @typedef {object} ReferenceSection
 * @property {string} title
 * @property {ReferenceItem[]} items
 */

/**
 * A checked `json` reference.
 *
 * @typedef {object} ReferenceModel
 * @property {string | null} title The heading of the page; the configured title is used when null.
 * @property {ReferenceSection[]} sections
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the text of a `json` reference and reads it.
 *
 * The format: `{title?, sections: [{title, items: [{name, kind?, signature?, description?, anchor?, undocumented?}]}]}`.
 * Unknown keys are ignored, so that a generator can carry more than coffer
 * reads. Every problem found (up to {@link MAX_PROBLEMS}) is returned with its
 * place in the file, such as `sections[1].items[0].name`.
 *
 * @param {string} text
 * @returns {{ model: ReferenceModel } | { problems: string[] }}
 */
export function parseReferenceJson(text) {
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    return { problems: [`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  /** @type {string[]} */
  const problems = [];
  let extra = 0;
  /** @param {string} message */
  const problem = (message) => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
    else extra += 1;
  };
  /**
   * @param {unknown} value
   * @param {string} path
   * @param {number} max
   * @param {boolean} required
   * @returns {string}
   */
  const textOf = (value, path, max, required) => {
    if (value === undefined || value === null) {
      if (required) problem(`${path}: is required`);
      return '';
    }
    if (typeof value !== 'string') {
      problem(`${path}: must be text`);
      return '';
    }
    if (value.length > max) {
      problem(`${path}: must be at most ${max} characters`);
      return '';
    }
    if (required && value.trim() === '') problem(`${path}: must not be empty`);
    return value;
  };

  if (!isMapping(data)) return { problems: ['the top level must be an object: {"title": ..., "sections": [...]}'] };
  const title = textOf(data.title, 'title', MAX_SHORT_TEXT, false).trim();
  /** @type {ReferenceSection[]} */
  const sections = [];
  /** @type {Map<string, string>} */
  const anchors = new Map();
  let itemCount = 0;
  if (!Array.isArray(data.sections)) {
    problem('sections: is required and must be a list');
  } else if (data.sections.length > MAX_REFERENCE_SECTIONS) {
    problem(`sections: at most ${MAX_REFERENCE_SECTIONS} sections`);
  } else {
    for (const [sectionIndex, rawSection] of data.sections.entries()) {
      const at = `sections[${sectionIndex}]`;
      if (!isMapping(rawSection)) {
        problem(`${at}: must be an object with title and items`);
        continue;
      }
      const sectionTitle = textOf(rawSection.title, `${at}.title`, MAX_SHORT_TEXT, true).trim();
      /** @type {ReferenceItem[]} */
      const items = [];
      if (!Array.isArray(rawSection.items)) {
        problem(`${at}.items: is required and must be a list`);
      } else {
        for (const [itemIndex, rawItem] of rawSection.items.entries()) {
          const place = `${at}.items[${itemIndex}]`;
          itemCount += 1;
          if (itemCount > MAX_REFERENCE_ITEMS) {
            if (itemCount === MAX_REFERENCE_ITEMS + 1) problem(`items: at most ${MAX_REFERENCE_ITEMS} items in all`);
            continue;
          }
          if (!isMapping(rawItem)) {
            problem(`${place}: must be an object with name`);
            continue;
          }
          const name = textOf(rawItem.name, `${place}.name`, MAX_SHORT_TEXT, true).trim();
          const kind = textOf(rawItem.kind, `${place}.kind`, MAX_SHORT_TEXT, false).trim();
          const signature = textOf(rawItem.signature, `${place}.signature`, MAX_SIGNATURE, false).trim();
          const description = textOf(rawItem.description, `${place}.description`, MAX_DESCRIPTION, false).trim();
          /** @type {string | null} */
          let anchor = null;
          if (rawItem.anchor !== undefined && rawItem.anchor !== null) {
            if (typeof rawItem.anchor !== 'string' || rawItem.anchor.length > MAX_ANCHOR || !ANCHOR.test(rawItem.anchor)) {
              problem(`${place}.anchor: must be letters, digits, "-", "_", "." and ":", starting with a letter or digit, at most ${MAX_ANCHOR} characters`);
            } else if (anchors.has(rawItem.anchor)) {
              problem(`${place}.anchor: "${rawItem.anchor}" is already the anchor of ${anchors.get(rawItem.anchor)}`);
            } else {
              anchor = rawItem.anchor;
              anchors.set(anchor, place);
            }
          }
          if (rawItem.undocumented !== undefined && rawItem.undocumented !== null && typeof rawItem.undocumented !== 'boolean') {
            problem(`${place}.undocumented: must be true or false`);
          }
          items.push({ name, kind, signature, description, anchor, undocumented: rawItem.undocumented === true });
        }
      }
      sections.push({ title: sectionTitle, items });
    }
  }
  if (problems.length > 0) {
    if (extra > 0) problems.push(`... and ${extra} more`);
    return { problems };
  }
  return { model: { title: title === '' ? null : title, sections } };
}

/**
 * @param {string} text
 * @returns {string} A lower-case ASCII `id` made from the text; "item" when nothing is left.
 */
function slugify(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return slug === '' ? 'item' : slug;
}

/**
 * A section of a `json` reference as the template shows it.
 *
 * @typedef {object} ReferenceSectionView
 * @property {string} id
 * @property {string} title
 * @property {{ id: string, name: string, kind: string, signature: string, paragraphs: string[], undocumented: boolean }[]} items
 */

/**
 * A `json` reference ready for the template: ids for sections and elements
 * (the anchor the file gave, else made from the name and made unique),
 * paragraphs, and the list of elements without documentation.
 *
 * @param {ReferenceModel} model
 * @param {readonly string[]} [undocumentedNames] Names the build found undocumented by other means (see `undocumented` in the configuration); an element with such a name is shown as undocumented.
 * @returns {{ title: string | null, sections: ReferenceSectionView[], itemCount: number, undocumented: { name: string, section: string, id: string }[] }}
 */
export function viewOfReference(model, undocumentedNames = []) {
  const known = new Set(undocumentedNames);
  const used = new Set(model.sections.flatMap((section) => section.items.flatMap((item) => (item.anchor === null ? [] : [item.anchor]))));
  /** @param {string} base */
  const unique = (base) => {
    let id = base;
    for (let number = 2; used.has(id); number += 1) id = `${base}-${number}`;
    used.add(id);
    return id;
  };
  /** @type {{ name: string, section: string, id: string }[]} */
  const undocumented = [];
  let itemCount = 0;
  const sections = model.sections.map((section) => ({
    id: unique(`section-${slugify(section.title)}`),
    title: section.title,
    items: section.items.map((item) => {
      itemCount += 1;
      const isUndocumented = item.undocumented || known.has(item.name);
      const id = item.anchor ?? unique(slugify(item.name));
      if (isUndocumented) undocumented.push({ name: item.name, section: section.title, id });
      return {
        id,
        name: item.name,
        kind: item.kind,
        signature: item.signature,
        paragraphs: isUndocumented ? [] : item.description.split(/\r?\n[ \t]*\r?\n/).map((part) => part.trim()).filter((part) => part !== ''),
        undocumented: isUndocumented,
      };
    }),
  }));
  return { title: model.title, sections, itemCount, undocumented };
}

// ---------------------------------------------------------------------------
// The bar that leads back to the site

/**
 * @param {string} text
 * @returns {string} The text with markup characters and everything outside ASCII written as character references, so that it is the same in a file of any ASCII-compatible encoding.
 */
function asciiHtml(text) {
  let out = '';
  for (const char of text) {
    const code = /** @type {number} */ (char.codePointAt(0));
    if (char === '&') out += '&amp;';
    else if (char === '<') out += '&lt;';
    else if (char === '>') out += '&gt;';
    else if (char === '"') out += '&quot;';
    else if (char === "'") out += '&#39;';
    else if (code < 0x20 || code > 0x7e) out += code === 9 || code === 10 ? ' ' : `&#${code};`;
    else out += char;
  }
  return out;
}

/**
 * The thin bar at the top of every page of an `html` reference, and of the
 * page of a `json` one. It looks the same everywhere, whatever the page
 * around it does: its style is in the element, and the page's style does not
 * reach it except through inheritance, which the bar resets.
 *
 * @param {string} href Address of the project's page on the site.
 * @param {string} text What the link says, such as "back to Kerfcalc on Tove Marlowe".
 * @returns {string} One element, ASCII only.
 */
export function backBarHtml(href, text) {
  const style =
    'all:initial;display:block;box-sizing:border-box;margin:0;padding:6px 12px;background:#1f2328;color:#ffffff;font:14px/1.4 system-ui,-apple-system,sans-serif';
  const linkStyle = 'all:initial;color:#ffffff;font:inherit;cursor:pointer;text-decoration:underline';
  return `<div class="coffer-reference-bar" style="${style}"><a href="${asciiHtml(href)}" style="${linkStyle}">&#8592; ${asciiHtml(text)}</a></div>`;
}

/** The start tag of `<body>`, with attributes that can hold a ">" in quotes. */
const BODY_TAG = /<body(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?>/i;

/**
 * Puts the bar right after the start of `<body>` of an HTML file. The file is
 * handled as bytes (the bar is ASCII), so its encoding is not touched. A file
 * without `<body>` gets the bar at its start, after a doctype.
 *
 * @param {Buffer} file
 * @param {string} bar The result of {@link backBarHtml}.
 * @returns {Buffer}
 */
export function injectBackBar(file, bar) {
  const text = file.toString('latin1');
  const body = BODY_TAG.exec(text);
  let at = 0;
  if (body) {
    at = body.index + body[0].length;
  } else {
    const doctype = /^\s*<!doctype[^>]*>/i.exec(text);
    if (doctype) at = doctype[0].length;
  }
  return Buffer.concat([file.subarray(0, at), Buffer.from(bar, 'latin1'), file.subarray(at)]);
}

/**
 * @param {string} name
 * @returns {boolean} Whether the file is an HTML page.
 */
function isHtmlFile(name) {
  return /\.html?$/i.test(name);
}

/**
 * Copies a folder, file by file. Links are not followed and not copied (they
 * are listed in `skipped`), so nothing outside the folder can end up in it.
 *
 * @param {string} from
 * @param {string} to
 * @param {(source: string, target: string) => void} copyOne Copies one file; both folders exist.
 * @returns {{ files: number, bytes: number, skipped: string[] }}
 */
function copyTree(from, to, copyOne) {
  let files = 0;
  let bytes = 0;
  /** @type {string[]} */
  const skipped = [];
  /**
   * @param {string} source
   * @param {string} target
   * @param {string} shown
   * @param {number} depth
   */
  const walk = (source, target, shown, depth) => {
    if (depth > MAX_REFERENCE_DEPTH) throw new ReferenceFailure(`the generated folder is nested deeper than ${MAX_REFERENCE_DEPTH} levels`);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(source, entry.name);
      const name = shown === '' ? entry.name : `${shown}/${entry.name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (skipped.length < MAX_SKIPPED) skipped.push(name);
      } else if (stat.isDirectory()) {
        walk(path, join(target, entry.name), name, depth + 1);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_REFERENCE_FILES) throw new ReferenceFailure(`the generated folder has more than ${MAX_REFERENCE_FILES} files`);
        if (bytes > MAX_REFERENCE_BYTES) throw new ReferenceFailure(`the generated folder is larger than ${Math.round(MAX_REFERENCE_BYTES / 1024 / 1024)} MiB`);
        copyOne(path, join(target, entry.name));
      }
    }
  };
  walk(from, to, '', 0);
  return { files, bytes, skipped };
}

/**
 * Publishes an `html` reference: every file of the generated folder is copied
 * as it is, and every HTML page gets the bar at the top of its body.
 *
 * @param {string} dataDir The generated folder (as the cache holds it).
 * @param {string} targetDir Where it is published.
 * @param {string} bar The result of {@link backBarHtml}.
 * @returns {{ files: number, pages: number }}
 */
export function publishReferenceFolder(dataDir, targetDir, bar) {
  let pages = 0;
  const { files } = copyTree(dataDir, targetDir, (source, target) => {
    if (isHtmlFile(source)) {
      pages += 1;
      writeFileSync(target, injectBackBar(readFileSync(source), bar));
    } else {
      copyFileSync(source, target);
    }
  });
  return { files, pages };
}

// ---------------------------------------------------------------------------
// Running the command

/**
 * @param {string} value
 * @param {NodeJS.Platform} [platform]
 * @returns {string} The value written for the system's shell as one word.
 */
export function shellQuote(value, platform = process.platform) {
  if (platform === 'win32') return /[\s&|<>^()%!"']/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return /[^A-Za-z0-9_/.:@%+=,-]/.test(value) ? `'${value.replaceAll("'", `'\\''`)}'` : value;
}

/**
 * Replaces `{repo}`, `{out}` and `{site}`; any other text in braces stays.
 *
 * @param {string} text
 * @param {Record<string, string>} values
 * @param {(value: string) => string} [quote] Applied to each value (for a command line).
 * @returns {string}
 */
export function substitutePlaceholders(text, values, quote = (value) => value) {
  return text.replace(/\{(repo|out|site)\}/g, (_whole, name) => quote(values[name]));
}

/**
 * Names of environment variables that look like they hold a secret (a token, a
 * key, a password, a credential, a cookie, an authorization) or that belong to
 * the services the site is published with. A generator is code of another
 * repository, so it does not get them.
 */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE|^(CLOUDFLARE|R2|AWS)_/i;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>} The environment without the variables whose names look like secrets.
 */
export function withoutSecrets(env) {
  /** @type {Record<string, string | undefined>} */
  const kept = {};
  for (const [name, value] of Object.entries(env)) if (!SECRET_NAME.test(name)) kept[name] = value;
  return kept;
}

/**
 * @param {import('./reference-config.js').ReferenceConfig['command']} command
 * @param {NodeJS.Platform} [platform]
 * @returns {string | string[]} The command for this system: the entry for Windows on Windows when there is one, else the default.
 */
export function commandFor(command, platform = process.platform) {
  if (typeof command === 'string' || Array.isArray(command)) return command;
  return platform === 'win32' && command.windows !== undefined ? command.windows : command.default;
}

/**
 * @typedef {object} CommandResult
 * @property {number | null} code The exit code; null when the process was killed or did not start.
 * @property {string} output The end of what it wrote (both streams together).
 * @property {boolean} timedOut
 * @property {string} [spawnError] Why it did not start.
 */

/**
 * Runs the command of a reference. A list is a program and its arguments, run
 * without a shell; the program is found in the absolute folders of the `PATH`
 * (never in the current folder), or, with a slash in it, relative to the
 * checkout. A text is a command line for the system's shell. The command is
 * killed, with everything it started, when it runs out of time.
 *
 * @param {object} call
 * @param {string | string[]} call.command
 * @param {Record<string, string>} call.values The placeholders.
 * @param {string} call.cwd
 * @param {Record<string, string | undefined>} call.env
 * @param {number} call.timeoutMs
 * @returns {Promise<CommandResult>}
 */
export function runCommand({ command, values, cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    /** @type {Record<string, string>} */
    const environment = {};
    for (const [key, value] of Object.entries(env)) if (value !== undefined) environment[key] = value;
    try {
      if (typeof command === 'string') {
        child = spawn(substitutePlaceholders(command, values, shellQuote), {
          shell: true,
          cwd,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      } else {
        const [first, ...rest] = command.map((part) => substitutePlaceholders(part, values));
        let program = first;
        if (!/[\\/]/.test(first)) {
          const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH');
          const found = findExecutable(first, pathKey === undefined ? '' : environment[pathKey]);
          // The Node that runs coffer is always there, whatever the PATH says.
          program = found ?? (first === 'node' ? process.execPath : '');
          if (program === '') {
            resolvePromise({ code: null, output: '', timedOut: false, spawnError: `the program "${first}" was not found in the PATH (for a script that needs the shell, give the command as one text)` });
            return;
          }
        } else {
          program = resolve(cwd, first);
        }
        child = spawn(program, rest, {
          cwd,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
      }
    } catch (error) {
      resolvePromise({ code: null, output: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = '';
    let settled = false;
    let timedOut = false;
    /** @param {Partial<CommandResult>} extra */
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: null, output, timedOut, ...extra });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish({ timedOut: true }), KILL_GRACE_MS).unref();
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk) => {
        output = (output + chunk).slice(-MAX_COMMAND_OUTPUT_BYTES);
      });
    }
    child.on('error', (error) => finish({ spawnError: error.message }));
    child.on('close', (code) => finish({ code }));
    child.on('exit', () => {
      if (timedOut) setTimeout(() => finish({ timedOut: true }), 300).unref();
    });
  });
}

/**
 * @param {string | string[]} command
 * @returns {string} The command for a message: one line, not too long.
 */
function describeCommand(command) {
  const text = (Array.isArray(command) ? command.join(' ') : command).replace(/\s+/g, ' ');
  return tailOf(text.length > 160 ? `${text.slice(0, 157)}...` : text, 1, 400).replace(/^\.\.\./, '');
}

/**
 * @param {CommandResult} result
 * @param {string | string[]} command
 * @param {number} timeoutMs
 * @returns {string} Why the command failed, with the end of its output.
 */
function commandFailure(result, command, timeoutMs) {
  const what = `the command \`${describeCommand(command)}\``;
  if (result.spawnError !== undefined) return `${what} could not be started: ${tailOf(result.spawnError)}`;
  if (result.timedOut) return `${what} did not finish within ${Number((timeoutMs / 1000).toFixed(1))} s and was stopped`;
  const output = tailOf(result.output, 15, 1500);
  const how = result.code === null ? 'was stopped by a signal' : `failed (exit code ${result.code})`;
  return output === '' ? `${what} ${how}` : `${what} ${how}: ${output}`;
}

// ---------------------------------------------------------------------------
// Generating and caching

/**
 * What {@link generateReference} returns.
 *
 * @typedef {object} ReferenceResult
 * @property {'html' | 'json'} format
 * @property {string} dataDir Absolute path of the generated folder (`html`) or of the folder that holds `reference.json` (`json`), inside the cache.
 * @property {ReferenceModel | null} model The checked content of a `json` reference; null for `html`.
 * @property {string[]} undocumentedNames The names the pattern of `undocumented` found in the output of the command.
 * @property {boolean} cached Whether the result was taken from the cache and the command did not run.
 * @property {number} files The number of files of an `html` reference; 1 for `json`.
 * @property {string[]} skipped Links in a generated folder, which were not published.
 */

/**
 * @typedef {object} ReferenceRequest
 * @property {string} slug The project's folder name; a folder of the cache.
 * @property {import('./reference-config.js').ReferenceConfig} reference
 * @property {import('./sources.js').FetchedDocs} fetched The fetched source, in which the command runs.
 * @property {string} siteDir The root of the content repository (`{site}`).
 * @property {string} cacheDir The folder of the reference cache, `.cache/reference`.
 * @property {number} [timeoutMs] Default {@link DEFAULT_REFERENCE_TIMEOUT_MS}.
 * @property {Record<string, string | undefined>} [env] The environment the command's is made from (default the process's), without the variables whose names look like secrets.
 */

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean} Whether `to` is `from` or inside it.
 */
function isInside(from, to) {
  const inside = relative(from, to);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/** The most files hashed for one `{site}` path of a command, and the most bytes read from one of them. */
const MAX_INPUT_FILES = 2000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** Ends each record of the hashed inputs. */
const SEPARATOR = String.fromCharCode(10);

/**
 * Hashes a file or folder of the content repository into `hash`: the files a
 * command is started with (a generator script, a Gradle init script) decide
 * what it produces, so changing one has to give a new cache entry. A folder
 * is read recursively in code-point order, `.git` and `node_modules` left out;
 * a symbolic link is recorded by name, not followed.
 *
 * @param {import('node:crypto').Hash} hash
 * @param {string} label The path as written in the command, after `{site}`, with `/`.
 * @param {string} path
 * @param {{ files: number }} budget
 */
function hashSiteInput(hash, label, path, budget) {
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    hash.update(`missing:${label}${SEPARATOR}`);
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`link:${label}${SEPARATOR}`);
  } else if (stat.isDirectory()) {
    hash.update(`dir:${label}${SEPARATOR}`);
    const names = readdirSync(path).filter((name) => name !== '.git' && name !== 'node_modules').sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) hashSiteInput(hash, `${label}/${name}`, join(path, name), budget);
  } else if (stat.isFile()) {
    budget.files += 1;
    if (budget.files > MAX_INPUT_FILES || stat.size > MAX_INPUT_BYTES) {
      hash.update(`large:${label}:${stat.size}${SEPARATOR}`);
      return;
    }
    hash.update(`file:${label}:${createHash('sha256').update(readFileSync(path)).digest('hex')}${SEPARATOR}`);
  } else {
    hash.update(`other:${label}${SEPARATOR}`);
  }
}

/**
 * The hash of the files of the content repository that a command names through
 * `{site}` (`{site}/generators/reference.mjs`, `--init-script={site}/x.kts`), in
 * every variant of the command. `{site}` alone, the folder itself, is not an input. The result of a generator depends on the
 * generator, so the contents of these files are part of the cache key.
 *
 * @param {import('./reference-config.js').ReferenceConfig['command']} command
 * @param {string} siteDir
 * @returns {string}
 */
export function siteInputsHash(command, siteDir) {
  const hash = createHash('sha256');
  /** @type {(string | string[])[]} */
  const lines = typeof command === 'string' || Array.isArray(command) ? [command] : [command.default, ...(command.windows === undefined ? [] : [command.windows])];
  const budget = { files: 0 };
  /** @type {Set<string>} */
  const seen = new Set();
  for (const line of lines) {
    for (const argument of typeof line === 'string' ? [line] : line) {
      for (const match of argument.matchAll(/\{site\}([^\s"'<>|&;]*)/g)) {
        const rest = match[1].replaceAll('\\', '/');
        // The root of the content repository itself is not an input: it holds the output and the caches.
        if (rest.split('/').every((part) => part === '' || part === '.') || seen.has(rest)) continue;
        seen.add(rest);
        hashSiteInput(hash, rest, resolve(siteDir, ...rest.split('/').filter(Boolean)), budget);
      }
    }
  }
  return hash.digest('hex');
}

/**
 * The hash of everything that decides what the command produces: the
 * configuration, and the contents of the files of the content repository that
 * the command names through `{site}`.
 *
 * @param {import('./reference-config.js').ReferenceConfig} reference
 * @param {string} siteDir
 * @returns {string}
 */
export function configHash(reference, siteDir) {
  return createHash('sha256')
    .update(JSON.stringify([CACHE_VERSION, reference.command, reference.format, reference.output, reference.undocumented, siteInputsHash(reference.command, siteDir)]))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Reads a finished cache entry. An entry that is incomplete, of another
 * version or format, or that no longer holds what it promised is no entry.
 *
 * @param {string} entry
 * @param {'html' | 'json'} format
 * @returns {ReferenceResult | null}
 */
function loadEntry(entry, format) {
  try {
    const meta = JSON.parse(readFileSync(join(entry, META_FILE), 'utf8'));
    if (!isMapping(meta) || meta.version !== CACHE_VERSION || meta.format !== format) return null;
    const dataDir = join(entry, DATA_DIR);
    const undocumentedNames = Array.isArray(meta.undocumented) ? meta.undocumented.filter((/** @type {unknown} */ name) => typeof name === 'string') : [];
    const skipped = Array.isArray(meta.skipped) ? meta.skipped.filter((/** @type {unknown} */ name) => typeof name === 'string') : [];
    if (format === 'json') {
      const parsed = parseReferenceJson(readFileSync(join(dataDir, REFERENCE_JSON_FILE), 'utf8'));
      if (!('model' in parsed)) return null;
      return { format, dataDir, model: parsed.model, undocumentedNames, cached: true, files: 1, skipped };
    }
    if (!statSync(join(dataDir, 'index.html')).isFile()) return null;
    return { format, dataDir, model: null, undocumentedNames, cached: true, files: Number(meta.files) || 0, skipped };
  } catch {
    return null;
  }
}

/**
 * Removes the older results of a project from the cache, and work folders that
 * a killed build left behind.
 *
 * @param {string} slugDir
 * @param {string} keep The entry that was just used.
 */
function pruneCache(slugDir, keep) {
  try {
    /** @type {{ path: string, time: number }[]} */
    const entries = [];
    for (const dirent of readdirSync(slugDir, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const path = join(slugDir, dirent.name);
      if (dirent.name.startsWith('.work-')) {
        if (Date.now() - statSync(path).mtimeMs > 3_600_000) rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (path === keep) continue;
      entries.push({ path, time: existsSync(join(path, META_FILE)) ? statSync(join(path, META_FILE)).mtimeMs : 0 });
    }
    entries.sort((a, b) => b.time - a.time);
    for (const { path } of entries.slice(KEEP_ENTRIES - 1)) rmSync(path, { recursive: true, force: true });
  } catch {
    // The cache is a speed-up; a folder that cannot be removed now is tried again next time.
  }
}

/**
 * Finds the names of undocumented elements in the output of the command.
 *
 * @param {string} output
 * @param {{ pattern: string } | null} undocumented
 * @returns {string[]} Distinct, in the order found.
 */
function undocumentedNamesIn(output, undocumented) {
  if (undocumented === null) return [];
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of output.matchAll(new RegExp(undocumented.pattern, 'gm'))) {
    const name = match.groups?.name?.trim();
    if (name) names.add(name);
    if (names.size >= MAX_UNDOCUMENTED) break;
  }
  return [...names];
}

/**
 * Generates the reference of a project: runs the configured command in the
 * checkout, takes its output, checks it and stores it.
 *
 * The command gets `{repo}` (the checkout), `{out}` (an empty folder made for
 * this run, in the cache) and `{site}` (the content repository). Its output is
 * the configured `output`, relative to the checkout (or an absolute path, which
 * `{out}` makes), and has to be inside the checkout or `{out}`: a command
 * cannot make the build publish any other file of the machine.
 *
 * The result is cached by the commit of the source and the configuration, in
 * `{cacheDir}/{slug}/{commit}-{hash}`: the same commit and the same
 * configuration give the result of the earlier run without running the command.
 * A source that cannot be pinned to a commit (a folder outside a repository,
 * or with uncommitted changes) is never taken from the cache.
 *
 * @param {ReferenceRequest} request
 * @returns {Promise<ReferenceResult>}
 * @throws {ReferenceFailure} When the command fails, runs out of time, or leaves nothing usable.
 */
export async function generateReference({ slug, reference, fetched, siteDir, cacheDir, timeoutMs = DEFAULT_REFERENCE_TIMEOUT_MS, env = process.env }) {
  const { source } = fetched;
  const sha = source.sha;
  const cacheable = sha !== null && (source.type === 'git' || source.dirty === false);
  const slugDir = join(cacheDir, slug);
  const entry = join(slugDir, cacheable ? `${sha}-${configHash(reference, siteDir)}` : '_uncached');
  if (cacheable) {
    const found = loadEntry(entry, reference.format);
    if (found) {
      try {
        // A result that is used stays among the newest.
        const now = new Date();
        utimesSync(join(entry, META_FILE), now, now);
      } catch {
        // Only the order of removal depends on it.
      }
      return found;
    }
  }

  const work = join(slugDir, `.work-${randomBytes(4).toString('hex')}`);
  try {
    rmSync(entry, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const out = join(work, 'out');
    mkdirSync(out, { recursive: true });
    const values = { repo: fetched.root, out, site: siteDir };
    const command = commandFor(reference.command);
    const result = await runCommand({ command, values, cwd: fetched.root, env: withoutSecrets(env), timeoutMs });
    if (result.spawnError !== undefined || result.timedOut || result.code !== 0) {
      throw new ReferenceFailure(commandFailure(result, command, timeoutMs));
    }

    // The output has to be inside the checkout or in {out}, links followed.
    const wanted = resolve(fetched.root, substitutePlaceholders(reference.output, values));
    /** @type {string} */
    let real;
    try {
      real = realpathSync(wanted);
    } catch {
      throw new ReferenceFailure(`the command succeeded, but its output "${reference.output}" does not exist (the path is relative to the repository; {out} is a folder made for the run)`);
    }
    const roots = [realpathSync(fetched.root), realpathSync(out)];
    if (!roots.some((root) => isInside(root, real))) {
      throw new ReferenceFailure(`the output "${reference.output}" is outside the repository and the folder {out}, and is not used`);
    }

    const data = join(work, DATA_DIR);
    /** @type {ReferenceModel | null} */
    let model = null;
    let files = 1;
    /** @type {string[]} */
    let skipped = [];
    const stat = statSync(real);
    if (reference.format === 'json') {
      if (!stat.isFile()) throw new ReferenceFailure(`the output "${reference.output}" must be a file for the format json`);
      if (stat.size > MAX_REFERENCE_JSON_BYTES) {
        throw new ReferenceFailure(`the output "${reference.output}" is ${stat.size} bytes; a json reference can have at most ${MAX_REFERENCE_JSON_BYTES}`);
      }
      const text = readFileSync(real, 'utf8');
      const parsed = parseReferenceJson(text);
      if (!('model' in parsed)) {
        throw new ReferenceFailure(`the output "${reference.output}" is not a valid reference: ${parsed.problems.join('; ')}`);
      }
      model = parsed.model;
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, REFERENCE_JSON_FILE), text);
    } else {
      if (!stat.isDirectory()) throw new ReferenceFailure(`the output "${reference.output}" must be a folder for the format html`);
      if (!existsSync(join(real, 'index.html'))) {
        throw new ReferenceFailure(`the output "${reference.output}" has no index.html, so there would be nothing at the address of the reference`);
      }
      const copied = copyTree(real, data, (from, to) => copyFileSync(from, to));
      files = copied.files;
      skipped = copied.skipped;
    }

    const undocumentedNames = undocumentedNamesIn(result.output, reference.undocumented);
    rmSync(out, { recursive: true, force: true });
    writeFileSync(join(work, META_FILE), `${JSON.stringify({ version: CACHE_VERSION, format: reference.format, files, undocumented: undocumentedNames, skipped }, null, 2)}\n`);
    mkdirSync(dirname(entry), { recursive: true });
    renameSync(work, entry);
    if (cacheable) pruneCache(slugDir, entry);
    return { format: reference.format, dataDir: join(entry, DATA_DIR), model, undocumentedNames, cached: false, files, skipped };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    if (error instanceof ReferenceFailure) throw error;
    throw new ReferenceFailure(`cannot generate the reference: ${tailOf(error instanceof Error ? error.message : String(error))}`);
  }
}
