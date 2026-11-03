import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PostError,
  discoverPosts,
  isPublished,
  parseDateValue,
  parsePostSource,
  resolveNow,
} from '../../src/content/posts.js';
import * as engine from '../../src/index.js';

/**
 * Creates a blog directory from a map of relative paths to file contents.
 *
 * @param {Record<string, string>} files
 * @returns {string}
 */
function blog(files) {
  const dir = mkdtempSync(join(tmpdir(), 'coffer-posts-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

/**
 * @param {Record<string, string>} files
 * @param {(dir: string) => void} body
 */
function withBlog(files, body) {
  const dir = blog(files);
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} fields Front matter lines.
 * @param {string} [body]
 * @returns {string}
 */
function doc(fields, body = 'Hello.\n') {
  return `---\n${fields}\n---\n${body}`;
}

/**
 * @param {() => unknown} action
 * @returns {string[]}
 */
function errorsOf(action) {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PostError, String(error));
    return error.errors;
  }
  assert.fail('expected a PostError');
}

const MINIMAL = doc('title: A post\ndate: 2024-05-01');

test('folder posts and single-file posts are discovered with their slugs', () => {
  withBlog(
    {
      'first-walk/index.md': doc('title: First walk\ndate: 2024-05-01'),
      'first-walk/photo.jpg': 'not really an image',
      'quick-note.md': doc('title: Quick note\ndate: 2024-06-01'),
      'notes.txt': 'ignored',
      '.hidden.md': 'ignored',
      'empty-folder/readme.txt': 'ignored',
    },
    (dir) => {
      const posts = discoverPosts(dir);
      assert.deepEqual(
        posts.map((post) => [post.slug, post.kind]),
        [
          ['quick-note', 'file'],
          ['first-walk', 'folder'],
        ],
      );
      const [file, folder] = posts;
      assert.equal(file.file, join(dir, 'quick-note.md'));
      assert.equal(file.dir, dir);
      assert.equal(folder.file, join(dir, 'first-walk', 'index.md'));
      assert.equal(folder.dir, join(dir, 'first-walk'));
    },
  );
});

test('the slug comes from the name only, not from date or tags', () => {
  withBlog(
    {
      'my-slug.md': doc('title: T\ndate: 2020-01-02\ntags: [a/b]\nslug: ignored'),
    },
    (dir) => {
      assert.equal(discoverPosts(dir)[0].slug, 'my-slug');
    },
  );
});

test('slugs may contain letters of any script and dots', () => {
  withBlog(
    {
      'поход-2024/index.md': doc('title: Поход\ndate: 2024-05-01'),
      'v1.2-notes.md': MINIMAL,
    },
    (dir) => {
      assert.deepEqual(
        discoverPosts(dir)
          .map((post) => post.slug)
          .sort(),
        ['v1.2-notes', 'поход-2024'],
      );
    },
  );
});

test('a slug with a space is an error naming the file', () => {
  withBlog({ 'two words.md': MINIMAL }, (dir) => {
    const errors = errorsOf(() => discoverPosts(dir));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /two words\.md: slug:/);
  });
});

test('duplicate slugs in one blog are an error naming both files', () => {
  withBlog({ 'same/index.md': MINIMAL, 'same.md': MINIMAL }, (dir) => {
    const errors = errorsOf(() => discoverPosts(dir));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /slug: "same" is already used by/);
    assert.ok(errors[0].includes(join(dir, 'same')));
  });
});

test('a missing blog directory is an error', () => {
  const missing = join(tmpdir(), 'coffer-no-such-blog-dir');
  const errors = errorsOf(() => discoverPosts(missing));
  assert.match(errors[0], /does not exist/);
  assert.ok(errors[0].startsWith(missing));
});

test('a missing title fails with the file path and the field name', () => {
  withBlog({ 'p.md': doc('date: 2024-05-01') }, (dir) => {
    const errors = errorsOf(() => discoverPosts(dir));
    assert.deepEqual(errors, [`${join(dir, 'p.md')}: title: is required`]);
  });
});

test('an empty or non-string title is rejected', () => {
  for (const title of ['""', '2024', '[a]']) {
    const errors = errorsOf(() =>
      parsePostSource({
        file: 'x.md',
        slug: 'x',
        text: doc(`title: ${title}\ndate: 2024-05-01`),
      }),
    );
    assert.deepEqual(errors, ['x.md: title: must be a non-empty string']);
  }
});

