import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeTag, parsePostSource } from '../../src/content/posts.js';
import {
  TAGS_FILE_NAME,
  TagsError,
  buildTagTree,
  loadTagMeta,
  parseTagMeta,
  tagName,
  tagPaths,
  tagUrl,
  unusedTagWarnings,
} from '../../src/content/tags.js';

/**
 * @param {string} slug
 * @param {string} date
 * @param {string[]} tags
 * @returns {import('../../src/content/posts.js').Post}
 */
function post(slug, date, tags) {
  const text = `---\ntitle: ${slug}\ndate: ${date}\ntags: [${tags.join(', ')}]\n---\n\nBody.\n`;
  return parsePostSource({ file: `${slug}.md`, slug, text });
}

/** @param {import('../../src/content/tags.js').TagNode} node */
const slugs = (node) => node.posts.map((entry) => entry.slug);

test('tagPaths lists a tag and its ancestors from the top down', () => {
  assert.deepEqual(tagPaths('a'), ['a']);
  assert.deepEqual(tagPaths('a/b/c'), ['a', 'a/b', 'a/b/c']);
});

test('a post tagged a/b appears on a and a/b, not on a/c', () => {
  const tree = buildTagTree([
    post('one', '2025-01-01', ['a/b']),
    post('two', '2025-01-02', ['a/c']),
  ]);
  assert.deepEqual(slugs(/** @type {any} */ (tree.nodes.get('a'))), ['two', 'one']);
  assert.deepEqual(slugs(/** @type {any} */ (tree.nodes.get('a/b'))), ['one']);
  assert.deepEqual(slugs(/** @type {any} */ (tree.nodes.get('a/c'))), ['two']);
});

test('every ancestor of a used tag is a node, and nothing else is', () => {
  const tree = buildTagTree([post('one', '2025-01-01', ['workshop/boxes/dovetails', 'trips'])]);
  assert.deepEqual([...tree.nodes.keys()].sort(), [
    'trips',
    'workshop',
    'workshop/boxes',
    'workshop/boxes/dovetails',
  ]);
  assert.deepEqual(
    tree.all.map((node) => node.path),
    ['trips', 'workshop', 'workshop/boxes', 'workshop/boxes/dovetails'],
  );
  assert.deepEqual(
    tree.roots.map((node) => node.path),
    ['trips', 'workshop'],
  );
  const boxes = /** @type {any} */ (tree.nodes.get('workshop/boxes'));
  assert.equal(boxes.parent, 'workshop');
  assert.equal(boxes.slug, 'boxes');
  assert.equal(boxes.depth, 2);
  assert.deepEqual(
    boxes.children.map((/** @type {any} */ child) => child.path),
    ['workshop/boxes/dovetails'],
  );
  assert.equal(tree.nodes.get('trips')?.parent, null);
});

test('the count of a node is the number of distinct posts in its subtree', () => {
  const tree = buildTagTree([
    post('both', '2025-01-03', ['a/b', 'a/c']),
    post('deep', '2025-01-02', ['a/b/x']),
    post('top', '2025-01-01', ['a']),
    post('other', '2025-01-04', ['z']),
  ]);
  const count = (/** @type {string} */ path) => tree.nodes.get(path)?.count;
  assert.equal(count('a'), 3, 'a post with two tags below a counts once');
  assert.equal(count('a/b'), 2);
  assert.equal(count('a/b/x'), 1);
  assert.equal(count('a/c'), 1);
  assert.equal(count('z'), 1);
  assert.equal(tree.nodes.get('a')?.posts.length, 3);
});

test('a node lists its posts newest first, ties broken by slug', () => {
  const tree = buildTagTree([
    post('old', '2024-01-01', ['t']),
    post('b-same', '2025-06-01', ['t/x']),
    post('a-same', '2025-06-01', ['t']),
    post('new', '2026-01-01', ['t/y']),
  ]);
  assert.deepEqual(slugs(/** @type {any} */ (tree.nodes.get('t'))), ['new', 'a-same', 'b-same', 'old']);
});

test('no posts make an empty tree', () => {
  const tree = buildTagTree([]);
  assert.deepEqual(tree.roots, []);
  assert.equal(tree.nodes.size, 0);
});

test('tagName is the display name, else the last segment', () => {
  const meta = new Map([
    ['wood/boxes', { name: 'Boxes', description: null, location: null, camera: null }],
  ]);
  assert.equal(tagName('wood/boxes', meta), 'Boxes');
  assert.equal(tagName('wood/boxes/dovetails', meta), 'dovetails');
  assert.equal(tagName('wood', meta), 'wood');
  assert.equal(tagName('wood'), 'wood');
});

