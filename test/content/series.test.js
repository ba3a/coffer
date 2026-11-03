import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePostSource } from '../../src/content/posts.js';
import {
  SERIES_FILE_NAME,
  SeriesError,
  buildSeries,
  compareSeriesParts,
  duplicatePositionWarnings,
  loadSeriesMeta,
  parseSeriesMeta,
  seriesUrl,
  unusedSeriesWarnings,
} from '../../src/content/series.js';

/**
 * @param {string} slug
 * @param {string} date
 * @param {string | null} series
 * @param {number} [position]
 * @returns {import('../../src/content/posts.js').Post}
 */
function post(slug, date, series, position) {
  const lines = [`title: ${slug}`, `date: ${date}`];
  if (series !== null) lines.push(`series: ${series}`);
  if (position !== undefined) lines.push(`seriesPosition: ${position}`);
  return parsePostSource({ file: `${slug}.md`, slug, text: `---\n${lines.join('\n')}\n---\n\nBody.\n` });
}

/** @param {import('../../src/content/series.js').Series} series */
const order = (series) => series.parts.map((part) => part.post.slug);

test('parts of a series without explicit positions read oldest first', () => {
  const [alps] = buildSeries([
    post('c', '2025-03-01', 'alps'),
    post('a', '2025-01-01', 'alps'),
    post('b', '2025-02-01', 'alps'),
  ]);
  assert.deepEqual(order(alps), ['a', 'b', 'c']);
  assert.deepEqual(
    alps.parts.map((part) => part.number),
    [1, 2, 3],
  );
  assert.equal(alps.count, 3);
});

test('explicit positions override the date order', () => {
  const [alps] = buildSeries([
    post('old', '2025-01-01', 'alps', 3),
    post('mid', '2025-02-01', 'alps', 1),
    post('new', '2025-03-01', 'alps', 2),
  ]);
  assert.deepEqual(order(alps), ['mid', 'new', 'old']);
});

test('in a mixed series explicit positions come first by value, then the rest by date', () => {
  const [alps] = buildSeries([
    post('plain-late', '2025-06-01', 'alps'),
    post('explicit-9', '2025-05-01', 'alps', 9),
    post('plain-early', '2025-01-01', 'alps'),
    post('explicit-2', '2025-07-01', 'alps', 2),
  ]);
  assert.deepEqual(order(alps), ['explicit-2', 'explicit-9', 'plain-early', 'plain-late']);
});

test('equal explicit positions fall back to the date, then the slug', () => {
  const posts = [
    post('b', '2025-01-01', 'alps', 1),
    post('a', '2025-01-01', 'alps', 1),
    post('z', '2024-01-01', 'alps', 1),
  ];
  const [alps] = buildSeries(posts);
  assert.deepEqual(order(alps), ['z', 'a', 'b']);
  assert.equal(compareSeriesParts(posts[0], posts[1]) > 0, true);
  const warnings = duplicatePositionWarnings([alps], (file) => `content/${file}`);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /^content\/a\.md: seriesPosition: 1 is also used by content\/z\.md in the series "alps"/);
});

test('every part knows its previous and next part in series order', () => {
  const [alps] = buildSeries([
    post('one', '2025-01-01', 'alps'),
    post('two', '2025-02-01', 'alps'),
    post('three', '2025-03-01', 'alps'),
  ]);
  const [first, second, third] = alps.parts;
  assert.equal(first.previous, null);
  assert.equal(first.next?.slug, 'two');
  assert.equal(second.previous?.slug, 'one');
  assert.equal(second.next?.slug, 'three');
  assert.equal(third.previous?.slug, 'two');
  assert.equal(third.next, null);
});

test('posts are grouped by series, posts without a series are ignored, groups are ordered by slug', () => {
  const groups = buildSeries([
    post('x', '2025-01-01', 'zeta'),
    post('y', '2025-01-02', null),
    post('z', '2025-01-03', 'alpha'),
    post('w', '2025-01-04', 'zeta'),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.slug, order(group)]),
    [
      ['alpha', ['z']],
      ['zeta', ['x', 'w']],
    ],
  );
});