test('a missing date fails with the file path and the field name', () => {
  withBlog({ 'p/index.md': doc('title: T') }, (dir) => {
    const errors = errorsOf(() => discoverPosts(dir));
    assert.deepEqual(errors, [`${join(dir, 'p', 'index.md')}: date: is required`]);
  });
});

test('an invalid date fails with the file path and the field name', () => {
  for (const value of [
    'yesterday',
    '2024-13-01',
    '2023-02-29',
    '2024-05-01T25:00',
    '20240501',
    '5',
  ]) {
    withBlog({ 'p.md': doc(`title: T\ndate: ${value}`) }, (dir) => {
      const errors = errorsOf(() => discoverPosts(dir));
      assert.equal(errors.length, 1, value);
      assert.ok(errors[0].startsWith(`${join(dir, 'p.md')}: date: `), errors[0]);
    });
  }
});

test('all problems of all posts are reported together', () => {
  withBlog(
    {
      'a.md': doc('date: nope'),
      'b.md': doc('title: B\ndate: 2024-01-01\ndraft: maybe'),
      'c.md': 'no front matter at all',
    },
    (dir) => {
      const errors = errorsOf(() => discoverPosts(dir));
      assert.equal(errors.length, 4);
      assert.ok(errors.some((e) => e.includes('a.md: title: is required')));
      assert.ok(errors.some((e) => e.includes('a.md: date: ')));
      assert.ok(errors.some((e) => e.includes('b.md: draft: must be true or false')));
      assert.ok(errors.some((e) => e.includes('c.md: front matter: missing')));
    },
  );
});

test('broken YAML is reported with the file and a line', () => {
  const errors = errorsOf(() =>
    parsePostSource({
      file: 'x.md',
      slug: 'x',
      text: '---\ntitle: ok\ntitle: twice\ndate: 2024-05-01\n---\n',
    }),
  );
  assert.match(errors[0], /^x\.md: front matter: .*\(line 3\)$/);
});

test('front matter that is not a mapping is rejected', () => {
  const errors = errorsOf(() =>
    parsePostSource({ file: 'x.md', slug: 'x', text: '---\n- a\n- b\n---\n' }),
  );
  assert.deepEqual(errors, [
    'x.md: front matter: must be a mapping of keys to values',
  ]);
});

test('CRLF line endings and a byte order mark are accepted', () => {
  const post = parsePostSource({
    file: 'x.md',
    slug: 'x',
    text: '﻿---\r\ntitle: Win\r\ndate: 2024-05-01\r\n---\r\nBody\r\n',
  });
  assert.equal(post.title, 'Win');
  assert.equal(post.body, 'Body\r\n');
  assert.equal(post.bodyLine, 5);
});

test('every front matter field is read', () => {
  const post = parsePostSource({
    file: 'x.md',
    slug: 'x',
    text: doc(
      [
        'title: " Trail notes "',
        'date: 2024-05-01',
        'tags: [Hiking/Alps, woodworking]',
        'summary: Short.',
        'cover: cover.jpg',
        'series: Alps',
        'seriesPosition: 2',
        'draft: true',
        'aliases: [old-name, older]',
        'location: keep',
        'camera: strip',
        'map: false',
        'extra: kept',
      ].join('\n'),
      'Text\n',
    ),
  });
  assert.equal(post.title, 'Trail notes');
  assert.deepEqual(post.tags, ['hiking/alps', 'woodworking']);
  assert.equal(post.summary, 'Short.');
  assert.equal(post.cover, 'cover.jpg');
  assert.equal(post.series, 'Alps');
  assert.equal(post.seriesPosition, 2);
  assert.equal(post.draft, true);
  assert.deepEqual(post.aliases, ['old-name', 'older']);
  assert.equal(post.location, 'keep');
  assert.equal(post.camera, 'strip');
  assert.equal(post.map, false);
  assert.equal(post.frontMatter.extra, 'kept');
  assert.equal(post.body, 'Text\n');
  assert.equal(post.bodyLine, 16);
});

test('optional fields default to empty values', () => {
  const post = parsePostSource({ file: 'x.md', slug: 'x', text: MINIMAL });
  assert.deepEqual(post.tags, []);
  assert.deepEqual(post.aliases, []);
  assert.equal(post.summary, null);
  assert.equal(post.cover, null);
  assert.equal(post.series, null);
  assert.equal(post.seriesPosition, null);
  assert.equal(post.draft, false);
  assert.equal(post.location, null);
  assert.equal(post.camera, null);
  assert.equal(post.map, null);
});

