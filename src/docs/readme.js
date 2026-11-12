import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { README_PLACEHOLDER_ATTRIBUTE } from '../markdown/directives/readme.js';
import { MARKDOWN_FILE, readGuideFile, repoLabelOf } from './guides.js';
import { resolveInside } from './sources.js';

/**
 * Sections of the README (or another Markdown file) of a project's repository,
 * for a `::readme` directive on the project's page.
 *
 * {@link findSection} cuts the section out of a text; {@link readSection}
 * finds the file in the fetched source and returns the section as a page the
 * guide machinery can render and whose links it can resolve. The file is
 * untrusted repository content, so it is read through `resolveInside` and
 * `readGuideFile` like a guide.
 */

/** The most headings listed in a message that names the headings a file has. */
const MAX_LISTED_HEADINGS = 12;

/**
 * @param {import('mdast').Nodes} node
 * @returns {string} The plain text of the node.
 */
function textOf(node) {
  if ('value' in node && typeof node.value === 'string') return node.value;
  if ('children' in node) return node.children.map((child) => textOf(child)).join('');
  if ('alt' in node && typeof node.alt === 'string') return node.alt;
  return '';
}

/**
 * @param {string} text
 * @returns {string} The text with white space collapsed and case folded, so that headings compare the way a reader reads them.
 */
function normalized(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A section of a Markdown text.
 *
 * @typedef {object} Section
 * @property {string} text The Markdown below the heading, up to the next heading of the same or a higher level; sub sections are part of it. Without the heading, with blank lines at both ends removed.
 * @property {number} line 1-based line of the file on which `text` starts.
 * @property {number} depth Level of the heading (1 to 6).
 */

/**
 * Finds a section of a Markdown text: the text below the first heading whose
 * words are `heading` (white space and capitals do not matter) up to the next
 * heading of the same or a higher level. Only headings of the text itself
 * count, not those inside quotes, lists or code.
 *
 * @param {string} text
 * @param {string} heading
 * @returns {{ section: Section } | { headings: string[] }} The section; or, when no heading matches, the headings the text has.
 */
export function findSection(text, heading) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
  const headings = tree.children.filter((node) => node.type === 'heading');
  const wanted = normalized(heading);
  const start = headings.find((node) => normalized(textOf(node)) === wanted);
  if (!start || start.position?.end.offset === undefined || start.position.end.line === undefined) {
    return { headings: headings.map((node) => textOf(node).replace(/\s+/g, ' ').trim()) };
  }
  const after = tree.children.slice(tree.children.indexOf(start) + 1);
  const next = after.find((node) => node.type === 'heading' && node.depth <= start.depth);
  const from = start.position.end.offset;
  const to = next?.position?.start.offset ?? text.length;
  const raw = text.slice(from, to);
  const blank = /^(?:[ \t]*\n)*/.exec(raw)?.[0] ?? '';
  return {
    section: {
      text: raw.slice(blank.length).trimEnd(),
      line: start.position.end.line + blank.split('\n').length - 1,
      depth: start.depth,
    },
  };
}

/**
 * @param {string} root
 * @returns {string[]} The names of the Markdown files in the top folder of the source that are called README, the best choice first.
 */
function readmeNames(root) {
  const base = resolveInside(root, '.');
  if (!base.ok) return [];
  let names;
  try {
    names = readdirSync(base.path);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^readme\.(?:md|markdown)$/i.test(name))
    .sort((a, b) => Number(b === 'README.md') - Number(a === 'README.md') || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Whether every part of the path has exactly the case it is written in, so
 * that a name that works on a case-insensitive disk does not break on GitHub.
 *
 * @param {string} root
 * @param {string} path
 * @returns {boolean}
 */
export function exactCase(root, path) {
  const base = resolveInside(root, '.');
  if (!base.ok) return false;
  let dir = base.path;
  for (const part of path.split('/')) {
    try {
      if (!readdirSync(dir).includes(part)) return false;
    } catch {
      return false;
    }
    dir = join(dir, part);
  }
  return true;
}

/**
 * What {@link readSection} returns when it found the section.
 *
 * @typedef {object} ReadmeSection
 * @property {import('./guides.js').GuidePage} page The section as a page: `rel` is the file, `text` the section, `label` names the file as `{repo}:{path}`.
 * @property {number} line 1-based line of the file on which the section text starts.
 */

/**
 * Reads a section of a file of the fetched source.
 *
 * @param {import('./sources.js').FetchedDocs} fetched
 * @param {{ file: string | null, section: string }} request The file as written in the directive (null for the README of the repository) and the heading.
 * @returns {{ ok: true, found: ReadmeSection } | { ok: false, message: string }} A failure carries the reason, written for the author of the page that asked.
 */
export function readSection(fetched, { file, section }) {
  const repo = repoLabelOf(fetched);
  let rel;
  if (file === null) {
    const [name] = readmeNames(fetched.root);
    if (name === undefined) return { ok: false, message: `the repository ${repo} has no README.md to take the section "${section}" from (name a file with file="...")` };
    rel = name;
  } else {
    rel = posix.normalize(file.replaceAll('\\', '/').replace(/^\.\//, ''));
    if (!MARKDOWN_FILE.test(rel)) return { ok: false, message: `file "${file}" is not a Markdown file (.md or .markdown)` };
    const inside = resolveInside(fetched.root, rel);
    if (!inside.ok) {
      return {
        ok: false,
        message: inside.reason === 'missing' ? `file "${file}" does not exist in the repository ${repo}` : `file "${file}" cannot be used: ${inside.message}`,
      };
    }
    if (!exactCase(fetched.root, rel)) {
      return { ok: false, message: `file "${file}" does not exist in the repository ${repo} with exactly this capitalisation (GitHub tells "Readme.md" from "README.md")` };
    }
  }
  const label = `${repo}:${rel}`;
  /** @type {string[]} */
  const problems = [];
  const text = readGuideFile(fetched.root, rel, label, (issue) => problems.push(issue.message));
  if (text === null) return { ok: false, message: problems[0] ?? `file "${rel}" cannot be read` };
  const found = findSection(text, section);
  if (!('section' in found)) {
    const listed = found.headings.slice(0, MAX_LISTED_HEADINGS).map((name) => `"${name}"`);
    const more = found.headings.length > listed.length ? ', ...' : '';
    return {
      ok: false,
      message: `${label} has no heading "${section}"${listed.length > 0 ? ` (its headings: ${listed.join(', ')}${more})` : ' (it has no headings)'}`,
    };
  }
  if (found.section.text === '') return { ok: false, message: `the section "${section}" of ${label} has no content` };
  return {
    ok: true,
    found: {
      page: { rel, inGuide: rel, guide: -1, label, text: found.section.text, slug: '', isIndex: false },
      line: found.section.line,
    },
  };
}

const PLACEHOLDER_RE = new RegExp(`<div ${README_PLACEHOLDER_ATTRIBUTE}="(\\d+)"></div>`, 'g');

/**
 * Puts the sections into the HTML of a page, each in the place of its
 * `::readme` directive. A directive whose section could not be read (the build
 * reports that) is left empty.
 *
 * @param {string} html The rendered page, with the placeholders the directives left.
 * @param {ReadonlyMap<number, string>} sections The finished HTML of each section, by the number of its directive.
 * @returns {string}
 */
export function fillReadmeSections(html, sections) {
  return html.replace(PLACEHOLDER_RE, (_match, index) => {
    const section = sections.get(Number(index));
    return section === undefined ? '' : `<div class="readme-section">${section}</div>`;
  });
}