test('the series name and description come from the metadata, the name defaults to the slug', () => {
  const meta = new Map([['alps', { name: 'Alps trip', description: 'Ten days.' }]]);
  const [alps, plain] = buildSeries([post('a', '2025-01-01', 'alps'), post('b', '2025-01-01', 'plain')], meta);
  assert.equal(alps.name, 'Alps trip');
  assert.equal(alps.description, 'Ten days.');
  assert.equal(plain.name, 'plain');
  assert.equal(plain.description, null);
});

test('adding a part changes the count and neighbours of earlier parts', () => {
  const early = [post('one', '2025-01-01', 'alps'), post('two', '2025-02-01', 'alps')];
  const before = /** @type {any} */ (buildSeries(early)[0]);
  assert.equal(before.count, 2);
  assert.equal(before.parts[1].next, null);

  const after = /** @type {any} */ (buildSeries([...early, post('three', '2025-03-01', 'alps')])[0]);
  assert.equal(after.count, 3);
  assert.equal(after.parts[0].number, 1);
  assert.equal(after.parts[1].next.slug, 'three');
});

test('series URLs are {blog}/{series segment}/{slug}/', () => {
  assert.equal(seriesUrl('/journal/', 'series', 'alps'), '/journal/series/alps/');
  assert.equal(seriesUrl('/', 'cycles', 'alps'), '/cycles/alps/');
});

test('series.yaml gives names and descriptions; unknown keys are warnings', () => {
  const { meta, warnings } = parseSeriesMeta(
    'series.yaml',
    'Alps:\n  name: Alps trip\n  description: Ten days.\n  colour: red\nplain:\n',
  );
  assert.deepEqual(meta.get('alps'), { name: 'Alps trip', description: 'Ten days.' });
  assert.deepEqual(meta.get('plain'), { name: null, description: null });
  assert.deepEqual(warnings, ['series.yaml: alps.colour: unknown key, ignored (expected one of: name, description)']);
});

test('an empty series.yaml is fine', () => {
  assert.equal(parseSeriesMeta('series.yaml', '# nothing yet\n').meta.size, 0);
});

test('invalid series.yaml content names the file and the key', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['- a\n- b\n', /^series\.yaml: must be a mapping of series slugs/],
    ['"a b":\n  name: X\n', /^series\.yaml: a b: must be a series slug/],
    ['a:\n  name: 5\n', /^series\.yaml: a\.name: must be a non-empty string$/],
    ['a: text\n', /^series\.yaml: a: must be a mapping/],
    ['a:\n  name: X\nA:\n  name: Y\n', /^series\.yaml: A: is the same series as an earlier entry, "a"$/],
    ['a: [\n', /^series\.yaml: /],
  ];
  for (const [text, pattern] of cases) {
    assert.throws(
      () => parseSeriesMeta('series.yaml', text),
      (error) => error instanceof SeriesError && pattern.test(error.errors[0] ?? ''),
      text,
    );
  }
});

test('loadSeriesMeta reads series.yaml from the blog directory, or reports none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-series-'));
  try {
    assert.deepEqual(loadSeriesMeta(dir), { file: null, meta: new Map(), warnings: [] });
    writeFileSync(join(dir, SERIES_FILE_NAME), '\uFEFFalps:\n  name: Alps trip\n');
    const loaded = loadSeriesMeta(dir);
    assert.equal(loaded.file, join(dir, SERIES_FILE_NAME));
    assert.equal(loaded.meta.get('alps')?.name, 'Alps trip');
    mkdirSync(join(dir, 'sub'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('entries of series.yaml for series without published posts are reported', () => {
  const meta = new Map([
    ['alps', { name: 'A', description: null }],
    ['gone', { name: 'G', description: null }],
  ]);
  const series = buildSeries([post('a', '2025-01-01', 'alps')], meta);
  assert.deepEqual(unusedSeriesWarnings('series.yaml', meta, series), [
    'series.yaml: gone: no published post is in this series, entry ignored',
  ]);
});
