import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';

import { IMAGE_EXTENSIONS } from '../images/defaults.js';
import { cleanRelativePath } from '../docs/sources.js';
import {
  checkRepoPicture,
  COMMON_PROJECT_KEYS,
  getProjectKind,
  isRepoPicture,
  listProjectKinds,
  readKindFields,
} from './project-kinds.js';
import { normalizeTag, PROJECT_SLUG_RE } from './posts.js';

/** Name of the file in a project's folder that declares the project. */
export const PROJECT_FILE_NAME = 'project.yaml';

/** Name of the file in a project's folder that holds the text of its page. */
export const PROJECT_PAGE_FILE_NAME = 'index.md';

/**
 * The stages a project can be in. Each one has a UI string `projects.status.{status}`.
 */
export const PROJECT_STATUSES = Object.freeze(['idea', 'in-development', 'released', 'maintained', 'archived']);

/**
 * A project as read from its folder.
 *
 * @typedef {object} Project
 * @property {string} slug The folder name; the last segment of the project's URL.
 * @property {string} dir Absolute path of the project's folder.
 * @property {string} file Absolute path of `project.yaml`.
 * @property {string} pageFile Absolute path of `index.md`. Does not exist when the page comes from {@link Project#landing}.
 * @property {string} name
 * @property {string} pitch One line that says what the project is.
 * @property {string} kind A registered kind such as `tool` or `game`.
 * @property {string} status One of {@link PROJECT_STATUSES}.
 * @property {string} card Absolute path of the card picture; empty when the card is a deferred `repo:` reference ({@link Project#cardRepo}).
 * @property {string | null} cardRepo Path of the card picture inside the project's `docs.source` (written `repo:path` in `project.yaml`), resolved after the source is fetched; null when the card is a file of the project folder.
 * @property {{ file: string } | null} landing The landing page in the docs source: `file` is its path inside the source, with `/`. Its text is the body of the project page instead of `index.md`; `body` is empty until the source is fetched. Null when the page is the local `index.md`.
 * @property {{ dir: string } | null} brand The folder in the docs source that holds the project's brand files: `dir` is its path inside the source, with `/`. Null when there is none.
 * @property {string} cardAlt Alternative text of the card picture; empty when the picture is decoration beside the project's name.
 * @property {boolean} featured Whether the project is in the home page's showcase.
 * @property {number | null} order Place in the showcase and on the projects page; lower comes first. Null sorts after every number.
 * @property {string | null} tag Normalized devlog tag path that marks the posts about the project, or null.
 * @property {string | null} license
 * @property {Record<string, unknown>} fields The kind's own fields, validated against the kind's schema.
 * @property {string} body The Markdown text of `index.md`.
 * @property {number} bodyLine 1-based line of `index.md` on which `body` starts (always 1: the file has no front matter).
 */

/**
 * Raised when the projects cannot be read or validated. Every problem is
 * listed in {@link ProjectError#errors}; each entry starts with the path of
 * the file and names the field.
 */
export class ProjectError extends Error {
  /**
   * @param {string[]} errors One entry per problem.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'ProjectError';
    /** @type {string[]} */
    this.errors = errors;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The order of the showcase and of the projects page: by `order`, projects
 * without one last, then by name.
 *
 * @param {Pick<Project, 'order' | 'name' | 'slug'>} a
 * @param {Pick<Project, 'order' | 'name' | 'slug'>} b
 * @returns {number}
 */
export function compareProjects(a, b) {
  if (a.order !== b.order) {
    if (a.order === null) return 1;
    if (b.order === null) return -1;
    return a.order - b.order;
  }
  return compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.slug, b.slug);
}

/**
 * The projects of the home page showcase: the featured ones, in order.
 *
 * @template {Pick<Project, 'featured' | 'order' | 'name' | 'slug'>} P
 * @param {readonly P[]} projects
 * @returns {P[]}
 */
export function showcaseOf(projects) {
  return projects.filter((project) => project.featured).sort(compareProjects);
}

