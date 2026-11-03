import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

import { normalizeTag } from './posts.js';

/** Name of the optional file in a blog's directory that describes its tags. */
export const TAGS_FILE_NAME = 'tags.yaml';

/** Keys an entry of `tags.yaml` may have. */
export const TAG_META_KEYS = Object.freeze(['name', 'description', 'location', 'camera']);

/**
 * @typedef {import('./posts.js').Post} Post
 */

/**
 * What `tags.yaml` says about one tag.
 *
 * @typedef {object} TagMeta
 * @property {string | null} name Display name, or null to show the last slug segment.
 * @property {string | null} description Short description, if given.
 * @property {string | null} location Location policy for the tag's subtree as written; checked when the policy is resolved.
 * @property {string | null} camera Camera metadata policy for the tag's subtree as written; checked when the policy is resolved.
 */

/**
 * One node of the tag tree: a tag path used by a post, or an ancestor of one.
 *
 * @typedef {object} TagNode
 * @property {string} path Full tag path such as `workshop/boxes`.
 * @property {string} slug Last segment of the path.
 * @property {number} depth Number of segments in the path.
 * @property {string | null} parent Path of the parent node, or null for a top-level tag.
 * @property {TagNode[]} children Child nodes, ordered by slug.
 * @property {Post[]} posts Distinct posts tagged with this tag or any tag below it, newest first.
 * @property {number} count Number of distinct posts in the subtree.
 */

/**
 * The tag tree of a blog.
 *
 * @typedef {object} TagTree
 * @property {TagNode[]} roots Top-level nodes, ordered by slug.
 * @property {Map<string, TagNode>} nodes Every node by path.
 * @property {TagNode[]} all Every node, ordered by path (a parent comes before its children).
 */

/**
 * Raised when `tags.yaml` cannot be read or validated. Every problem is listed
 * in {@link TagsError#errors}; the message joins them.
 */
export class TagsError extends Error {
  /**
   * @param {string[]} errors One entry per problem, each starting with the file path.
   */
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'TagsError';
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
 * The tag itself and its ancestors, from the top-level tag down.
 *
 * @param {string} path
 * @returns {string[]} For `a/b/c`: `a`, `a/b`, `a/b/c`.
 */
export function tagPaths(path) {
  const segments = path.split('/');
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Builds the tag tree from the tags of the given posts. There is no registry:
 * every tag used by a post is a node, and so is every ancestor of such a tag.
 * A node lists the posts tagged with it or with any tag below it, each post
 * once however many of its tags fall in the subtree.
 *
 * @param {readonly Post[]} posts The posts to count; pass published posts only.
 * @returns {TagTree}
 */
export function buildTagTree(posts) {
  const ordered = [...posts].sort(
    (a, b) => b.date.getTime() - a.date.getTime() || compareText(a.slug, b.slug),
  );

  /** @type {Map<string, Set<Post>>} */
  const members = new Map();
  for (const post of ordered) {
    for (const tag of post.tags) {
      for (const path of tagPaths(tag)) {
        let set = members.get(path);
        if (set === undefined) {
          set = new Set();
          members.set(path, set);
        }
        set.add(post);
      }
    }
  }

  /** @type {Map<string, TagNode>} */
  const nodes = new Map();
  for (const path of [...members.keys()].sort(compareText)) {
    const segments = path.split('/');
    const list = [...(members.get(path) ?? [])];
    nodes.set(path, {
      path,
      slug: segments[segments.length - 1] ?? path,
      depth: segments.length,
      parent: segments.length > 1 ? segments.slice(0, -1).join('/') : null,
      children: [],
      posts: list,
      count: list.length,
    });
  }

  /** @type {TagNode[]} */
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent === null ? undefined : nodes.get(node.parent);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const bySlug = (/** @type {TagNode} */ a, /** @type {TagNode} */ b) => compareText(a.slug, b.slug);
  roots.sort(bySlug);
  for (const node of nodes.values()) node.children.sort(bySlug);

  return { roots, nodes, all: [...nodes.values()] };
}

/**
 * Reads the text of a `tags.yaml`: a mapping of tag paths to `{ name,
 * description, location, camera }`. Keys of an entry that coffer does not know
 * are returned as warnings, as is everything else that does not stop the
 * file from being understood.
 *
 * @param {string} file Path shown in messages.
 * @param {string} text Whole content of the file.
 * @returns {{ meta: Map<string, TagMeta>, warnings: string[] }}
 * @throws {TagsError} When the file is not valid YAML, an entry is not a mapping, a tag path is invalid or repeated, or a value has the wrong type.
 */
export function parseTagMeta(file, text) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, TagMeta>} */
  const meta = new Map();

  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const line = error.linePos?.[0]?.line;
      const where = line === undefined ? '' : ` (line ${line})`;
      const message = (error.message.split('\n')[0] ?? '')
        .replace(/ at line \d+, column \d+:?/, '')
        .trim();
      errors.push(`${file}: ${message}${where}`);
    }
    throw new TagsError(errors);
  }
  const data = document.toJS();
  if (data === null || data === undefined) return { meta, warnings };
  if (!isMapping(data)) {
    throw new TagsError([`${file}: must be a mapping of tag paths to { name, description }`]);
  }

  for (const [rawPath, entry] of Object.entries(data)) {
    const path = normalizeTag(rawPath);
    if (path === undefined) {
      errors.push(
        `${file}: ${rawPath}: must be a slash separated tag path whose segments are made of letters, digits, ".", "_" and "-"`,
      );
      continue;
    }
    if (meta.has(path)) {
      errors.push(`${file}: ${rawPath}: is the same tag as an earlier entry, "${path}"`);
      continue;
    }
    if (entry === null) {
      meta.set(path, { name: null, description: null, location: null, camera: null });
      continue;
    }
    if (!isMapping(entry)) {
      errors.push(`${file}: ${path}: must be a mapping with "name" and "description"`);
      continue;
    }

    /** @type {TagMeta} */
    const value = { name: null, description: null, location: null, camera: null };
    let valid = true;
    for (const [key, raw] of Object.entries(entry)) {
      if (!TAG_META_KEYS.includes(key)) {
        warnings.push(
          `${file}: ${path}.${key}: unknown key, ignored (expected one of: ${TAG_META_KEYS.join(', ')})`,
        );
        continue;
      }
      if (raw === null || raw === undefined) continue;
      if (typeof raw !== 'string' || raw.trim() === '') {
        errors.push(`${file}: ${path}.${key}: must be a non-empty string`);
        valid = false;
        continue;
      }
      value[/** @type {'name' | 'description' | 'location' | 'camera'} */ (key)] = raw.trim();
    }
    if (valid) meta.set(path, value);
  }

  if (errors.length > 0) throw new TagsError(errors);
  return { meta, warnings };
}