test('tagUrl joins the blog, the tags segment and the path', () => {
  assert.equal(tagUrl('/journal/', 'tags'), '/journal/tags/');
  assert.equal(tagUrl('/journal/', 'tags', 'a/b'), '/journal/tags/a/b/');
  assert.equal(tagUrl('/', 'themes', 'a'), '/themes/a/');
});

test('tags are URL-safe path segments', () => {
  assert.equal(normalizeTag('Wood/Boxes'), 'wood/boxes');
  assert.equal(normalizeTag('a/../b'), undefined);
  assert.equal(normalizeTag('./a'), undefined);
  assert.equal(normalizeTag('a b'), undefined);
  assert.equal(normalizeTag('a?b'), undefined);
  assert.equal(normalizeTag('a//b'), undefined);
  assert.equal(normalizeTag('поход/горы'), 'поход/горы');
});

test('tags.yaml gives a display name and a description to a tag path', () => {
  const { meta, warnings } = parseTagMeta(
    'tags.yaml',
    [
      'Workshop/Boxes:',
      '  name: Коробки',
      '  description: Small boxes.',
      'trips:',
      '  name: Trips',
      'plain:',
      '',
    ].join('\n'),
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(meta.get('workshop/boxes'), {
    name: 'Коробки',
    description: 'Small boxes.',
    location: null,
    camera: null,
  });
  assert.equal(meta.get('trips')?.description, null);
  assert.ok(meta.has('plain'), 'an entry without a value is allowed');
});

test('tags.yaml may carry location and camera policies for later', () => {
  const { meta, warnings } = parseTagMeta('tags.yaml', 'hike:\n  location: keep\n  camera: strip\n');
  assert.deepEqual(warnings, []);
  assert.equal(meta.get('hike')?.location, 'keep');
  assert.equal(meta.get('hike')?.camera, 'strip');
});

test('unknown keys in tags.yaml are warnings, not errors', () => {
  const { meta, warnings } = parseTagMeta(
    'tags.yaml',
    'a:\n  name: A\n  colour: red\n  icon: x\n',
  );
  assert.equal(meta.get('a')?.name, 'A');
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^tags\.yaml: a\.colour: unknown key/);
  assert.match(warnings[1], /^tags\.yaml: a\.icon: unknown key/);
});

test('entries for tags no post uses are warnings', () => {
  const tree = buildTagTree([post('one', '2025-01-01', ['a/b'])]);
  const { meta } = parseTagMeta(
    'tags.yaml',
    'a:\n  name: A\na/b:\n  name: B\nghost:\n  name: Ghost\na/zzz:\n  name: Zzz\n',
  );
  const warnings = unusedTagWarnings('tags.yaml', meta, tree);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^tags\.yaml: ghost: no published post uses this tag/);
  assert.match(warnings[1], /^tags\.yaml: a\/zzz: no published post uses this tag/);
});

test('an empty tags.yaml is fine', () => {
  assert.equal(parseTagMeta('tags.yaml', '').meta.size, 0);
  assert.equal(parseTagMeta('tags.yaml', '# only a comment\n').meta.size, 0);
});

test('invalid tags.yaml is a TagsError listing every problem with the file', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['- a\n- b\n', /^tags\.yaml: must be a mapping/],
    ['a: [1]\n', /^tags\.yaml: a: must be a mapping/],
    ['a:\n  name: 5\n', /^tags\.yaml: a\.name: must be a non-empty string$/],
    ['a:\n  description: ""\n', /^tags\.yaml: a\.description: must be a non-empty string$/],
    ['"a//b":\n  name: X\n', /^tags\.yaml: a\/\/b: must be a slash separated tag path/],
    ['a:\n  name: X\nA:\n  name: Y\n', /^tags\.yaml: A: is the same tag as an earlier entry, "a"$/],
    ['a: [unclosed\n', /^tags\.yaml: /],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(
      () => parseTagMeta('tags.yaml', text),
      (error) => error instanceof TagsError && error.errors.some((line) => pattern.test(line)),
      text,
    );
  }
  assert.throws(
    () => parseTagMeta('tags.yaml', 'a:\n  name: 1\nb:\n  name: 2\n'),
    (error) => error instanceof TagsError && error.errors.length === 2,
  );
});

test('loadTagMeta reads tags.yaml from the blog directory, and tolerates its absence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-tags-'));
  try {
    assert.deepEqual(loadTagMeta(dir), { file: null, meta: new Map(), warnings: [] });
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, TAGS_FILE_NAME), 'a:\n  name: A\n  odd: 1\n');
    const loaded = loadTagMeta(dir);
    assert.equal(loaded.file, join(dir, TAGS_FILE_NAME));
    assert.equal(loaded.meta.get('a')?.name, 'A');
    assert.equal(loaded.warnings.length, 1);
    assert.ok(loaded.warnings[0].startsWith(join(dir, TAGS_FILE_NAME)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