/**
 * Site-relative URL of a project's page.
 *
 * @param {string} prefix The `urls.projects` prefix of the site.
 * @param {string} slug
 * @returns {string}
 */
export function projectUrl(prefix, slug) {
  return `/${prefix}/${slug}/`;
}

/**
 * Checks a `project.yaml` key whose value is a mapping with one key that names
 * a path inside the project's docs source (`landing: { file }`, `brand: { dir }`).
 * The path is not looked for: the source is fetched later.
 *
 * @param {string} key The key of `project.yaml`.
 * @param {unknown} value
 * @param {string} inner The only key the mapping can have.
 * @param {boolean} hasDocsSource
 * @param {(field: string, message: string) => void} fail
 * @returns {string | undefined} The clean path, or undefined after reporting a problem.
 */
function sourcePath(key, value, inner, hasDocsSource, fail) {
  if (!isMapping(value)) {
    fail(key, `must be a mapping with the key ${inner} (a path inside docs.source)`);
    return undefined;
  }
  const unknown = Object.keys(value).filter((name) => name !== inner);
  if (unknown.length > 0) {
    fail(key, `unknown key ${unknown.map((name) => `"${name}"`).join(', ')} (expected ${inner})`);
    return undefined;
  }
  if (!hasDocsSource) {
    fail(key, 'needs docs.source: the path is read from the docs source of the project');
    return undefined;
  }
  if (value[inner] === undefined || value[inner] === null) {
    fail(`${key}.${inner}`, 'is required');
    return undefined;
  }
  const cleaned = cleanRelativePath(value[inner]);
  if ('problem' in cleaned) {
    fail(`${key}.${inner}`, cleaned.problem);
    return undefined;
  }
  return cleaned.value;
}

/**
 * Parses the text of a `project.yaml` and checks it, the card picture and the
 * kind's own fields.
 *
 * @param {object} source
 * @param {string} source.slug The folder name.
 * @param {string} source.dir Absolute path of the project's folder.
 * @param {string} source.file Absolute path of `project.yaml`; used in messages.
 * @param {string} source.text Content of the file.
 * @param {string[]} errors Receives one entry per problem.
 * @returns {Omit<Project, 'body' | 'bodyLine' | 'pageFile'> | undefined} Undefined when problems were found.
 */