/**
 * Loads the optional `tags.yaml` of a blog directory.
 *
 * @param {string} blogDir Directory holding the posts of the blog.
 * @returns {{ file: string | null, meta: Map<string, TagMeta>, warnings: string[] }} `file` is null when the blog has no `tags.yaml`.
 * @throws {TagsError} As {@link parseTagMeta}, or when the file cannot be read.
 */
export function loadTagMeta(blogDir) {
  const file = join(blogDir, TAGS_FILE_NAME);
  if (!existsSync(file) || !statSync(file).isFile()) {
    return { file: null, meta: new Map(), warnings: [] };
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TagsError([`${file}: cannot be read: ${reason}`]);
  }
  return { file, ...parseTagMeta(file, text.replace(/^﻿/, '')) };
}

/**
 * Warnings about entries of `tags.yaml` for tags that no post uses.
 *
 * @param {string} file Path shown in messages.
 * @param {ReadonlyMap<string, TagMeta>} meta
 * @param {TagTree} tree
 * @returns {string[]}
 */
export function unusedTagWarnings(file, meta, tree) {
  /** @type {string[]} */
  const warnings = [];
  for (const path of meta.keys()) {
    if (!tree.nodes.has(path)) {
      warnings.push(`${file}: ${path}: no published post uses this tag, entry ignored`);
    }
  }
  return warnings;
}

/**
 * The name to show for a tag: the display name from `tags.yaml`, else the last
 * segment of the path.
 *
 * @param {string} path
 * @param {ReadonlyMap<string, TagMeta>} [meta]
 * @returns {string}
 */
export function tagName(path, meta) {
  const name = meta?.get(path)?.name;
  if (name) return name;
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Site-relative URL of a tag page: `{blog}/{tags}/{path}/`.
 *
 * @param {string} blogUrl Site-relative URL of the blog, ending in a slash.
 * @param {string} tagsSegment The `urls.tags` setting.
 * @param {string} [path] Tag path; omitted for the tag tree page.
 * @returns {string}
 */
export function tagUrl(blogUrl, tagsSegment, path) {
  const base = `${blogUrl}${tagsSegment}/`;
  return path === undefined ? base : `${base}${path}/`;
}