test('tags are normalized: lowercase, trimmed, deduplicated', () => {
  const post = parsePostSource({
    file: 'x.md',
    slug: 'x',
    text: doc(
      'title: T\ndate: 2024-05-01\ntags: ["Wood/Boxes /Dovetails", wood/boxes/dovetails, " Tools "]',
    ),
  });
  assert.deepEqual(post.tags, ['wood/boxes/dovetails', 'tools']);
});

test('tags with empty segments are rejected with the field name', () => {
  for (const tag of ['""', '"a//b"', '"/a"', '"a/"', '"  "']) {
    const errors = errorsOf(() =>
      parsePostSource({
        file: 'x.md',
        slug: 'x',
        text: doc(`title: T\ndate: 2024-05-01\ntags: [fine, ${tag}]`),
      }),
    );
    assert.equal(errors.length, 1, tag);
    assert.match(errors[0], /^x\.md: tags\[1\]: /);
  }
});

test('other field mistakes name the file and the field', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['tags: nope', /^x\.md: tags: must be a list$/],
    ['tags: [1]', /^x\.md: tags\[0\]: must be a string$/],
    ['summary: 5', /^x\.md: summary: must be a non-empty string$/],
    ['cover: ""', /^x\.md: cover: /],
    ['series: [a]', /^x\.md: series: /],
    ['draft: yes', /^x\.md: draft: must be true or false$/],
    ['map: 1', /^x\.md: map: must be true or false$/],
    ['location: 3', /^x\.md: location: /],
    ['camera: [a]', /^x\.md: camera: /],
    ['series: s\nseriesPosition: 1.5', /^x\.md: seriesPosition: must be an integer$/],
    ['series: s\nseriesPosition: first', /^x\.md: seriesPosition: must be an integer$/],
    ['seriesPosition: 2', /^x\.md: seriesPosition: needs a "series"/],
    ['aliases: old', /^x\.md: aliases: must be a list$/],
    ['aliases: ["a b"]', /^x\.md: aliases\[0\]: /],
    ['aliases: [x]', /^x\.md: aliases\[0\]: .*own slug/],
  ];
  for (const [fields, pattern] of cases) {
    const errors = errorsOf(() =>
      parsePostSource({
        file: 'x.md',
        slug: 'x',
        text: doc(`title: T\ndate: 2024-05-01\n${fields}`),
      }),
    );
    assert.equal(errors.length, 1, fields);
    assert.match(errors[0], pattern, fields);
  }
});

test('posts come newest first, ties broken by slug', () => {
  withBlog(
    {
      'b.md': doc('title: B\ndate: 2024-01-01'),
      'a.md': doc('title: A\ndate: 2024-01-01'),
      'c.md': doc('title: C\ndate: 2025-01-01'),
    },
    (dir) => {
      assert.deepEqual(
        discoverPosts(dir).map((post) => post.slug),
        ['c', 'a', 'b'],
      );
    },
  );
});

test('dates: a date-only value means 00:00 in the site timezone', () => {
  const samara = parseDateValue('2024-05-01', 'Europe/Samara');
  assert.ok('date' in samara);
  assert.equal(samara.date.toISOString(), '2024-04-30T20:00:00.000Z');
  assert.equal(samara.dateOnly, true);

  const utc = parseDateValue('2024-05-01');
  assert.ok('date' in utc);
  assert.equal(utc.date.toISOString(), '2024-05-01T00:00:00.000Z');
});

test('dates: daylight saving time is respected', () => {
  const winter = parseDateValue('2024-01-15T09:30', 'America/New_York');
  const summer = parseDateValue('2024-07-15T09:30', 'America/New_York');
  assert.ok('date' in winter && 'date' in summer);
  assert.equal(winter.date.toISOString(), '2024-01-15T14:30:00.000Z');
  assert.equal(summer.date.toISOString(), '2024-07-15T13:30:00.000Z');
  assert.equal(winter.dateOnly, false);
});