export function parseProjectSource({ slug, dir, file, text }, errors) {
  const before = errors.length;
  /** @param {string} field @param {string} message */
  const fail = (field, message) => {
    errors.push(`${file}: ${field}: ${message}`);
  };

  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const line = error.linePos?.[0]?.line;
      const where = line === undefined ? '' : ` (line ${line})`;
      const message = (error.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?/, '').trim();
      errors.push(`${file}: ${message}${where}`);
    }
    return undefined;
  }
  const data = document.toJS() ?? {};
  if (!isMapping(data)) {
    errors.push(`${file}: must be a mapping of keys to values`);
    return undefined;
  }

  /**
   * @param {string} key
   * @returns {string | undefined} The trimmed text when the field is a non-empty string; otherwise reports and returns undefined.
   */
  const text1 = (key) => {
    const value = data[key];
    if (value === undefined || value === null) {
      fail(key, 'is required');
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      fail(key, 'must be a non-empty string');
      return undefined;
    }
    return value.trim();
  };

  const name = text1('name');
  const pitch = text1('pitch');

  /** @type {import('./project-kinds.js').ProjectKind | undefined} */
  let kind;
  const rawKind = data.kind;
  if (rawKind === undefined || rawKind === null) {
    fail('kind', `is required (one of: ${listProjectKinds().map((entry) => entry.name).join(', ')})`);
  } else if (typeof rawKind !== 'string' || (kind = getProjectKind(rawKind.trim())) === undefined) {
    fail(
      'kind',
      `unknown kind ${JSON.stringify(rawKind)} (known kinds: ${listProjectKinds().map((entry) => entry.name).join(', ')})`,
    );
  }

  let status = text1('status');
  if (status !== undefined && !PROJECT_STATUSES.includes(status)) {
    fail('status', `unknown status ${JSON.stringify(status)} (one of: ${PROJECT_STATUSES.join(', ')})`);
    status = undefined;
  }

  // The pictures and files "in the repository" are read from the docs source, so they need one.
  const hasDocsSource =
    kind?.fields.docs?.type === 'docs' && isMapping(data.docs) && data.docs.source !== undefined && data.docs.source !== null;

  /** @type {string | undefined} */
  let card;
  /** @type {string | null} */
  let cardRepo = null;
  const rawCard = text1('card');
  if (rawCard !== undefined && isRepoPicture(rawCard)) {
    const checked = checkRepoPicture(rawCard, hasDocsSource);
    if ('problem' in checked) fail('card', checked.problem);
    else {
      cardRepo = checked.value.repo;
      card = '';
    }
  } else if (rawCard !== undefined) {
    const target = resolve(dir, rawCard);
    const inside = relative(dir, target);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      fail('card', `"${rawCard}" must be a picture inside the project folder`);
    } else if (!IMAGE_EXTENSIONS.includes(extname(target).toLowerCase())) {
      fail('card', `"${rawCard}" must be one of ${IMAGE_EXTENSIONS.join(', ')}`);
    } else if (!existsSync(target) || !statSync(target).isFile()) {
      fail('card', `the picture "${rawCard}" does not exist in the project folder`);
    } else {
      card = target;
    }
  }

  let cardAlt = '';
  if (data.cardAlt !== undefined && data.cardAlt !== null) {
    if (typeof data.cardAlt !== 'string') fail('cardAlt', 'must be a string');
    else cardAlt = data.cardAlt.trim();
  }

  let featured = false;
  if (data.featured !== undefined && data.featured !== null) {
    if (typeof data.featured !== 'boolean') fail('featured', 'must be true or false');
    else featured = data.featured;
  }

  /** @type {number | null} */
  let order = null;
  if (data.order !== undefined && data.order !== null) {
    if (typeof data.order !== 'number' || !Number.isInteger(data.order)) fail('order', 'must be a whole number');
    else order = data.order;
  }

  /** @type {string | null} */
  let tag = null;
  if (data.tag !== undefined && data.tag !== null) {
    const normalized = typeof data.tag === 'string' ? normalizeTag(data.tag) : undefined;
    if (normalized === undefined) {
      fail('tag', 'must be a tag path such as "projects/lathe" (letters, digits, ".", "_" and "-", separated by "/")');
    } else {
      tag = normalized;
    }
  }

  /** @type {string | null} */
  let license = null;
  if (data.license !== undefined && data.license !== null) {
    if (typeof data.license !== 'string' || data.license.trim() === '') fail('license', 'must be a non-empty string');
    else license = data.license.trim();
  }

  /** @type {Project['landing']} */
  let landing = null;
  if (data.landing !== undefined && data.landing !== null) {
    const file = sourcePath('landing', data.landing, 'file', hasDocsSource, fail);
    if (file !== undefined) {
      if (extname(file).toLowerCase() !== '.md') fail('landing.file', `"${file}" must be a Markdown file (.md)`);
      else landing = { file };
    }
  }

  /** @type {Project['brand']} */
  let brand = null;
  if (data.brand !== undefined && data.brand !== null) {
    const dirInSource = sourcePath('brand', data.brand, 'dir', hasDocsSource, fail);
    if (dirInSource !== undefined) brand = { dir: dirInSource };
  }

  /** @type {Record<string, unknown>} */
  let fields = {};
  if (kind !== undefined) {
    /**
     * @param {(string | number)[]} path
     * @returns {number | undefined}
     */
    const lineOf = (path) => {
      const node = /** @type {{ range?: [number, number, number], type?: string } | null} */ (
        /** @type {unknown} */ (document.getIn(path, true))
      );
      if (!node || !node.range) return undefined;
      const line = lines.linePos(node.range[0]).line;
      // The text of a block scalar starts on the line after its `|` or `>`.
      return node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED' ? line + 1 : line;
    };
    fields = readKindFields(kind, data, { dir, lineOf, hasDocsSource }, fail);
    const allowed = [...COMMON_PROJECT_KEYS, ...Object.keys(kind.fields)];
    for (const key of Object.keys(data)) {
      if (allowed.includes(key)) continue;
      fail(
        key,
        key === 'slug'
          ? 'is not a field: the slug is the name of the project folder'
          : `unknown key for a ${kind.name} (expected one of: ${allowed.join(', ')})`,
      );
    }
  }

  if (errors.length > before) return undefined;
  return {
    slug,
    dir,
    file,
    name: /** @type {string} */ (name),
    pitch: /** @type {string} */ (pitch),
    kind: /** @type {import('./project-kinds.js').ProjectKind} */ (kind).name,
    status: /** @type {string} */ (status),
    card: /** @type {string} */ (card),
    cardRepo,
    landing,
    brand,
    cardAlt,
    featured,
    order,
    tag,
    license,
    fields,
  };
}

/**
 * Reads every project of a projects directory: each folder holds a
 * `project.yaml`, an `index.md` and the pictures the two refer to. Folders
 * whose names start with "." or "_" are not projects. Projects are returned
 * in showcase order (see {@link compareProjects}).
 *
 * @param {string} dir Absolute path of the projects directory.
 * @returns {Project[]}
 * @throws {ProjectError} With every problem found: a missing directory, a folder without `project.yaml` or `index.md`, an unknown kind, a missing or invalid field.
 */
export function loadProjects(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new ProjectError([`${dir}: projects directory does not exist`]);
  }
  /** @type {string[]} */
  const errors = [];
  /** @type {Project[]} */
  const projects = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const slug = entry.name;
    const folder = join(dir, slug);
    const file = join(folder, PROJECT_FILE_NAME);
    const pageFile = join(folder, PROJECT_PAGE_FILE_NAME);
    const before = errors.length;
    if (!PROJECT_SLUG_RE.test(slug)) {
      errors.push(
        `${folder}: slug: "${slug}" (the folder name) must be lower-case letters, digits, "-" and "_", starting with a letter or a digit`,
      );
    }
    const hasFile = existsSync(file) && statSync(file).isFile();
    const hasPage = existsSync(pageFile) && statSync(pageFile).isFile();
    if (!hasFile) {
      errors.push(`${file}: missing; every project folder needs a ${PROJECT_FILE_NAME}`);
      if (!hasPage) {
        errors.push(`${pageFile}: missing; every project folder needs an ${PROJECT_PAGE_FILE_NAME} with the text of the page`);
      }
      continue;
    }

    let text;
    let body = '';
    try {
      text = readFileSync(file, 'utf8');
      if (hasPage) body = readFileSync(pageFile, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(`${folder}: cannot be read: ${reason}`);
      continue;
    }
    const project = parseProjectSource({ slug, dir: folder, file, text }, errors);
    if (project === undefined) continue;
    if (project.landing !== null) {
      // The page has one source: the landing file of the docs source, or a local index.md.
      if (hasPage) {
        errors.push(
          `${pageFile}: two sources for one page: ${PROJECT_FILE_NAME} has landing (${project.landing.file} in docs.source) and the folder has an ${PROJECT_PAGE_FILE_NAME}; remove one of them`,
        );
      }
    } else if (!hasPage) {
      errors.push(`${pageFile}: missing; every project folder needs an ${PROJECT_PAGE_FILE_NAME} with the text of the page`);
    } else if (/^﻿?---[ \t]*\r?\n/.test(body)) {
      errors.push(`${pageFile}: front matter: not used; the fields of a project are in ${PROJECT_FILE_NAME}`);
    }
    if (errors.length === before) {
      projects.push({ ...project, pageFile, body: '', bodyLine: 1, ...(project.landing === null ? { body } : {}) });
    }
  }
  if (errors.length > 0) throw new ProjectError(errors);
  return projects.sort(compareProjects);
}