test('dates: an explicit offset or Z overrides the site timezone', () => {
  for (const [value, iso] of [
    ['2024-05-01T10:00:00Z', '2024-05-01T10:00:00.000Z'],
    ['2024-05-01T10:00:00+03:00', '2024-05-01T07:00:00.000Z'],
    ['2024-05-01 10:00-0530', '2024-05-01T15:30:00.000Z'],
    ['2024-05-01T10:00:30.5+02', '2024-05-01T08:00:30.500Z'],
  ]) {
    const parsed = parseDateValue(value, 'Europe/Samara');
    assert.ok('date' in parsed, value);
    assert.equal(parsed.date.toISOString(), iso, value);
  }
});

test('dates: values that are not strings are rejected', () => {
  for (const value of [20240501, true, null, undefined, {}]) {
    assert.ok('error' in parseDateValue(value));
  }
});

test('the timezone is applied to post dates', () => {
  const post = parsePostSource(
    { file: 'x.md', slug: 'x', text: MINIMAL },
    { timezone: 'Europe/Samara' },
  );
  assert.equal(post.date.toISOString(), '2024-04-30T20:00:00.000Z');
});

test('with a fixed now, a future-dated post and a draft are excluded', () => {
  withBlog(
    {
      'past.md': doc('title: Past\ndate: 2024-05-01'),
      'future.md': doc('title: Future\ndate: 2030-01-01'),
      'draft.md': doc('title: Draft\ndate: 2024-05-02\ndraft: true'),
      'future-draft.md': doc('title: Both\ndate: 2031-01-01\ndraft: true'),
    },
    (dir) => {
      const now = new Date('2026-06-01T12:00:00Z');
      const posts = discoverPosts(dir);
      assert.deepEqual(
        posts.filter((post) => isPublished(post, { now })).map((p) => p.slug),
        ['past'],
      );
    },
  );
});

test('in preview mode drafts and future-dated posts are included', () => {
  withBlog(
    {
      'past.md': doc('title: Past\ndate: 2024-05-01'),
      'future.md': doc('title: Future\ndate: 2030-01-01'),
      'draft.md': doc('title: Draft\ndate: 2024-05-02\ndraft: true'),
    },
    (dir) => {
      const now = new Date('2026-06-01T12:00:00Z');
      const posts = discoverPosts(dir);
      assert.deepEqual(
        posts
          .filter((post) => isPublished(post, { now, drafts: true }))
          .map((p) => p.slug)
          .sort(),
        ['draft', 'future', 'past'],
      );
    },
  );
});

test('a post becomes published at the exact moment of its date', () => {
  const post = { draft: false, date: new Date('2026-06-01T00:00:00Z') };
  assert.equal(
    isPublished(post, { now: new Date('2026-05-31T23:59:59.999Z') }),
    false,
  );
  assert.equal(
    isPublished(post, { now: new Date('2026-06-01T00:00:00Z') }),
    true,
  );
});

test('now comes from --now, then COFFER_NOW, then the clock', () => {
  const clock = () => new Date('2020-01-01T00:00:00Z');
  const env = { COFFER_NOW: '2025-02-03T04:05:06Z' };
  assert.equal(
    resolveNow({ flag: '2026-07-08T09:10:11Z', env, clock }).toISOString(),
    '2026-07-08T09:10:11.000Z',
  );
  assert.equal(
    resolveNow({ env, clock }).toISOString(),
    '2025-02-03T04:05:06.000Z',
  );
  assert.equal(
    resolveNow({ flag: '', env: { COFFER_NOW: ' ' }, clock }).toISOString(),
    '2020-01-01T00:00:00.000Z',
  );
  assert.ok(Math.abs(resolveNow({ env: {} }).getTime() - Date.now()) < 5000);
});

test('now given as a date is read in the site timezone', () => {
  const now = resolveNow({ flag: '2026-06-01', timezone: 'Europe/Samara' });
  assert.equal(now.toISOString(), '2026-05-31T20:00:00.000Z');
});

test('an invalid now names its source', () => {
  assert.throws(() => resolveNow({ flag: 'soon', env: {} }), /^Error: --now: /);
  assert.throws(
    () => resolveNow({ env: { COFFER_NOW: 'soon' } }),
    /^Error: COFFER_NOW: /,
  );
});

test('the engine entry point exports the content API', () => {
  assert.equal(engine.discoverPosts, discoverPosts);
  assert.equal(engine.isPublished, isPublished);
  assert.equal(engine.resolveNow, resolveNow);
});
